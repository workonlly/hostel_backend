import pool from '../../db/pool.js';
import { roundAllocator }       from '../engine/roundallocator.js';
import { evaluate as evaluateRollovers } from '../engine/rolloverEvaluator.js';
import { execute as executeGhostPenalty } from '../engine/ghostPenalty.js';
import { evaluate as evaluateShatter }  from '../engine/shatterProtocol.js';
import { execute as executeFinalSweep } from '../engine/finalSweep.js';

const GROUP_STATUS = {
    FORMING: 'FORMING',
    SOFT_LOCKED: 'SOFT_LOCKED',
    HARD_LOCKED: 'HARD_LOCKED',
    ALLOCATED: 'ALLOCATED',
    SHATTERED: 'SHATTERED',
    PENALIZED: 'PENALIZED'
};

const SYSTEM_PHASES = {
    LIVE_BATCHES: 'LIVE_BATCHES'
};

const rolloverEvaluator  = { evaluate: evaluateRollovers };
const ghostPenalty       = { execute:  executeGhostPenalty };
const shatterProtocol    = { evaluate: (groupId) => evaluateShatter(groupId) };
const finalSweep         = { execute:  executeFinalSweep };


class AllocationService {

    // =====================================================
    // 1. SUBMIT PREFERENCES
    // =====================================================

    async submitPreferences({
        groupId,
        submittedBy,
        hostelId,
        batchNumber,
        roundNumber,
        preferences,
    }) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // ---------------------------------------------
            // LOCK the group row — prevents concurrent
            // leader changes, shatters, and dissolves
            // ---------------------------------------------
            const groupRes = await client.query(`
                SELECT hg.*,
                       (SELECT COUNT(*) FROM student s WHERE s.group_id = hg.id) as group_size
                FROM housing_group hg
                WHERE hg.id = $1
                FOR UPDATE
            `, [groupId]);

            if (groupRes.rowCount === 0) {
                throw new Error('Group not found');
            }

            const group = groupRes.rows[0];

            // Verify submitter belongs to this group
            const memberRes = await client.query(
                'SELECT 1 FROM student WHERE id = $1 AND group_id = $2',
                [submittedBy, groupId]
            );
            if (memberRes.rowCount === 0) {
                throw new Error('Submitter is not a member of this group');
            }

            // ---------------------------------------------
            // Validate group status
            // ---------------------------------------------
            if (
                group.status !== GROUP_STATUS.SOFT_LOCKED &&
                group.status !== GROUP_STATUS.HARD_LOCKED
            ) {
                throw new Error('Group is not eligible for allocation');
            }

            // ---------------------------------------------
            // Validate batch — must exist AND status = ACTIVE
            // ---------------------------------------------
            const batchRes = await client.query(
                'SELECT id, hostel_id, start_time, end_time, status FROM batch WHERE hostel_id = $1 AND batch_number = $2',
                [hostelId, batchNumber]
            );
            if (batchRes.rowCount === 0) {
                throw new Error('Batch not found');
            }

            const batch = batchRes.rows[0];
            const resolvedBatchId = batch.id;
            const now = new Date();

            if (batch.status !== 'ACTIVE') {
                throw new Error(`Batch is not active (current status: ${batch.status})`);
            }

            if (now < new Date(batch.start_time) || now > new Date(batch.end_time)) {
                throw new Error('Submission is outside the allowed batch time window');
            }

            // ---------------------------------------------
            // Validate preference list
            // ---------------------------------------------
            if (!Array.isArray(preferences) || preferences.length === 0) {
                throw new Error('At least one preference is required');
            }

            // Detect duplicate room IDs in the submitted list
            const uniqueRoomIds = new Set(preferences);
            if (uniqueRoomIds.size !== preferences.length) {
                throw new Error('Preference list contains duplicate room IDs');
            }

            // ─── Pool-aware validation ───────────────────────────────────────
            // Validate all submitted room IDs exist in the allocation pool
            // for this source hostel. The pool may span multiple TO hostels.
            const roomCheckRes = await client.query(
                `SELECT r.id
                 FROM room r
                 JOIN allocation_room_pool arp ON arp.room_id = r.id
                 WHERE r.id = ANY($1::uuid[])
                   AND arp.source_hostel_id = $2`,
                [preferences, batch.hostel_id]
            );
            if (roomCheckRes.rowCount !== preferences.length) {
                const foundIds = new Set(roomCheckRes.rows.map(r => r.id));
                const invalid = preferences.filter(id => !foundIds.has(id));
                throw new Error(`Invalid or non-existent room IDs (not in allocation pool): ${invalid.join(', ')}`);
            }

