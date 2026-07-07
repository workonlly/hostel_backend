/**
 * admin.routes.js — Admin allocation scheduling endpoints
 *
 * Authority levels:
 *   1 = View only
 *   2 = Warden — can set allocation date + trigger phase transitions
 *   3 = Other admin — view + room override, but NOT set allocation date
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import pool from '../../db/pool.js';
import { setCurrentPhase } from '../services/phase.service.js';
import { previewRankUpdate, executeRankUpdate } from '../services/rankUpdate.service.js';
import { invalidateRooms } from '../../cache/roomCache.js';

const router = express.Router();

// ─── Multer setup for rank/CGPA CSV upload ────────────────────────────────────

const tempDir = 'uploads/temp/';
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const rankUploadStorage = multer.diskStorage({
    destination: tempDir,
    filename: (req, file, cb) => {
        const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, 'rank-' + suffix + path.extname(file.originalname));
    },
});
const rankUpload = multer({
    storage: rankUploadStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.csv', '.xls', '.xlsx'].includes(ext)) cb(null, true);
        else cb(new Error('Unsupported file format. Use .csv, .xls or .xlsx'));
    },
});

// ─── Admin Auth Middleware ────────────────────────────────────────────────────

function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.authority_level) {
            return res.status(403).json({ success: false, message: 'Not an admin account' });
        }
        req.admin = decoded;
        next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

function requireLevel(minLevel) {
    return (req, res, next) => {
        if ((req.admin?.authority_level ?? 0) < minLevel) {
            return res.status(403).json({
                success: false,
                message: `Requires authority level ${minLevel} or higher`
            });
        }
        next();
    };
}

// ─── GET /api/admin/hostels ───────────────────────────────────────────────────
// Returns all hostels (simplified — phase/date now live on allocation_event).

router.get('/hostels', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, type, total_capacity, created_at
             FROM hostel ORDER BY name ASC`
        );
        return res.json({ success: true, hostels: result.rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── GET /api/admin/hostels-with-rooms ──────────────────────────────────────
// Returns all hostels with their rooms, grouped for the pool configurator UI.

router.get('/hostels-with-rooms', async (req, res) => {
    try {
        const hostelsRes = await pool.query(
            `SELECT id, name, type FROM hostel ORDER BY name ASC`
        );
        const hostels = hostelsRes.rows;

        if (hostels.length === 0) return res.json({ success: true, hostels: [] });

        const hostelIds = hostels.map(h => h.id);
        const roomsRes = await pool.query(
            `SELECT id, hostel_id, room_number, block, room_type,
                    max_capacity, current_occupancy
             FROM room
             WHERE hostel_id = ANY($1::uuid[])
             ORDER BY hostel_id, block NULLS FIRST, room_number ASC`,
            [hostelIds]
        );

        // Group rooms by hostel_id
        const roomsByHostel = {};
        for (const room of roomsRes.rows) {
            if (!roomsByHostel[room.hostel_id]) roomsByHostel[room.hostel_id] = [];
            roomsByHostel[room.hostel_id].push(room);
        }

        const result = hostels.map(h => ({
            ...h,
            rooms: roomsByHostel[h.id] ?? [],
        }));

        return res.json({ success: true, hostels: result });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/set-allocation-pool ─────────────────────────────────────
//
// Configures a fully custom room pool for a FROM hostel.
//
// Body:
//   fromHostelId   — the hostel whose STUDENTS will participate
//   allocationDate — YYYY-MM-DD string; must be a Saturday
//   hostels        — array of { hostelId, rooms: ['uuid',...] | 'ALL' }
//                    rooms: 'ALL' means every room in that hostel;
//                           array means specific room UUIDs only.

router.post('/set-allocation-pool', async (req, res) => {
    const { fromHostelId, allocationDate, hostels: toHostelEntries } = req.body;

    if (!fromHostelId || !allocationDate || !Array.isArray(toHostelEntries) || toHostelEntries.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'fromHostelId, allocationDate, and at least one hostel entry are required'
        });
    }

    // Validate Saturday
    const date = new Date(allocationDate + 'T00:00:00Z');
    if (date.getUTCDay() !== 6) {
        return res.status(400).json({
            success: false,
            message: 'Allocation date must be a Saturday'
        });
    }

    const lobbyDate = new Date(date);
    lobbyDate.setUTCDate(lobbyDate.getUTCDate() - 5);
    lobbyDate.setUTCHours(3, 30, 0, 0);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify FROM hostel exists
        const fromRes = await client.query('SELECT id, name FROM hostel WHERE id = $1', [fromHostelId]);
        if (fromRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'From-hostel not found' });
        }

        // Collect all room IDs to add to the pool
        let allRoomIds = [];
        const hostelNames = [];

        for (const entry of toHostelEntries) {
            const { hostelId, rooms } = entry;

            // Verify TO hostel exists
            const toRes = await client.query('SELECT id, name FROM hostel WHERE id = $1', [hostelId]);
            if (toRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: `To-hostel ${hostelId} not found` });
            }
            hostelNames.push(toRes.rows[0].name);

            if (rooms === 'ALL') {
                // Select all rooms in this hostel
                const allRoomsRes = await client.query(
                    `SELECT id FROM room WHERE hostel_id = $1`, [hostelId]
                );
                allRoomIds = allRoomIds.concat(allRoomsRes.rows.map(r => r.id));
            } else if (Array.isArray(rooms) && rooms.length > 0) {
                // Validate that every submitted room ID belongs to this hostel
                const validRes = await client.query(
                    `SELECT id FROM room WHERE id = ANY($1::uuid[]) AND hostel_id = $2`,
                    [rooms, hostelId]
                );
                if (validRes.rowCount !== rooms.length) {
                    const foundIds = new Set(validRes.rows.map(r => r.id));
                    const invalid = rooms.filter(id => !foundIds.has(id));
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        message: `Rooms not found in hostel ${toRes.rows[0].name}: ${invalid.join(', ')}`
                    });
                }
                allRoomIds = allRoomIds.concat(rooms);
            }
        }

        if (allRoomIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Pool must contain at least one room' });
        }

        // Clear existing pool for this source hostel
        await client.query(
            `DELETE FROM allocation_room_pool WHERE source_hostel_id = $1`,
            [fromHostelId]
        );

        // Insert new pool rows
        const poolValues = allRoomIds.map((roomId, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
            `INSERT INTO allocation_room_pool (source_hostel_id, room_id) VALUES ${poolValues}
             ON CONFLICT (source_hostel_id, room_id) DO NOTHING`,
            [fromHostelId, ...allRoomIds]
        );

        // Update FROM hostel — set allocation date, lobby open time
        const fromUpdate = await client.query(
            `UPDATE hostel
             SET allocation_date  = $1,
                 lobby_opens_at   = $2
             WHERE id = $3
             RETURNING id, name, allocation_date, lobby_opens_at, current_phase`,
            [allocationDate, lobbyDate.toISOString(), fromHostelId]
        );

        await client.query('COMMIT');

        // Invalidate rooms cache for every TO hostel so getLiveRoomMap
        // returns fresh pool data on the next student/warden request.
        // Matches the PG commit → Redis invalidate pattern from room.service.js.
        for (const entry of toHostelEntries) {
            await invalidateRooms(entry.hostelId).catch(() => {});
        }

        return res.json({
            success: true,
            fromHostel: fromUpdate.rows[0],
            poolSize: allRoomIds.length,
            toHostels: hostelNames,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ─── GET /api/admin/allocation-pool/:fromHostelId ─────────────────────────────
// Returns the current pool config for a FROM hostel, grouped by TO hostel.

router.get('/allocation-pool/:fromHostelId', async (req, res) => {
    try {
        const { fromHostelId } = req.params;
        const result = await pool.query(
            `SELECT
                 arp.room_id,
                 r.room_number,
                 r.block,
                 r.room_type,
                 r.max_capacity,
                 r.current_occupancy,
                 r.hostel_id AS to_hostel_id,
                 h.name     AS to_hostel_name
             FROM allocation_room_pool arp
             JOIN room   r ON r.id = arp.room_id
             JOIN hostel h ON h.id = r.hostel_id
             WHERE arp.source_hostel_id = $1
             ORDER BY h.name, r.block NULLS FIRST, r.room_number ASC`,
            [fromHostelId]
        );

        // Group by to_hostel_id
        const grouped = {};
        for (const row of result.rows) {
            if (!grouped[row.to_hostel_id]) {
                grouped[row.to_hostel_id] = {
                    hostelId:   row.to_hostel_id,
                    hostelName: row.to_hostel_name,
                    rooms: [],
                };
            }
            grouped[row.to_hostel_id].rooms.push({
                id:          row.room_id,
                roomNumber:  row.room_number,
                block:       row.block,
                roomType:    row.room_type,
                maxCapacity: row.max_capacity,
                occupancy:   row.current_occupancy,
            });
        }

        return res.json({
            success: true,
            fromHostelId,
            totalRooms: result.rowCount,
            hostels: Object.values(grouped),
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/set-allocation-date ─────────────────────────────────────
// @deprecated  Use POST /set-allocation-pool instead.
//
// Kept for backward compatibility. Sets a single-hostel pool
// (all rooms of toHostelId) and the allocation date.
//
// Body:
//   fromHostelId   — the hostel whose STUDENTS will participate in this cycle
//   toHostelId     — the hostel whose ROOMS will be shown and allocated
//   allocationDate — YYYY-MM-DD string; must be a Saturday

router.post('/set-allocation-date', async (req, res) => {
    const { fromHostelId, toHostelId, allocationDate } = req.body;

    if (!fromHostelId || !toHostelId || !allocationDate) {
        return res.status(400).json({
            success: false,
            message: 'fromHostelId, toHostelId, and allocationDate are required'
        });
    }

    // Validate it's a Saturday (day = 6)
    const date = new Date(allocationDate + 'T00:00:00Z');
    if (date.getUTCDay() !== 6) {
        return res.status(400).json({
            success: false,
            message: 'Allocation date must be a Saturday'
        });
    }

    // lobby_opens_at = allocationDate - 5 days at 09:00 IST (03:30 UTC)
    const lobbyDate = new Date(date);
    lobbyDate.setUTCDate(lobbyDate.getUTCDate() - 5);
    lobbyDate.setUTCHours(3, 30, 0, 0); // 9:00 AM IST = 3:30 AM UTC

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify both hostels exist
        const fromRes = await client.query('SELECT id, name FROM hostel WHERE id = $1', [fromHostelId]);
        if (fromRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'From-hostel not found' });
        }

        const toRes = await client.query('SELECT id, name FROM hostel WHERE id = $1', [toHostelId]);
        if (toRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'To-hostel not found' });
        }

        // Update the FROM hostel: set allocation schedule + target link (kept for display)
        const fromUpdate = await client.query(
            `UPDATE hostel
             SET allocation_date    = $1,
                 lobby_opens_at     = $2,
                 target_hostel_id   = $3
             WHERE id = $4
             RETURNING id, name, allocation_date, lobby_opens_at, current_phase,
                       target_hostel_id`,
            [allocationDate, lobbyDate.toISOString(), toHostelId, fromHostelId]
        );

        // Update the TO hostel: set reverse source link
        await client.query(
            `UPDATE hostel SET source_hostel_id = $1 WHERE id = $2`,
            [fromHostelId, toHostelId]
        );

        // Also populate allocation_room_pool with ALL rooms of toHostelId
        // so the new pool-aware engine works correctly even when using the legacy endpoint.
        const toRoomsRes = await client.query(
            `SELECT id FROM room WHERE hostel_id = $1`, [toHostelId]
        );
        if (toRoomsRes.rowCount > 0) {
            await client.query(
                `DELETE FROM allocation_room_pool WHERE source_hostel_id = $1`,
                [fromHostelId]
            );
            const poolVals = toRoomsRes.rows.map((r, i) => `($1, $${i + 2})`).join(', ');
            await client.query(
                `INSERT INTO allocation_room_pool (source_hostel_id, room_id) VALUES ${poolVals}
                 ON CONFLICT (source_hostel_id, room_id) DO NOTHING`,
                [fromHostelId, ...toRoomsRes.rows.map(r => r.id)]
            );
        }

        await client.query('COMMIT');

        return res.json({
            success: true,
            deprecated: true,
            message: 'Use POST /set-allocation-pool for multi-hostel pool configuration.',
            fromHostel: fromUpdate.rows[0],
            toHostel: { id: toRes.rows[0].id, name: toRes.rows[0].name },
            poolSize: toRoomsRes.rowCount,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ─── GET /api/admin/allocation-status/:hostelId ───────────────────────────────

router.get('/allocation-status/:hostelId', async (req, res) => {
    try {
        const hostelRes = await pool.query(
            `SELECT h.id, h.name, h.current_phase, h.is_paused,
                    h.allocation_date, h.lobby_opens_at,
                    h.target_hostel_id, h.source_hostel_id,
                    th.name AS target_hostel_name,
                    sh.name AS source_hostel_name
             FROM hostel h
             LEFT JOIN hostel th ON th.id = h.target_hostel_id
             LEFT JOIN hostel sh ON sh.id = h.source_hostel_id
             WHERE h.id = $1`,
            [req.params.hostelId]
        );
        if (hostelRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Hostel not found' });
        }

        const hostel = hostelRes.rows[0];

        // Get batch summary
        const batchRes = await pool.query(
            `SELECT batch_number, status, start_time, end_time
             FROM batch WHERE hostel_id = $1 ORDER BY batch_number ASC`,
            [req.params.hostelId]
        );

        // Get unallocated student count
        const unallocRes = await pool.query(
            `SELECT COUNT(*) as cnt FROM student WHERE is_allotted = false`
        );

        return res.json({
            success: true,
            hostel,
            batches: batchRes.rows,
            unallocatedCount: parseInt(unallocRes.rows[0].cnt),
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/trigger-phase ───────────────────────────────────────────

router.post('/trigger-phase', async (req, res) => {
    const { hostelId, phase } = req.body;
    if (!hostelId || !phase) {
        return res.status(400).json({ success: false, message: 'hostelId and phase are required' });
    }
    try {
        const updated = await setCurrentPhase(hostelId, phase);
        return res.json({ success: true, hostel: updated });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/rank-update/upload ──────────────────────────────────────
// Step 1: Upload CSV/XLSX and preview auto-detected column mappings

router.post('/rank-update/upload', rankUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        const result = await previewRankUpdate(req.file.path, req.file.filename);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/rank-update/confirm ─────────────────────────────────────
// Step 2: Confirm and execute the rank + CGPA update

router.post('/rank-update/confirm', async (req, res) => {
    try {
        const { fileId, mappings } = req.body;
        if (!fileId || !mappings) {
            return res.status(400).json({ success: false, message: 'fileId and mappings are required' });
        }
        const result = await executeRankUpdate(fileId, mappings);
        return res.json({ success: true, ...result });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ success: false, message: err.message });
    }
});

export default router;
