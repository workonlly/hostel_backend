/**
 * Manually assigns groups that were missed by soft lock
 * (e.g. cross-hostel groups where the leader belongs to a different hostel)
 * Run: node scripts/fix-missed-groups.js <hostelId>
 */
import pool from '../src/db/pool.js';

const hostelId = process.argv[2] || 'f5c4c3d4-cabb-43f2-a0f9-f8ab5f350d8e';

console.log(`\nLooking for FORMING groups with members in hostel ${hostelId}...\n`);

// Find groups that are still FORMING but have a member in this hostel
const missedRes = await pool.query(`
    SELECT DISTINCT hg.id, hg.status, hg.batch_id, hg.group_rank,
           leader.individual_rank AS leader_rank
    FROM housing_group hg
    JOIN student leader ON leader.id = hg.primary_applicant_id
    WHERE hg.status = 'FORMING'
      AND hg.batch_id IS NULL
      AND EXISTS (
          SELECT 1 FROM student m
          WHERE m.group_id = hg.id AND m.hostel_id = $1
      )
    ORDER BY leader.individual_rank ASC NULLS LAST
`, [hostelId]);

if (missedRes.rowCount === 0) {
    console.log('No missed groups found. All groups are assigned.');
    await pool.end();
    process.exit(0);
}

console.log(`Found ${missedRes.rowCount} missed group(s):\n`);

// Find the batch with the fewest groups (to balance load) or the last batch
const batchRes = await pool.query(`
    SELECT b.id, b.batch_number, b.status,
           COUNT(hg.id) as group_count
    FROM batch b
    LEFT JOIN housing_group hg ON hg.batch_id = b.id
    WHERE b.hostel_id = $1 AND b.status IN ('PENDING', 'ACTIVE')
    GROUP BY b.id, b.batch_number, b.status
    ORDER BY b.batch_number ASC
`, [hostelId]);

console.log('Available batches:');
batchRes.rows.forEach(b => {
    console.log(`  Batch #${b.batch_number} (${b.status}) — ${b.group_count} groups`);
});

if (batchRes.rowCount === 0) {
    console.error('No available batches found!');
    await pool.end();
    process.exit(1);
}

// Assign missed groups to the batch with the smallest group count
const targetBatch = batchRes.rows.reduce((a, b) => 
    parseInt(a.group_count) <= parseInt(b.group_count) ? a : b
);

console.log(`\nAssigning missed groups to Batch #${targetBatch.batch_number} (id: ${targetBatch.id})\n`);

for (const group of missedRes.rows) {
    await pool.query(`
        UPDATE housing_group
        SET status = 'SOFT_LOCKED', batch_id = $1
        WHERE id = $2 AND status = 'FORMING'
    `, [targetBatch.id, group.id]);
    console.log(`  ✓ Group ${group.id} → Batch #${targetBatch.batch_number}`);
}

console.log(`\nDone. ${missedRes.rowCount} group(s) assigned.`);
await pool.end();