            // Count available rooms in the pool for this source hostel
            const availableRoomsRes = await client.query(
                `SELECT COUNT(*) as cnt
                 FROM room r
                 JOIN allocation_room_pool arp ON arp.room_id = r.id
                 WHERE arp.source_hostel_id = $1
                   AND r.current_occupancy < r.max_capacity`,
                [batch.hostel_id]
            );
            const availableCount = parseInt(availableRoomsRes.rows[0].cnt, 10);
            const maxPreferences = Math.min(availableCount, 10);

            if (availableCount >= 10 && preferences.length !== 10) {
                throw new Error('Exactly 10 preferences required when 10 or more rooms are available');
            }
            if (preferences.length > maxPreferences) {
                throw new Error(`Cannot submit more preferences than available rooms (${availableCount})`);
            }



            // ---------------------------------------------
            // Get effective leader rank (always from the group's primary applicant)
            // ---------------------------------------------
            const leaderRes = await client.query(
                'SELECT individual_rank FROM student WHERE id = $1',
                [group.primary_applicant_id]
            );
            const effectiveLeaderRank = leaderRes.rows[0]?.individual_rank;

            // ---------------------------------------------
            // Create submission
            // ---------------------------------------------
            const insertSubRes = await client.query(`
                INSERT INTO allocation_submission (
                    group_id, submitted_by, batch_id, round_number,
                    effective_group_rank, effective_leader_rank, effective_group_size
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (group_id, batch_id, round_number) DO NOTHING
                RETURNING id
            `, [
                groupId,
                submittedBy,
                resolvedBatchId,
                roundNumber,
                group.group_rank,
                effectiveLeaderRank,
                group.group_size
            ]);

            // First-submission-wins: if another member already submitted, return metadata
            if (insertSubRes.rowCount === 0) {
                const existingRes = await client.query(
                    `SELECT asb.id, asb.submitted_by, asb.submitted_at, s.name as submitted_by_name
                     FROM allocation_submission asb
                     JOIN student s ON s.id = asb.submitted_by
                     WHERE asb.group_id = $1 AND asb.batch_id = $2 AND asb.round_number = $3`,
                    [groupId, resolvedBatchId, roundNumber]
                );
                const existing = existingRes.rows[0];
                await client.query('ROLLBACK');
                return {
                    success: true,
                    alreadySubmitted: true,
                    submissionId:  existing?.id ?? null,
                    submittedBy:   existing?.submitted_by_name ?? null,
                    submittedAt:   existing?.submitted_at ?? null,
                };
            }

            const submissionId = insertSubRes.rows[0].id;

            // ---------------------------------------------
            // Insert preferences
            // Sorted by room_id (ASC) for deterministic lock ordering
            // to eliminate deadlock risk when submissions overlap.
            // preference_order retains the original user ranking.
            // ---------------------------------------------
            const sortedPreferences = [...preferences].sort(); // deterministic ORDER BY room_id
            const prefValues = [];
            let valueIndex = 1;
            const queryParams = [];

            for (const roomId of sortedPreferences) {
                const preference_order = preferences.indexOf(roomId) + 1; // original user order
                prefValues.push(`($${valueIndex}, $${valueIndex + 1}, $${valueIndex + 2})`);
                queryParams.push(submissionId, roomId, preference_order);
                valueIndex += 3;
            }

            const insertPrefQuery = `
                INSERT INTO submission_preference (submission_id, room_id, preference_order)
                VALUES ${prefValues.join(', ')}
            `;

            await client.query(insertPrefQuery, queryParams);

