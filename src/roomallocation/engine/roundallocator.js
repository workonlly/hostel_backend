/**
 * roundAllocator.js — THE ALLOCATION ENGINE
 * ============================================================
 * This is the most critical file in the project.
 *
 * Performs:
 *   - Preference processing (in group-rank order)
 *   - Room locking (deterministic, deadlock-safe)
 *   - Room assignment (room_assignment INSERT)
 *   - Occupancy updates (via DB trigger)
 *   - Submission state updates (is_processed, allocation_result)
 *   - Student state updates (is_allotted, allocated_room_id)
 *
 * INVARIANTS — never violated:
 *   1. Every assignment is inside a transaction.
 *   2. Room rows are locked BEFORE occupancy is read.
 *   3. Rooms are locked in sorted UUID order.
 *   4. current_occupancy + group_size <= max_capacity is
 *      re-verified INSIDE the transaction after locking.
 *   5. Submissions are processed in effective_group_rank ASC.
 *   6. A group is NEVER double-allocated.
 *
 * Owned by: engine layer.
 * Called by: allocationService.executeBatchRound().
 * ============================================================
 */

import pool from '../../db/pool.js';
import { withTransaction, lockRoomsInOrder, lockGroup, lockStudents } from './locking.js';
import { selectPreferredRoom } from './roomSelector.js';
import {
    logAllocationSuccess,
    logAllocationFailure,
    logEvent,
} from './allocationLogger.js';
import { printAllocationProgress } from '../utils/allocationOutputWriter.js';

// ─────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────

/**
 * Process one allocation round for a batch.
 * Called by allocationService after fetching active submissions.
 *
 * @param {{
 *   batchId: string,
 *   roundNumber: number,
 *   submissions: Array<{
 *     id: string,
 *     group_id: string,
 *     submitted_by: number,
 *     effective_group_rank: number,
 *     effective_group_size: number,
 *     preferences: Array<{ room_id: string, preference_order: number }>
 *   }>
 * }} params
 *
 * @returns {Promise<{
 *   batchId: string,
 *   roundNumber: number,
 *   processed: number,
 *   allocated: number,
 *   failed: number,
 *   results: object[]
 * }>}
 */
export async function processRound({ batchId, roundNumber, submissions }) {
    if (!submissions || submissions.length === 0) {
        return { batchId, roundNumber, processed: 0, allocated: 0, failed: 0, results: [] };
    }

    // CRITICAL: sort by effective_group_rank ASC (lower = higher priority)
    // This is the fairness guarantee of the entire system.
    const sorted = [...submissions].sort(
        (a, b) => a.effective_group_rank - b.effective_group_rank
    );

    const results = [];
    let allocated = 0;
    let failed = 0;
    const total = sorted.length;

    for (const submission of sorted) {
        const result = await _processSubmission({ batchId, roundNumber, submission });
        results.push(result);

        if (result.success) allocated++;
        else failed++;

        // ── Terminal progress (dev-only) ──────────────────
        printAllocationProgress({
            allocated,
            total,
            groupId: result.groupId ?? submission.group_id,
            roomNumber: result.roomNumber ?? null,
            success: result.success && !result.skipped,
        });
    }

    await logEvent('ROUND_COMPLETE', { batchId, roundNumber, allocated, failed });

    return { batchId, roundNumber, processed: sorted.length, allocated, failed, results };
}

// ─────────────────────────────────────────────────────────
// PER-SUBMISSION PROCESSOR
// ─────────────────────────────────────────────────────────

/**
 * Allocate a single submission inside its own transaction.
 * Each submission is isolated — one failure doesn't block others.
 */
