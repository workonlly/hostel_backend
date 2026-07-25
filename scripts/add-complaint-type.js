import pool from '../src/db/pool.js';

async function addComplaintTypeColumn() {
    try {
        console.log('Connecting to database to add "type" column to "complaint" table...');
        
        // Using DEFAULT 'General' so that any existing complaints don't violate the NOT NULL constraint
        await pool.query(`
            ALTER TABLE complaint 
            ADD COLUMN IF NOT EXISTS type VARCHAR(255) NOT NULL DEFAULT 'General';
        `);
        
        console.log('Successfully added "type" column to "complaint" table!');
    } catch (error) {
        console.error('Failed to add column:', error.message);
    } finally {
        await pool.end();
    }
}

addComplaintTypeColumn();