            await client.query('COMMIT');
            return {
                success: true,
                submissionId: submissionId,
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // =====================================================
    // 2. EXECUTE ROUND
    // =====================================================

    async executeBatchRound(batchId, roundNumber) {
        // Fetch active submissions, rollover groups first, then by rank within each tier
        const submissionsRes = await pool.query(`
            SELECT asb.*, hg.is_rollover_priority
            FROM allocation_submission asb
            JOIN housing_group hg ON hg.id = asb.group_id
            WHERE asb.batch_id = $1 AND asb.round_number = $2 AND asb.is_processed = false
            ORDER BY hg.is_rollover_priority DESC, asb.effective_group_rank ASC
        `, [batchId, roundNumber]);

        const submissions = submissionsRes.rows;

        if (submissions.length > 0) {
            // Fetch all preferences for these submissions
            const submissionIds = submissions.map(s => s.id);
            const prefRes = await pool.query(`
                SELECT * FROM submission_preference
                WHERE submission_id = ANY($1::uuid[])
                ORDER BY preference_order ASC
            `, [submissionIds]);

            // Group preferences by submission_id
            const prefsBySub = {};
            for (const pref of prefRes.rows) {
                if (!prefsBySub[pref.submission_id]) {
                    prefsBySub[pref.submission_id] = [];
                }
                prefsBySub[pref.submission_id].push(pref);
            }

            // Attach to submissions
            for (const sub of submissions) {
                sub.preferences = prefsBySub[sub.id] || [];
            }
        }

        // Execute allocator engine
        if (roundAllocator && typeof roundAllocator.processRound === 'function') {
            const result = await roundAllocator.processRound({
                batchId,
                roundNumber,
                submissions,
            });
            return result;
        } else {
            console.warn('roundAllocator.processRound is not fully implemented yet.');
            return { success: true, processedCount: submissions.length, message: "Engine stubbed" };
        }
    }

    // =====================================================
    // 3. LIVE ROOM MAP
    // =====================================================

    async getLiveRoomMap(hostelId, studentId = null) {
        let joiningYear = null;
        if (studentId) {
            const studentRes = await pool.query('SELECT joining_year FROM student WHERE id = $1', [studentId]);
            if (studentRes.rowCount > 0) {
                joiningYear = studentRes.rows[0].joining_year;
            }
        }

        // ── Pool-aware room lookup ─────────────────────────────────────────────
        // Check if there is an allocation_room_pool configured for this hostel.
        // If so, return exactly those rooms (across any number of TO hostels).
        // Falls back to target_hostel_id (legacy) if no pool rows exist,
        // and ultimately to the hostel's own rooms if neither is set.
        const poolCountRes = await pool.query(
            `SELECT COUNT(*) AS cnt FROM allocation_room_pool WHERE source_hostel_id = $1`,
            [hostelId]
        );
        const hasPool = parseInt(poolCountRes.rows[0].cnt, 10) > 0;

        let query, params;

        if (hasPool) {
            // New path: return rooms from the configured pool
            if (joiningYear) {
                query = `
                    SELECT r.id,
                           r.room_number,
                           r.max_capacity,
                           r.current_occupancy,
                           r.hostel_id,
                           h.name AS hostel_name,
                           (SELECT COUNT(*)::int
                            FROM room_assignment ra
                            JOIN student s ON s.id = ra.student_id
                            WHERE ra.room_id = r.id
                              AND ra.assignment_status = 'UPCOMING'
                              AND s.joining_year = $2
                           ) AS cohort_occupancy,
                           (r.max_capacity - r.current_occupancy) AS remaining_beds,
                           (r.current_occupancy < r.max_capacity)  AS available,
                           (
                               SELECT json_agg(json_build_object(
                                   'id', s.id, 'name', s.name,
                                   'roll_no', s.roll_no, 'branch', s.department
                               ))
                               FROM room_assignment ra
                               JOIN student s ON s.id = ra.student_id
                               WHERE ra.room_id = r.id
                                 AND ra.assignment_status IN ('ACTIVE','UPCOMING')
                           ) AS occupants
                    FROM room r
                    JOIN allocation_room_pool arp ON arp.room_id = r.id
                    JOIN hostel h ON h.id = r.hostel_id
                    WHERE arp.source_hostel_id = $1
                    ORDER BY h.name, r.room_number ASC
                `;
                params = [hostelId, joiningYear];
            } else {
                query = `
                    SELECT r.id,
                           r.room_number,
                           r.max_capacity,
                           r.current_occupancy,
                           r.hostel_id,
                           h.name AS hostel_name,
                           (r.max_capacity - r.current_occupancy) AS remaining_beds,
                           (r.current_occupancy < r.max_capacity)  AS available,
                           (
                               SELECT json_agg(json_build_object(
                                   'id', s.id, 'name', s.name,
                                   'roll_no', s.roll_no, 'branch', s.department
                               ))
                               FROM room_assignment ra
                               JOIN student s ON s.id = ra.student_id
                               WHERE ra.room_id = r.id
                                 AND ra.assignment_status IN ('ACTIVE','UPCOMING')
                           ) AS occupants
                    FROM room r
                    JOIN allocation_room_pool arp ON arp.room_id = r.id
                    JOIN hostel h ON h.id = r.hostel_id
                    WHERE arp.source_hostel_id = $1
                    ORDER BY h.name, r.room_number ASC
                `;
                params = [hostelId];
            }
        } else {
            // Legacy fallback: single target_hostel_id
            const targetRes = await pool.query(
                `SELECT COALESCE(target_hostel_id, id) AS room_hostel_id FROM hostel WHERE id = $1`,
                [hostelId]
            );
            const roomHostelId = targetRes.rows[0]?.room_hostel_id ?? hostelId;

            if (joiningYear) {
                query = `
                    SELECT r.id,
                           r.room_number,
                           r.max_capacity,
                           r.current_occupancy,
                           r.hostel_id,
                           h.name AS hostel_name,
                           (SELECT COUNT(*)::int FROM room_assignment ra JOIN student s ON s.id = ra.student_id WHERE ra.room_id = r.id AND ra.assignment_status = 'UPCOMING' AND s.joining_year = $2) as cohort_occupancy,
                           (r.max_capacity - r.current_occupancy) as remaining_beds,
                           (r.current_occupancy < r.max_capacity) as available,
                           (
                               SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'roll_no', s.roll_no, 'branch', s.department))
                               FROM room_assignment ra
                               JOIN student s ON s.id = ra.student_id
                               WHERE ra.room_id = r.id AND ra.assignment_status IN ('ACTIVE', 'UPCOMING')
                           ) as occupants
                    FROM room r
                    JOIN hostel h ON h.id = r.hostel_id
                    WHERE r.hostel_id = $1
                    ORDER BY r.room_number ASC
                `;
                params = [roomHostelId, joiningYear];
            } else {
                query = `
                    SELECT r.id,
                           r.room_number,
                           r.max_capacity,
                           r.current_occupancy,
                           r.hostel_id,
                           h.name AS hostel_name,
                           (r.max_capacity - r.current_occupancy) as remaining_beds,
                           (r.current_occupancy < r.max_capacity) as available,
                           (
                               SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'roll_no', s.roll_no, 'branch', s.department))
                               FROM room_assignment ra
                               JOIN student s ON s.id = ra.student_id
                               WHERE ra.room_id = r.id AND ra.assignment_status IN ('ACTIVE', 'UPCOMING')
                           ) as occupants
                    FROM room r
                    JOIN hostel h ON h.id = r.hostel_id
                    WHERE r.hostel_id = $1
                    ORDER BY r.room_number ASC
                `;
                params = [roomHostelId];
            }
        }

        const roomsRes = await pool.query(query, params);

        return roomsRes.rows.map(room => ({
            id:           room.id,
            roomNumber:   room.room_number,
            capacity:     room.max_capacity,
            occupancy:    room.current_occupancy,
            remainingBeds: room.remaining_beds,
            available:    room.available,
            hostelId:     room.hostel_id,
            hostelName:   room.hostel_name ?? null,
            occupants:    room.occupants || [],
        }));
    }

    // =====================================================
    // 4. GET ALLOCATION STATUS
    // =====================================================

    async getAllocationStatus(studentId) {
        // Full join to get all fields the frontend needs
        const studentRes = await pool.query(`
            SELECT 
                s.id, s.name, s.group_id, s.is_allotted, s.allocated_room_id,
                s.individual_rank, s.cgpa,
                hg.id                    AS hg_id,
                hg.status                AS group_status,
                hg.batch_id              AS group_batch_id,
                hg.group_rank,
                hg.is_rollover_priority,
                hg.primary_applicant_id,
                hg.rollover_count,
                b.batch_number,
                b.status                 AS batch_status,
                b.start_time             AS batch_start_time,
                b.end_time               AS batch_end_time,
                b.hostel_id              AS batch_hostel_id,
                h.id                     AS hostel_id,
                h.current_phase          AS hostel_phase,
                h.name                   AS hostel_name,
                h.is_paused,
                h.allocation_date,
                h.lobby_opens_at,
                r.room_number            AS allocated_room_number,
                r.room_type              AS allocated_room_type,
                r.max_capacity           AS allocated_room_capacity,
                h.target_hostel_id,
                th.name                  AS target_hostel_name
            FROM student s
            LEFT JOIN housing_group hg ON s.group_id = hg.id
            LEFT JOIN batch b ON hg.batch_id = b.id
            LEFT JOIN hostel h ON s.hostel_id = h.id
            LEFT JOIN hostel th ON th.id = h.target_hostel_id
            LEFT JOIN room r ON s.allocated_room_id = r.id
            WHERE s.id = $1
        `, [studentId]);

        if (studentRes.rowCount === 0) {
            const err = new Error('Student not found');
            err.statusCode = 404;
            throw err;
        }

        const student = studentRes.rows[0];

        // If student has no group→batch→hostel, try to find ANY hostel
        // (needed for ADMIN_MODE/pre-lobby state)
        let hostelId = student.hostel_id;
        let hostelPhase = student.hostel_phase;
        let hostelName = student.hostel_name;
        let isPaused = student.is_paused;
        let allocationDate = student.allocation_date;
        let lobbyOpensAt = student.lobby_opens_at;

        if (!hostelId) {
            const anyHostelRes = await pool.query(
                'SELECT id, name, current_phase, is_paused, allocation_date, lobby_opens_at FROM hostel LIMIT 1'
            );
            if (anyHostelRes.rowCount > 0) {
                const h = anyHostelRes.rows[0];
                hostelId = h.id;
                hostelPhase = h.current_phase;
                hostelName = h.name;
                isPaused = h.is_paused;
                allocationDate = h.allocation_date;
                lobbyOpensAt = h.lobby_opens_at;
            }
        }

        // Derive current round from batch timing
        let currentRound = null;
        if (student.batch_status === 'ACTIVE' && student.batch_start_time) {
            const now = new Date();
            const startTime = new Date(student.batch_start_time);
            const diffMs = now.getTime() - startTime.getTime();
            const ROUND_DURATION_MS = 10 * 60 * 1000; // 10 minutes
            const derivedRound = Math.floor(diffMs / ROUND_DURATION_MS) + 1;
            currentRound = Math.min(Math.max(derivedRound, 1), 6);
        }

        // Check if submitted this round
        let submittedThisRound = false;
        if (student.group_batch_id && currentRound) {
            const subRes = await pool.query(
                `SELECT 1 FROM allocation_submission
                 WHERE group_id = $1 AND batch_id = $2 AND round_number = $3
                 LIMIT 1`,
                [student.group_id, student.group_batch_id, currentRound]
            );
            submittedThisRound = subRes.rowCount > 0;
        }

        // Get roommates if allocated
        let roommates = [];
        if (student.is_allotted && student.allocated_room_id) {
            const roommatesRes = await pool.query(
                `SELECT s2.id, s2.name, s2.roll_no, s2.department, s2.cgpa
                 FROM student s2
                 WHERE s2.allocated_room_id = $1 AND s2.id != $2`,
                [student.allocated_room_id, studentId]
            );
            roommates = roommatesRes.rows;
        }

        // Get assignment info (how room was assigned)
        let assignedBy = null;
        if (student.is_allotted && student.allocated_room_id) {
            const assignRes = await pool.query(
                `SELECT assigned_by FROM room_assignment
                 WHERE student_id = $1 AND assignment_status IN ('UPCOMING', 'ACTIVE')
                 LIMIT 1`,
                [studentId]
            );
            if (assignRes.rowCount > 0) assignedBy = assignRes.rows[0].assigned_by;
        }

        return {
            student_id:             studentId,
            cgpa:                   student.cgpa ?? null,
            individual_rank:        student.individual_rank ?? null,
            // Phase info
            hostel_id:              hostelId,
            hostel_phase:           hostelPhase ?? 'ADMIN_MODE',
            hostel_name:            hostelName,
            is_paused:              isPaused ?? false,
            allocation_date:        allocationDate,
            lobby_opens_at:         lobbyOpensAt,
            // Target hostel (rooms visible to this student)
            target_hostel_id:       student.target_hostel_id ?? null,
            target_hostel_name:     student.target_hostel_name ?? null,
            // Group info
            group_id:               student.group_id ?? null,
            group_status:           student.group_status ?? null,
            is_leader:              student.group_id ? (student.primary_applicant_id === parseInt(studentId)) : false,
            group_rank:             student.group_rank ?? null,
            rollover_count:         student.rollover_count ?? 0,
            is_rollover_priority:   student.is_rollover_priority ?? false,
            // Batch info
            batch_id:               student.group_batch_id ?? null,
            batchNumber:            student.batch_number ?? null,
            batch_is_active:        student.batch_status === 'ACTIVE',
            batch_start_time:       student.batch_start_time ?? null,
            batch_end_time:         student.batch_end_time ?? null,
            // Round info
            current_round:          currentRound,
            submitted_this_round:   submittedThisRound,
            // Allocation outcome
            is_allotted:            student.is_allotted ?? false,
            allocated_room_id:      student.allocated_room_id ?? null,
            allocated_room_number:  student.allocated_room_number ?? null,
            allocated_room_type:    student.allocated_room_type ?? null,
            allocated_room_capacity: student.allocated_room_capacity ?? null,
            assigned_by:            assignedBy,
            roommates,
        };
    }

    // =====================================================
    // 5. TRIGGER ROLLOVER
    // =====================================================

    async triggerRolloverEvaluation(batchId) {
        return await rolloverEvaluator.evaluate(batchId);
    }

    // =====================================================
    // 6. TRIGGER GHOST PENALTY
    // =====================================================

    async triggerGhostPenalty(batchId) {
        return await ghostPenalty.execute(batchId);
    }

    // =====================================================
    // 7. SHATTER CHECK
    // =====================================================

    async triggerShatterProtocol(groupId) {
        return await shatterProtocol.evaluate(groupId);
    }

    // =====================================================
    // 8. FINAL SWEEP
    // =====================================================

    async runFinalSweep(hostelId) {
        return await finalSweep.execute(hostelId);
    }

    // =====================================================
    // 9. FORCE ASSIGNMENT
    // =====================================================

    async forceAssignRoom({
        studentId,
        roomId,
        hostelId,   // Required: used to enforce admin override gate
    }) {
        // Admin override is blocked during LIVE_BATCHES (spec Phase 6)
        if (hostelId) {
            const { canAdminOverride } = await import('./phase.service.js');
            await canAdminOverride(hostelId);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const roomRes = await client.query('SELECT max_capacity, current_occupancy FROM room WHERE id = $1 FOR UPDATE', [roomId]);
            if (roomRes.rowCount === 0) {
                throw new Error('Room not found');
            }

            const room = roomRes.rows[0];
            if (room.current_occupancy >= room.max_capacity) {
                throw new Error('Room already full');
            }

            // Using direct INSERT. Database triggers handle student status and room occupancy.
            await client.query(`
                INSERT INTO room_assignment (room_id, student_id, assigned_by, assignment_status)
                VALUES ($1, $2, 'ADMIN', 'ACTIVE')
            `, [roomId, studentId]);

            await client.query('COMMIT');

            return {
                success: true,
                message: 'Room assigned successfully',
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // =====================================================
    // 10. GET BATCH RESULTS
    // =====================================================

    async getBatchResults(batchId) {
        const submissionsRes = await pool.query(`
            SELECT asb.*, row_to_json(hg.*) as group
            FROM allocation_submission asb
            LEFT JOIN housing_group hg ON asb.group_id = hg.id
            WHERE asb.batch_id = $1
        `, [batchId]);

        return submissionsRes.rows.map(sub => ({
            groupId: sub.group_id,
            round: sub.round_number,
            result: sub.allocation_result,
            processed: sub.is_processed,
            group: sub.group
        }));
    }

    // =====================================================
    // 11. GET CURRENT ROUND
    // =====================================================

    async getCurrentRound(batchId) {
        const batchRes = await pool.query('SELECT start_time FROM batch WHERE id = $1', [batchId]);

        if (batchRes.rowCount === 0) {
            throw new Error('Batch not found');
        }

        const batch = batchRes.rows[0];
        const now = new Date();
        const startTime = new Date(batch.start_time);

        const diffMs = now.getTime() - startTime.getTime();
        const round = Math.floor(diffMs / (10 * 60 * 1000)) + 1;

        return Math.min(Math.max(round, 1), 6);
    }

    // =====================================================
    // 12. GET ACTIVE BATCH
    // =====================================================

    async getActiveBatch(hostelId) {
        const batchRes = await pool.query(`
            SELECT * FROM batch
            WHERE hostel_id = $1 AND status = 'ACTIVE'
            ORDER BY start_time ASC
            LIMIT 1
        `, [hostelId]);

        return batchRes.rowCount > 0 ? batchRes.rows[0] : null;
    }

    // =====================================================
    // 13. VALIDATE PHASE
    // =====================================================

    async validateAllocationPhase(hostelId) {
        const hostelRes = await pool.query('SELECT is_paused, current_phase FROM hostel WHERE id = $1', [hostelId]);

        if (hostelRes.rowCount === 0) {
            throw new Error('Hostel not found');
        }

        const hostel = hostelRes.rows[0];

        if (hostel.is_paused) {
            throw new Error('Allocation system paused');
        }

        if (hostel.current_phase !== SYSTEM_PHASES.LIVE_BATCHES) {
            throw new Error('Allocation phase inactive');
        }

        return true;
    }
}

export const allocationService = new AllocationService();
