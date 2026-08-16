import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import pool from '../src/db/pool.js';
import auth from '../src/middleware/middleware.js';
import dotenv from 'dotenv';
import { generateOtp, storeOtp, verifyOtp } from '../src/utils/otp.js';
import { getClientIp, getRefreshTokenExpiry, hashRefreshToken, compareRefreshTokens, lookupLocationFromIp } from '../src/utils/authHelpers.js';
import { logAuthentication } from '../src/logging/services/auth.service.js';
import {
    startSession, deactivateSessions, rotateSessionRefresh, endSession,
    getActiveSession, getActiveSessionByMachine, updateGuardSession
} from '../src/logging/services/session.service.js';
import { mapActorType } from '../src/utils/actorType.js';

dotenv.config();

// ======================================================
// CONSTANTS & HELPERS
// ======================================================

const DEPARTMENT_PREFIXES = {
    CSE: 'BCS',
    ME: 'BME',
    CE: 'BCE',
    CH: 'BCH',
    EE: 'BEE',
    ECE: 'BEC',
    MNC: 'BMA',
    'ENGINEERING PHYSICS': 'BPH',
    'MATERIAL SCIENCE': 'BMS',
    'CHEMICAL ENGINEERING': 'BCH',
    CHEMICAL: 'BCH',
    ARCHITECTURE: 'BAR',
    BAR: 'BAR',
    'DUAL DEGREE CSE': 'DCS',
    'DUAL DEGREE ELECTRONICS': 'DEC',
};

const PREFIX_TO_DEPARTMENT = {
    BCS: 'CSE',
    BME: 'ME',
    BCE: 'CE',
    BCH: 'CHEMICAL ENGINEERING',
    BEE: 'EE',
    BEC: 'ECE',
    BMA: 'MNC',
    BPH: 'ENGINEERING PHYSICS',
    BMS: 'MATERIAL SCIENCE',
    BAR: 'ARCHITECTURE',
    DCS: 'DUAL DEGREE CSE',
    DEC: 'DUAL DEGREE ELECTRONICS',
};

const extractRollInfo = (email) => {
    if (!email) return null;
    const local = String(email).trim().toLowerCase().split('@')[0];
    const match = local.match(/^(\d{2})([a-z]{3})(\d+)$/i);
    if (!match) return { rollNo: local, department: 'CSE', degreeType: 'B.Tech' };
    const yearDigits = match[1];
    const prefix = match[2].toUpperCase();
    const rollNo = local;
    const department = PREFIX_TO_DEPARTMENT[prefix] || 'CSE';

    let degreeType = 'B.Tech';
    if (prefix.startsWith('D')) degreeType = 'Dual Degree';
    else if (prefix === 'BAR') degreeType = 'B.Arch';
    else if (prefix.startsWith('M')) degreeType = 'M.Tech';

    const joiningYear = parseInt('20' + yearDigits, 10);
    return { rollNo, prefix, department, degreeType, joiningYear };
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
    'CHEMICAL ENGINEERING': 'CHEMICAL ENGINEERING',
    CHEMICAL: 'CHEMICAL ENGINEERING',
    CH: 'CHEMICAL ENGINEERING',
    ARCHITECTURE: 'ARCHITECTURE',
    BAR: 'ARCHITECTURE',
    'DUAL DEGREE CSE': 'DUAL DEGREE CSE',
    DCS: 'DUAL DEGREE CSE',
    'DUAL DEGREE ELECTRONICS': 'DUAL DEGREE ELECTRONICS',
    DEC: 'DUAL DEGREE ELECTRONICS',
};

/**
 * All users must have @nith.ac.in email addresses.
 * Student email format: (YY)(branch-3-letters)(rollnumber)@nith.ac.in
 * e.g. 23bcs001@nith.ac.in
 */
const NITH_DOMAIN = '@nith.ac.in';

const isNithEmail = (email) => {
    return String(email || '').trim().toLowerCase().endsWith(NITH_DOMAIN);
};

/**
 * Validate that a student email matches the format: rollno@nith.ac.in
 * and that the local part equals their roll number.
 */
