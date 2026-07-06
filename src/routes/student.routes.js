import { Router } from "express";

import auth from "../middleware/middleware.js";

import {
    searchByNameOrRollno,
    sortStudentsInRange,
    getAllOutpassesByStatus,
    getHostelOutpassesByStatus,
    assignAttendent
} from "../controllers/student.controller.js";
import pool from "../db/pool.js";

const router = Router();

// GET /api/students/search?q=name_or_roll  
// Returns only id, name, roll_no (NO cgpa, NO rank) for privacy
// Only returns students without a group
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
        return res.status(400).json({ success: false, message: 'Query must be at least 2 characters' });
    }
    try {
        const result = await pool.query(
            `SELECT id, name, roll_no, department
             FROM student
             WHERE group_id IS NULL
               AND (name ILIKE $1 OR roll_no ILIKE $1)
             ORDER BY name ASC
             LIMIT 20`,
            [`%${q}%`]
        );
        return res.json({ success: true, students: result.rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/students/group-members/:groupId
// Returns members with cgpa (members can see each other's cgpa)
router.get('/group-members/:groupId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.id, s.name, s.roll_no, s.department, s.cgpa, s.individual_rank,
                    (hg.primary_applicant_id = s.id) as is_leader
             FROM student s
             JOIN housing_group hg ON s.group_id = hg.id
             WHERE s.group_id = $1
             ORDER BY s.individual_rank ASC NULLS LAST`,
            [req.params.groupId]
        );
        return res.json({ success: true, members: result.rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

/*
=================================================
SEARCH STUDENT
=================================================
*/
router.post(
    "/search",
    auth,
    searchByNameOrRollno
);

/*
=================================================
OUTPASSES IN RANGE
=================================================
*/
router.post(
    "/range",
    auth,
    sortStudentsInRange
);
router.post(
    "/assign-attendent",
    assignAttendent
);
/*
=================================================
OUTPASSES BY STATUS
=================================================
*/
router.post(
    "/hostel-status",
    auth,
    getHostelOutpassesByStatus
);
router.post(
    "/status",
    auth,
    getAllOutpassesByStatus
);

export default router;