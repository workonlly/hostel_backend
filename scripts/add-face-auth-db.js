import pool from '../src/db/db.js';

async function migrate() {
    console.log("Starting Face Auth DB Migration...");
    const client = await pool.connect();
    
    try {
        await client.query("BEGIN");
        
        console.log("Adding face_enrolled column to student table (if not exists)...");
        await client.query(`
            ALTER TABLE student
            ADD COLUMN IF NOT EXISTS face_enrolled BOOLEAN DEFAULT FALSE;
        `);
        
        console.log("Creating student_face_enrollment table...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS student_face_enrollment (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
                zepiris_face_id VARCHAR(128) UNIQUE NOT NULL,
                photo_index SMALLINT NOT NULL CHECK (photo_index BETWEEN 1 AND 5),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, photo_index)
            );
        `);
        
        await client.query("COMMIT");
        console.log("Migration completed successfully!");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Migration failed:", err);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();
