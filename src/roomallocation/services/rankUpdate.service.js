/**
 * rankUpdate.service.js
 * ============================================================
 * Bulk update student rank (individual_rank) and CGPA from a
 * CSV/XLSX upload on the /allocation/admin page.
 *
 * Unlike the first-year bulk insert, this is an UPDATE-only
 * operation that matches students by roll_no and overwrites
 * their current individual_rank and cgpa values.
 *
 * Required columns (auto-detected via fieldMapper aliases):
 *   - roll_no        (roll number / registration number / …)
 *   - individual_rank (rank / serial number / S.No. / …)
 *   - cgpa           (cgpa / gpa / marks / …)
 *
 * Optional column:
 *   - name           (used only for preview cross-check)
 * ============================================================
 */

import pool from '../../db/pool.js';
import ApiError from '../../utils/apiError.js';
import { logRankImport } from '../engine/allocationLogger.js';
import { parseFile } from '../../imports/fileParser.js';
import { detectMappings } from '../../imports/fieldMapper.js';
import path from 'path';

// ─────────────────────────────────────────────────────────
// PARSE & MAP
// ─────────────────────────────────────────────────────────

/**
 * Parse the uploaded file and auto-detect column mappings.
 * Returns a preview for the admin to confirm.
 */
export const previewRankUpdate = async (filePath, filename) => {
    const { headers, rows } = await parseFile(filePath, filename);

    if (!headers || headers.length === 0) {
        throw new ApiError(400, 'File does not contain headers');
    }

    const { detectedMappings, unmappedColumns } = detectMappings(headers);

    // We do NOT throw an error here if required columns are missing.
    // Instead, we let the frontend's manual mapper handle it.

    return {
        fileId: filename,
        headers,
        rowCount: rows.length,
        detectedMappings,
        unmappedColumns,
        rawRows: rows.slice(0, 10),
    };
};

// ─────────────────────────────────────────────────────────
// EXECUTE UPDATE
// ─────────────────────────────────────────────────────────

/**
 * Apply rank + CGPA updates to all matched students.
 *
 * @param {string} fileId       - filename saved in uploads/temp/
 * @param {object} mappings     - { roll_no: 'ColA', individual_rank: 'ColB', cgpa: 'ColC' }
 * @returns {{ updated, skipped, notFound, details }}
 */
export const executeRankUpdate = async (fileId, mappings) => {
    if (!mappings.roll_no || !mappings.individual_rank) {
        throw new ApiError(400, 'mappings must include roll_no and individual_rank');
    }

    const filePath = path.join(process.cwd(), 'uploads', 'temp', fileId);
    let parseResult;
    try {
        parseResult = await parseFile(filePath, fileId);
    } catch {
        throw new ApiError(400, 'Temporary file not found or could not be parsed. Please re-upload.');
    }

    const { rows } = parseResult;
    if (rows.length === 0) throw new ApiError(400, 'File has no data rows');

    // Transform rows using provided mappings
    const records = rows.map((row, i) => ({
        _row: i + 2, // 1-based + header row
        roll_no:         String(row[mappings.roll_no] ?? '').trim(),
        individual_rank: parseInt(String(row[mappings.individual_rank] ?? '').trim(), 10),
        cgpa:            mappings.cgpa ? parseFloat(String(row[mappings.cgpa] ?? '').trim()) : null,
        name:            mappings.name ? String(row[mappings.name] ?? '').trim() : null,
    })).filter(r => r.roll_no); // skip empty roll_no rows

    if (records.length === 0) throw new ApiError(400, 'No valid rows found after filtering');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let updated = 0;
        let skipped = 0;
        const notFound = [];
        const details = [];

        for (const rec of records) {
            if (isNaN(rec.individual_rank) || rec.individual_rank < 1) {
                skipped++;
                details.push({ roll_no: rec.roll_no, status: 'skipped', reason: 'Invalid rank value' });
                continue;
            }

            // Build dynamic UPDATE
            const setClauses = ['individual_rank = $1'];
            const params = [rec.individual_rank];

            if (rec.cgpa !== null && !isNaN(rec.cgpa)) {
                setClauses.push(`cgpa = $${params.length + 1}`);
                params.push(rec.cgpa);
            }

            params.push(rec.roll_no); // always last param for WHERE
            const res = await client.query(
                `UPDATE student
                 SET ${setClauses.join(', ')}
                 WHERE roll_no = $${params.length}
                 RETURNING id, roll_no, individual_rank, cgpa`,
                params
            );

            if (res.rowCount === 0) {
                notFound.push(rec.roll_no);
                details.push({ roll_no: rec.roll_no, status: 'not_found' });
            } else {
                updated++;
                details.push({
                    roll_no: rec.roll_no,
                    individual_rank: res.rows[0].individual_rank,
                    cgpa: res.rows[0].cgpa,
                    status: 'updated',
                });
            }
        }

        await client.query('COMMIT');

        // Audit log
        await logRankImport({ updated, skipped, total: records.length });

        return { updated, skipped, notFound, total: records.length, details };

    } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Rank update failed: ' + error.message);
    } finally {
        client.release();
    }
};
