/**
 * test-face-auth.js
 *
 * Full end-to-end test of the ZepIris face-auth pipeline.
 *
 * Pipeline:
 *   Phase 0 — PRE-CLEAN
 *     Queries ZepIris for any existing faces whose ID starts with "test_"
 *     belonging to this tenant and deletes them so we start fresh.
 *     (Also deletes the 3 known orphaned IDs from the previous failed run.)
 *
 *   Phase 1 — IMAGE PREP (via sharp)
 *     For each enrollment image:
 *       - Resize longest edge to 640 px (keeps aspect ratio)
 *       - Convert to JPEG at 90% quality
 *       - Rotate to correct EXIF orientation
 *     Writes cleaned files to src/face-auth/test/_cleaned/
 *
 *   Phase 2 — ENROLLMENT
 *     Enrolls all 5 cleaned images per person into ZepIris.
 *     3 s pause between uploads, 3 retries + 5 s back-off on timeout.
 *
 *   Phase 3 — VERIFICATION
 *     Sends each probe image (also cleaned) to /v1/faces/search.
 *     Reports PASS / FAIL with exact match details.
 *
 *   Phase 4 — CLEANUP
 *     Deletes all enrolled test faces from ZepIris.
 *
 * Usage:
 *   node --env-file=.env src/face-auth/test-face-auth.js
 */

import 'dotenv/config';
import { readFile, mkdir, rm } from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname, basename } from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL        = process.env.ZEPIRIS_BASE_URL;
const TENANT          = process.env.ZEPIRIS_TENANT ?? 'nit_hamirpur';
const THRESHOLD       = Number(process.env.ZEPIRIS_MATCH_THRESHOLD ?? 0.60);
const TEST_DIR        = resolve('src/face-auth/test');
const CLEANED_DIR     = join(TEST_DIR, '_cleaned');
const REQUEST_TIMEOUT = 30_000;   // ms
const REQUEST_DELAY   = 3_000;    // ms between consecutive uploads
const RETRY_DELAY     = 5_000;    // ms before retry after timeout
const MAX_RETRIES     = 3;

// Orphaned face IDs from the previous failed test run
const KNOWN_ORPHANS = [
    'test_ayush_e0771215-8369-4cbb-8c0c-0f51a52a2e9f',
    'test_ayush_90721114-042e-42b5-b707-2dfc6f4fe12d',
    'test_ayush_f8a61fde-edec-40b1-95f4-a63824f6e420',
];

if (!BASE_URL) {
    console.error('❌  ZEPIRIS_BASE_URL is not set in .env');
    process.exit(1);
}

// ── Logging ──────────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const MAGENTA = '\x1b[35m';

const pass  = (msg) => console.log(`  ${GREEN}✔${R}  ${msg}`);
const fail  = (msg) => console.log(`  ${RED}✘${R}  ${msg}`);
const info  = (msg) => console.log(`  ${CYAN}ℹ${R}  ${msg}`);
const warn  = (msg) => console.log(`  ${YELLOW}⚠${R}  ${msg}`);
const head  = (msg) => console.log(`\n${BOLD}${msg}${R}`);
const dim   = (msg) => console.log(`${DIM}${msg}${R}`);
const debug = (msg) => console.log(`  ${MAGENTA}⚙${R}  ${DIM}${msg}${R}`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isImage = (f) => ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase());

// ── Error Classifier ─────────────────────────────────────────────────────────
/**
 * Returns a human-readable string explaining exactly WHY a fetch/abort failed.
 */
