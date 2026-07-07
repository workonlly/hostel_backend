import pool from '../../db/pool.js';
import ApiError from '../../utils/apiError.js';
import {
    getGroup, setGroup, invalidateGroup,
    getMembers, setMembers, invalidateMembers,
} from '../../cache/groupCache.js';

async function ensureShatterHistoryTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS group_shatter_history (
            id BIGSERIAL PRIMARY KEY,
            student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
            hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
            source_group_id UUID REFERENCES housing_group(id) ON DELETE SET NULL,
            shattered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            consumed_at TIMESTAMPTZ NULL
        )
    `);

    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_group_shatter_history_student_hostel_active
        ON group_shatter_history (student_id, hostel_id, consumed_at, shattered_at DESC)
    `);
}

/**
 * Create a new housing group
 */
export const createGroup = async (primaryApplicantId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if student already in a group
        const studentRes = await client.query(`SELECT group_id, hostel_id, individual_rank FROM student WHERE id = $1`, [primaryApplicantId]);
        if (studentRes.rows.length === 0) throw new ApiError(404, 'Student not found');
        const student = studentRes.rows[0];
        if (student.group_id) throw new ApiError(400, 'Student is already in a group');

        // Check event phase for student's year
        // Prefer group's event if they have one; fallback to current_year lookup
        const eventRes = await client.query(
            `SELECT ae.status AS current_phase
             FROM allocation_event ae
             JOIN event_hostel_participation ehp ON ehp.allocation_event_id = ae.id
             WHERE ehp.hostel_id = $1
               AND ae.target_year = (
                   SELECT current_year FROM student WHERE id = $2
               )
             ORDER BY ae.created_at DESC
             LIMIT 1`,
            [student.hostel_id, primaryApplicantId]
        );
        const currentPhase = eventRes.rows[0]?.current_phase ?? 'ADMIN_MODE';

        let status = 'FORMING';
        let batchId = null;
        let shatterExceptionId = null;

        if (currentPhase === 'SOFT_LOCK' || currentPhase === 'LIVE_BATCHES') {
            // Strict gate: after soft lock, new group creation is blocked unless
            // this student was recently shattered by the engine.
            await ensureShatterHistoryTable(client);
            const shatterRes = await client.query(
                `SELECT id
                 FROM group_shatter_history
                 WHERE student_id = $1
                   AND hostel_id = $2
                   AND consumed_at IS NULL
                 ORDER BY shattered_at DESC
                 LIMIT 1`,
                [primaryApplicantId, student.hostel_id]
            );

            if (shatterRes.rowCount === 0) {
                throw new ApiError(
                    403,
                    'New group creation is disabled after Soft Lock. You can only join existing groups unless your previous group was shattered.'
                );
            }

            shatterExceptionId = shatterRes.rows[0].id;

            // Dynamic late batch assignment
            const batchesRes = await client.query(`
                SELECT b.id, b.status, b.batch_number, COALESCE(MAX(s.individual_rank), 0) AS max_rank
                FROM batch b
                LEFT JOIN housing_group hg ON hg.batch_id = b.id
                LEFT JOIN student s ON s.id = hg.primary_applicant_id
                WHERE b.hostel_id = $1
                GROUP BY b.id, b.batch_number
                ORDER BY b.batch_number ASC
            `, [student.hostel_id]);

            let idealBatchIndex = batchesRes.rows.findIndex(b => parseInt(b.max_rank) >= student.individual_rank || parseInt(b.max_rank) === 0);
            
            if (idealBatchIndex === -1 && batchesRes.rows.length > 0) {
                idealBatchIndex = batchesRes.rows.length - 1; // Fallback to last batch if rank is worse than all
            }

            if (idealBatchIndex !== -1) {
                // Find next available pending batch
                for (let i = idealBatchIndex; i < batchesRes.rows.length; i++) {
                    if (batchesRes.rows[i].status === 'PENDING') {
                        batchId = batchesRes.rows[i].id;
                        status = 'SOFT_LOCKED';
                        break;
                    }
                }
            }
        }

        // Create group
        const groupRes = await client.query(
            `INSERT INTO housing_group (primary_applicant_id, status, batch_id) VALUES ($1, $2, $3) RETURNING *`,
            [primaryApplicantId, status, batchId]
        );
        const group = groupRes.rows[0];

        // Update student
        await client.query(
            `UPDATE student SET group_id = $1 WHERE id = $2`,
            [group.id, primaryApplicantId]
        );

        // Consume one shatter exception token for this post-soft-lock creation.
        if (shatterExceptionId) {
            await client.query(
                `UPDATE group_shatter_history
                 SET consumed_at = NOW()
                 WHERE id = $1`,
                [shatterExceptionId]
            );
        }

        await client.query('COMMIT');

        // Invalidate any stale group cache for the new group
        await invalidateGroup(group.id);
        await invalidateMembers(group.id);

        return group;
    } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error creating group: ' + error.message);
    } finally {
        client.release();
    }
};

