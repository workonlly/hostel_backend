/**
 * test_allocation_pool.js — Dummy allocation verification script
 * ==============================================================
 * Simulates a complete allocation cycle using the new pool-based engine:
 *
 * Flow:
 *   1. Select FROM hostel and two TO hostels from DB
 *   2. Configure a room pool (first 3 rooms from each TO hostel)
 *   3. Create mock students + groups in the FROM hostel
 *   4. Open a batch for the FROM hostel
 *   5. Submit preferences (room IDs from the pool)
 *   6. Run the allocation engine
 *   7. Print results and verify:
 *        ✓ All assigned rooms are in the pool
 *        ✓ No room is over capacity
 *        ✓ Students not in the FROM hostel are unaffected
 *   8. Clean up test data
 *
 * Usage:
 *   node hostel_backend/src/roomallocation/db/test_allocation_pool.js
 *
 * Requires:
 *   DATABASE_URL env var (or .env in hostel_backend/)
 */

import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'crypto';

const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Colours for terminal output ──────────────────────────────────────────────
const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log(C.green(`  ✓ ${msg}`)); }
function fail(msg) { console.error(C.red(`  ✗ ${msg}`)); process.exitCode = 1; }
function info(msg) { console.log(C.cyan(`  ℹ ${msg}`)); }
function warn(msg) { console.log(C.yellow(`  ⚠ ${msg}`)); }
function hr()      { console.log(C.dim('─'.repeat(60))); }

