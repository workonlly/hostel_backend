import pool from '../src/db/pool.js';

// Check why Ayush's group wasn't soft-locked
const groupId = '00092cf5-d1f5-41cd-900f-67261a8adb2c';
const hostelId = 'f5c4c3d4-cabb-43f2-a0f9-f8ab5f350d8e';

console.log('=== Group details ===');
const groupRes = await pool.query(`
    SELECT hg.id, hg.status, hg.batch_id, hg.primary_applicant_id,
           hg.group_rank,
           leader.name as leader_name, leader.roll_no as leader_roll,
           leader.hostel_id as leader_hostel_id,
           (SELECT COUNT(*) FROM student WHERE group_id = hg.id) as member_count
    FROM housing_group hg
    LEFT JOIN student leader ON leader.id = hg.primary_applicant_id
    WHERE hg.id = $1
`, [groupId]);
console.log(JSON.stringify(groupRes.rows[0], null, 2));

console.log('\n=== All group members ===');
const membersRes = await pool.query(`
    SELECT s.id, s.name, s.roll_no, s.hostel_id
    FROM student s WHERE s.group_id = $1
`, [groupId]);
console.log(JSON.stringify(membersRes.rows, null, 2));

console.log('\n=== Soft lock eligibility check ===');
const eligRes = await pool.query(`
    SELECT hg.id, hg.status, s.individual_rank AS leader_rank,
           s.hostel_id as leader_hostel_id, ($2 = s.hostel_id) as would_be_included
    FROM housing_group hg
    JOIN student s ON s.id = hg.primary_applicant_id
    WHERE hg.id = $1
`, [groupId, hostelId]);
console.log(JSON.stringify(eligRes.rows[0], null, 2));

await pool.end();
