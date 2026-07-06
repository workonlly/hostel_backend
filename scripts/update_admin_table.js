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

    // Make authority_level NOT NULL and add hostel column
    const alterQuery = `
      ALTER TABLE admin 
      ALTER COLUMN authority_level SET NOT NULL,
      ADD COLUMN IF NOT EXISTS hostel VARCHAR(255) REFERENCES hostel(name);
    `;

    await client.query(alterQuery);
    console.log('Successfully updated the admin table.');

  } catch (error) {
    console.error('Error updating the database:', error);
  } finally {
    await client.end();
  }
}

main();
