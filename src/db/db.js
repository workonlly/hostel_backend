import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then((client) => {
    console.log('Successfully connected to the database.');
    client.release();
  })
  .catch((error) => {
    console.error('Database connection failed:', error.message);
  });

export default pool;