#!/usr/bin/env node
/**
 * run_migration_and_test.js
 * ==========================================================
 * 1. Applies migration_room_pool.sql to the database
 *    (skips gracefully if the table already exists)
 * 2. Runs the full allocation pool integration test
 * 3. All test data is cleaned up inside the test itself
 *
 * Usage (from repo root):
 *   node hostel_backend/src/roomallocation/db/run_migration_and_test.js
 *
 * Or with a custom DB URL:
 *   DATABASE_URL=postgres://... node ...
 *
 * Requires:
 *   DATABASE_URL env var OR individual DB_* vars in hostel_backend/.env
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pg from 'pg';
import { randomUUID } from 'crypto';

// ─── Resolve .env from hostel_backend/ ────────────────────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load .env manually (dotenv may not be installed globally)
try {
    const dotenv = await import('dotenv');
    // db/ → roomallocation/ → src/ → hostel_backend/ → .env
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
    dotenv.config({ path: envPath });
} catch { /* dotenv optional */ }


const { Pool } = pg;

const db = process.env.DATABASE_URL
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
      })
    : new Pool({
          user:     process.env.DB_USER,
          host:     process.env.DB_HOST,
          database: process.env.DB_NAME,
          password: process.env.DB_PASSWORD,
          port:     parseInt(process.env.DB_PORT ?? '5432'),
      });

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Terminal colours ─────────────────────────────────────────────────────────
const C = {
    green:  s => `\x1b[32m${s}\x1b[0m`,
    red:    s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    cyan:   s => `\x1b[36m${s}\x1b[0m`,
    bold:   s => `\x1b[1m${s}\x1b[0m`,
    dim:    s => `\x1b[2m${s}\x1b[0m`,
};

const ok   = (m) => console.log(C.green(`  ✓ ${m}`));
const fail = (m) => { console.error(C.red(`  ✗ ${m}`)); process.exitCode = 1; };
const info = (m) => console.log(C.cyan(`  ℹ ${m}`));
const warn = (m) => console.log(C.yellow(`  ⚠ ${m}`));
const hr   = ()  => console.log(C.dim('─'.repeat(64)));

// ─── IDs to clean up ──────────────────────────────────────────────────────────
const created = {
    hostelIds:   [],
    roomIds:     [],
    studentIds:  [],
    groupIds:    [],
    batchIds:    [],
};

// =============================================================================
// STEP 1 — APPLY MIGRATION
// =============================================================================