/**
 * Get group details including members
 */
export const getGroupDetails = async (groupId) => {
    try {
        // Redis read-through for group
        const cachedGroup = await getGroup(groupId);
        const cachedMembers = await getMembers(groupId);

        if (cachedGroup !== null && cachedMembers !== null) {
            console.log(`[cache] HIT  group:${groupId}`);
            return { ...cachedGroup, members: cachedMembers };
        }

        // Postgres fallback
        console.log(`[cache] MISS group:${groupId} — querying Postgres`);
        const groupRes = await pool.query(`SELECT * FROM v_housing_group_with_size WHERE id = $1`, [groupId]);
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');

        const membersRes = await pool.query(
            `SELECT id, name, roll_no, department, individual_rank 
             FROM student WHERE group_id = $1`,
            [groupId]
        );

        // Populate cache
        await setGroup(groupId, groupRes.rows[0]);
        await setMembers(groupId, membersRes.rows);

        return {
            ...groupRes.rows[0],
            members: membersRes.rows
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error fetching group details: ' + error.message);
    }
};

/**
 * Send a group request (invite or apply)
 * requestType: 'INVITE_FROM_PRIMARY' | 'APPLICATION_FROM_STUDENT'
 */
export const sendGroupRequest = async (groupId, studentId, requestType) => {
    try {
        // Check if student is already in a group
        const studentRes = await pool.query(`SELECT group_id FROM student WHERE id = $1`, [studentId]);
        if (studentRes.rows.length === 0) throw new ApiError(404, 'Student not found');
        if (studentRes.rows[0].group_id) throw new ApiError(400, 'Student is already in a group');

        // Check if group exists and is FORMING
        const groupRes = await pool.query(`SELECT status FROM housing_group WHERE id = $1`, [groupId]);
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');
        if (groupRes.rows[0].status !== 'FORMING') throw new ApiError(400, 'Group is not accepting members');

        // Check for existing pending request
        const existingReq = await pool.query(
            `SELECT id FROM group_request WHERE group_id = $1 AND student_id = $2 AND status = 'PENDING'`,
            [groupId, studentId]
        );
        if (existingReq.rows.length > 0) throw new ApiError(400, 'A pending request already exists between this group and student');

        const result = await pool.query(
            `INSERT INTO group_request (group_id, student_id, request_type, status) 
             VALUES ($1, $2, $3, 'PENDING') RETURNING *`,
            [groupId, studentId, requestType]
        );
        return result.rows[0];
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error sending group request: ' + error.message);
    }
};

/**
 * Respond to a group request
 * status: 'ACCEPTED' | 'REJECTED'
 */
export const respondToGroupRequest = async (requestId, status) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Get request details
        const reqRes = await client.query(`SELECT * FROM group_request WHERE id = $1 FOR UPDATE`, [requestId]);
        if (reqRes.rows.length === 0) throw new ApiError(404, 'Request not found');
        const request = reqRes.rows[0];

        if (request.status !== 'PENDING') throw new ApiError(400, 'Request is no longer pending');

        // Update request status
        const updateRes = await client.query(
            `UPDATE group_request SET status = $1 WHERE id = $2 RETURNING *`,
            [status, requestId]
        );

        // If accepted, add student to group
        if (status === 'ACCEPTED') {
            // Verify group status — Phase 2 top-up gate
            const groupRes = await client.query(
                `SELECT hg.status,
                        (SELECT COUNT(*) FROM student s WHERE s.group_id = hg.id) AS member_count
                 FROM housing_group hg
                 WHERE hg.id = $1`,
                [request.group_id]
            );
            const group = groupRes.rows[0];

            if (!group) throw new ApiError(404, 'Group not found');

            if (group.status === 'HARD_LOCKED' || group.status === 'ALLOCATED') {
                throw new ApiError(400,
                    `Cannot accept new members: group is ${group.status}. ` +
                    'The batch has started — no more members allowed.'
                );
            }

            // During SOFT_LOCK: accept is fine as long as group has space (< 4)
            if (group.status === 'SOFT_LOCKED' && parseInt(group.member_count, 10) >= 4) {
                throw new ApiError(400, 'Group is already full (4 members max)');
            }

            // Re-verify student isn't in a group (race condition check)
            const studentCheck = await client.query(`SELECT group_id FROM student WHERE id = $1`, [request.student_id]);
            if (studentCheck.rows[0].group_id) {
                await client.query(`UPDATE group_request SET status = 'CANCELED' WHERE id = $1`, [requestId]);
                throw new ApiError(400, 'Student joined another group. Request auto-canceled.');
            }

            // Note: The check_group_capacity trigger in DB will throw if group is full (>=4)
            await client.query(
                `UPDATE student SET group_id = $1 WHERE id = $2`,
                [request.group_id, request.student_id]
            );

            // Auto-cancel other PENDING requests for this student
            await client.query(
                `UPDATE group_request
                 SET status = 'CANCELED'
                 WHERE student_id = $1
                   AND status = 'PENDING'
                   AND id != $2`,
                [request.student_id, requestId]
            );
        }

        await client.query('COMMIT');

        // Invalidate group + members cache after membership change
        if (status === 'ACCEPTED') {
            await invalidateGroup(request.group_id);
            await invalidateMembers(request.group_id);
        }

        return updateRes.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.message && error.message.includes('maximum capacity')) {
            throw new ApiError(400, error.message);
        }
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error responding to request: ' + error.message);
    } finally {
        client.release();
    }
};

