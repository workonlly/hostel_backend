import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Properly resolves the .env file located at hostel_backend/.env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { faker } from "@faker-js/faker";

const STUDENTS_PER_HOSTEL = 50; // Regular grouped students
const UNASSIGNED_STUDENTS_PER_HOSTEL = 20; // Unassigned students for search bar
const BOTS_PER_HOSTEL = 20; // Bots for squad addition

async function seedStudents() {
    const { default: pool } = await import('../src/db/pool.js');
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // -----------------------------------------
        // Fetch ALL hostel IDs
        // -----------------------------------------
        const hostelRes = await client.query(`
            SELECT id, name
            FROM hostel
        `);

        if (hostelRes.rows.length === 0) {
            throw new Error("No hostels found in the database. Please seed hostels first.");
        }

        console.log(`Found ${hostelRes.rows.length} hostels. Generating students...`);

        // -----------------------------------------
        // Rank start
        // -----------------------------------------
        const rankRes = await client.query(`
            SELECT COALESCE(MAX(individual_rank), 0) AS max_rank
            FROM student
        `);

        let rank = Number(rankRes.rows[0].max_rank) + 1;

        // -----------------------------------------
        // Generate students dynamically for ALL hostels
        // -----------------------------------------
        const students = [];
        let globalRollCounter = 1;
        const maxRollRes = await client.query(`SELECT roll_no FROM student WHERE roll_no LIKE '23BCH%' ORDER BY roll_no DESC LIMIT 1`);
        if (maxRollRes.rows.length > 0) {
            const numPart = parseInt(maxRollRes.rows[0].roll_no.replace('23BCH', ''), 10);
            if (!isNaN(numPart)) globalRollCounter = numPart + 1;
        }

        let globalBotCounter = 1;
        const maxBotRes = await client.query(`SELECT name FROM student WHERE name LIKE 'Bot %' ORDER BY NULLIF(regexp_replace(name, '\\D', '', 'g'), '')::int DESC LIMIT 1`);
        if (maxBotRes.rows.length > 0) {
            const numPart = parseInt(maxBotRes.rows[0].name.replace('Bot ', ''), 10);
            if (!isNaN(numPart)) globalBotCounter = numPart + 1;
        }

        function createStudentObj(hostel, rollNo, name, individual_rank, type) {
            const joiningYear = faker.helpers.arrayElement([2021, 2022, 2023]);
            return {
                name,
                father_name: faker.person.fullName(),
                email: `${rollNo}@nith.ac.in`,
                password: "password123",
                hostel: hostel.name,
                hostel_id: hostel.id,
                roll_no: rollNo,
                phone: faker.string.numeric(10),
                parent_number: faker.string.numeric(10),
                blood_group: faker.helpers.arrayElement([
                    "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"
                ]),
                state: faker.location.state(),
                address: faker.location.streetAddress(),
                pincode: faker.string.numeric(6),
                department: "Computer Science and Engineering",
                joining_year: joiningYear,
                cgpa: null,
                individual_rank,
                type // 'grouped', 'unassigned', or 'bot'
            };
        }

        for (const hostel of hostelRes.rows) {
            // 1. Grouped Students
            for (let i = 1; i <= STUDENTS_PER_HOSTEL; i++) {
                const rollNo = `23BCH${String(globalRollCounter).padStart(4, "0")}`;
                students.push(createStudentObj(hostel, rollNo, faker.person.fullName(), rank++, 'grouped'));
                globalRollCounter++;
            }

            // 2. Unassigned Students
            for (let i = 1; i <= UNASSIGNED_STUDENTS_PER_HOSTEL; i++) {
                const rollNo = `23BCH${String(globalRollCounter).padStart(4, "0")}`;
                students.push(createStudentObj(hostel, rollNo, faker.person.fullName(), rank++, 'unassigned'));
                globalRollCounter++;
            }

            // 3. Bots
            for (let i = 1; i <= BOTS_PER_HOSTEL; i++) {
                const rollNo = `23BCH${String(globalRollCounter).padStart(4, "0")}`;
                students.push(createStudentObj(hostel, rollNo, `Bot ${globalBotCounter}`, rank++, 'bot'));
                globalRollCounter++;
                globalBotCounter++;
            }
        }

        // -----------------------------------------
        // Bulk insert students
        // -----------------------------------------
        const values = [];
        const placeholders = [];

        students.forEach((s, idx) => {
            const p = idx * 16;

            placeholders.push(`
            (
                $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4},
                $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8},
                $${p + 9}, $${p + 10}, $${p + 11}, $${p + 12},
                $${p + 13}, $${p + 14}, $${p + 15}, $${p + 16}
            )
            `);

            values.push(
                s.name,
                s.father_name,
                s.email,
                s.password,
                s.hostel,
                s.hostel_id,
                s.roll_no,
                s.phone,
                s.parent_number,
                s.blood_group,
                s.state,
                s.address,
                s.pincode,
                s.department,
                s.joining_year,
                s.individual_rank
            );
        });

        console.log(`Inserting ${students.length} students into the database...`);

        const insertedStudents = await client.query(
            `
            INSERT INTO student (
                name, father_name, email, password, hostel, hostel_id, 
                roll_no, phone, parent_number, blood_group, state, 
                address, pincode, department, joining_year, individual_rank
            )
            VALUES ${placeholders.join(",")}
            RETURNING id
            `,
            values
        );

        // Add generated IDs back to the objects
        insertedStudents.rows.forEach((row, idx) => {
            students[idx].id = row.id;
        });

        const groupedStudents = students.filter(s => s.type === 'grouped');

        // -----------------------------------------
        // Bulk create solo groups
        // -----------------------------------------
        console.log(`Creating ${groupedStudents.length} solo housing groups...`);
        const groupValues = [];
        const groupPlaceholders = [];

        groupedStudents.forEach((student, idx) => {
            const p = idx * 2;
            groupPlaceholders.push(`($${p + 1}, $${p + 2})`);
            groupValues.push(student.id, idx + 1);
        });

        let insertedGroups = { rows: [] };
        if (groupedStudents.length > 0) {
            insertedGroups = await client.query(
                `
                INSERT INTO housing_group (primary_applicant_id, group_rank)
                VALUES ${groupPlaceholders.join(",")}
                RETURNING id
                `,
                groupValues
            );
        }

        // -----------------------------------------
        // Bulk update students to link their group
        // -----------------------------------------
        if (insertedGroups.rows.length > 0) {
            console.log('Linking grouped students to their groups...');
            const mappingValues = [];
            const mappingRows = [];

            insertedGroups.rows.forEach((group, idx) => {
                const p = idx * 2;
                mappingRows.push(`($${p + 1}::uuid, $${p + 2}::integer)`);
                mappingValues.push(group.id, groupedStudents[idx].id);
            });

            await client.query(
                `
                UPDATE student s
                SET group_id = m.group_id
                FROM (
                    VALUES ${mappingRows.join(",")}
                ) AS m(group_id, student_id)
                WHERE s.id = m.student_id
                `,
                mappingValues
            );
        }

        await client.query("COMMIT");

        console.log("================================");
        console.log("✅ Seed Complete");
        console.log(`Hostels Processed: ${hostelRes.rows.length}`);
        console.log(`Total Students Generated: ${students.length} (Grouped: ${groupedStudents.length}, Unassigned: ${UNASSIGNED_STUDENTS_PER_HOSTEL * hostelRes.rows.length}, Bots: ${BOTS_PER_HOSTEL * hostelRes.rows.length})`);
        console.log(`Total Groups Created: ${insertedGroups.rows.length}`);
        console.log("================================");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Seeding failed. Transaction rolled back.");
        console.error(err);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

seedStudents();