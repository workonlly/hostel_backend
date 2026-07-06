import 'dotenv/config';
import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

async function main() {
    try {
        await client.connect();
        console.log('Connected to the database.');

        await client.query(`
            ALTER TABLE hostel
                ADD COLUMN IF NOT EXISTS target_hostel_id UUID REFERENCES hostel(id) ON DELETE SET NULL,
                ADD COLUMN IF NOT EXISTS source_hostel_id UUID REFERENCES hostel(id) ON DELETE SET NULL;
        `);

        console.log('Successfully added target_hostel_id and source_hostel_id columns to the hostel table.');
    } catch (error) {
        console.error('Error updating the database:', error);
    } finally {
        await client.end();
    }
}

main();