/**
 * Leave a group
 * Explicit pre-mutation validation before relying on triggers.
 */
export const leaveGroup = async (studentId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verify student exists and is in a group
        const studentRes = await client.query(
            `SELECT id, group_id FROM student WHERE id = $1 FOR UPDATE`,
            [studentId]
        );
        if (studentRes.rows.length === 0) throw new ApiError(404, 'Student not found');
        const student = studentRes.rows[0];
        if (!student.group_id) throw new ApiError(400, 'Student is not in any group');

        // 2. Verify group exists and is in a mutable state
        const groupRes = await client.query(
            `SELECT id, status FROM housing_group WHERE id = $1`,
            [student.group_id]
        );
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');
        const group = groupRes.rows[0];

        const LOCKED_STATES = ['SOFT_LOCKED', 'HARD_LOCKED', 'ALLOCATED'];
        if (LOCKED_STATES.includes(group.status)) {
            throw new ApiError(400, `Cannot leave group — it is currently ${group.status}`);
        }

        // 3. Perform the leave — triggers handle leader reassignment/group deletion
        const groupIdForCache = student.group_id;

        await client.query(
            `UPDATE student SET group_id = NULL WHERE id = $1`,
            [studentId]
        );

        await client.query('COMMIT');

        // Invalidate the group cache since membership changed
        await invalidateGroup(groupIdForCache);
        await invalidateMembers(groupIdForCache);

        return { success: true, message: 'Successfully left group' };
    } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error leaving group: ' + error.message);
    } finally {
        client.release();
    }
};

/**
 * Update group status (e.g., FORMING -> SOFT_LOCKED)
 */
export const updateGroupStatus = async (groupId, status) => {
    try {
        const result = await pool.query(
            `UPDATE housing_group SET status = $1 WHERE id = $2 RETURNING *`,
            [status, groupId]
        );
        if (result.rows.length === 0) throw new ApiError(404, 'Group not found');
        return result.rows[0];
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error updating group status: ' + error.message);
    }
};

/**
 * Get all group requests (admin / debug view)
 */
export const getAllRequests = async () => {
    try {
        const result = await pool.query(
            `SELECT gr.*, 
                    s.name as student_name, 
                    ls.name as leader_name 
             FROM group_request gr
             LEFT JOIN student s ON gr.student_id = s.id
             LEFT JOIN housing_group hg ON gr.group_id = hg.id
             LEFT JOIN student ls ON hg.primary_applicant_id = ls.id
             ORDER BY gr.created_at DESC`
        );
        return result.rows;
    } catch (error) {
        throw new ApiError(500, 'Error fetching group requests: ' + error.message);
    }
};

