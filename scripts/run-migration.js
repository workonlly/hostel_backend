import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

async function runMigration() {
    const { default: pool } = await import("../src/db/pool.js");
    const client = await pool.connect();

    try {
        console.log("Reading migration SQL file...");
        const sqlPath = path.join(__dirname, "../src/roomallocation/db/migration_year_based_alloc.sql");
        let sql = await fs.readFile(sqlPath, "utf8");

        // We uncomment the PASS 2 steps for the sake of the test environment
        // so that the database is fully upgraded.
        sql = sql.replace(/-- ALTER TABLE hostel DROP COLUMN IF EXISTS/g, 'ALTER TABLE hostel DROP COLUMN IF EXISTS');
        sql = sql.replace(/-- ALTER TABLE batch ALTER COLUMN allocation_event_id/g, 'ALTER TABLE batch ALTER COLUMN allocation_event_id');
        sql = sql.replace(/-- DROP TABLE IF EXISTS allocation_room_pool/g, 'DROP TABLE IF EXISTS allocation_room_pool');
        sql = sql.replace(/-- ALTER TABLE batch DROP COLUMN IF EXISTS hostel_id/g, 'ALTER TABLE batch DROP COLUMN IF EXISTS hostel_id');
        sql = sql.replace(/-- ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_batch_number_key/g, 'ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_batch_number_key');
        sql = sql.replace(/-- ALTER TABLE batch ADD CONSTRAINT batch_number_per_event/g, 'ALTER TABLE batch ADD CONSTRAINT batch_number_per_event');

        console.log("Executing migration...");
        await client.query(sql);
        console.log("✅ Migration executed successfully.");
    } catch (err) {
        console.error("❌ Failed to execute migration:");
        console.error(err);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

runMigration();