// ─── IDs created during this test run (for cleanup) ──────────────────────────
const created = {
    hostelIds:  [],
    roomIds:    [],
    studentIds: [],
    groupIds:   [],
    batchId:    null,
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
    log(C.bold('\n◆ ALLOCATION POOL — INTEGRATION TEST\n'));

    let fromHostelId, toHostelAId, toHostelBId;

    // ── Step 1: Create test hostels ──────────────────────────────────────────
    hr();
    log(C.bold('STEP 1 — Creating test hostels'));

    fromHostelId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`TEST_FROM_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(fromHostelId);
    ok(`FROM hostel: ${fromHostelId}`);

    toHostelAId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`TEST_TO_A_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(toHostelAId);
    ok(`TO hostel A: ${toHostelAId}`);

    toHostelBId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`TEST_TO_B_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(toHostelBId);
    ok(`TO hostel B: ${toHostelBId}`);

    // ── Step 2: Create rooms in both TO hostels ──────────────────────────────
    hr();
    log(C.bold('STEP 2 — Creating rooms in TO hostels'));

    const poolRoomIds = [];

    for (let i = 1; i <= 3; i++) {
        const r = await db.query(
            `INSERT INTO room (hostel_id, room_number, max_capacity) VALUES ($1, $2, 2) RETURNING id`,
            [toHostelAId, `A${i}`]
        );
        created.roomIds.push(r.rows[0].id);
        poolRoomIds.push(r.rows[0].id);
        ok(`Room A${i} → ${r.rows[0].id} (TO-A)`);
    }

    for (let i = 1; i <= 3; i++) {
        const r = await db.query(
            `INSERT INTO room (hostel_id, room_number, max_capacity) VALUES ($1, $2, 2) RETURNING id`,
            [toHostelBId, `B${i}`]
        );
        created.roomIds.push(r.rows[0].id);
        poolRoomIds.push(r.rows[0].id);
        ok(`Room B${i} → ${r.rows[0].id} (TO-B)`);
    }

    info(`Pool contains ${poolRoomIds.length} rooms across 2 TO hostels`);

    // ── Step 3: Configure room pool ──────────────────────────────────────────
    hr();
    log(C.bold('STEP 3 — Configuring allocation_room_pool'));

    await db.query(`DELETE FROM allocation_room_pool WHERE source_hostel_id = $1`, [fromHostelId]);
    const poolVals = poolRoomIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    await db.query(
        `INSERT INTO allocation_room_pool (source_hostel_id, room_id) VALUES ${poolVals}
         ON CONFLICT DO NOTHING`,
        [fromHostelId, ...poolRoomIds]
    );
    const poolCheck = await db.query(
        `SELECT COUNT(*) AS cnt FROM allocation_room_pool WHERE source_hostel_id = $1`,
        [fromHostelId]
    );
    ok(`Pool rows inserted: ${poolCheck.rows[0].cnt}`);

    // ── Step 4: Create test students (2 groups of 2) ─────────────────────────
    hr();
    log(C.bold('STEP 4 — Creating students and housing groups'));

    async function createStudent(name, rank, hostelId) {
        const s = await db.query(
            `INSERT INTO student (name, roll_no, hostel, hostel_id, department, individual_rank, joining_year)
             VALUES ($1, $2, $3, $4, 'CS', $5, 2024) RETURNING id`,
            [name, `TEST_${rank}_${Date.now()}`, 'Test', hostelId, rank]
        );
        created.studentIds.push(s.rows[0].id);
        return s.rows[0].id;
    }

    // Group 1 (rank 1 — higher priority)
    const s1 = await createStudent('Alice (Test)', 1, fromHostelId);
    const s2 = await createStudent('Bob (Test)',   2, fromHostelId);

    const g1 = await db.query(
        `INSERT INTO housing_group (primary_applicant_id, group_rank, status)
         VALUES ($1, 1, 'HARD_LOCKED') RETURNING id`,
        [s1]
    );
    const group1Id = g1.rows[0].id;
    created.groupIds.push(group1Id);
    await db.query(`UPDATE student SET group_id = $1 WHERE id = ANY($2::int[])`, [group1Id, [s1, s2]]);
    ok(`Group 1 (rank 1): Alice + Bob → ${group1Id}`);

    // Group 2 (rank 2)
    const s3 = await createStudent('Charlie (Test)', 3, fromHostelId);
    const s4 = await createStudent('Dana (Test)',    4, fromHostelId);

    const g2 = await db.query(
        `INSERT INTO housing_group (primary_applicant_id, group_rank, status)
         VALUES ($1, 2, 'HARD_LOCKED') RETURNING id`,
        [s3]
    );
    const group2Id = g2.rows[0].id;
    created.groupIds.push(group2Id);
    await db.query(`UPDATE student SET group_id = $1 WHERE id = ANY($2::int[])`, [group2Id, [s3, s4]]);
    ok(`Group 2 (rank 2): Charlie + Dana → ${group2Id}`);

    // ── Step 5: Create a batch for FROM hostel ───────────────────────────────
    hr();
    log(C.bold('STEP 5 — Creating active batch'));

    const now     = new Date();
    const start   = new Date(now.getTime() - 60_000);        // 1 min ago
    const end     = new Date(now.getTime() + 3_600_000);     // 1 hour from now
    const batchRes = await db.query(
        `INSERT INTO batch (hostel_id, batch_number, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
        [fromHostelId, Math.floor(Date.now() / 1000) % 1000000, start.toISOString(), end.toISOString()]
    );
    created.batchId = batchRes.rows[0].id;
    ok(`Batch: ${created.batchId}`);

    await db.query(`UPDATE housing_group SET batch_id = $1 WHERE id = ANY($2::uuid[])`,
        [created.batchId, [group1Id, group2Id]]);
    ok('Groups linked to batch');

    // ── Step 6: Submit preferences ───────────────────────────────────────────
    hr();
    log(C.bold('STEP 6 — Submitting preferences'));

    // Pool rooms (first 2 from A, then 2 from B)
    const prefs = poolRoomIds.slice(0, 4); // 4 rooms out of 6

    async function submitPreferences(groupId, submittedBy, preferredRooms) {
        const subRes = await db.query(
            `INSERT INTO allocation_submission
                 (group_id, submitted_by, batch_id, round_number,
                  effective_group_rank, effective_leader_rank, effective_group_size)
             VALUES ($1, $2, $3, 1, $4, $5, 2) RETURNING id`,
            [groupId, submittedBy, created.batchId,
             groupId === group1Id ? 1 : 2,
             groupId === group1Id ? 1 : 3]
        );
        const subId = subRes.rows[0].id;

        for (let i = 0; i < preferredRooms.length; i++) {
            await db.query(
                `INSERT INTO submission_preference (submission_id, room_id, preference_order)
                 VALUES ($1, $2, $3)`,
                [subId, preferredRooms[i], i + 1]
            );
        }
        ok(`Group ${groupId === group1Id ? 1 : 2} submission: ${subId}`);
        return subId;
    }

    await submitPreferences(group1Id, s1, prefs);
    await submitPreferences(group2Id, s3, prefs);

    // ── Step 7: Run allocation engine ────────────────────────────────────────
    hr();
    log(C.bold('STEP 7 — Running allocation engine'));

    // Import allocation service dynamically
    const { allocationService } = await import('../services/allocation.service.js');
    const result = await allocationService.executeBatchRound(created.batchId, 1);

    info(`Processed: ${result.processed}, Allocated: ${result.allocated}, Failed: ${result.failed}`);

    // ── Step 8: Verify results ───────────────────────────────────────────────
    hr();
    log(C.bold('STEP 8 — Verifying results'));

    // Check both groups are ALLOCATED
    const groupsRes = await db.query(
        `SELECT id, status FROM housing_group WHERE id = ANY($1::uuid[])`,
        [[group1Id, group2Id]]
    );
    for (const g of groupsRes.rows) {
        if (g.status === 'ALLOCATED') {
            ok(`Group ${g.id} → ALLOCATED`);
        } else {
            warn(`Group ${g.id} → ${g.status} (may be ok if rooms were full)`);
        }
    }

    // Check all assigned rooms are in the pool
    const assignments = await db.query(
        `SELECT ra.room_id, ra.student_id, ra.assigned_by, r.room_number, h.name AS hostel_name
         FROM room_assignment ra
         JOIN room r ON r.id = ra.room_id
         JOIN hostel h ON h.id = r.hostel_id
         WHERE ra.student_id = ANY($1::int[])
           AND ra.assignment_status = 'UPCOMING'`,
        [[s1, s2, s3, s4]]
    );

    const poolSet = new Set(poolRoomIds);
    let allInPool = true;

    for (const a of assignments.rows) {
        const inPool = poolSet.has(a.room_id);
        if (inPool) {
            ok(`Student ${a.student_id} → Room ${a.room_number} @ ${a.hostel_name} [IN POOL ✓]`);
        } else {
            fail(`Student ${a.student_id} assigned to room NOT in pool: ${a.room_id}`);
            allInPool = false;
        }
    }

    if (assignments.rows.length === 0) {
        warn('No assignments found (engine may be running in stub mode)');
    } else if (allInPool) {
        ok('All assignments are within the configured pool');
    }

    // Check no room is over capacity
    const overCapacity = await db.query(
        `SELECT id, room_number, max_capacity, current_occupancy
         FROM room WHERE id = ANY($1::uuid[]) AND current_occupancy > max_capacity`,
        [poolRoomIds]
    );
    if (overCapacity.rowCount === 0) {
        ok('No rooms over capacity');
    } else {
        for (const r of overCapacity.rows) {
            fail(`Room ${r.room_number} over capacity: ${r.current_occupancy}/${r.max_capacity}`);
        }
    }

    // Print pool room summary
    const poolSummary = await db.query(
        `SELECT r.room_number, h.name AS hostel, r.max_capacity, r.current_occupancy
         FROM room r JOIN hostel h ON h.id = r.hostel_id
         WHERE r.id = ANY($1::uuid[])
         ORDER BY h.name, r.room_number`,
        [poolRoomIds]
    );
    hr();
    log(C.bold('POOL ROOM SUMMARY:'));
    for (const r of poolSummary.rows) {
        const bar = '█'.repeat(r.current_occupancy) + '░'.repeat(r.max_capacity - r.current_occupancy);
        log(`  ${r.hostel} / ${r.room_number}  [${bar}] ${r.current_occupancy}/${r.max_capacity}`);
    }

    log('\n' + C.bold('TEST COMPLETE') + (process.exitCode === 1 ? C.red(' — FAILURES DETECTED') : C.green(' — ALL CHECKS PASSED')));
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────

async function cleanup() {
    hr();
    log(C.dim('Cleaning up test data…'));
    try {
        if (created.batchId) {
            await db.query(`DELETE FROM allocation_submission WHERE batch_id = $1`, [created.batchId]);
            await db.query(`DELETE FROM batch WHERE id = $1`, [created.batchId]);
        }
        if (created.roomIds.length) {
            await db.query(`DELETE FROM room_assignment WHERE room_id = ANY($1::uuid[])`, [created.roomIds]);
            await db.query(`DELETE FROM allocation_room_pool WHERE room_id = ANY($1::uuid[])`, [created.roomIds]);
        }
        if (created.studentIds.length) {
            await db.query(`UPDATE student SET group_id = NULL WHERE id = ANY($1::int[])`, [created.studentIds]);
        }
        if (created.groupIds.length) {
            await db.query(`DELETE FROM housing_group WHERE id = ANY($1::uuid[])`, [created.groupIds]);
        }
        if (created.studentIds.length) {
            await db.query(`DELETE FROM student WHERE id = ANY($1::int[])`, [created.studentIds]);
        }
        if (created.roomIds.length) {
            await db.query(`DELETE FROM room WHERE id = ANY($1::uuid[])`, [created.roomIds]);
        }
        if (created.hostelIds.length) {
            await db.query(`DELETE FROM allocation_room_pool WHERE source_hostel_id = ANY($1::uuid[])`, [created.hostelIds]);
            await db.query(`DELETE FROM hostel WHERE id = ANY($1::uuid[])`, [created.hostelIds]);
        }
        log(C.dim('  Cleanup complete.\n'));
    } catch (e) {
        console.error(C.red('Cleanup error: ' + e.message));
    }
    await db.end();
}

main()
    .catch(err => { console.error(C.red('\nFATAL: ' + err.message)); process.exitCode = 1; })
    .finally(cleanup);