const validateStudentEmail = (email, rollno) => {
    if (!email || !rollno) return false;

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedRollNo = String(rollno).trim().toLowerCase();

    if (!normalizedEmail.endsWith(NITH_DOMAIN)) return false;

    const localPart = normalizedEmail.split('@')[0];
    return localPart === normalizedRollNo;
};

const normalizeDepartment = (department) => {
    if (!department) return '';
    const upper = String(department).trim().toUpperCase();
    return DEPARTMENT_ALIASES[upper] || '';
};

const getDepartmentPrefix = (department) => {
    return DEPARTMENT_PREFIXES[normalizeDepartment(department)] || null;
};

const validateDepartmentRollNumber = (department, rollno) => {
    if (!department || !rollno) return false;
    const prefix = getDepartmentPrefix(department);
    if (!prefix) return false;
    const normalizedRollNo = String(rollno).trim().toUpperCase();
    const pattern = new RegExp(`^(?:\\d{2,4})?${prefix}`);
    return pattern.test(normalizedRollNo);
};

/**
 * Infer a user's role from their email address.
 * All staff accounts follow a nith.ac.in email convention.
 */
const inferRoleFromEmail = (email) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return 'student';
    if (e.includes('attendant') || e.includes('att_')) return 'attendant';
    if (e.includes('chief')) return 'chief-warden';
    if (e.includes('guard') || e.includes('gate')) return 'guard';
    if (e.includes('warden')) return 'warden';
    return 'student';
};

/** Map role -> DB table name (using a fixed whitelist to prevent injection) */
const ROLE_TABLES = {
    student: 'student',
    attendant: 'attendent',
    guard: 'guard',
    warden: 'admin',
    'chief-warden': 'admin',
};

/** Roles that require OTP verification on login */
const OTP_ENABLED_ROLES = new Set(['student', 'attendant', 'warden', 'chief-warden']);

/**
 * Strip sensitive fields (password hashes etc.) from a DB row before
 * returning it to the client.
 */
const sanitizeUser = (user) => {
    if (!user) return null;
    const { password, password_hash, ...safe } = user;
    return safe;
};

/** Generate a short-lived access JWT. Role is always embedded in the token. */
const generateAccessToken = (payload) =>
    jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.ACCESS_EXPIRES_IN || '1h',
    });

/**
 * Build the cookie options. On localhost (http) Secure cannot be set, so we
 * only enable it when NODE_ENV is production (which implies HTTPS on Render).
 */
const cookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    // 7 days to match refresh token lifetime
    maxAge: 7 * 24 * 60 * 60 * 1000,
});

const router = express.Router();

// ======================================================
// SHARED: CREATE AUTHENTICATED SESSION & SET COOKIES
// Accepts cookies as the storage mechanism for tokens.
// The access token and user role are also returned in the
// JSON body so the frontend can read them for routing.
// ======================================================