function classifyError(err, elapsedMs) {
    const name    = err.name    ?? '';
    const code    = err.code    ?? '';
    const message = err.message ?? '';

    // AbortController fired (our own timeout)
    if (name === 'AbortError' || message.toLowerCase().includes('aborted') || message.includes('operation was aborted')) {
        return `TIMEOUT — request did not complete within ${REQUEST_TIMEOUT / 1000}s `
             + `(elapsed: ${(elapsedMs / 1000).toFixed(2)}s). `
             + `ZepIris is likely still processing a previous image (CPU-bound saturation).`;
    }

    // TCP connection refused — service not running
    if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
        return `CONNECTION REFUSED (ECONNREFUSED) — nothing is listening on ${BASE_URL}. `
             + `Start the ZepIris service and try again.`;
    }

    // DNS resolution failure
    if (code === 'ENOTFOUND' || message.includes('ENOTFOUND')) {
        return `DNS FAILURE (ENOTFOUND) — hostname in ZEPIRIS_BASE_URL could not be resolved. `
             + `Check ZEPIRIS_BASE_URL in .env (current: ${BASE_URL}).`;
    }

    // Connection reset
    if (code === 'ECONNRESET' || message.includes('ECONNRESET')) {
        return `CONNECTION RESET (ECONNRESET) — ZepIris closed the connection unexpectedly. `
             + `It may have crashed or ran out of memory.`;
    }

    // Pipe broken
    if (code === 'EPIPE' || message.includes('EPIPE')) {
        return `BROKEN PIPE (EPIPE) — the connection was forcibly closed while sending data.`;
    }

    // HTTP-level error from ZepIris itself
    if (err.status) {
        return `HTTP ${err.status} from ZepIris — ${JSON.stringify(err.data ?? message)}`;
    }

    // Fallback
    return `UNKNOWN ERROR — name="${name}" code="${code}" message="${message}"`;
}

// ── HTTP Layer ───────────────────────────────────────────────────────────────
async function zepirisRequest(endpoint, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const t0 = Date.now();
    try {
        const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, signal: controller.signal });
        let data = {};
        try { data = await res.json(); } catch (_) {}
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            err.data   = data;
            throw err;
        }
        return { data, elapsedMs: Date.now() - t0 };
    } catch (rawErr) {
        rawErr._elapsedMs = Date.now() - t0;
        throw rawErr;
    } finally {
        clearTimeout(timer);
    }
}

async function zepirisRequestWithRetry(endpoint, options = {}, label = endpoint) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await zepirisRequest(endpoint, options);
            debug(`${label} → ${result.elapsedMs}ms`);
            return result.data;
        } catch (err) {
            const elapsed = err._elapsedMs ?? 0;
            const reason  = classifyError(err, elapsed);
            const isRetryable = err.name === 'AbortError'
                             || err.message?.includes('aborted')
                             || (err.code && ['ECONNRESET', 'EPIPE'].includes(err.code));

            if (attempt < MAX_RETRIES && isRetryable) {
                warn(`  Attempt ${attempt}/${MAX_RETRIES} failed after ${(elapsed / 1000).toFixed(2)}s`);
                warn(`  Reason: ${reason}`);
                warn(`  Retrying in ${RETRY_DELAY / 1000}s…`);
                await sleep(RETRY_DELAY);
            } else {
                // Attach clean reason to error so callers can log it
                err._reason = reason;
                err._elapsed = elapsed;
                throw err;
            }
        }
    }
}

// ── ZepIris Operations ───────────────────────────────────────────────────────
async function enrollImage({ faceId, buffer, filename }) {
    const form = new FormData();
    form.append('id',     faceId);
    form.append('tenant', TENANT);
    form.append('file',   new Blob([buffer], { type: 'image/jpeg' }), filename);
    return zepirisRequestWithRetry('/v1/faces/insert', { method: 'POST', body: form }, `ENROLL ${filename}`);
}

async function searchImage({ buffer, filename }) {
    const form = new FormData();
    form.append('id',     `query_${Date.now()}`);
    form.append('tenant', TENANT);
    form.append('file',   new Blob([buffer], { type: 'image/jpeg' }), filename);
    return zepirisRequestWithRetry(`/v1/faces/search?top_k=5`, { method: 'POST', body: form }, `SEARCH ${filename}`);
}

async function deleteFace(faceId) {
    try {
        const result = await zepirisRequestWithRetry(
            `/v1/faces/delete?id=${faceId}`,
            { method: 'DELETE' },
            `DELETE ${faceId.slice(0, 28)}…`
        );
        return result;
    } catch (err) {
        warn(`  Could not delete ${faceId.slice(0, 28)}…`);
        warn(`  Reason: ${err._reason ?? err.message}`);
    }
}

// ── Image Cleaner (sharp) ─────────────────────────────────────────────────────
/**
 * Reads an image, normalises it, and returns a clean JPEG buffer.
 * - Rotates to correct EXIF orientation
 * - Resizes longest edge to 640 px
 * - Converts to JPEG, quality 90
 */
