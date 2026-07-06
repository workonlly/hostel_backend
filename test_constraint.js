import pool from './src/db/pool.js';
import { getUnassignedFirstYearStudents } from './src/roomallocation/first-year-allocation/studentPool.service.js';
import { matchConstraints } from './src/roomallocation/first-year-allocation/constraintMatcher.js';
import { executeBulkAllocation } from './src/roomallocation/first-year-allocation/bulkAllocator.js';

async function runTest() {
    try {
        console.log("Starting Constraint Engine Test...");
        
        // 1. Get Hostel ID for Kailash Boys Hostel
        const hostelRes = await pool.query(`SELECT id FROM hostel WHERE name = 'Kailash Boys Hostel' LIMIT 1`);
        if (hostelRes.rowCount === 0) {
            console.error("Hostel not found!");
            return;
        }
        const hostelId = hostelRes.rows[0].id;
        console.log(`Found Hostel ID: ${hostelId}`);

        // 2. Fetch unassigned students
        const unassignedStudents = await getUnassignedFirstYearStudents(hostelId);
        console.log(`Fetched ${unassignedStudents.length} unassigned students.`);
        
        // Check states available
        const stateCounts = unassignedStudents.reduce((acc, s) => {
            acc[s.state_category] = (acc[s.state_category] || 0) + 1;
            return acc;
        }, {});
        console.log("State categories available:", stateCounts);

        const branchCounts = unassignedStudents.reduce((acc, s) => {
            acc[s.branch] = (acc[s.branch] || 0) + 1;
            return acc;
        }, {});
        console.log("Branch counts available:", branchCounts);

        // 3. Get empty 3-seater rooms
        const roomsRes = await pool.query(
            `SELECT id, room_number FROM room WHERE hostel_id = $1 AND max_capacity = 3 AND current_occupancy = 0`,
            [hostelId]
        );
        console.log(`Found ${roomsRes.rowCount} empty 3-seater rooms.`);
        
        const targetRoomIds = roomsRes.rows.map(r => r.id);

        // 4. Construct Layout Config
        const layoutConfig = {
            capacity: 3,
            branchDiversity: 'MUST_BE_UNIQUE',
            nodes: [
                { state: 'OTHER_STATE', branch: 'ANY' },
                { state: 'OTHER_STATE', branch: 'ANY' },
                { state: 'HOME_STATE', branch: 'ANY' }
            ]
        };

        console.log("Running Constraint Engine...");
        console.time("Engine Execution Time");
        const allocations = matchConstraints(unassignedStudents, targetRoomIds, layoutConfig);
        console.timeEnd("Engine Execution Time");

        console.log(`Engine successfully mapped ${allocations.size} rooms.`);

        if (allocations.size > 0) {
            // Print out the first 2 allocations
            let count = 0;
            for (const [roomId, studentIds] of allocations.entries()) {
                if (count >= 2) break;
                const roomInfo = roomsRes.rows.find(r => r.id === roomId);
                const students = studentIds.map(sid => unassignedStudents.find(s => s.id === sid));
                console.log(`Room ${roomInfo.room_number} allocated to:`);
                students.forEach(s => {
                    console.log(`  - [ID: ${s.id}] Rank: ${s.individual_rank}, State: ${s.state_category}, Branch: ${s.branch}`);
                });
                count++;
            }

            console.log("\nExecuting Bulk Allocation to save to database...");
            const result = await executeBulkAllocation(allocations, hostelId);
            console.log("Bulk Allocation Result:", result);
        }

    } catch (err) {
        console.error("Test Error:", err);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runTest();
