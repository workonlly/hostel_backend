/**
 * cleanup-orphaned-faces.js
 *
 * Deletes the 3 test face IDs that were enrolled during the failed
 * test run but never cleaned up because ZepIris timed out.
 *
 * Usage:
 *   node --env-file=.env src/face-auth/cleanup-orphaned-faces.js
 */

import 'dotenv/config';

const BASE_URL = process.env.ZEPIRIS_BASE_URL;
const ORPHANS = [
    'test_ayush_e0771215-8369-4cbb-8c0c-0f51a52a2e9f',
    'test_ayush_90721114-042e-42b5-b707-2dfc6f4fe12d',
    'test_ayush_f8a61fde-edec-40b1-95f4-a63824f6e420',
];

async function deleteFace(faceId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(`${BASE_URL}/v1/faces/delete?id=${faceId}`, {
            method: 'DELETE',
            signal: controller.signal,
        });
        let data = {};
        try { data = await res.json(); } catch (_) {}
        console.log(`  ✔ Deleted ${faceId}`, res.status, JSON.stringify(data));
    } catch (err) {
        console.error(`  ✘ Failed to delete ${faceId}: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    console.log(`\nCleaning up ${ORPHANS.length} orphaned test faces from ZepIris…\n`);
    for (const id of ORPHANS) {
        await deleteFace(id);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('\nDone.\n');
}

main();