/**
 * Get all housing groups (admin / debug view)
 */
export const getAllGroups = async () => {
    try {
        const result = await pool.query(
            `SELECT h.*, s.name as leader_name 
             FROM v_housing_group_with_size h
             LEFT JOIN student s ON h.primary_applicant_id = s.id
             ORDER BY h.id`
        );
        return result.rows;
    } catch (error) {
        throw new ApiError(500, 'Error fetching groups: ' + error.message);
    }
};

/**
 * Get group details with its members list
 */
export const getGroupMembers = async (groupId) => {
    try {
        // Redis read-through
        const cachedGroup   = await getGroup(groupId);
        const cachedMembers = await getMembers(groupId);

        if (cachedGroup !== null && cachedMembers !== null) {
            console.log(`[cache] HIT  groupmembers:${groupId}`);
            return { group: cachedGroup, members: cachedMembers };
        }

        // Postgres fallback
        console.log(`[cache] MISS groupmembers:${groupId} — querying Postgres`);
        const groupRes = await pool.query(
            `SELECT * FROM v_housing_group_with_size WHERE id = $1`,
            [groupId]
        );
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');

        const membersRes = await pool.query(
            `SELECT id, name, roll_no, email, individual_rank
             FROM student
             WHERE group_id = $1
             ORDER BY individual_rank ASC`,
            [groupId]
        );

        // Populate cache
        await setGroup(groupId, groupRes.rows[0]);
        await setMembers(groupId, membersRes.rows);

        return {
            group: groupRes.rows[0],
            members: membersRes.rows,
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error fetching group members: ' + error.message);
    }
};

/**
 * Transfer leadership to another group member
 */
export const transferLeadership = async (groupId, newLeaderId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify group exists and is in a mutable state
        const groupRes = await client.query(
            `SELECT id, status FROM housing_group WHERE id = $1`,
            [groupId]
        );
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');

        const FROZEN_STATES = ['SOFT_LOCKED', 'HARD_LOCKED', 'ALLOCATED'];
        if (FROZEN_STATES.includes(groupRes.rows[0].status)) {
            throw new ApiError(400,
                `Cannot transfer leadership — group is ${groupRes.rows[0].status}. ` +
                'Leader titles are frozen after the Soft Lock.'
            );
        }

        // Verify new leader is a member of this group
        const memberRes = await client.query(
            `SELECT id FROM student WHERE id = $1 AND group_id = $2`,
            [newLeaderId, groupId]
        );
        if (memberRes.rows.length === 0) {
            throw new ApiError(400, 'New leader must be a member of the group');
        }

        const updated = await client.query(
            `UPDATE housing_group SET primary_applicant_id = $1 WHERE id = $2 RETURNING *`,
            [newLeaderId, groupId]
        );

        await client.query('COMMIT');

        // Invalidate group cache since leader changed
        await invalidateGroup(groupId);

        return updated.rows[0];
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error transferring leadership: ' + error.message);
    } finally {
        client.release();
    }
};

/**
 * Kick a member from the group (Leader only action)
 */
export const kickMember = async (groupId, leaderId, memberId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const groupRes = await client.query(
            `SELECT id, status, primary_applicant_id FROM housing_group WHERE id = $1`,
            [groupId]
        );
        if (groupRes.rows.length === 0) throw new ApiError(404, 'Group not found');
        
        const group = groupRes.rows[0];
        if (parseInt(group.primary_applicant_id) !== parseInt(leaderId)) {
            throw new ApiError(403, 'Only the leader can kick members');
        }
        if (parseInt(leaderId) === parseInt(memberId)) {
            throw new ApiError(400, 'Leader cannot kick themselves. Use leave group instead.');
        }

        const FROZEN_STATES = ['SOFT_LOCKED', 'HARD_LOCKED', 'ALLOCATED'];
        if (FROZEN_STATES.includes(group.status)) {
            throw new ApiError(400, `Cannot kick members — group is ${group.status}.`);
        }

        // Remove the member
        await client.query(
            `UPDATE student SET group_id = NULL WHERE id = $1 AND group_id = $2`,
            [memberId, groupId]
        );

        await client.query('COMMIT');

        // Invalidate group + members cache
        await invalidateGroup(groupId);
        await invalidateMembers(groupId);

        return { success: true, message: 'Member kicked successfully' };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, 'Error kicking member: ' + error.message);
    } finally {
        client.release();
    }
};
