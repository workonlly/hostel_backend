import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// FIXED: Points accurately to hostel_backend/.env
dotenv.config({ path: path.join(__dirname, '..', '.env') });
import { faker } from '@faker-js/faker';

const CHUNK_SIZE = 500;
const MAX_LOOPS = 6;

async function assignRanks() {
    const { default: pool } = await import('../src/db/pool.js');
    const client = await pool.connect();
    
    try {
        console.log('🔗 Connected to database.');

        // FIXED: Removed LIMIT 3000 to fetch ALL students
        const { rows: students } = await client.query('SELECT id, joining_year FROM student');
        
        if (students.length === 0) {
            console.log('No students found.');
            return;
        }

        console.log(`Found ${students.length} students. Generating CGPAs and Ranks...`);

        // 2. Generate random CGPA for each student
        const studentsWithCgpa = students.map(s => ({
            id: s.id,
            joining_year: s.joining_year,
            cgpa: parseFloat(faker.number.float({ min: 5.0, max: 10.0, multipleOf: 0.01 }).toFixed(2))
        }));

        // 3. Group by joining_year to assign unique ranks per cohort
        const cohorts = {};
        for (const s of studentsWithCgpa) {
            if (!cohorts[s.joining_year]) cohorts[s.joining_year] = [];
            cohorts[s.joining_year].push(s);
        }

        const finalUpdates = [];
        for (const year in cohorts) {
            // Sort descending by CGPA
            cohorts[year].sort((a, b) => b.cgpa - a.cgpa);
            
            // Assign rank
            cohorts[year].forEach((s, idx) => {
                finalUpdates.push({
                    id: s.id,
                    cgpa: s.cgpa,
                    rank: idx + 1
                });
            });
        }

        // 4. Split into chunks of CHUNK_SIZE
        const chunks = [];
        for (let i = 0; i < finalUpdates.length; i += CHUNK_SIZE) {
            chunks.push(finalUpdates.slice(i, i + CHUNK_SIZE));
        }

        const loopsToRun = Math.min(chunks.length, MAX_LOOPS);

        console.log(`Prepared ${chunks.length} chunks of size ${CHUNK_SIZE}. Running ${loopsToRun} loops.`);

        // 5. Bulk Update inside a transaction
        await client.query('BEGIN');
        console.log('Transaction started.');

        // Shift existing ranks for ALL students to avoid unique constraint collisions
        await client.query('UPDATE student SET individual_rank = individual_rank + 1000000 WHERE individual_rank IS NOT NULL');
        
        for (let i = 0; i < loopsToRun; i++) {
            const chunk = chunks[i];
            
            const ids = chunk.map(s => s.id);
            const cgpas = chunk.map(s => s.cgpa);
            const ranks = chunk.map(s => s.rank);

            const query = `
                UPDATE student AS s
                SET cgpa = v.cgpa, individual_rank = v.rank
                FROM (
                    SELECT unnest($1::int[]) as id, 
                           unnest($2::numeric[]) as cgpa, 
                           unnest($3::int[]) as rank
                ) AS v
                WHERE s.id = v.id;
            `;

            await client.query(query, [ids, cgpas, ranks]);
            console.log(`✅ Loop ${i + 1}/${loopsToRun}: Updated ${chunk.length} students.`);
        }

        await client.query('COMMIT');
        console.log('✅ Transaction committed successfully!');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error during update. Transaction rolled back.', err);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

assignRanks();