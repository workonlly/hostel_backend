/**
 * rolloverEvaluator.js — Rollover Eligibility Engine
 * ============================================================
 * Determines which groups failed allocation in the current
 * batch and should be carried forward to the next batch.
 *
 * Rollover rules:
 *   ELIGIBLE:   submitted at least once + allocation_result = 'FAILED'
 *   INELIGIBLE: already ALLOCATED, PENALIZED, or SHATTERED
 *
 * INVARIANTS:
 *   1. Never rollover an already-allocated group.
 *   2. No duplicate rollovers (idempotent — checks batch_id).
 *   3. Next batch must exist before migrating groups.
 * ============================================================
 */

import { withTransaction } from './locking.js';
import { logRollover, logRolloverSkipped } from './allocationLogger.js';
import pool from '../../db/pool.js';

// ─────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────

/**
 * Evaluate rollover eligibility after a batch ends.
 *
 * @param {string} batchId  UUID of the completed batch
 * @returns {Promise<{ rolledOver: number, skipped: number, nextBatchId: string|null }>}
 */
export async function evaluate(batchId) {
    // 1. Find the next PENDING batch for the same event
    const batchRes = await pool.query(
        `SELECT allocation_event_id, batch_number FROM batch WHERE id = $1`,
        [batchId]
    );
    if (batchRes.rowCount === 0) throw new Error(`Batch ${batchId} not found`);

    const { allocation_event_id, batch_number } = batchRes.rows[0];

    const nextBatchRes = await pool.query(
        `SELECT id FROM batch
         WHERE allocation_event_id = $1
           AND batch_number > $2
           AND status = 'PENDING'
         ORDER BY batch_number ASC
         LIMIT 1`,
        [allocation_event_id, batch_number]
    );
    const nextBatchId = nextBatchRes.rows[0]?.id ?? null;

    // 2. Find groups that submitted but failed in this batch
    const failedRes = await pool.query(
        `SELECT DISTINCT hg.id, hg.status, hg.rollover_count
         FROM allocation_submission asb
         JOIN housing_group hg ON asb.group_id = hg.id
         WHERE asb.batch_id = $1
           AND asb.allocation_result = 'FAILED'
           AND hg.status NOT IN ('ALLOCATED', 'SHATTERED', 'PENALIZED')`,
        [batchId]
    );

    let rolledOver = 0;
    let skipped = 0;

    for (const group of failedRes.rows) {
        if (!nextBatchId) {
            // No next batch — cannot rollover
            await logRolloverSkipped({ batchId, groupId: group.id, reason: 'No next batch available' });
            skipped++;
            continue;
        }

        // Check not already migrated to next batch (duplicate guard)
        // We compare the group's current batch_id, not submissions.
        if (group.id) {
            const currentBatchRes = await pool.query(
                `SELECT batch_id FROM housing_group WHERE id = $1`,
                [group.id]
            );
            const currentBatchId = currentBatchRes.rows[0]?.batch_id;
            if (currentBatchId === nextBatchId) {
                await logRolloverSkipped({ batchId, groupId: group.id, reason: 'Already migrated to next batch' });
                skipped++;
                continue;
            }
        }

        // Migrate group to next batch, increment rollover counter
        await withTransaction(async (client) => {
            await client.query(
                `UPDATE housing_group
                 SET batch_id           = $1,
                     rollover_count     = rollover_count + 1,
                     is_rollover_priority = true
                 WHERE id = $2`,
                [nextBatchId, group.id]
            );
            await logRollover({ batchId, groupId: group.id, nextBatchId, client });
        });

        rolledOver++;
    }

    return { rolledOver, skipped, nextBatchId };
}