async function _processSubmission({ batchId, roundNumber, submission }) {
    const { id: submissionId, group_id, effective_group_size } = submission;

    // Skip already-processed submissions (idempotency guard)
    const alreadyDone = await pool.query(
        `SELECT is_processed, allocation_result FROM allocation_submission WHERE id = $1`,
        [submissionId]
    );
    if (alreadyDone.rows[0]?.is_processed) {
        return {
            submissionId,
            success: alreadyDone.rows[0].allocation_result === 'ALLOCATED',
            skipped: true,
            reason: 'Already processed',
        };
    }

    if (!submission.preferences || submission.preferences.length === 0) {
        await _markSubmission(submissionId, 'FAILED');
        return { submissionId, success: false, reason: 'No preferences submitted' };
    }

    // Collect all room IDs from this submission's preferences
    const preferenceRoomIds = submission.preferences.map(p => p.room_id);

    try {
        const result = await withTransaction(async (client) => {
            // ── 1. Lock the group row ──────────────────────────
            const group = await lockGroup(client, group_id);
            if (!group) {
                throw Object.assign(new Error('Group not found'), { code: 'GROUP_MISSING' });
            }
            if (group.status === 'ALLOCATED' || group.status === 'SHATTERED' || group.status === 'PENALIZED') {
                throw Object.assign(
                    new Error(`Group is ${group.status} — cannot allocate`),
                    { code: 'GROUP_INELIGIBLE' }
                );
            }

            // ── 2. Fetch group members ─────────────────────────
            const membersRes = await client.query(
                `SELECT id FROM student WHERE group_id = $1 ORDER BY id ASC`,
                [group_id]
            );
            const memberIds = membersRes.rows.map(r => r.id);
            const actualGroupSize = memberIds.length;

            if (actualGroupSize === 0) {
                throw Object.assign(new Error('Group has no members'), { code: 'GROUP_EMPTY' });
            }

            // Lock students in sorted order
            await lockStudents(client, memberIds);

            // ── 3. Lock all preference rooms in sorted order ───
            const lockedRooms = await lockRoomsInOrder(client, preferenceRoomIds);

            // ── 4. Select best fitting room ────────────────────
            const selection = selectPreferredRoom(
                submission.preferences,
                lockedRooms,
                actualGroupSize
            );

            if (!selection) {
                // Mark as FAILED — eligible for rollover evaluation
                await client.query(
                    `UPDATE allocation_submission
                     SET is_processed = true, allocation_result = 'FAILED'
                     WHERE id = $1`,
                    [submissionId]
                );
                await logAllocationFailure({
                    batchId, roundNumber, groupId: group_id,
                    reason: 'No eligible room found',
                    triedRooms: preferenceRoomIds,
                    client,
                });
                return { submissionId, success: false, reason: 'No eligible room found' };
            }

            const { room } = selection;

            // ── 5. FINAL occupancy guard (inside lock) ─────────
            // Re-check after acquiring the lock — never trust pre-lock reads
            if (room.current_occupancy + actualGroupSize > room.max_capacity) {
                // Race: room filled between preference submission and now
                await client.query(
                    `UPDATE allocation_submission
                     SET is_processed = true, allocation_result = 'FAILED'
                     WHERE id = $1`,
                    [submissionId]
                );
                return { submissionId, success: false, reason: 'Room filled during allocation (race)' };
            }

            // ── 6. Create room_assignment for all members ─────
            for (const studentId of memberIds) {
                await client.query(
                    `INSERT INTO room_assignment
                        (room_id, student_id, assigned_by, assignment_status)
                     VALUES ($1, $2, 'ALGORITHM', 'UPCOMING')`,
                    [room.id, studentId]
                );
            }
            // Note: current_occupancy is updated automatically by
            // trigger_update_room_occupancy after the INSERT above.

            // ── 7. Update student records ──────────────────────
            await client.query(
                `UPDATE student
                 SET is_allotted = true,
                     allocated_room_id = $1
                 WHERE id = ANY($2::int[])`,
                [room.id, memberIds]
            );

            // ── 8. Update group status ─────────────────────────
            await client.query(
                `UPDATE housing_group
                 SET status = 'ALLOCATED'
                 WHERE id = $1`,
                [group_id]
            );

            // ── 9. Mark submission as processed ───────────────
            await client.query(
                `UPDATE allocation_submission
                 SET is_processed = true,
                     allocation_result = 'ALLOCATED'
                 WHERE id = $1`,
                [submissionId]
            );

            await logAllocationSuccess({
                batchId, roundNumber, groupId: group_id,
                roomId: room.id, studentIds: memberIds,
                client,
            });

            return {
                submissionId,
                success: true,
                groupId: group_id,
                roomId: room.id,
                roomNumber: room.room_number ?? null,
                memberIds,
                preferenceOrder: selection.preferenceOrder,
            };
        });

        return result;

    } catch (err) {
        // Non-retryable errors (group ineligible, missing, etc.)
        const knownCode = err.code;
        const reason = err.message;

        // Try to mark submission as failed (best-effort, new transaction)
        await _markSubmission(submissionId, 'FAILED').catch(() => {});

        await logAllocationFailure({ batchId, roundNumber, groupId: group_id, reason }).catch(() => {});

        return {
            submissionId,
            success: false,
            reason,
            errorCode: knownCode ?? 'UNKNOWN',
        };
    }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Mark a submission with the given allocation_result.
 * Used for out-of-transaction fallback updates.
 */
async function _markSubmission(submissionId, allocationResult) {
    await pool.query(
        `UPDATE allocation_submission
         SET is_processed = true, allocation_result = $1
         WHERE id = $2 AND is_processed = false`,
        [allocationResult, submissionId]
    );
}

// Named export for allocationService import compatibility
export const roundAllocator = { processRound };
