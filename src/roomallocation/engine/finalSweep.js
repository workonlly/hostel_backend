/**
 * finalSweep.js — Forced Final Allocation Pass
 * ============================================================
 * After all batches complete, some students may still be
 * unallocated. This engine force-assigns them to any
 * remaining available beds, one student at a time.
 *
 * Strategy:
 *   - Collect all unallocated students (is_allotted = false)
 *   - Sort remaining rooms by remaining beds ASC (fill tightest first)
 *   - Assign each student to best available room
 *   - Each assignment is its own transaction (fragmented capacity
 *     means rooms fill at different rates)
 *
 * INVARIANTS:
 *   1. Never over-allocate (occupancy + 1 <= capacity enforced).
 *   2. Each assignment is transaction-safe.
 *   3. Skips students who become allocated mid-sweep (idempotent).
 *   4. Handles fragmented capacity (1 bed here, 2 beds there).
 * ============================================================
 */

import { withTransaction, lockRoom } from './locking.js';
import { sortRoomsByFill, getRemainingBeds } from './roomSelector.js';
import { logFinalSweepAssignment, logFinalSweepSkipped } from './allocationLogger.js';
import pool from '../../db/pool.js';

// ─────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────

/**
 * Run the final allocation sweep for a hostel.
 * Called by evaluationScheduler after all batches complete.
 *
 * @param {string} hostelId  UUID
 * @returns {Promise<{ assigned: number, skipped: number, unplaced: number }>}
 */
export async function execute(hostelId) {
    // 1. Fetch all unallocated students from THIS source hostel
    //    (students whose is_allotted = false and whose hostel_id = hostelId)
    const studentsRes = await pool.query(
        `SELECT s.id, s.name, s.roll_no, s.individual_rank
         FROM student s
         WHERE s.is_allotted = false
           AND s.hostel_id = $1
         ORDER BY s.individual_rank ASC NULLS LAST, s.id ASC`,
        [hostelId]
    );

    // Also include shattered / penalized orphan students from this hostel
    // (group_id IS NULL but still attached to this hostel)
    const orphanRes = await pool.query(
        `SELECT s.id, s.name, s.roll_no, s.individual_rank
         FROM student s
         WHERE s.is_allotted = false
           AND s.group_id IS NULL
           AND s.physical_room_id IS NULL
           AND s.hostel_id = $1
         ORDER BY s.individual_rank ASC NULLS LAST, s.id ASC`,
        [hostelId]
    );

    // Merge, deduplicate by id
    const allStudents = _deduplicateById([...studentsRes.rows, ...orphanRes.rows]);

    if (allStudents.length === 0) {
        return { assigned: 0, skipped: 0, unplaced: 0 };
    }

    // Check if a room pool is configured for this hostel
    const poolCountRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM allocation_room_pool WHERE source_hostel_id = $1`,
        [hostelId]
    );
    const hasPool = parseInt(poolCountRes.rows[0].cnt, 10) > 0;

    let assigned = 0;
    let skipped = 0;
    let unplaced = 0;

    for (const student of allStudents) {
        const outcome = await _assignStudentToRoom(student, hostelId, hasPool);

        if (outcome === 'ASSIGNED') assigned++;
        else if (outcome === 'SKIPPED') skipped++;
        else unplaced++;
    }

    return { assigned, skipped, unplaced };
}

// ─────────────────────────────────────────────────────────
// PER-STUDENT ASSIGNMENT
// ─────────────────────────────────────────────────────────

/**
 * Attempt to assign a single student to the best available room.
 * Each attempt is its own transaction.
 *
 * @returns {'ASSIGNED'|'SKIPPED'|'UNPLACED'}
 */
async function _assignStudentToRoom(student, hostelId, hasPool) {
    // Idempotency: re-check if already assigned
    const freshCheck = await pool.query(
        `SELECT is_allotted FROM student WHERE id = $1`,
        [student.id]
    );
    if (freshCheck.rows[0]?.is_allotted) {
        return 'SKIPPED';
    }

    // Fetch available rooms from the pool (includes half-filled rooms).
    // Sort tightest-first (fewest remaining beds) to minimise waste.
    let roomsRes;
    if (hasPool) {
        // Pool-aware: only rooms in the configured allocation pool
        roomsRes = await pool.query(
            `SELECT r.id, r.max_capacity, r.current_occupancy
             FROM room r
             JOIN allocation_room_pool arp ON arp.room_id = r.id
             WHERE arp.source_hostel_id = $1
               AND r.current_occupancy < r.max_capacity
             ORDER BY (r.max_capacity - r.current_occupancy) ASC, r.id ASC`,
            [hostelId]
        );
    } else {
        // Legacy fallback: all available rooms in the target hostel
        roomsRes = await pool.query(
            `SELECT id, max_capacity, current_occupancy
             FROM room
             WHERE hostel_id = $1
               AND current_occupancy < max_capacity
             ORDER BY (max_capacity - current_occupancy) ASC, id ASC`,
            [hostelId]
        );
    }

    if (roomsRes.rowCount === 0) {
        await logFinalSweepSkipped({ hostelId, studentId: student.id, reason: 'No available rooms' });
        return 'UNPLACED';
    }

    // Try each room in order until one succeeds
    const sortedRooms = sortRoomsByFill(roomsRes.rows);

    for (const candidate of sortedRooms) {
        try {
            const success = await withTransaction(async (client) => {
                // Re-lock and re-read — inventory changes between iterations
                const room = await lockRoom(client, candidate.id);
                if (!room) return false;

                if (getRemainingBeds(room) < 1) return false; // filled since last check

                // Re-verify student not assigned (race guard)
                const studentCheck = await client.query(
                    `SELECT is_allotted FROM student WHERE id = $1 FOR UPDATE`,
                    [student.id]
                );
                if (studentCheck.rows[0]?.is_allotted) return false;

                // Insert assignment
                await client.query(
                    `INSERT INTO room_assignment
                        (room_id, student_id, assigned_by, assignment_status)
                     VALUES ($1, $2, 'FINAL_SWEEP', 'UPCOMING')`,
                    [room.id, student.id]
                );
                // Trigger recalculates current_occupancy automatically

                // Update student record
                await client.query(
                    `UPDATE student
                     SET is_allotted = true, allocated_room_id = $1
                     WHERE id = $2`,
                    [room.id, student.id]
                );

                await logFinalSweepAssignment({ hostelId, studentId: student.id, roomId: room.id, client });
                return true;
            });

            if (success) return 'ASSIGNED';
        } catch (err) {
            // This room failed (race/deadlock) — try next candidate
            console.warn(`[finalSweep] Room ${candidate.id} failed for student ${student.id}: ${err.message}`);
        }
    }

    await logFinalSweepSkipped({ hostelId, studentId: student.id, reason: 'All room attempts failed' });
    return 'UNPLACED';
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

function _deduplicateById(students) {
    const seen = new Set();
    return students.filter(s => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
    });
}
