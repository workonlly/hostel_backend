import express from 'express';

import pool from '../src/db/db.js';

import auth from '../src/middleware/middleware.js';

const router = express.Router();

/* =================================================
GET ALL COMPLAINTS FOR WARDEN
================================================= */

router.get(
  "/all",
  auth,
  async (req, res) => {

    try {

      const complaints =
        await pool.query(

          `
          SELECT

            c.*,

            s.name AS student_name,

            s.roll_no AS student_roll_no,

            s.phone AS student_phone,

            s.department AS student_department

          FROM complaint c

          JOIN student s
          ON c.student_id = s.id

          ORDER BY c.date_created DESC
          `
        );

      return res.status(200).json({

        complaints:
          complaints.rows,

      });

    } catch (err) {

      console.error(
        "Error in all complaints:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          "Internal server error",

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code,
      });
    }
  }
);
/* =================================================
HOSTEL COMPLAINTS
================================================= */

router.get(
  '/hostel-complaints',
  auth,
  async (req, res) => {

    const {
      id: student_id
    } = req.user;

    try {

      /* ================= GET STUDENT HOSTEL ================= */

      const studentResult =
        await pool.query(

          `SELECT hostel
           FROM student
           WHERE id = $1`,

          [student_id]
        );

      if (
        studentResult.rows.length === 0
      ) {

        return res.status(404).json({

          message:
            'Student not found'

        });
      }

      const hostel =
        studentResult.rows[0].hostel;

      /* ================= GET HOSTEL COMPLAINTS ================= */

      const complaints =
        await pool.query(

          `SELECT
              c.*,

              s.name AS student_name,

              s.roll_no AS student_roll_no,

              s.department AS student_department

           FROM complaint c

           JOIN student s
           ON c.student_id = s.id

           WHERE c.hostel = $1

           ORDER BY
             c.upvotes DESC,
             c.date_created DESC`,

          [hostel]
        );

      return res.status(200).json({

        complaints:
          complaints.rows

      });

    } catch (err) {

      console.error(
        "Error in hostel-complaints:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          'Internal server error',

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code
      });
    }
  }
);

/* =================================================
GET COMPLAINTS BY HOSTEL
================================================= */

router.get(
  '/by-hostel',
  auth,
  async (req, res) => {

    const { hostel } = req.query;

    if (!hostel) {

      return res.status(400).json({
        message:
          'hostel query parameter is required'
      });
    }

    try {
        const complaints = await pool.query(
            `SELECT c.*, s.name as student_name, r.room_number as student_room, s.phone as student_phone 
             FROM complaint c 
             JOIN student s ON c.student_id = s.id 
             LEFT JOIN room r ON s.physical_room_id = r.id
             WHERE c.hostel = $1 AND c.status = $2 
             ORDER BY c.date_created DESC`,
            [hostel, 'pending']
        );

      return res.status(200).json({

        complaints:
          complaints.rows

      });

    } catch (err) {

      console.error(
        "Error in by-hostel complaints:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          'Internal server error',

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code
      });
    }
  }
);

/* =================================================
UPDATE COMPLAINT
================================================= */

router.put('/update-complaint', auth, async (req, res) => {
    const { complaint_id, status, resolved_description } = req.body;
    const { id: attendant_id } = req.user;

    if (
      !complaint_id ||
      !status
    ) {

      return res.status(400).json({

        message:
          'complaint_id and status are required'

      });
    }

    try {
        const result = await pool.query(
            `UPDATE complaint SET status = $1, resolved_by = $2, resolved_at = NOW(), resolved_description = $3 
             WHERE id = $4 AND status != 'resolved'
             RETURNING *`,
            [status, attendant_id, resolved_description || null, complaint_id]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          message:
            'Complaint not found or already resolved'

        });
      }

      return res.status(200).json({

        message:
          'Complaint updated successfully',

        complaint:
          result.rows[0]
      });

    } catch (err) {

      console.error(
        "Error in update-complaint:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          'Internal server error',

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code
      });
    }
  }
);

/* =================================================
POST COMPLAINT
================================================= */

router.post('/postcomplaint', auth, async (req, res) => {
  const { title, type, description, hostel } = req.body;
  const { id: student_id } = req.user; // Get securely from token

  if (!title || !type || !description || !hostel) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO complaint (student_id, title, type, description, hostel) VALUES ($1, $2, $3, $4, $5) RETURNING *', 
      [student_id, title, type, description, hostel]
    );
    
    return res.status(200).json({ message: 'Complaint submitted successfully', complaint: result.rows[0] });
  } catch (err) {
    console.error("Error in postcomplaint:", err);
    return res.status(500).json({
        message: err.message || 'Internal server error',
        error: err.toString(),
        detail: err.detail,
        code: err.code
    });
  }
});

router.get(
  '/my-complaints',
  auth,
  async (req, res) => {

    const {
      id: student_id
    } = req.user;

    try {

      const complaints =
        await pool.query(

          `SELECT *

           FROM complaint

           WHERE student_id = $1

           ORDER BY date_created DESC`,

          [student_id]
        );

      return res.status(200).json({

        complaints:
          complaints.rows

      });

    } catch (err) {

      console.error(
        "Error in my-complaints:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          'Internal server error',

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code
      });
    }
  }
);

/* =================================================
UPVOTE
================================================= */

router.put(
  '/upvote',
  auth,
  async (req, res) => {

    const {
      complaint_id
    } = req.body;

    if (!complaint_id) {

      return res.status(400).json({

        message:
          'complaint_id is required'

      });
    }

    try {

      const result =
        await pool.query(

          `UPDATE complaint

           SET upvotes = upvotes + 1

           WHERE id = $1
           AND status = 'pending'

           RETURNING *`,

          [complaint_id]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({

          message:
            'Complaint not found or already resolved'

        });
      }

      return res.status(200).json({

        message:
          'Upvoted successfully',

        complaint:
          result.rows[0]
      });

    } catch (err) {

      console.error(
        "Error in upvote complaint:",
        err
      );

      return res.status(500).json({

        message:
          err.message ||
          'Internal server error',

        error:
          err.toString(),

        detail:
          err.detail,

        code:
          err.code
      });
    }
  }
);

export default router;