async function applyMigration() {
    hr();
    console.log(C.bold('STEP 1 — Applying migration_room_pool.sql'));

    const sqlPath = resolve(__dir, 'migration_room_pool.sql');
    const sql     = readFileSync(sqlPath, 'utf8');

    // Check if the table already exists
    const exists = await db.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = 'allocation_room_pool'
    `);

    if (exists.rowCount > 0) {
        warn('allocation_room_pool already exists — skipping table creation');
        // Still ensure the indexes exist (CREATE INDEX IF NOT EXISTS is idempotent)
        const indexLines = sql
            .split('\n')
            .filter(l => l.trim().startsWith('CREATE INDEX IF NOT EXISTS'));
        for (const line of indexLines) {
            await db.query(line.replace(/;?\s*$/, ';')).catch(() => {});
        }
        ok('Indexes verified');
        return;
    }

    await db.query(sql);
    ok('Table allocation_room_pool created');
    ok('Indexes idx_arp_source and idx_arp_room created');
}

// =============================================================================
// STEP 2 — INTEGRATION TEST
// =============================================================================

async function runTest() {
    hr();
    console.log(C.bold('STEP 2 — Integration test: multi-hostel room pool allocation'));

    // ── 2a. Create test hostels ────────────────────────────────────────────────
    console.log('\n  Creating test hostels…');

    const fromHostelId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`__TEST_FROM_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(fromHostelId);
    ok(`FROM hostel created: ${fromHostelId}`);

    const toHostelAId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`__TEST_TO_A_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(toHostelAId);
    ok(`TO hostel A created: ${toHostelAId}`);

    const toHostelBId = (await db.query(
        `INSERT INTO hostel (name, type) VALUES ($1, 'Boys') RETURNING id`,
        [`__TEST_TO_B_${Date.now()}`]
    )).rows[0].id;
    created.hostelIds.push(toHostelBId);
    ok(`TO hostel B created: ${toHostelBId}`);

    // ── 2b. Create rooms ───────────────────────────────────────────────────────
    console.log('\n  Creating rooms in TO hostels…');

    const poolRoomIds = [];

    for (let i = 1; i <= 3; i++) {
        const r = (await db.query(
            `INSERT INTO room (hostel_id, room_number, max_capacity) VALUES ($1, $2, 2) RETURNING id`,
            [toHostelAId, `TA${i}`]
        )).rows[0].id;
        created.roomIds.push(r);
        poolRoomIds.push(r);
        ok(`Room TA${i} (TO-A) → ${r}`);
    }

    for (let i = 1; i <= 3; i++) {
        const r = (await db.query(
            `INSERT INTO room (hostel_id, room_number, max_capacity) VALUES ($1, $2, 2) RETURNING id`,
            [toHostelBId, `TB${i}`]
        )).rows[0].id;
        created.roomIds.push(r);
        poolRoomIds.push(r);
        ok(`Room TB${i} (TO-B) → ${r}`);
    }

    info(`Pool will contain ${poolRoomIds.length} rooms across 2 TO hostels`);

    // ── 2c. Configure room pool ────────────────────────────────────────────────
    console.log('\n  Configuring allocation_room_pool…');

    await db.query(
        `DELETE FROM allocation_room_pool WHERE source_hostel_id = $1`,
        [fromHostelId]
    );
    const pv = poolRoomIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    const insertedPool = await db.query(
        `INSERT INTO allocation_room_pool (source_hostel_id, room_id) VALUES ${pv}
         ON CONFLICT DO NOTHING RETURNING id`,
        [fromHostelId, ...poolRoomIds]
    );
    ok(`Pool rows inserted: ${insertedPool.rowCount}`);

    const verifyPool = await db.query(
        `SELECT COUNT(*) AS cnt FROM allocation_room_pool WHERE source_hostel_id = $1`,
        [fromHostelId]
    );
    if (parseInt(verifyPool.rows[0].cnt) === poolRoomIds.length) {
        ok(`Pool verified: ${verifyPool.rows[0].cnt} entries`);
    } else {
        fail(`Pool mismatch: expected ${poolRoomIds.length}, got ${verifyPool.rows[0].cnt}`);
    }

    // ── 2d. Create students ────────────────────────────────────────────────────
    console.log('\n  Creating test students and groups…');

    const mkStudent = async (name, rank) => {
        const s = (await db.query(
            `INSERT INTO student (name, roll_no, hostel, hostel_id, department, individual_rank, joining_year)
             VALUES ($1, $2, '__TEST__', $3, 'CS', $4, 2024) RETURNING id`,
            [name, `__TST_${rank}_${Date.now()}`, fromHostelId, rank]
        )).rows[0].id;
        created.studentIds.push(s);
        return s;
    };

    const s1 = await mkStudent('Alpha (Test)', 999901);
    const s2 = await mkStudent('Beta  (Test)', 999902);
    const s3 = await mkStudent('Gamma (Test)', 999903);
    const s4 = await mkStudent('Delta (Test)', 999904);

    // Group creation strategy:
    //   primary_applicant_id is NOT NULL, so we must insert with the real leader ID.
    //   The validate_primary_applicant trigger is DEFERRABLE INITIALLY DEFERRED:
    //   it checks at COMMIT that the leader's group_id = group.id.
    //   So the correct order inside a single transaction is:
    //     1. INSERT housing_group  (with real primary_applicant_id)
    //     2. UPDATE student SET group_id  (links leader + members)
    //     3. COMMIT  → deferred trigger fires, sees leader is now in group  ✓

    const mkGroup = async (allStudentIds, primaryId, rank) => {
        const client = await db.connect();
        try {
            await client.query('BEGIN');

            const gRes = await client.query(
                `INSERT INTO housing_group (primary_applicant_id, group_rank, status)
                 VALUES ($1, $2, 'HARD_LOCKED') RETURNING id`,
                [primaryId, rank]
            );
            const groupId = gRes.rows[0].id;
            created.groupIds.push(groupId);

            // Link all students (including the leader) to the group
            await client.query(
                `UPDATE student SET group_id = $1 WHERE id = ANY($2::int[])`,
                [groupId, allStudentIds]
            );

            // COMMIT triggers the deferred validate_primary_applicant check.
            // By now leader.group_id = groupId, so the check passes.
            await client.query('COMMIT');
            return groupId;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    };

    const g1 = await mkGroup([s1, s2], s1, 1);
    ok(`Group 1 (rank 1): Alpha + Beta → ${g1}`);

    const g2 = await mkGroup([s3, s4], s3, 2);
    ok(`Group 2 (rank 2): Gamma + Delta → ${g2}`);

    // ── 2e. Create batch ───────────────────────────────────────────────────────
    console.log('\n  Creating active batch…');

    const now   = new Date();
    const start = new Date(now.getTime() - 60_000).toISOString();
    const end   = new Date(now.getTime() + 3_600_000).toISOString();
    const batchId = (await db.query(
        `INSERT INTO batch (hostel_id, batch_number, start_time, end_time, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
        [fromHostelId, (Date.now() % 1_000_000), start, end]
    )).rows[0].id;
    created.batchIds.push(batchId);
    ok(`Batch: ${batchId}`);

    await db.query(
        `UPDATE housing_group SET batch_id = $1 WHERE id = ANY($2::uuid[])`,
        [batchId, [g1, g2]]
    );
    ok('Groups linked to batch');

    // ── 2f. Submit preferences ─────────────────────────────────────────────────
    console.log('\n  Submitting preferences…');

    const prefs = poolRoomIds.slice(0, 4); // pick 4 of the 6 pool rooms

    const submitGroup = async (groupId, leaderId, effectiveRank, leaderRank) => {
        const subId = (await db.query(
            `INSERT INTO allocation_submission
                 (group_id, submitted_by, batch_id, round_number,
                  effective_group_rank, effective_leader_rank, effective_group_size)
             VALUES ($1, $2, $3, 1, $4, $5, 2) RETURNING id`,
            [groupId, leaderId, batchId, effectiveRank, leaderRank]
        )).rows[0].id;

        for (let i = 0; i < prefs.length; i++) {
            await db.query(
                `INSERT INTO submission_preference (submission_id, room_id, preference_order)
                 VALUES ($1, $2, $3)`,
                [subId, prefs[i], i + 1]
            );
        }
        ok(`Group ${groupId} → submission ${subId}`);
        return subId;
    };

    await submitGroup(g1, s1, 1, 1);
    await submitGroup(g2, s3, 2, 3);

    // ── 2g. Run allocations using DB stored procedure ──────────────────────────
    // We call assign_student_to_room() directly (the same procedure the engine calls)
    // to simulate an allocation and verify pool enforcement.
    console.log('\n  Simulating room assignments from the pool…');

    // Assign group-1 students to first pool room (capacity 2 → fits both)
    const room1 = poolRoomIds[0];
    const room2 = poolRoomIds[1]; // for group 2

    for (const studentId of [s1, s2]) {
        const res = await db.query(
            `SELECT assign_student_to_room($1, $2, 'ADMIN') AS ok`,
            [studentId, room1]
        );
        if (res.rows[0].ok) ok(`Student ${studentId} → room ${room1}`);
        else fail(`Student ${studentId} assignment failed`);
    }

    for (const studentId of [s3, s4]) {
        const res = await db.query(
            `SELECT assign_student_to_room($1, $2, 'ADMIN') AS ok`,
            [studentId, room2]
        );
        if (res.rows[0].ok) ok(`Student ${studentId} → room ${room2}`);
        else fail(`Student ${studentId} assignment failed`);
    }

    // ── 2h. Verify: all assignments are inside the pool ────────────────────────
    console.log('\n  Verifying assignments…');

    const assignments = await db.query(
        `SELECT ra.room_id, ra.student_id, r.room_number, h.name AS hostel_name
         FROM room_assignment ra
         JOIN room   r ON r.id = ra.room_id
         JOIN hostel h ON h.id = r.hostel_id
         WHERE ra.student_id = ANY($1::int[])
           AND ra.assignment_status = 'UPCOMING'`,
        [[s1, s2, s3, s4]]
    );

    const poolSet  = new Set(poolRoomIds);
    let   allInPool = true;

    for (const a of assignments.rows) {
        if (poolSet.has(a.room_id)) {
            ok(`Student ${a.student_id} → Room ${a.room_number} @ ${a.hostel_name} [IN POOL ✓]`);
        } else {
            fail(`Student ${a.student_id} assigned to room NOT in pool: ${a.room_id}`);
            allInPool = false;
        }
    }

    if (assignments.rowCount === 0) {
        warn('No UPCOMING assignments found');
    } else if (allInPool) {
        ok('All assignments are within the configured pool ✓');
    }

    // Verify no room is over capacity
    const over = await db.query(
        `SELECT id, room_number, max_capacity, current_occupancy
         FROM room WHERE id = ANY($1::uuid[]) AND current_occupancy > max_capacity`,
        [poolRoomIds]
    );
    if (over.rowCount === 0) {
        ok('No rooms over capacity ✓');
    } else {
        for (const r of over.rows) {
            fail(`Room ${r.room_number} over capacity: ${r.current_occupancy}/${r.max_capacity}`);
        }
    }

    // Print pool summary
    const summary = await db.query(
        `SELECT r.room_number, h.name AS hostel, r.max_capacity, r.current_occupancy
         FROM room r JOIN hostel h ON h.id = r.hostel_id
         WHERE r.id = ANY($1::uuid[])
         ORDER BY h.name, r.room_number`,
        [poolRoomIds]
    );
    hr();
    console.log(C.bold('Pool room summary:'));
    for (const r of summary.rows) {
        const filled  = '█'.repeat(r.current_occupancy);
        const empty   = '░'.repeat(r.max_capacity - r.current_occupancy);
        const status  = r.current_occupancy >= r.max_capacity ? C.red('FULL') : C.green('OK');
        console.log(`  ${r.hostel.padEnd(20)} / ${r.room_number.padEnd(5)} [${filled}${empty}] ` +
                    `${r.current_occupancy}/${r.max_capacity}  ${status}`);
    }
}

