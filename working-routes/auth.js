import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool.js';
import auth from '../src/middleware/middleware.js';
import dotenv from 'dotenv';
import { generateOtp } from './generateOtp.js';
import { storeOtp, verifyOtp } from './otpStore.js';

const DEPARTMENT_PREFIXES = {
    CSE: 'BCS',
    ME: 'BME',
    CE: 'BCE',
    EE: 'BEE',
    ECE: 'BEC',
    MNC: 'BMA',
    'ENGINEERING PHYSICS': 'BPH',
    'MATERIAL SCIENCE': 'BMS',
    ARCHITECTURE: 'BAR',
    'DUAL DEGREE CSE': 'DCS',
    'DUAL DEGREE ELECTRONICS': 'DEC',
};

const DEPARTMENT_ALIASES = {
    'COMPUTER SCIENCE ENGINEERING': 'CSE',
    'COMPUTER SCIENCE & ENGINEERING': 'CSE',
    CSE: 'CSE',
    'MECHANICAL ENGINEERING': 'ME',
    ME: 'ME',
    'CIVIL ENGINEERING': 'CE',
    CE: 'CE',
    'ELECTRICAL ENGINEERING': 'EE',
    EE: 'EE',
    'ELECTRONICS & COMMUNICATION ENGINEERING': 'ECE',
    'ELECTRONICS AND COMMUNICATION ENGINEERING': 'ECE',
    ECE: 'ECE',
    'MATHEMATICS & COMPUTING': 'MNC',
    'MATHEMATICS AND COMPUTING': 'MNC',
    MNC: 'MNC',
    'ENGINEERING PHYSICS': 'ENGINEERING PHYSICS',
    BPH: 'ENGINEERING PHYSICS',
    'MATERIAL SCIENCE': 'MATERIAL SCIENCE',
    BMS: 'MATERIAL SCIENCE',
    ARCHITECTURE: 'ARCHITECTURE',
    BAR: 'ARCHITECTURE',
    'DUAL DEGREE CSE': 'DUAL DEGREE CSE',
    DCS: 'DUAL DEGREE CSE',
    'DUAL DEGREE ELECTRONICS': 'DUAL DEGREE ELECTRONICS',
    DEC: 'DUAL DEGREE ELECTRONICS',
};

const normalizeDepartment = (department) => {
    if (!department) return '';

    const trimmed = String(department).trim();
    const upper = trimmed.toUpperCase();
    return DEPARTMENT_ALIASES[upper] || DEPARTMENT_ALIASES[trimmed] || '';
};

const getDepartmentPrefix = (department) => {
    const normalizedDepartment = normalizeDepartment(department);
    return DEPARTMENT_PREFIXES[normalizedDepartment] || null;
};

const validateDepartmentRollNumber = (department, rollno) => {
    if (!department || !rollno) return false;

    const prefix = getDepartmentPrefix(department);
    if (!prefix) return false;

    const normalizedRollNo = String(rollno).trim().toUpperCase();
    const pattern = new RegExp(`^(?:\\d{2,4})?${prefix}`);
    return pattern.test(normalizedRollNo);
};

const validateStudentEmail = (email, rollno) => {
    if (!email || !rollno) return false;

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedRollNo = String(rollno).trim().toLowerCase();

    if (!normalizedEmail.endsWith('@nith.ac.in')) return false;

    const localPart = normalizedEmail.split('@')[0];
    return localPart === normalizedRollNo;
};

dotenv.config();

const router = express.Router();

const generateToken = (payload) => jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: '1h'
});

const getAdminRole = (admin) => {
    const normalizedEmail = String(admin?.email || '').toLowerCase();

    if (normalizedEmail.includes('attendant')) return 'attendant';
    if (normalizedEmail.includes('chief')) return 'chief-warden';
    if (normalizedEmail.includes('warden')) return 'warden';

    switch (Number(admin?.authority_level)) {
        case 1:
            return 'attendant';
        case 2:
            return 'warden';
        case 3:
            return 'chief-warden';
        default:
            return 'attendant';
    }
};

const isBcryptHash = (value) => typeof value === 'string' && /^\$2[aby]\$/i.test(value);

const verifyStoredPassword = async (inputPassword, storedPassword) => {
    if (!storedPassword) return false;

    if (isBcryptHash(storedPassword)) {
        return bcrypt.compare(inputPassword, storedPassword);
    }

    return inputPassword === storedPassword;
};

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
    const { email, password } = req.body || {};

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
            const passwordMatch = await verifyStoredPassword(
                password,
                storedPassword
            );
            if (!passwordMatch) {
                return res.status(401).json({
                    message: 'Invalid credentials'
                });
            }

            const role = getAdminRole(admin);

            const otp = generateOtp();
            const otpPayload = {
                id: admin.id,
                email: admin.email,
                role,
                authority_level: admin.authority_level,
                user: admin,
            };

            storeOtp(admin.email, otp, otpPayload);
            console.log(`OTP for ${admin.email}: ${otp}`);

            return res.status(200).json({
                success: true,
                message: "OTP generated"
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

  const passwordMatch = await verifyStoredPassword(
    password,
    guard.password
  );

  if (!passwordMatch) {
    return res.status(401).json({
      message: "Invalid credentials",
    });
  }

  const otp = generateOtp();
  const otpPayload = {
    id: guard.id,
    email: guard.email,
    role: "guard",
    user: guard,
  };

  storeOtp(guard.email, otp, otpPayload);
  console.log(`OTP for ${guard.email}: ${otp}`);

  return res.status(200).json({
    success: true,
    message: "OTP generated",
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

        const passwordMatch = await verifyStoredPassword(
            password,
            storedPassword
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: "Invalid credentials"
            });
        }

        const otp = generateOtp();
        const otpPayload = {
            id: user.id,
            email: user.email,
            role: "student",
            user,
        };

        storeOtp(user.email, otp, otpPayload);
        console.log(`OTP for ${user.email}: ${otp}`);

        return res.status(200).json({
            success: true,
            message: "OTP generated"
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

router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body || {};

    if (!email || !otp) {
        return res.status(400).json({
            success: false,
            message: 'Invalid or expired OTP'
        });
    }

    const result = verifyOtp(email, otp);

    if (!result || !result.valid) {
        return res.status(400).json({
            success: false,
            message: 'Invalid or expired OTP'
        });
    }

    const payload = result.payload;

    const token = generateToken({
        id: payload.id,
        email: payload.email,
        role: payload.role,
        authority_level: payload.authority_level,
    });

    return res.status(200).json({
        success: true,
        token,
        user: payload.user,
        role: payload.role
    });
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

            if (!validateDepartmentRollNumber(department, rollno)) {
                return res.status(400).json({
                    message: 'Roll number does not match the selected department.'
                });
            }

            if (!validateStudentEmail(email, rollno)) {
                return res.status(400).json({
                    message: 'Email must be in the format rollno@nith.ac.in'
                });
            }

            const existingStudent = await pool.query(
                `SELECT email, roll_no, phone FROM student
                 WHERE email = $1 OR roll_no = $2 OR phone = $3
                 LIMIT 1`,
                [email, rollno, phone]
            );

            if (existingStudent.rows.length > 0) {
                const existing = existingStudent.rows[0];
                const conflicts = [];

                if (existing.email === email) conflicts.push('email');
                if (existing.roll_no === rollno) conflicts.push('roll number');
                if (existing.phone === phone) conflicts.push('phone number');

                return res.status(409).json({
                    message: `The following values already exist: ${conflicts.join(', ')}`
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

        const token = generateToken({ id: user.id, email: user.email, role: data.role });
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