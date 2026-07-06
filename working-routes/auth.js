import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool.js';
import auth from '../src/middleware/middleware.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();


const ROLE_TABLES = {
    student: "student",
    guard: "guard",
    attendant: "admin",
    warden: "admin",
    "chief-warden": "admin",
};

// ======================================================
// VERIFY LOGIN TOKEN
// ======================================================

router.get('/login', (req, res) => {
    const authHeader = req.headers.authorization || '';

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.headers.token;

    const { role } = req.headers;

    if (!token || !role) {
        return res.status(400).json({
            message: 'Token and role are required'
        });
    }

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        if (decoded.role !== role) {
            return res.status(401).json({
                message: 'Unauthorized'
            });
        }

        return res.status(200).json({
            message: 'Token is valid',
            user: decoded
        });

    } catch (err) {
        return res.status(401).json({
            message: 'Invalid token'
        });
    }
});


// ======================================================
// LOGIN
// ======================================================

// ======================================================
// LOGIN
// ======================================================

router.post('/login', async (req, res) => {
   

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            message: 'Email and password are required'
        });
    }

    try {

        // ======================================================
        // CHECK ADMINS TABLE FIRST
        // ======================================================

        const adminResult = await pool.query(
            `SELECT *
             FROM admin
             WHERE email = $1
             LIMIT 1`,
            [email]
        );
        if (adminResult.rows.length > 0) {

            const admin = adminResult.rows[0];
             
            const storedPassword =
                admin.password_hash ?? admin.password;
            const passwordMatch = await bcrypt.compare(
                password,
                storedPassword
            );
            if (!passwordMatch) {
                return res.status(401).json({
                    message: 'Invalid credentials'
                });
            }

            let role;

            switch (admin.authority_level) {

                case 1:
                    role = "attendant";
                    break;

                case 2:
                    role = "warden";
                    break;

                case 3:
                    role = "chief-warden";
                    break;

                default:
                     return res.status(403).json({
            message: "Invalid authority level"
        });
            }

            const token = jwt.sign(
                {
                    id: admin.id,
                    email: admin.email,
                    role,
                    authority_level: admin.authority_level
                },
                process.env.JWT_SECRET,
                {
                    expiresIn: "1h"
                }
            );

            return res.status(200).json({
                message: "Login successful",
                user: admin,
                token,
                role
            });
        }
        // ======================================================
// CHECK GUARD TABLE
// ======================================================

const guardResult = await pool.query(
  `
  SELECT *
  FROM guard
  WHERE email = $1
  LIMIT 1
  `,
  [email]
);

if (guardResult.rows.length > 0) {
  const guard = guardResult.rows[0];

  const passwordMatch = await bcrypt.compare(
    password,
    guard.password
  );

  if (!passwordMatch) {
    return res.status(401).json({
      message: "Invalid credentials",
    });
  }

  const token = jwt.sign(
    {
      id: guard.id,
      email: guard.email,
      role: "guard",
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1h",
    }
  );

  return res.status(200).json({
    message: "Login successful",
    user: guard,
    token,
    role: "guard",
  });
}
        // ======================================================
        // IF NOT ADMIN, CHECK STUDENT TABLE
        // ======================================================

        const result = await pool.query(
            `SELECT *
             FROM student
             WHERE email = $1
             LIMIT 1`,
            [email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                message: "Invalid credentials"
            });
        }

        const storedPassword =
            user.password_hash ?? user.password;

        const passwordMatch = await bcrypt.compare(
            password,
            storedPassword
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: "Invalid credentials"
            });
        }

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                role: "student"
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "1h"
            }
        );

        return res.status(200).json({
            message: "Login successful",
            user,
            token,
            role: "student"
        });

    } catch (err) {

        console.error("Login error:", err);

        return res.status(500).json({
            message: err.message || "Internal server error",
            error: err.toString(),
            detail: err.detail,
            code: err.code
        });
    }
});


// ======================================================
// CURRENT USER
// ======================================================

router.get('/me', auth, async (req, res) => {

    const { id, email, role } = req.user;

    const tableName = ROLE_TABLES[role];

    if (!tableName) {
        return res.status(400).json({
            message: 'Invalid role'
        });
    }

    try {

        const result = await pool.query(
            `SELECT *
             FROM ${tableName}
             WHERE id = $1
             AND email = $2
             LIMIT 1`,
            [id, email]
        );

        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({
                message: 'User not found'
            });
        }

        return res.status(200).json({
            user,
            role
        });

    } catch (err) {

        console.error("Error in /me:", err);

        return res.status(500).json({
            message: err.message || "Internal server error",
            error: err.toString(),
            detail: err.detail,
            code: err.code
        });
    }
});


// ======================================================
// SIGNUP
// ======================================================

