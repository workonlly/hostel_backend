import { Pool } from "pg";
import { faker } from "@faker-js/faker";

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function seedStudents() {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // -----------------------------------------
        // Fetch hostel IDs
        // -----------------------------------------

        const hostelRes = await client.query(`
            SELECT id, name
            FROM hostel
            WHERE name IN (
                'Satpura Hostel',
                'Himgiri Boys Hostel'
            )
        `);

        const hostels = {};

        for (const row of hostelRes.rows) {
            hostels[row.name] = row.id;
        }

        if (!hostels["Satpura Hostel"]) {
            throw new Error("Satpura Hostel not found");
        }

        if (!hostels["Himgiri Boys Hostel"]) {
            throw new Error("Himgiri Boys Hostel not found");
        }

        // -----------------------------------------
        // Rank start
        // -----------------------------------------

        const rankRes = await client.query(`
            SELECT COALESCE(MAX(individual_rank),0) AS max_rank
            FROM student
        `);

        let rank = Number(rankRes.rows[0].max_rank) + 1;

        // -----------------------------------------
        // Generate students
        // -----------------------------------------

        const students = [];

        for (let i = 1; i <= 100; i++) {
            const rollNo = `23BCS${String(i).padStart(4, "0")}`;

            students.push({
                name: faker.person.fullName(),
                father_name: faker.person.fullName(),
                email: `${rollNo}@nith.ac.in`,
                password: "password123",
                hostel: "Satpura Hostel",
                hostel_id: hostels["Satpura Hostel"],
                roll_no: rollNo,
                phone: faker.string.numeric(10),
                parent_number: faker.string.numeric(10),
                blood_group: faker.helpers.arrayElement([
                    "A+",
                    "A-",
                    "B+",
                    "B-",
                    "AB+",
                    "AB-",
                    "O+",
                    "O-",
                ]),
                state: faker.location.state(),
                address: faker.location.streetAddress(),
                pincode: faker.string.numeric(6),
                department: "Computer Science and Engineering",
                joining_year: 2023,
                cgpa: null,
                individual_rank: rank++,
            });
        }

        for (let i = 1; i <= 100; i++) {
            const rollNo = `22BCS${String(i).padStart(4, "0")}`;

            students.push({
                name: faker.person.fullName(),
                father_name: faker.person.fullName(),
                email: `${rollNo}@nith.ac.in`,
                password: "password123",
                hostel: "Himgiri Boys Hostel",
                hostel_id: hostels["Himgiri Boys Hostel"],
                roll_no: rollNo,
                phone: faker.string.numeric(10),
                parent_number: faker.string.numeric(10),
                blood_group: faker.helpers.arrayElement([
                    "A+",
                    "A-",
                    "B+",
                    "B-",
                    "AB+",
                    "AB-",
                    "O+",
                    "O-",
                ]),
                state: faker.location.state(),
                address: faker.location.streetAddress(),
                pincode: faker.string.numeric(6),
                department: "Computer Science and Engineering",
                joining_year: 2022,
                cgpa: null,
                individual_rank: rank++,
            });
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
                $${p + 1},
                $${p + 2},
                $${p + 3},
                $${p + 4},
                $${p + 5},
                $${p + 6},
                $${p + 7},
                $${p + 8},
                $${p + 9},
                $${p + 10},
                $${p + 11},
                $${p + 12},
                $${p + 13},
                $${p + 14},
                $${p + 15},
                $${p + 16}
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

        const insertedStudents = await client.query(
            `
            INSERT INTO student (
                name,
                father_name,
                email,
                password,
                hostel,
                hostel_id,
                roll_no,
                phone,
                parent_number,
                blood_group,
                state,
                address,
                pincode,
                department,
                joining_year,
                individual_rank
            )
            VALUES ${placeholders.join(",")}
            RETURNING id
            `,
            values
        );

        const studentIds = insertedStudents.rows.map(r => r.id);

        // -----------------------------------------
        // Bulk create solo groups
        // -----------------------------------------

        const groupValues = [];
        const groupPlaceholders = [];

        studentIds.forEach((studentId, idx) => {
            const p = idx * 2;

            groupPlaceholders.push(
                `($${p + 1}, $${p + 2})`
            );

            groupValues.push(
                studentId,
                idx + 1
            );
        });

        const insertedGroups = await client.query(
            `
            INSERT INTO housing_group (
                primary_applicant_id,
                group_rank
            )
            VALUES ${groupPlaceholders.join(",")}
            RETURNING id
            `,
            groupValues
        );

        // -----------------------------------------
        // Bulk update students
        // -----------------------------------------

        const mappingValues = [];
        const mappingRows = [];

        insertedGroups.rows.forEach((group, idx) => {
            const p = idx * 2;

            mappingRows.push(
                `($${p + 1}::uuid,$${p + 2}::integer)`
            );

            mappingValues.push(
                group.id,
                studentIds[idx]
            );
        });

        await client.query(
            `
            UPDATE student s
            SET group_id = m.group_id
            FROM (
                VALUES
                ${mappingRows.join(",")}
            ) AS m(group_id, student_id)
            WHERE s.id = m.student_id
            `,
            mappingValues
        );

        await client.query("COMMIT");

        console.log("================================");
        console.log("Seed Complete");
        console.log("Students:", studentIds.length);
        console.log("Groups:", insertedGroups.rows.length);
        console.log("================================");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

seedStudents();