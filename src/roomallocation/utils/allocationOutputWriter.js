/**
 * allocationOutputWriter.js — CSV & Log Output Layer
 * ============================================================
 * Writes allocation results to disk during allocation phase.
 *
 * RULES:
 *   - CSV files are saved ONLY when NODE_ENV=development
 *   - Log files are ALWAYS saved (regardless of env)
 *   - Terminal progress is shown ONLY when NODE_ENV=development
 *   - Never throws — all errors are swallowed to protect allocation
 *
 * Output directory structure:
 *   outputs/
 *     <hostel_name>/
 *       allocation_<date>_batch<N>_round<N>.csv
 *       allocation_<date>_batch<N>_round<N>.log
 * ============================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Resolve path: src/roomallocation/utils → src/roomallocation/outputs
const OUTPUTS_BASE = path.resolve(__dirname, '../outputs');

const IS_DEV = process.env.NODE_ENV === 'development';

// ─────────────────────────────────────────────────────────
// PATH HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Sanitise a hostel name to be safe for directory names.
 * e.g. "Hostel A (Men)" → "hostel_a_men"
 */
function _sanitiseName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
}

/**
 * Build the directory path for a given hostel.
 * Creates the directory if it does not exist.
 */
function _ensureHostelDir(hostelName) {
    const dir = path.join(OUTPUTS_BASE, _sanitiseName(hostelName));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Generate a timestamp prefix for filenames.
 * Format: YYYY-MM-DD_HH-MM-SS
 */
function _dateTag() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    );
}

// ─────────────────────────────────────────────────────────
// TERMINAL PROGRESS (dev-only)
// ─────────────────────────────────────────────────────────

/**
 * Log a live allocation progress line to the terminal.
 * Only printed when NODE_ENV=development.
 *
 * @param {{ allocated: number, total: number, groupId: string, roomNumber: string|null, success: boolean }} opts
 */
export function printAllocationProgress({ allocated, total, groupId, roomNumber, success }) {
    if (!IS_DEV) return;

    const bar   = _progressBar(allocated, total);
    const icon  = success ? '✔' : '✘';
    const label = success
        ? `Group ${groupId} → Room ${roomNumber ?? '?'}`
        : `Group ${groupId} → FAILED`;

    process.stdout.write(
        `\r  [${bar}] ${allocated}/${total}  ${icon} ${label.padEnd(50)}`
    );

    // After last item, print newline to avoid overwriting
    if (allocated === total) {
        process.stdout.write('\n');
    }
}