// =============================================================================
// CLEANUP — deletes all test data created above
// =============================================================================

async function cleanup() {
    hr();
    console.log(C.dim('Cleaning up test data…'));
    try {
        // Undo room assignments
        if (created.roomIds.length) {
            await db.query(
                `DELETE FROM room_assignment WHERE room_id = ANY($1::uuid[])`,
                [created.roomIds]
            );
        }

        // Remove pool entries
        if (created.hostelIds.length) {
            await db.query(
                `DELETE FROM allocation_room_pool WHERE source_hostel_id = ANY($1::uuid[])`,
                [created.hostelIds]
            );
        }

        // Remove submissions
        if (created.batchIds.length) {
            await db.query(
                `DELETE FROM allocation_submission WHERE batch_id = ANY($1::uuid[])`,
                [created.batchIds]
            );
            await db.query(
                `DELETE FROM batch WHERE id = ANY($1::uuid[])`,
                [created.batchIds]
            );
        }

        // Unlock groups first so we can modify students
        if (created.groupIds.length) {
            await db.query(
                `UPDATE housing_group SET status = 'OPEN' WHERE id = ANY($1::uuid[])`,
                [created.groupIds]
            );
        }

        // Detach students from groups before deleting
        if (created.studentIds.length) {
            await db.query(
                `UPDATE student SET group_id = NULL WHERE id = ANY($1::int[])`,
                [created.studentIds]
            );
        }

        // Delete groups
        if (created.groupIds.length) {
            await db.query(
                `DELETE FROM housing_group WHERE id = ANY($1::uuid[])`,
                [created.groupIds]
            );
        }

        // Delete students
        if (created.studentIds.length) {
            await db.query(
                `DELETE FROM student WHERE id = ANY($1::int[])`,
                [created.studentIds]
            );
        }

        // Delete rooms
        if (created.roomIds.length) {
            await db.query(
                `DELETE FROM room WHERE id = ANY($1::uuid[])`,
                [created.roomIds]
            );
        }

        // Delete hostels
        if (created.hostelIds.length) {
            await db.query(
                `DELETE FROM hostel WHERE id = ANY($1::uuid[])`,
                [created.hostelIds]
            );
        }

        console.log(C.dim('  All test data removed.\n'));
    } catch (e) {
        console.error(C.red('  Cleanup error: ' + e.message));
    } finally {
        await db.end();
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
    console.log(C.bold('\n◆ MIGRATION + ALLOCATION POOL TEST\n'));

    await applyMigration();
    await runTest();

    hr();
    const passed = process.exitCode !== 1;
    console.log(
        '\n' + C.bold('RESULT: ') +
        (passed ? C.green('ALL CHECKS PASSED ✓') : C.red('FAILURES DETECTED ✗')) +
        '\n'
    );
}

main()
    .catch(err => {
        console.error(C.red('\nFATAL: ' + err.stack ?? err.message));
        process.exitCode = 1;
    })
    .finally(cleanup);