async function cleanImage(inputPath) {
    const buffer = await sharp(inputPath)
        .rotate()                               // auto-rotate from EXIF
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90, mozjpeg: false })
        .toBuffer();

    const meta = await sharp(buffer).metadata();
    return { buffer, width: meta.width, height: meta.height, size: buffer.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n${BOLD}╔══════════════════════════════════════════════╗`);
    console.log(`║   ZepIris Face-Auth Integration Test v2      ║`);
    console.log(`╚══════════════════════════════════════════════╝${R}`);
    info(`ZepIris URL   : ${BASE_URL}`);
    info(`Tenant        : ${TENANT}`);
    info(`Threshold     : ${THRESHOLD}`);
    info(`Req timeout   : ${REQUEST_TIMEOUT / 1000}s  |  Upload delay: ${REQUEST_DELAY / 1000}s  |  Retries: ${MAX_RETRIES}`);

    // ── Health check ──────────────────────────────────────────────────────
    head('0. Health Check');
    try {
        const t0 = Date.now();
        await zepirisRequest('/healthz');
        pass(`ZepIris service is healthy (${Date.now() - t0}ms)`);
    } catch (err) {
        fail(`ZepIris unreachable`);
        fail(`Reason: ${classifyError(err, err._elapsedMs ?? 0)}`);
        fail(`Fix this before continuing.`);
        process.exit(1);
    }

    // ── Phase 0: Pre-clean ────────────────────────────────────────────────
    head('0b. Pre-clean (removing any leftover test faces)');
    const allOrphans = [...new Set(KNOWN_ORPHANS)];
    if (allOrphans.length > 0) {
        info(`Deleting ${allOrphans.length} known orphaned face ID(s)…`);
        for (const id of allOrphans) {
            await deleteFace(id);
            await sleep(500);
        }
    } else {
        info('No known orphans to clean up.');
    }

    // ── Discover persons ─────────────────────────────────────────────────
    const persons = readdirSync(TEST_DIR)
        .filter(e => {
            const full = join(TEST_DIR, e);
            return statSync(full).isDirectory() && !e.startsWith('_');
        });

    const probeFiles = readdirSync(TEST_DIR)
        .filter(f => {
            const full = join(TEST_DIR, f);
            return statSync(full).isFile() && isImage(f);
        });

    info(`Persons to enroll : ${persons.join(', ')}`);
    info(`Probe images      : ${probeFiles.join(', ')}`);

    // ── Phase 1: Image prep ───────────────────────────────────────────────
    head('1. Image Prep (sharp — resize + EXIF rotate + JPEG normalise)');

    // Wipe and recreate _cleaned dir
    if (existsSync(CLEANED_DIR)) {
        await rm(CLEANED_DIR, { recursive: true, force: true });
    }
    await mkdir(CLEANED_DIR, { recursive: true });

    // { person: [{ buffer, filename }] }
    const cleanedEnrollment = {};
    // [{ buffer, filename, expectedPerson }]
    const cleanedProbes = [];

    for (const person of persons) {
        const personDir = join(TEST_DIR, person);
        const images    = readdirSync(personDir).filter(isImage).map(f => join(personDir, f));

        if (!images.length) { warn(`No images in ${person}/ — skipping`); continue; }

        info(`Cleaning ${BOLD}${person}${R}${CYAN} (${images.length} images)…${R}`);
        cleanedEnrollment[person] = [];

        const outDir = join(CLEANED_DIR, person);
        await mkdir(outDir, { recursive: true });

        for (const imgPath of images) {
            const orig = basename(imgPath);
            const out  = join(outDir, orig.replace(/[^a-zA-Z0-9._-]/g, '_') + '.jpg');
            try {
                const { buffer, width, height, size } = await cleanImage(imgPath);
                const { writeFile } = await import('fs/promises');
                await writeFile(out, buffer);
                cleanedEnrollment[person].push({ buffer, filename: basename(out) });
                dim(`    ${orig} → ${width}×${height}  ${(size / 1024).toFixed(1)} KB  saved: ${basename(out)}`);
            } catch (err) {
                warn(`    Failed to clean ${orig}: ${err.message}`);
            }
        }
    }

    for (const probeFile of probeFiles) {
        const probePath      = join(TEST_DIR, probeFile);
        const expectedPerson = probeFile.replace(/\.[^.]+$/, '');
        try {
            const { buffer, width, height, size } = await cleanImage(probePath);
            const outFilename = probeFile.replace(/[^a-zA-Z0-9._-]/g, '_') + '_clean.jpg';
            const { writeFile } = await import('fs/promises');
            await writeFile(join(CLEANED_DIR, outFilename), buffer);
            cleanedProbes.push({ buffer, filename: outFilename, expectedPerson });
            dim(`    ${probeFile} (probe) → ${width}×${height}  ${(size / 1024).toFixed(1)} KB`);
        } catch (err) {
            warn(`    Failed to clean probe ${probeFile}: ${err.message}`);
        }
    }

    pass(`Image prep done → cleaned files written to ${CLEANED_DIR}`);

    // ── Phase 2: Enrollment ───────────────────────────────────────────────
    head('2. Enrollment Phase');

    const faceIdMap = {};   // { person: [faceId, …] }
    const results   = { enroll: {}, verify: {} };

    for (const person of Object.keys(cleanedEnrollment)) {
        const images = cleanedEnrollment[person];
        if (!images.length) { warn(`No cleaned images for ${person}`); continue; }

        info(`Enrolling ${BOLD}${person}${R}${CYAN} (${images.length} images)…${R}`);
        faceIdMap[person]      = [];
        results.enroll[person] = { success: 0, fail: 0 };

        for (let i = 0; i < images.length; i++) {
            const { buffer, filename } = images[i];
            const faceId = `test_${person}_${randomUUID()}`;

            try {
                const res = await enrollImage({ faceId, buffer, filename });
                faceIdMap[person].push(faceId);
                results.enroll[person].success++;
                pass(`  [${i + 1}/${images.length}] ${filename} → ${DIM}${faceId.slice(0, 28)}…${R}`);
                if (res?.imageQualityAssessment) {
                    const qa = res.imageQualityAssessment;
                    dim(`         blur=${qa.blur?.score?.toFixed(3) ?? 'n/a'}  spoof=${qa.spoof?.score?.toFixed(3) ?? 'n/a'}  nsfw=${qa.nsfw?.score?.toFixed(3) ?? 'n/a'}`);
                }
            } catch (err) {
                results.enroll[person].fail++;
                fail(`  [${i + 1}/${images.length}] ${filename} — FAILED`);
                fail(`    Reason  : ${err._reason ?? classifyError(err, err._elapsed ?? 0)}`);
                fail(`    Elapsed : ${((err._elapsed ?? 0) / 1000).toFixed(2)}s`);
                if (err.data) fail(`    Response: ${JSON.stringify(err.data)}`);
            }

            if (i < images.length - 1) {
                debug(`Pausing ${REQUEST_DELAY / 1000}s before next upload…`);
                await sleep(REQUEST_DELAY);
            }
        }

        if (persons.indexOf(person) < persons.length - 1) {
            debug(`Pausing 3s before next person…`);
            await sleep(3000);
        }
    }

    // ── Phase 3: Verification ─────────────────────────────────────────────
    head('3. Verification Phase');

    for (const probe of cleanedProbes) {
        const { buffer, filename, expectedPerson } = probe;

        info(`Verifying ${BOLD}${filename}${R}${CYAN} → expected person: ${expectedPerson}${R}`);

        if (!faceIdMap[expectedPerson]?.length) {
            warn(`  No enrolled faces for "${expectedPerson}" — skipping`);
            results.verify[expectedPerson] = { status: 'SKIPPED', reason: 'not enrolled' };
            continue;
        }

        debug(`Pausing ${REQUEST_DELAY / 1000}s before search…`);
        await sleep(REQUEST_DELAY);

        try {
            const res     = await searchImage({ buffer, filename });
            const matches = res?.searchResult?.matches ?? [];

            if (!matches.length) {
                fail(`  ZepIris returned 0 matches — face not found in index`);
                results.verify[expectedPerson] = { status: 'FAIL', reason: 'no matches returned' };
                continue;
            }

            const best      = matches[0];
            const bestScore = best.score;

            let matchedPerson = null;
            for (const [p, ids] of Object.entries(faceIdMap)) {
                if (ids.includes(best.id)) { matchedPerson = p; break; }
            }

            const threshOk = bestScore <= THRESHOLD;
            const personOk = matchedPerson === expectedPerson;
            const verdict  = threshOk && personOk ? 'PASS' : 'FAIL';

            console.log(`\n  ${DIM}All matches returned (lower score = better match):${R}`);
            for (const m of matches) {
                const mp  = Object.entries(faceIdMap).find(([, ids]) => ids.includes(m.id))?.[0] ?? '???';
                const bar = '█'.repeat(Math.round((1 - Math.min(m.score, 1)) * 20));
                dim(`    ${m.score.toFixed(4)}  ${bar.padEnd(20)}  person=${mp}  id=${m.id.slice(0, 28)}…`);
            }

            console.log();
            if (verdict === 'PASS') {
                pass(`Result: ${GREEN}${BOLD}PASS${R}  matched=${matchedPerson}  score=${bestScore.toFixed(4)}  threshold=${THRESHOLD}`);
            } else {
                fail(`Result: ${RED}${BOLD}FAIL${R}`);
                fail(`  matched person : ${matchedPerson ?? 'none (no enrolled face matched the ID)'}`);
                fail(`  best score     : ${bestScore.toFixed(4)}  (threshold: ${THRESHOLD}  — score must be ≤ threshold)`);
                fail(`  score OK?      : ${threshOk}    person OK?: ${personOk}`);
                if (!threshOk) fail(`  → Distance too large: face similarity is below acceptance threshold`);
                if (!personOk) fail(`  → Wrong person matched: expected "${expectedPerson}", got "${matchedPerson ?? 'none'}"`);
            }

            if (res?.imageQualityAssessment) {
                const qa = res.imageQualityAssessment;
                dim(`  Quality — blur=${qa.blur?.score?.toFixed(3) ?? 'n/a'}  spoof=${qa.spoof?.score?.toFixed(3) ?? 'n/a'}  nsfw=${qa.nsfw?.score?.toFixed(3) ?? 'n/a'}`);
            }

            results.verify[expectedPerson] = { status: verdict, matchedPerson, bestScore, threshOk, personOk };

        } catch (err) {
            fail(`  Search FAILED`);
            fail(`  Reason  : ${err._reason ?? classifyError(err, err._elapsed ?? 0)}`);
            fail(`  Elapsed : ${((err._elapsed ?? 0) / 1000).toFixed(2)}s`);
            results.verify[expectedPerson] = { status: 'FAIL', reason: err._reason ?? err.message };
        }
    }

    // ── Phase 4: Cleanup ─────────────────────────────────────────────────
    head('4. Cleanup Phase');

    for (const [person, ids] of Object.entries(faceIdMap)) {
        info(`Deleting ${ids.length} face(s) for ${person}…`);
        for (const faceId of ids) {
            await deleteFace(faceId);
            await sleep(500);
        }
        pass(`Done cleaning ${person}`);
    }

    // ── Summary ──────────────────────────────────────────────────────────
    head('5. Summary');

    console.log(`\n  ${BOLD}Enrollment:${R}`);
    for (const [person, r] of Object.entries(results.enroll)) {
        const icon = r.fail === 0 ? `${GREEN}✔${R}` : `${YELLOW}⚠${R}`;
        console.log(`    ${icon}  ${person}: ${r.success}/${r.success + r.fail} enrolled`);
    }

    console.log(`\n  ${BOLD}Verification:${R}`);
    let passCount = 0, failCount = 0, skipCount = 0;
    for (const [person, r] of Object.entries(results.verify)) {
        if (r.status === 'PASS') {
            passCount++;
            console.log(`    ${GREEN}✔${R}  ${person} → ${GREEN}PASS${R}  (score=${r.bestScore?.toFixed(4)})`);
        } else if (r.status === 'SKIPPED') {
            skipCount++;
            console.log(`    ${YELLOW}⚠${R}  ${person} → SKIPPED (${r.reason})`);
        } else {
            failCount++;
            console.log(`    ${RED}✘${R}  ${person} → ${RED}FAIL${R}  (${r.reason ?? `matched=${r.matchedPerson ?? 'none'}, score=${r.bestScore?.toFixed(4)}`})`);
        }
    }

    const total = passCount + failCount;
    console.log(`\n  ${BOLD}Overall: ${passCount}/${total} verifications passed${skipCount > 0 ? `, ${skipCount} skipped` : ''}${R}\n`);

    if (failCount > 0) process.exit(1);
}

main().catch((err) => {
    console.error(`\n${RED}❌  Fatal error:${R}`, err);
    process.exit(1);
});