function _progressBar(done, total, width = 20) {
    const filled = Math.round((done / Math.max(total, 1)) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─────────────────────────────────────────────────────────
// MAIN WRITER
// ─────────────────────────────────────────────────────────

/**
 * Write allocation round results to disk.
 *
 * Always writes: .log file
 * Dev-only writes: .csv file
 *
 * @param {{
 *   hostelName: string,
 *   hostelId: string,
 *   batchId: string,
 *   batchNumber: number,
 *   roundNumber: number,
 *   results: Array<{
 *     submissionId: string,
 *     success: boolean,
 *     groupId?: string,
 *     roomId?: string,
 *     roomNumber?: string,
 *     memberIds?: number[],
 *     preferenceOrder?: number,
 *     reason?: string,
 *     errorCode?: string,
 *     skipped?: boolean,
 *   }>,
 *   allocated: number,
 *   failed: number,
 *   processed: number,
 * }} params
 */
export async function writeAllocationOutput({
    hostelName,
    hostelId,
    batchId,
    batchNumber,
    roundNumber,
    results,
    allocated,
    failed,
    processed,
}) {
    try {
        const dir     = _ensureHostelDir(hostelName ?? hostelId ?? 'unknown_hostel');
        const dateTag = _dateTag();
        const stem    = `allocation_${dateTag}_batch${batchNumber}_round${roundNumber}`;

        const logContent = _buildLog({ hostelName, hostelId, batchId, batchNumber, roundNumber, results, allocated, failed, processed, dateTag });

        // ── LOG (always) ───────────────────────────────────
        const logPath = path.join(dir, `${stem}.log`);
        fs.writeFileSync(logPath, logContent, 'utf8');

        // ── CSV (dev-only) ─────────────────────────────────
        if (IS_DEV) {
            const csvContent = _buildCsv(results);
            const csvPath    = path.join(dir, `${stem}.csv`);
            fs.writeFileSync(csvPath, csvContent, 'utf8');
            console.log(`\n[outputWriter] CSV  → ${csvPath}`);
        }

        console.log(`[outputWriter] LOG  → ${logPath}`);

    } catch (err) {
        // Never break allocation due to output errors
        console.error('[outputWriter] Failed to write output (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// CSV BUILDER
// ─────────────────────────────────────────────────────────

function _buildCsv(results) {
    const headers = [
        'submission_id',
        'group_id',
        'outcome',
        'room_id',
        'room_number',
        'preference_order',
        'member_ids',
        'reason',
        'error_code',
        'skipped',
    ];

    const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        // RFC 4180: wrap in quotes if contains comma, quote, or newline
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    const rows = results.map((r) => [
        escape(r.submissionId),
        escape(r.groupId ?? ''),
        escape(r.skipped ? 'SKIPPED' : r.success ? 'ALLOCATED' : 'FAILED'),
        escape(r.roomId ?? ''),
        escape(r.roomNumber ?? ''),
        escape(r.preferenceOrder ?? ''),
        escape(r.memberIds ? r.memberIds.join(';') : ''),
        escape(r.reason ?? ''),
        escape(r.errorCode ?? ''),
        escape(r.skipped ? 'true' : 'false'),
    ].join(','));

    return [headers.join(','), ...rows].join('\r\n');
}

// ─────────────────────────────────────────────────────────
// LOG BUILDER
// ─────────────────────────────────────────────────────────

function _buildLog({ hostelName, hostelId, batchId, batchNumber, roundNumber, results, allocated, failed, processed, dateTag }) {
    const sep  = '='.repeat(60);
    const dash = '-'.repeat(60);
    const ts   = new Date().toISOString();

    const lines = [
        sep,
        `ALLOCATION ROUND LOG`,
        sep,
        `Generated At   : ${ts}`,
        `Hostel         : ${hostelName ?? 'N/A'} (${hostelId ?? 'N/A'})`,
        `Batch ID       : ${batchId}`,
        `Batch Number   : ${batchNumber}`,
        `Round Number   : ${roundNumber}`,
        dash,
        `SUMMARY`,
        dash,
        `Total Processed: ${processed}`,
        `Allocated      : ${allocated}`,
        `Failed         : ${failed}`,
        `Success Rate   : ${processed > 0 ? ((allocated / processed) * 100).toFixed(1) : '0.0'}%`,
        dash,
        `RESULTS`,
        dash,
    ];

    for (const r of results) {
        const outcome = r.skipped ? 'SKIPPED' : r.success ? 'ALLOCATED' : 'FAILED';
        const prefix  = r.success ? '  ✔' : r.skipped ? '  ⊘' : '  ✘';

        lines.push(`${prefix} [${outcome}]`);
        lines.push(`     Submission : ${r.submissionId}`);
        lines.push(`     Group      : ${r.groupId ?? 'N/A'}`);

        if (r.success) {
            lines.push(`     Room ID    : ${r.roomId}`);
            lines.push(`     Room No.   : ${r.roomNumber ?? 'N/A'}`);
            lines.push(`     Pref Order : ${r.preferenceOrder ?? 'N/A'}`);
            lines.push(`     Members    : ${r.memberIds?.join(', ') ?? 'N/A'}`);
        } else {
            lines.push(`     Reason     : ${r.reason ?? 'N/A'}`);
            if (r.errorCode) lines.push(`     Error Code : ${r.errorCode}`);
        }

        lines.push('');
    }

    lines.push(sep);
    lines.push(`END OF LOG`);
    lines.push(sep);

    return lines.join('\n');
}
