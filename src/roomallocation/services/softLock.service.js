/**
 * softLock.service.js — Soft Lock Batch Assignment
 * ============================================================
 * Triggered when the system transitions LOBBY → SOFT_LOCK for
 * an allocation_event.
 *
 * NEW ARCHITECTURE (year-based):
 *   assignGroupsToBatches(eventId) — event-scoped, not hostel-scoped.
 *
 * What it does:
 *   1. Fetches all FORMING groups assigned to this allocation event
 *   2. Joins to get each group's leader individual_rank
 *   3. Sorts groups by leader rank ASC (lower rank = higher CGPA priority)
 *   4. Assigns groups to PENDING batches in chunks of BATCH_SIZE (50)
 *   5. Sets housing_group.status = 'SOFT_LOCKED' and housing_group.batch_id
 *
 * Preconditions:
 *   - Batches must already exist (via softLock auto-creation or admin pre-creation).
 *   - Groups must be in FORMING status and have allocation_event_id = eventId.
 *
 * INVARIANTS:
 *   1. Idempotent — a group already SOFT_LOCKED is skipped.
 *   2. Transaction-safe — each batch assignment is atomic.
 *   3. Groups with no leader rank go last (NULLS LAST).
 * ============================================================
 */

import pool from '../../db/pool.js';
import ApiError from '../../utils/apiError.js';
import { BATCH_SIZE, BATCH_DURATION_MS, TEST_MODE } from '../constants/testConfig.js';
import { logBatchAssignment } from '../engine/allocationLogger.js';

/**
 * Assign all FORMING groups for an allocation event to PENDING batches,
 * sorted by leader CGPA rank, in chunks of BATCH_SIZE.
 *
 * @param {string} eventId — UUID of allocation_event
 * @returns {Promise<{ assigned: number, unassigned: number, batches: number }>}
 */
export async function assignGroupsToBatches(eventId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch all FORMING groups for this event, ordered by leader rank
        const groupsRes = await client.query(
            `SELECT hg.id, leader.individual_rank AS leader_rank
             FROM housing_group hg
             JOIN student leader ON leader.id = hg.primary_applicant_id
             WHERE hg.status = 'FORMING'
               AND hg.allocation_event_id = $1
             ORDER BY leader.individual_rank ASC NULLS LAST`,
            [eventId]
        );

        const groups = groupsRes.rows;
        if (groups.length === 0) {
            await client.query('ROLLBACK');
            return { assigned: 0, unassigned: 0, batches: 0 };
        }

        // 2. Fetch PENDING batches for this event, ordered by batch_number ASC
        const batchesRes = await client.query(
            `SELECT id, batch_number FROM batch
             WHERE allocation_event_id = $1 AND status = 'PENDING'
             ORDER BY batch_number ASC`,
            [eventId]
        );

        const batches = batchesRes.rows;
        if (batches.length === 0) {
            // Auto-create batches if none exist
            const numBatches = Math.max(1, Math.ceil(groups.length / BATCH_SIZE));
            console.log(`[softLock] Auto-creating ${numBatches} batches for event ${eventId}.`);

            const batchDurationMinutes = Math.floor(BATCH_DURATION_MS / 60000);
            const bufferMinutes = TEST_MODE ? 1 : 10;

            for (let i = 0; i < numBatches; i++) {
                const startOffset = bufferMinutes + (i * batchDurationMinutes);
                const endOffset   = startOffset + batchDurationMinutes;

                const newBatchRes = await client.query(
                    `INSERT INTO batch (allocation_event_id, batch_number, status, start_time, end_time)
                     VALUES ($1, $2, 'PENDING',
                             NOW() + ($3 || ' minutes')::interval,
                             NOW() + ($4 || ' minutes')::interval)
                     RETURNING id, batch_number`,
                    [eventId, i + 1, startOffset, endOffset]
                );
                batches.push(newBatchRes.rows[0]);
            }
        }

        let assigned   = 0;
        let unassigned = 0;
        let batchesUsed = 0;

        // 3. Assign groups in chunks of BATCH_SIZE to successive batches
        for (let i = 0; i < groups.length; i++) {
            const batchIndex = Math.floor(i / BATCH_SIZE);
            const batch      = batches[batchIndex];

            if (!batch) {
                unassigned++;
                console.warn(
                    `[softLock] Group ${groups[i].id} has no batch — ` +
                    `create more batches (need at least ${Math.ceil(groups.length / BATCH_SIZE)})`
                );
                continue;
            }

            await client.query(
                `UPDATE housing_group
                 SET status     = 'SOFT_LOCKED',
                     batch_id   = $1,
                     group_rank = $3
                 WHERE id = $2
                   AND status = 'FORMING'`,
                [batch.id, groups[i].id, i + 1]
            );

            assigned++;
            batchesUsed = Math.max(batchesUsed, batchIndex + 1);
        }

        await client.query('COMMIT');

        // Audit log
        await logBatchAssignment({ eventId, assigned, unassigned, batches: batchesUsed });

        console.log(
            `[softLock] Soft-locked ${assigned} groups into ${batchesUsed} batches ` +
            `(${unassigned} groups had no batch available)`
        );

        return { assigned, unassigned, batches: batchesUsed };

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Soft lock batch assignment failed: ' + error.message);
    } finally {
        client.release();
    }
}
