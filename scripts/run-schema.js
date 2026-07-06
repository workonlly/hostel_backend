import dotenv from "dotenv";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({
    path: path.join(__dirname, "../.env"),
});

async function runSchema() {
    const { default: pool } = await import("../src/db/pool.js");

    const client = await pool.connect();

    try {
        console.log("Reading SQL file...");

        const sqlPath = path.join(
            __dirname,
            "../src/roomallocation/db/newdb.sql"
        );

        const sql = await fs.readFile(sqlPath, "utf8");

        console.log("Executing schema...");

        await client.query(sql);

        console.log("✅ Schema executed successfully.");
    } catch (err) {
        console.error("❌ Failed to execute schema:");
        console.error(err);
    } finally {
        client.release();
        await pool.end();
        process.exit(0);
    }
}

runSchema();