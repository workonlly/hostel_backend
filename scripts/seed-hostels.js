import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Properly resolves the .env file located at hostel_backend/.env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// The dataset with block allocations and FIXED room types matching room_type_enum
const hostelsData = [
    {
        name: 'Kailash Boys Hostel', type: 'Boys', total_capacity: 612,
        rooms: [
            { block: 'A', prefix: 'K', start: 1, end: 41, capacity: 3, roomType: 'Student' },
            { block: 'B', prefix: 'K', start: 42, end: 82, capacity: 3, roomType: 'Student' },
            { block: 'C', prefix: 'K', start: 83, end: 123, capacity: 3, roomType: 'Student' },
            { block: 'D', prefix: 'K', start: 124, end: 164, capacity: 3, roomType: 'Student' },
            { block: 'E', prefix: 'K', start: 165, end: 204, capacity: 3, roomType: 'Student' }
        ]
    },
    {
        name: 'Himgiri Boys Hostel', type: 'Boys', total_capacity: 493,
        rooms: [
            { block: 'A', prefix: 'H-S', start: 1, end: 235, capacity: 1, roomType: 'Student' },
            { block: 'B', prefix: 'H-S', start: 236, end: 471, capacity: 1, roomType: 'Student' },
            { block: 'C', prefix: 'H-D', start: 1, end: 11, capacity: 2, roomType: 'Student' }
        ]
    },
    {
        name: 'Udaygiri Boys Hostel', type: 'Boys', total_capacity: 489,
        rooms: [
            { block: 'A', prefix: 'U', start: 1, end: 82, capacity: 3, roomType: 'Student' },
            { block: 'B', prefix: 'U', start: 83, end: 163, capacity: 3, roomType: 'Student' }
        ]
    },
    {
        name: 'Neelkanth Boys Hostel', type: 'Boys', total_capacity: 441,
        rooms: [
            { block: 'A', prefix: 'N-T', start: 1, end: 73, capacity: 3, roomType: 'Student' },
            { block: 'B', prefix: 'N-T', start: 74, end: 145, capacity: 3, roomType: 'Student' },
            { block: 'C', prefix: 'N-D', start: 1, end: 2, capacity: 2, roomType: 'Student' }
        ]
    },
    {
        name: 'Dhauladhar Boys Hostel', type: 'Boys', total_capacity: 165,
        rooms: [
            { block: 'A', prefix: 'D-T', start: 1, end: 24, capacity: 3, roomType: 'Student' },
            { block: 'B', prefix: 'D-S', start: 1, end: 91, capacity: 1, roomType: 'Student' },
            { block: 'Admin', prefix: 'D-G', start: 1, end: 2, capacity: 2, roomType: 'Guest' }
        ]
    },
    {
        name: 'Vindhyachal Boys Hostel', type: 'Boys', total_capacity: 166,
        rooms: [
            { block: 'A', prefix: 'V', start: 1, end: 83, capacity: 1, roomType: 'Student' },
            { block: 'B', prefix: 'V', start: 84, end: 166, capacity: 1, roomType: 'Student' }
        ]
    },
    {
        name: 'Shivalik Boys Hostel', type: 'Boys', total_capacity: 130,
        rooms: [
            { block: 'A', prefix: 'SH-6', start: 1, end: 15, capacity: 6, roomType: 'Student' },
            { block: 'B', prefix: 'SH-4', start: 1, end: 10, capacity: 4, roomType: 'Student' }
        ]
    },
    {
        name: 'Ambika Girls Hostel', type: 'Girls', total_capacity: 351,
        rooms: [
            { block: 'A', prefix: 'AM-D', start: 1, end: 66, capacity: 2, roomType: 'Student' },
            { block: 'B', prefix: 'AM-T', start: 1, end: 26, capacity: 3, roomType: 'Student' },
            { block: 'C', prefix: 'AM-4', start: 1, end: 4, capacity: 4, roomType: 'Student' },
            { block: 'D', prefix: 'AM-5', start: 1, end: 25, capacity: 5, roomType: 'Student' }
        ]
    },
    {
        name: 'Parvati Girls Hostel', type: 'Girls', total_capacity: 162,
        rooms: [
            { block: 'A', prefix: 'P-S', start: 1, end: 54, capacity: 1, roomType: 'Student' },
            { block: 'B', prefix: 'P-T', start: 1, end: 36, capacity: 3, roomType: 'Student' },
            { block: 'Admin', prefix: 'P-G', start: 1, end: 2, capacity: 2, roomType: 'Guest' },
            // FIXED: Changed from 'Visitor' to 'Guest' to satisfy room_type_enum constraint
            { block: 'Admin', prefix: 'P-VIS', start: 1, end: 1, capacity: 4, roomType: 'Guest' }
        ]
    },
    {
        name: 'Mani-Mahesh Girls Hostel', type: 'Girls', total_capacity: 167,
        rooms: [
            { block: 'A', prefix: 'MM', start: 1, end: 84, capacity: 1, roomType: 'Student' },
            { block: 'B', prefix: 'MM', start: 85, end: 167, capacity: 1, roomType: 'Student' }
        ]
    },
    {
        name: 'Aravali Girls Hostel', type: 'Girls', total_capacity: 60,
        rooms: [
            { block: 'A', prefix: 'AR', start: 1, end: 15, capacity: 2, roomType: 'Student' },
            { block: 'B', prefix: 'AR', start: 16, end: 30, capacity: 2, roomType: 'Student' }
        ]
    },
    {
        name: 'Satpura Hostel', type: 'Boys', total_capacity: 297,
        rooms: [
            { block: 'A', prefix: 'SAT', start: 1, end: 50, capacity: 4, roomType: 'Student' },
            { block: 'B', prefix: 'SAT', start: 51, end: 99, capacity: 4, roomType: 'Student' }
        ]
    }
];

async function seedHostels() {
    const { default: pool } = await import('../src/db/pool.js');
    const client = await pool.connect();
    console.log('🔗 Connected to database. Starting hostel and room population...');

    try {
        await client.query('BEGIN');

        for (const hostel of hostelsData) {
            console.log(`Inserting ${hostel.name}...`);
            
            const hostelInsertQuery = `
                INSERT INTO hostel (name, type, total_capacity) 
                VALUES ($1, $2, $3) 
                RETURNING id;
            `;
            const hostelResult = await client.query(hostelInsertQuery, [
                hostel.name, 
                hostel.type, 
                hostel.total_capacity
            ]);
            
            const hostelId = hostelResult.rows[0].id;
            
            const roomValues = [];
            let paramIndex = 1;
            const insertParams = [];

            hostel.rooms.forEach(config => {
                for (let i = config.start; i <= config.end; i++) {
                    const roomNumber = `${config.prefix}-${i}`;
                    
                    roomValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`);
                    insertParams.push(hostelId, config.block, roomNumber, config.capacity, config.roomType);
                    
                    paramIndex += 5;
                }
            });

            if (roomValues.length > 0) {
                const roomInsertQuery = `
                    INSERT INTO room (hostel_id, block, room_number, max_capacity, room_type) 
                    VALUES ${roomValues.join(', ')};
                `;
                await client.query(roomInsertQuery, insertParams);
            }
        }

        await client.query('COMMIT');
        console.log('✅ Hostels and rooms seeded successfully!');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error seeding data. All changes rolled back.', error);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

seedHostels();