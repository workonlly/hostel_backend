import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Adjust this path if your .env is elsewhere
dotenv.config({
    path: path.join(__dirname, "../.env"),
});

async function testDatabase() {
    const { default: pool } = await import("../src/db/pool.js");

    try {
        console.log("Connecting to database...\n");

        // Basic connectivity
        const version = await pool.query("SELECT version();");
        console.log("✓ Connected successfully");
        console.log("PostgreSQL:", version.rows[0].version);

        // Current database information
        const db = await pool.query(`
            SELECT
                current_database() AS database,
                current_user AS user_name,
                current_schema() AS schema,
                now() AS server_time;
        `);

        console.table(db.rows);

        // Count public tables
        const tables = await pool.query(`
            SELECT COUNT(*) AS total_tables
            FROM information_schema.tables
            WHERE table_schema = 'public';
        `);

        console.log(`Public tables: ${tables.rows[0].total_tables}`);

        // List all public tables
        const list = await pool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `);

        console.log("\nTables:");
        list.rows.forEach(({ table_name }) => {
            console.log(`- ${table_name}`);
        });

        console.log("\n✓ Database migration appears successful.");
    } catch (err) {
        console.error("\n✗ Database connection failed");
        console.error(err);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

testDatabase();