router.post('/signup', async (req, res) => {

    const data = req.body;

    if (!data || !data.role) {
        return res.status(400).json({
            message: 'Role is required'
        });
    }

    try {

        let result;
        let user;

        // ======================================================
        // STUDENT SIGNUP
        // ======================================================

        if (data.role === 'student') {

            const {
                name,
                email,
                password,
                phone,
                department,
                rollno,
                hostel
            } = data;

            const missingFields = [];
            if (!name) missingFields.push('name');
            if (!email) missingFields.push('email');
            if (!password) missingFields.push('password');
            if (!phone) missingFields.push('phone');
            if (!department) missingFields.push('department');
            if (!rollno) missingFields.push('rollno');
            if (!hostel) missingFields.push('hostel');

            if (missingFields.length > 0) {
                return res.status(400).json({
                    message: `Missing required fields for student: ${missingFields.join(', ')}`
                });
            }

            // Find hostel
            const hostelResult = await pool.query(
                `SELECT id, name
                 FROM hostel
                 WHERE name = $1
                 LIMIT 1`,
                [hostel]
            );

            if (hostelResult.rows.length === 0) {
                return res.status(404).json({
                    message: 'Hostel not found. Pick one of the available hostels.'
                });
            }

            const hostelData = hostelResult.rows[0];
            const hashedPassword = await bcrypt.hash(password, 10);

            result = await pool.query(
    `INSERT INTO student
    (
        name,
        email,
        password,
        hostel,
        hostel_id,
        roll_no,
        phone,
        department
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`,
    [
        name,
        email,
        hashedPassword,
        hostelData.name,
        hostelData.id,
        rollno,
        phone,
        department
    ]
);

            user = result.rows[0];
        }

        // ======================================================
        // ATTENDANT SIGNUP
        // ======================================================

        // else if (data.role === 'attendant') {

        //     const {
        //         name,
        //         email,
        //         password,
        //         hostel,
        //         phone
        //     } = data;

        //     const missingFields = [];
        //     if (!name) missingFields.push('name');
        //     if (!email) missingFields.push('email');
        //     if (!password) missingFields.push('password');
        //     if (!phone) missingFields.push('phone');
        //     if (!hostel) missingFields.push('hostel');

        //     if (missingFields.length > 0) {
        //         return res.status(400).json({
        //             message: `Missing required fields for attendant: ${missingFields.join(', ')}`
        //         });
        //     }

        //     // Find hostel
        //     const hostelResult = await pool.query(
        //         `SELECT id, name
        //          FROM hostel
        //          WHERE name = $1
        //          LIMIT 1`,
        //         [hostel]
        //     );

        //     if (hostelResult.rows.length === 0) {
        //         return res.status(404).json({
        //             message: 'Hostel not found'
        //         });
        //     }

        //     const hostelData = hostelResult.rows[0];

        //     const hashedPasswordAttendant = await bcrypt.hash(password, 10);

        //     result = await pool.query(
        //         `INSERT INTO attendent
        //         (
        //             name,
        //             email,
        //             password,
        //             hostel,
        //             hostel_id,
        //             phone
        //         )
        //         VALUES ($1,$2,$3,$4,$5,$6)
        //         RETURNING *`,
        //         [
        //             name,
        //             email,
        //             hashedPasswordAttendant,
        //             hostelData.name,
        //             hostelData.id,
        //             phone
        //         ]
        //     );

        //     user = result.rows[0];
        // }

        // // ======================================================
        // // GUARD SIGNUP
        // // ======================================================

        // else if (data.role === 'guard') {

        //     const {
        //         name,
        //         email,
        //         password,
        //         phone
        //     } = data;

        //     const missingFields = [];
        //     if (!name) missingFields.push('name');
        //     if (!email) missingFields.push('email');
        //     if (!password) missingFields.push('password');
        //     if (!phone) missingFields.push('phone');

        //     if (missingFields.length > 0) {
        //         return res.status(400).json({
        //             message: `Missing required fields for guard: ${missingFields.join(', ')}`
        //         });
        //     }

        //     const hashedPasswordGuard = await bcrypt.hash(password, 10);

        //     result = await pool.query(
        //         `INSERT INTO guard
        //         (
        //             name,
        //             email,
        //             password,
        //             phone
        //         )
        //         VALUES ($1,$2,$3,$4)
        //         RETURNING *`,
        //         [
        //             name,
        //             email,
        //             hashedPasswordGuard,
        //             phone
        //         ]
        //     );

        //     user = result.rows[0];
        // }

        // ======================================================
// WARDEN SIGNUP
// ======================================================

else if (data.role === 'warden') {

    const {
        name,
        email,
        password,
        authority_level
    } = data;

    const missingFields = [];

    if (!name) missingFields.push('name');
    if (!email) missingFields.push('email');
    if (!password) missingFields.push('password');
    if (!authority_level) missingFields.push('authority_level');

    if (missingFields.length > 0) {
        return res.status(400).json({
            message: `Missing required fields for warden: ${missingFields.join(', ')}`
        });
    }

    if (![1, 2, 3].includes(Number(authority_level))) {
        return res.status(400).json({
            message: 'authority_level must be 1, 2, or 3'
        });
    }

    const hashedPasswordWarden = await bcrypt.hash(password, 10);

    result = await pool.query(
        `
        INSERT INTO admin
        (
            name,
            email,
            password_hash,
            authority_level
        )
        VALUES ($1,$2,$3,$4)
        RETURNING *
        `,
        [
            name,
            email,
            hashedPasswordWarden,
            authority_level
        ]
    );

    user = result.rows[0];
}
        // ======================================================
        // INVALID ROLE
        // ======================================================

        else {
            return res.status(400).json({
                message: 'Invalid role'
            });
        }

        // ======================================================
        // GENERATE JWT TOKEN
        // ======================================================

        const token = jwt.sign({ id: user.id, email: user.email, role: data.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
        return res.status(201).json({ message: 'User created successfully', user, token });
    } catch (err) {
        console.error("Signup error:", err);

        // Handle specific Postgres duplicate key constraint violations (e.g. email or roll number already exists)
        if (err.code === '23505') {
            let detailMessage = 'Email or roll number already exists.';
            if (err.detail) {
                detailMessage = err.detail;
            }
            return res.status(409).json({
                message: 'Duplicate key violation: User already exists.',
                detail: detailMessage,
                code: err.code
            });
        }

        return res.status(500).json({
            message: err.message || 'Internal server error',
            error: err.toString(),
            detail: err.detail,
            code: err.code
        });
    }
});


// ======================================================
// LOGOUT
// ======================================================

router.post('/logout', (req, res) => {
    return res.status(200).json({
        message: 'Logout successful'
    });
});

export default router;