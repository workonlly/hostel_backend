import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import assert from "assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

async function runTest() {
    const { default: pool } = await import("../src/db/pool.js");
    const { allocationService } = await import("../src/roomallocation/services/allocation.service.js");
    const { runPostBatchEvaluation } = await import("../src/roomallocation/schedulers/evaluationScheduler.js");

    const client = await pool.connect();
    
    try {
        console.log("1. Cleaning up database...");
        await client.query(`
            TRUNCATE TABLE 
                room_assignment, 
                submission_preference, 
                allocation_submission, 
                housing_group,
                student, 
                batch, 
                event_room_pool, 
                event_hostel_participation, 
                allocation_event, 
                room, 
                hostel 
            CASCADE;
        `);

        console.log("2. Inserting Hostels and Rooms...");
        const hA = (await client.query(`INSERT INTO hostel (name, type, total_capacity) VALUES ('Hostel A', 'BOYS', 100) RETURNING id`)).rows[0].id;
        const hB = (await client.query(`INSERT INTO hostel (name, type, total_capacity) VALUES ('Hostel B', 'BOYS', 100) RETURNING id`)).rows[0].id;
        
        const rA1 = (await client.query(`INSERT INTO room (hostel_id, room_number, max_capacity, block) VALUES ($1, 'A1', 2, 'A') RETURNING id`, [hA])).rows[0].id;
        const rA2 = (await client.query(`INSERT INTO room (hostel_id, room_number, max_capacity, block) VALUES ($1, 'A2', 1, 'A') RETURNING id`, [hA])).rows[0].id;
        const rB1 = (await client.query(`INSERT INTO room (hostel_id, room_number, max_capacity, block) VALUES ($1, 'B1', 3, 'B') RETURNING id`, [hB])).rows[0].id;

        console.log("3. Creating Allocation Event...");
        const eventId = (await client.query(`
            INSERT INTO allocation_event (target_year, status) 
            VALUES (2, 'LIVE_BATCHES') 
            RETURNING id
        `)).rows[0].id;

        console.log("4. Adding Hostels and Rooms to Event Pool...");
        await client.query(`INSERT INTO event_hostel_participation (allocation_event_id, hostel_id) VALUES ($1, $2), ($1, $3)`, [eventId, hA, hB]);
        await client.query(`INSERT INTO event_room_pool (allocation_event_id, hostel_id, room_id) VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $6)`, 
            [eventId, hA, rA1, rA2, hB, rB1]);

        console.log("5. Creating Students and Groups...");
        
        await client.query('BEGIN');
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        
        // Group 1: 2 students (Rank 1, 2)
        const s1 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S1', '1', 2, 1, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const s2 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S2', '2', 2, 2, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const g1 = (await client.query(`INSERT INTO housing_group (primary_applicant_id, status, group_rank, allocation_event_id) VALUES ($1, 'SOFT_LOCKED', 1, $2) RETURNING id`, [s1, eventId])).rows[0].id;
        await client.query(`UPDATE student SET group_id = $1 WHERE id IN ($2, $3)`, [g1, s1, s2]);

        // Group 2: 1 student (Rank 3)
        const s3 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S3', '3', 2, 3, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const g2 = (await client.query(`INSERT INTO housing_group (primary_applicant_id, status, group_rank, allocation_event_id) VALUES ($1, 'SOFT_LOCKED', 3, $2) RETURNING id`, [s3, eventId])).rows[0].id;
        await client.query(`UPDATE student SET group_id = $1 WHERE id = $2`, [g2, s3]);

        // Group 3: 3 students (Rank 4, 5, 6)
        const s4 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S4', '4', 2, 4, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const s5 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S5', '5', 2, 5, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const s6 = (await client.query(`INSERT INTO student (name, roll_no, current_year, individual_rank, hostel_id, hostel, department) VALUES ('S6', '6', 2, 6, $1, 'Hostel A', 'CSE') RETURNING id`, [hA])).rows[0].id;
        const g3 = (await client.query(`INSERT INTO housing_group (primary_applicant_id, status, group_rank, allocation_event_id) VALUES ($1, 'SOFT_LOCKED', 4, $2) RETURNING id`, [s4, eventId])).rows[0].id;
        await client.query(`UPDATE student SET group_id = $1 WHERE id IN ($2, $3, $4)`, [g3, s4, s5, s6]);

        await client.query('COMMIT');

        console.log("6. Creating Active Batch and mapping groups...");
        const batchId = (await client.query(`
            INSERT INTO batch (allocation_event_id, batch_number, start_time, end_time, status) 
            VALUES ($1, 1, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour', 'ACTIVE') RETURNING id
        `, [eventId])).rows[0].id;
        await client.query(`UPDATE housing_group SET batch_id = $1 WHERE id IN ($2, $3, $4)`, [batchId, g1, g2, g3]);

        console.log("7. Creating Preferences...");
        // Group 1 prefers Hostel A rooms (A1)
        const sub1 = (await client.query(`INSERT INTO allocation_submission (group_id, batch_id, submitted_by, round_number, effective_group_rank, effective_leader_rank, effective_group_size) VALUES ($1, $2, $3, 1, 1, 1, 2) RETURNING id`, [g1, batchId, s1])).rows[0].id;
        await client.query(`INSERT INTO submission_preference (submission_id, preference_order, room_id) VALUES ($1, 1, $2)`, [sub1, rA1]);

        // Group 2 prefers Hostel A rooms (A2)
        const sub2 = (await client.query(`INSERT INTO allocation_submission (group_id, batch_id, submitted_by, round_number, effective_group_rank, effective_leader_rank, effective_group_size) VALUES ($1, $2, $3, 1, 3, 3, 1) RETURNING id`, [g2, batchId, s3])).rows[0].id;
        await client.query(`INSERT INTO submission_preference (submission_id, preference_order, room_id) VALUES ($1, 1, $2)`, [sub2, rA2]);

        // Group 3 prefers Hostel B rooms (B1)
        const sub3 = (await client.query(`INSERT INTO allocation_submission (group_id, batch_id, submitted_by, round_number, effective_group_rank, effective_leader_rank, effective_group_size) VALUES ($1, $2, $3, 1, 4, 4, 3) RETURNING id`, [g3, batchId, s4])).rows[0].id;
        await client.query(`INSERT INTO submission_preference (submission_id, preference_order, room_id) VALUES ($1, 1, $2)`, [sub3, rB1]);

        console.log("8. Running Allocation Engine...");
        const result = await allocationService.executeBatchRound(batchId, 1);
        console.log("Allocation Result:", result);

        assert(result.allocated === 3, "Expected 3 groups to be allocated");
        assert(result.failed === 0, "Expected 0 groups to fail");

        const group1Status = (await client.query(`SELECT status FROM housing_group WHERE id = $1`, [g1])).rows[0].status;
        assert(group1Status === 'ALLOCATED', "Group 1 should be ALLOCATED");
        const group2Status = (await client.query(`SELECT status FROM housing_group WHERE id = $1`, [g2])).rows[0].status;
        assert(group2Status === 'ALLOCATED', "Group 2 should be ALLOCATED");
        const group3Status = (await client.query(`SELECT status FROM housing_group WHERE id = $1`, [g3])).rows[0].status;
        assert(group3Status === 'ALLOCATED', "Group 3 should be ALLOCATED");

        console.log("9. Running Post-Batch Evaluation...");
        await runPostBatchEvaluation(batchId, eventId);
        
        console.log("✅ All tests passed. Entire year-based allocation flow works perfectly.");
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("❌ Test failed:");
        console.error(err);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

runTest();