const createAuthenticatedSessionResponse = async (
    req,
    res,
    { user, role, clientIp, userAgent, machineId = null, existingSession = null }
) => {
    const refreshToken = jwt.sign(
        { sub: user.id, role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    const refreshTokenHash = await hashRefreshToken(refreshToken);
    const refreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry(role));
    const location = await lookupLocationFromIp(clientIp);

    if (role !== 'guard') {
        await deactivateSessions({ actorId: user.id, actorType: mapActorType(role) });
    }

    await logAuthentication({
        actorId: user.id,
        actorType: mapActorType(role),
        action: 'SIGN_IN',
        success: true,
        ipAddress: clientIp,
        userAgent,
        eventName: 'SESSION_REVOKED',
        endpoint: req.originalUrl,
        status: 200,
        userEmail: user.email,
        role,
    });

    let session;
    if (existingSession) {
        session = existingSession;
    } else {
        session = await startSession({
            actorId: user.id,
            actorType: mapActorType(role),
            ipAddress: clientIp,
            userAgent,
            role,
            refreshTokenHash,
            refreshExpiresAt,
            isActive: true,
            machineId: role === 'guard' ? req.headers['x-machine-id'] : null,
        });
    }

    const accessToken = generateAccessToken({
        id: user.id,
        email: user.email,
        role,
        authority_level: user.authority_level,
        sessionId: session?.id,
    });

    await logAuthentication({
        actorId: user.id,
        actorType: mapActorType(role),
        action: 'SIGN_IN',
        success: true,
        ipAddress: clientIp,
        userAgent,
        eventName: 'LOGIN_SUCCESS',
        endpoint: req.originalUrl,
        status: 200,
        sessionId: session?.id,
        userEmail: user.email,
        role,
        details: location || undefined,
    });

    if (location && session?.id) {
        await pool.query(
            `UPDATE user_session SET city = $1, state = $2, country = $3 WHERE id = $4`,
            [location.city, location.state, location.country, session.id]
        );
    }

    // Store both tokens in httpOnly cookies — never expose to JS
    const opts = cookieOptions();
    res.cookie('token', accessToken, opts);
    res.cookie('refreshToken', refreshToken, opts);

    // Return sanitized user — no password fields
    return res.status(200).json({
        success: true,
        message: 'Login successful',
        // token also in JSON body so frontend can use it in Authorization header
        // for requests where cookies may not be forwarded (e.g. multipart uploads)
        token: accessToken,
        role,
        user: sanitizeUser(user),
        sessionId: session?.id,
    });
};

// ======================================================
// LOGIN
// POST /api/auth/login
// OTP for eligible roles, direct JWT for Guard
// ======================================================

router.post('/login', async (req, res) => {
    const { email, password, role: requestedRole } = req.body || {};
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }

    // All accounts must use @nith.ac.in addresses
    if (!isNithEmail(email)) {
        return res.status(400).json({ message: 'Only @nith.ac.in email addresses are accepted' });
    }

    const role = requestedRole || inferRoleFromEmail(email);
    const tableName = ROLE_TABLES[role];

    if (!tableName) {
        return res.status(400).json({ message: 'Invalid role' });
    }

    try {
        // Search the most likely table first, then fall back to others so a
        // user who was created in a different table is still found.
        const lookupTables = [tableName, 'attendent', 'admin', 'guard', 'student']
            .filter((v, i, a) => a.indexOf(v) === i);

        let user = null;

        for (const table of lookupTables) {
            const result = await pool.query(
                `SELECT * FROM ${table} WHERE LOWER(email) = LOWER($1) LIMIT 1`,
                [email]
            );
            if (result.rows[0]) {
                user = result.rows[0];
                break;
            }
        }

        if (!user) {
            await logAuthentication({
                actorId: null,
                actorType: mapActorType(role),
                action: 'SIGN_IN',
                success: false,
                ipAddress: clientIp,
                userAgent,
                eventName: 'LOGIN_FAILED',
                endpoint: req.originalUrl,
                status: 401,
                userEmail: email,
                role,
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Only accept bcrypt hashes — no plaintext fallback
        const storedPassword = user.password_hash ?? user.password;
        if (!storedPassword || !/^\$2[aby]\$/i.test(storedPassword)) {
            console.error(`[Auth] User ${email} has no valid bcrypt hash stored`);
            return res.status(500).json({ message: 'Account is not properly configured. Contact admin.' });
        }

        const passwordMatch = await bcrypt.compare(password, storedPassword);

        if (!passwordMatch) {
            await logAuthentication({
                actorId: user.id,
                actorType: mapActorType(role),
                action: 'SIGN_IN',
                success: false,
                ipAddress: clientIp,
                userAgent,
                eventName: 'LOGIN_FAILED',
                endpoint: req.originalUrl,
                status: 401,
                userEmail: user.email,
                role,
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Guard login — requires a registered machine ID
        if (role === 'guard') {
            const machineIdHeader = req.headers['x-machine-id'] || req.headers['X-Machine-ID'];
            const normalizedMachineId = (
                Array.isArray(machineIdHeader) ? machineIdHeader[0] : machineIdHeader || ''
            ).trim();

            if (!normalizedMachineId) {
                return res.status(400).json({
                    message: 'Machine ID header (X-Machine-ID) is required for Guard login.',
                });
            }

            const refreshToken = jwt.sign(
                { sub: user.id, role },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            const refreshTokenHash = await hashRefreshToken(refreshToken);
            const refreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry(role));

            const existingSession = await getActiveSessionByMachine({
                actorId: user.id,
                actorType: role,
                machineId: normalizedMachineId,
            });

            if (existingSession) {
                await updateGuardSession(existingSession.id, {
                    ipAddress: clientIp,
                    userAgent,
                    refreshTokenHash,
                    refreshExpiresAt,
                });
                return createAuthenticatedSessionResponse(req, res, {
                    user,
                    role,
                    clientIp,
                    userAgent,
                    existingSession,
                });
            }

            if (process.env.NODE_ENV !== 'development') {
                const guardRecord = await pool.query(
                    `SELECT authorized_machine_1, authorized_machine_2 FROM guard WHERE id = $1 LIMIT 1`,
                    [user.id]
                );
                const { authorized_machine_1: m1, authorized_machine_2: m2 } = guardRecord.rows[0] || {};

                if (m1 && m2 && m1 !== normalizedMachineId && m2 !== normalizedMachineId) {
                    return res.status(403).json({
                        message: 'Access Denied: This Guard account is already registered on 2 authorized gate machines.',
                    });
                }

                if (!m1) {
                    await pool.query(`UPDATE guard SET authorized_machine_1 = $1 WHERE id = $2`, [normalizedMachineId, user.id]);
                } else if (!m2) {
                    await pool.query(`UPDATE guard SET authorized_machine_2 = $1 WHERE id = $2`, [normalizedMachineId, user.id]);
                }
            }

            return createAuthenticatedSessionResponse(req, res, { user, role, clientIp, userAgent });
        }

        // OTP-enabled roles — send OTP and wait for verification
        if (OTP_ENABLED_ROLES.has(role)) {
            const otp = generateOtp();
            storeOtp(email, otp, role, user);

            await logAuthentication({
                actorId: user.id,
                actorType: mapActorType(role),
                action: 'SIGN_IN',
                success: true,
                ipAddress: clientIp,
                userAgent,
                eventName: 'OTP_SENT',
                endpoint: req.originalUrl,
                status: 200,
                userEmail: user.email,
                role,
            });

            // Never return OTP in the response body
            return res.status(200).json({
                success: true,
                message: 'OTP generated',
                email,
                role,
            });
        }

        return createAuthenticatedSessionResponse(req, res, { user, role, clientIp, userAgent });

    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// ======================================================
// VERIFY LOGIN OTP
// POST /api/auth/verify-login-otp
// ======================================================

router.post('/verify-login-otp', async (req, res) => {
    const { email, otp } = req.body || {};
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';

    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const result = verifyOtp(email, otp);

    if (!result || !result.valid) {
        const role = inferRoleFromEmail(email);
        await logAuthentication({
            actorId: null,
            actorType: mapActorType(role),
            action: 'SIGN_IN',
            success: false,
            ipAddress: clientIp,
            userAgent,
            eventName: 'OTP_FAILED',
            endpoint: req.originalUrl,
            status: 401,
            userEmail: email,
            role,
        });
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    const payload = result.payload;
    const role = payload.role || inferRoleFromEmail(email) || 'student';
    const user = payload.user || payload;

    if (!user?.id) {
        return res.status(400).json({ success: false, message: 'Invalid OTP payload' });
    }

    return createAuthenticatedSessionResponse(req, res, { user, role, clientIp, userAgent });
});

// ======================================================
// SIGNUP STEP 1: SEND OTP
// POST /api/auth/send-otp
// ======================================================

router.post('/send-otp', async (req, res) => {
    const data = req.body;
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';

    if (!data?.role) {
        return res.status(400).json({ message: 'Role is required' });
    }

    const { role, email } = data;

    // All accounts must use @nith.ac.in addresses
    if (!email || !isNithEmail(email)) {
        return res.status(400).json({ message: 'Only @nith.ac.in email addresses are accepted' });
    }

    try {
        let tempUserData = {};

        if (role === 'student') {
            const { password, phone, hostel, room } = data;

            const missingFields = [];
            if (!email) missingFields.push('email');
            if (!password) missingFields.push('password');
            if (!phone) missingFields.push('phone');
            if (!hostel) missingFields.push('hostel');
            if (!room) missingFields.push('room');

            if (missingFields.length > 0) {
                return res.status(400).json({
                    message: `Missing required fields: ${missingFields.join(', ')}`,
                });
            }

            const derived = extractRollInfo(email);
            const rollno = derived ? derived.rollNo : email.split('@')[0];
            const department = derived ? derived.department : 'CSE';

            const hostelResult = await pool.query(
                `SELECT id, name FROM hostel WHERE name = $1 LIMIT 1`,
                [hostel]
            );
            if (hostelResult.rows.length === 0) {
                return res.status(404).json({ message: 'Hostel not found. Pick one of the available hostels.' });
            }

            const hostelData = hostelResult.rows[0];

            // Resolve Room UUID if possible
            let roomId = null;
            const roomResult = await pool.query(
                `SELECT id FROM room WHERE hostel_id = $1 AND room_number = $2 LIMIT 1`,
                [hostelData.id, String(room).trim()]
            );
            if (roomResult.rows.length > 0) {
                roomId = roomResult.rows[0].id;
            } else if (process.env.NODE_ENV === 'development') {
                // In dev, auto-create room if it does not exist
                try {
                    const newRoomRes = await pool.query(
                        `INSERT INTO room (hostel_id, room_number, max_capacity) VALUES ($1, $2, 4) RETURNING id`,
                        [hostelData.id, String(room).trim()]
                    );
                    roomId = newRoomRes.rows[0].id;
                } catch {
                    // ignore if insert fails
                }
            }

            const hashedPassword = await bcrypt.hash(password, 10);

            tempUserData = {
                role,
                name: rollno.toUpperCase(),
                email,
                password: hashedPassword,
                hostel: hostelData.name,
                hostel_id: hostelData.id,
                room: String(room).trim(),
                room_id: roomId,
                rollno,
                phone,
                department,
                degree_type: derived?.degreeType || 'B.Tech',
            };

        } else if (role === 'attendant') {
            const { name, password, hostel, phone } = data;

            const missingFields = [];
            if (!name) missingFields.push('name');
            if (!password) missingFields.push('password');
            if (!phone) missingFields.push('phone');
            if (!hostel) missingFields.push('hostel');
            if (missingFields.length > 0) {
                return res.status(400).json({ message: `Missing required fields: ${missingFields.join(', ')}` });
            }

            const hostelResult = await pool.query(
                `SELECT id, name FROM hostel WHERE name = $1 LIMIT 1`,
                [hostel]
            );
            if (hostelResult.rows.length === 0) {
                return res.status(404).json({ message: 'Hostel not found' });
            }

            const hostelData = hostelResult.rows[0];
            const hashedPassword = await bcrypt.hash(password, 10);

            tempUserData = {
                role,
                name,
                email,
                password: hashedPassword,
                hostel: hostelData.name,
                hostel_id: hostelData.id,
                phone,
            };

        } else if (role === 'guard') {
            const { name, password, phone } = data;

            const missingFields = [];
            if (!name) missingFields.push('name');
            if (!password) missingFields.push('password');
            if (!phone) missingFields.push('phone');
            if (missingFields.length > 0) {
                return res.status(400).json({ message: `Missing required fields: ${missingFields.join(', ')}` });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            tempUserData = { role, name, email, password: hashedPassword, phone };

        } else if (role === 'warden') {
            const { name, password, authority_level } = data;

            const missingFields = [];
            if (!name) missingFields.push('name');
            if (!password) missingFields.push('password');
            if (!authority_level) missingFields.push('authority_level');
            if (missingFields.length > 0) {
                return res.status(400).json({ message: `Missing required fields: ${missingFields.join(', ')}` });
            }

            if (![1, 2, 3].includes(Number(authority_level))) {
                return res.status(400).json({ message: 'authority_level must be 1, 2, or 3' });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            tempUserData = { role, name, email, password: hashedPassword, authority_level };

        } else {
            return res.status(400).json({ message: 'Invalid role' });
        }

        const otp = generateOtp();
        storeOtp(email, otp, role, tempUserData);

        await logAuthentication({
            actorId: null,
            actorType: mapActorType(role),
            action: 'SIGN_UP',
            success: true,
            ipAddress: clientIp,
            userAgent,
            eventName: 'OTP_SENT',
            endpoint: req.originalUrl,
            status: 200,
            userEmail: email,
            role,
        });

        // Never return the OTP in the response body
        return res.status(200).json({
            success: true,
            message: 'OTP sent successfully to email.',
            email,
            role,
        });

    } catch (err) {
        console.error('[Auth] send-otp error:', err.message);

        if (err.code === '23505') {
            return res.status(409).json({ message: 'User already exists.' });
        }
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// ======================================================
// SIGNUP STEP 2: VERIFY OTP & CREATE ACCOUNT
// POST /api/auth/verify-otp  (also mounted as /signup for legacy compat)
// ======================================================

const finalizeSignup = async (req, res, { clientIp, userAgent }) => {
    const { email, otp } = req.body || {};

    if (!email || !otp) {
        return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const result = verifyOtp(email, otp);

    if (!result || !result.valid) {
        await logAuthentication({
            actorId: null,
            actorType: mapActorType('student'),
            action: 'SIGN_UP',
            success: false,
            ipAddress: clientIp,
            userAgent,
            eventName: 'INVALID_OTP',
            endpoint: req.originalUrl,
            status: 400,
            userEmail: email,
        });
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    const payload = result.payload;
    const tempUser = payload.user || payload;
    let createdUser = null;

    try {
        if (tempUser?.role) {
            const { role } = tempUser;

            if (role === 'student') {
                // Check if student exists (pre-fed record)
                const existingRes = await pool.query(
                    `SELECT id, name FROM student WHERE LOWER(roll_no) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1`,
                    [tempUser.rollno, tempUser.email]
                );

                if (existingRes.rows.length > 0) {
                    const studentId = existingRes.rows[0].id;
                    const updateRes = await pool.query(
                        `UPDATE student 
                         SET password = $1, phone = $2, hostel = $3, hostel_id = $4, physical_room_id = $5, email = $6
                         WHERE id = $7 RETURNING *`,
                        [tempUser.password, tempUser.phone, tempUser.hostel, tempUser.hostel_id, tempUser.room_id, tempUser.email, studentId]
                    );
                    createdUser = updateRes.rows[0];
                } else if (process.env.NODE_ENV === 'development') {
                    // Development mode: Create new entry if pre-fed data does not exist
                    const insertRes = await pool.query(
                        `INSERT INTO student (name, email, password, hostel, hostel_id, roll_no, phone, department, physical_room_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                         RETURNING *`,
                        [tempUser.name || tempUser.rollno.toUpperCase(), tempUser.email, tempUser.password, tempUser.hostel,
                         tempUser.hostel_id, tempUser.rollno, tempUser.phone, tempUser.department || 'CSE', tempUser.room_id]
                    );
                    createdUser = insertRes.rows[0];
                } else {
                    return res.status(404).json({
                        success: false,
                        message: `Student record for ${tempUser.rollno} not found in database. Please contact hostel administration.`
                    });
                }
            } else if (role === 'attendant') {
                const insertRes = await pool.query(
                    `INSERT INTO attendent (name, email, password, hostel, hostel_id, phone)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     RETURNING *`,
                    [tempUser.name, tempUser.email, tempUser.password, tempUser.hostel,
                     tempUser.hostel_id, tempUser.phone]
                );
                createdUser = insertRes.rows[0];
            } else if (role === 'guard') {
                const insertRes = await pool.query(
                    `INSERT INTO guard (name, email, password, phone)
                     VALUES ($1, $2, $3, $4)
                     RETURNING *`,
                    [tempUser.name, tempUser.email, tempUser.password, tempUser.phone]
                );
                createdUser = insertRes.rows[0];
            } else if (role === 'warden') {
                const insertRes = await pool.query(
                    `INSERT INTO admin (name, email, password, authority_level)
                     VALUES ($1, $2, $3, $4)
                     RETURNING *`,
                    [tempUser.name, tempUser.email, tempUser.password, tempUser.authority_level]
                );
                createdUser = insertRes.rows[0];
            }
        }

        const userObj = createdUser || tempUser;
        const role = tempUser.role;
        const refreshToken = jwt.sign({ sub: userObj.id, role }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const refreshTokenHash = await hashRefreshToken(refreshToken);
        const refreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry(role));
        const location = await lookupLocationFromIp(clientIp);

        await deactivateSessions({ actorId: userObj.id, actorType: mapActorType(role) });

        const session = await startSession({
            actorId: userObj.id,
            actorType: mapActorType(role),
            ipAddress: clientIp,
            userAgent,
            role,
            refreshTokenHash,
            refreshExpiresAt,
            isActive: true,
        });

        const accessToken = generateAccessToken({
            id: userObj.id,
            email: userObj.email,
            role,
            authority_level: userObj.authority_level,
            sessionId: session?.id,
        });

        await logAuthentication({
            actorId: userObj.id,
            actorType: mapActorType(role),
            action: 'SIGN_UP',
            success: true,
            ipAddress: clientIp,
            userAgent,
            eventName: 'ACCOUNT_CREATED',
            endpoint: req.originalUrl,
            status: 200,
            userEmail: userObj.email,
            role,
        });

        await logAuthentication({
            actorId: userObj.id,
            actorType: mapActorType(role),
            action: 'SIGN_IN',
            success: true,
            ipAddress: clientIp,
            userAgent,
            eventName: 'OTP_VERIFIED',
            endpoint: req.originalUrl,
            status: 200,
            userEmail: userObj.email,
            role,
            details: location || undefined,
        });

        if (location && session?.id) {
            await pool.query(
                `UPDATE user_session SET city = $1, state = $2, country = $3 WHERE id = $4`,
                [location.city, location.state, location.country, session.id]
            );
        }

        const opts = cookieOptions();
        res.cookie('token', accessToken, opts);
        res.cookie('refreshToken', refreshToken, opts);

        return res.status(200).json({
            success: true,
            message: 'OTP verified and account created',
            token: accessToken,
            role,
            user: sanitizeUser(userObj),
            sessionId: session?.id,
        });

    } catch (err) {
        console.error('[Auth] Error creating user during OTP verification:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to complete registration' });
    }
};

router.post('/verify-otp', async (req, res) => {
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';
    return finalizeSignup(req, res, { clientIp, userAgent });
});

// Legacy alias — same handler
router.post('/signup', async (req, res) => {
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';
    return finalizeSignup(req, res, { clientIp, userAgent });
});

// ======================================================
// CURRENT USER
// GET /api/auth/me
// ======================================================
router.get('/hostels', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, type, total_capacity
             FROM hostel
             ORDER BY name ASC`
        );

        return res.status(200).json({
            success: true,
            hostels: result.rows
        });
    } catch (err) {
        console.error('[Auth] Get hostels error:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch hostels'
        });
    }
});

router.get('/me', auth, async (req, res) => {
    const { id, email, role } = req.user;
    const tableName = ROLE_TABLES[role];

    if (!tableName) {
        return res.status(400).json({ message: 'Invalid role in token' });
    }

    try {
        const result = await pool.query(
            `SELECT * FROM ${tableName} WHERE id = $1 AND email = $2 LIMIT 1`,
            [id, email]
        );

        const user = result.rows[0];
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).json({ user: sanitizeUser(user), role });

    } catch (err) {
        console.error('[Auth] /me error:', err.message);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

// ======================================================
// LOGOUT
// POST /api/auth/logout
// ======================================================

router.post('/logout', async (req, res) => {
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';

    // Accept token from cookie (preferred) or Authorization header (fallback)
    const cookieToken = req.cookies?.token;
    const authHeader = req.headers.authorization || '';
    const token = cookieToken || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers.token);

    // Clear cookies regardless of token validity
    const opts = cookieOptions();
    res.clearCookie('token', opts);
    res.clearCookie('refreshToken', opts);

    if (!token) {
        return res.status(200).json({ message: 'Logged out' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const actorType = mapActorType(decoded.role || 'student');
        const activeSession = await getActiveSession({ actorId: decoded.id, actorType });
        await deactivateSessions({ actorId: decoded.id, actorType });
        if (activeSession?.id) {
            await endSession(activeSession.id);
        }
        await logAuthentication({
            actorId: decoded.id,
            actorType,
            action: 'SIGN_OUT',
            success: true,
            ipAddress: clientIp,
            userAgent,
            eventName: 'LOGOUT',
            endpoint: req.originalUrl,
            status: 200,
            userEmail: decoded.email,
            role: decoded.role,
        });
    } catch {
        // Token invalid or expired — cookies already cleared, just return success
    }

    return res.status(200).json({ message: 'Logged out' });
});

// ======================================================
// REFRESH TOKEN
// POST /api/auth/refresh
// ======================================================

router.post('/refresh', async (req, res) => {
    const clientIp = getClientIp(req);
    const userAgent = req.get('user-agent') || '';

    // Accept access token from cookie or Authorization header
    const cookieToken = req.cookies?.token;
    const authHeader = req.headers.authorization || '';
    const token = cookieToken || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers.token);

    // Accept refresh token from cookie or request body
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!token || !refreshToken) {
        return res.status(401).json({ message: 'Token and refresh token are required' });
    }

    try {
        // Use ignoreExpiration because access tokens may be expired — that's
        // why the client is calling /refresh in the first place.
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
        const actorType = mapActorType(decoded.role || 'student');
        const activeSession = await getActiveSession({ actorId: decoded.id, actorType });

        if (!activeSession?.refresh_token_hash) {
            return res.status(401).json({ message: 'No active session found' });
        }

        const tokenMatches = await compareRefreshTokens(refreshToken, activeSession.refresh_token_hash);
        if (!tokenMatches || new Date(activeSession.refresh_expires_at) < new Date()) {
            return res.status(401).json({ message: 'Invalid or expired refresh token' });
        }

        const newRefreshToken = jwt.sign(
            { sub: decoded.id, role: decoded.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        const newRefreshTokenHash = await hashRefreshToken(newRefreshToken);
        const newRefreshExpiresAt = new Date(Date.now() + getRefreshTokenExpiry(decoded.role));

        const updatedSession = await rotateSessionRefresh(activeSession.id, {
            refreshTokenHash: newRefreshTokenHash,
            refreshExpiresAt: newRefreshExpiresAt,
            isActive: true,
        });

        const newAccessToken = generateAccessToken({
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            authority_level: decoded.authority_level,
            sessionId: updatedSession?.id || activeSession.id,
        });

        await logAuthentication({
            actorId: decoded.id,
            actorType,
            action: 'SIGN_IN',
            success: true,
            ipAddress: clientIp,
            userAgent,
            eventName: 'REFRESH_TOKEN_ROTATED',
            endpoint: req.originalUrl,
            status: 200,
            userEmail: decoded.email,
            role: decoded.role,
        });

        const opts = cookieOptions();
        res.cookie('token', newAccessToken, opts);
        res.cookie('refreshToken', newRefreshToken, opts);

        return res.status(200).json({
            success: true,
            token: newAccessToken,
            sessionId: updatedSession?.id,
        });

    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
});

// ======================================================
// GET ROOMS FOR A HOSTEL (for signup dropdowns)
// GET /api/auth/rooms/:hostelName
// ======================================================
router.get('/rooms/:hostelName', async (req, res) => {
    const { hostelName } = req.params;
    try {
        const hostelRes = await pool.query(`SELECT id FROM hostel WHERE LOWER(name) = LOWER($1) LIMIT 1`, [hostelName]);
        if (hostelRes.rows.length === 0) {
            return res.status(200).json({ success: true, rooms: [] });
        }
        const hostelId = hostelRes.rows[0].id;
        const roomsRes = await pool.query(`SELECT id, room_number FROM room WHERE hostel_id = $1 ORDER BY room_number ASC`, [hostelId]);
        return res.status(200).json({ success: true, rooms: roomsRes.rows });
    } catch (err) {
        console.error('[Auth] Get rooms error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch rooms' });
    }
});

export default router;