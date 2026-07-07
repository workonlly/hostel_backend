/**
 * event.routes.js — Year-based Allocation Event Management API
 *
 * New architecture: allocation_event replaces per-hostel phase/date tracking.
 * Multiple hostel admins contribute rooms to a shared event for a student year.
 *
 * Authority levels:
 *   1 = View only
 *   2 = Warden — create/modify events, set dates, trigger phases
 *   3 = Other admin — view + room override, NOT set date
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import pool from '../../db/pool.js';
import { setCurrentPhase, pauseAllocation, resumeAllocation } from '../services/phase.service.js';
import { invalidateRooms } from '../../cache/roomCache.js';
import * as cacheService from '../../cache/cache.service.js';

const router = express.Router();

// ─── Auth Middleware ──────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeLobbyOpensAt(allocationDate) {
    // lobby_opens_at = allocationDate − 5 days at 03:30 UTC (= 09:00 IST)
    const d = new Date(allocationDate + 'T03:30:00Z');
    d.setUTCDate(d.getUTCDate() - 5);
    return d;
}

function validateSaturday(allocationDate) {
    const d = new Date(allocationDate + 'T00:00:00Z');
    return d.getUTCDay() === 6; // 6 = Saturday
}

async function getRoomIds(hostelId, rooms) {
    if (rooms === 'ALL') {
        const res = await pool.query(`SELECT id FROM room WHERE hostel_id = $1`, [hostelId]);
        return res.rows.map(r => r.id);
    }
    return rooms;
}

// ─── GET /api/admin/events ────────────────────────────────────────────────────
// List all allocation events with participating hostel counts.

router.get('/events', adminAuth, async (req, res) => {
    try {
        const events = await pool.query(`
            SELECT
                ae.id, ae.target_year, ae.allocation_date, ae.lobby_opens_at,
                ae.status, ae.is_paused, ae.created_at,
                COUNT(DISTINCT ehp.hostel_id)   AS participating_hostels,
                COUNT(DISTINCT erp.room_id)     AS total_rooms,
                COUNT(DISTINCT b.id)            AS batch_count
            FROM allocation_event ae
            LEFT JOIN event_hostel_participation ehp ON ehp.allocation_event_id = ae.id
            LEFT JOIN event_room_pool erp            ON erp.allocation_event_id = ae.id
            LEFT JOIN batch b                        ON b.allocation_event_id   = ae.id
            GROUP BY ae.id
            ORDER BY ae.target_year ASC, ae.created_at DESC
        `);
        return res.json({ success: true, events: events.rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── GET /api/admin/events/:eventId ──────────────────────────────────────────
// Full event detail: room pool grouped by hostel, batches, phase.

router.get('/events/:eventId', adminAuth, async (req, res) => {
    try {
        const { eventId } = req.params;

        const eventRes = await pool.query(
            `SELECT * FROM allocation_event WHERE id = $1`,
            [eventId]
        );
        if (eventRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        // Hostels contributing rooms
        const hostelRes = await pool.query(`
            SELECT h.id, h.name, h.type,
                   COUNT(erp.room_id) AS room_count
            FROM event_hostel_participation ehp
            JOIN hostel h ON h.id = ehp.hostel_id
            LEFT JOIN event_room_pool erp ON erp.hostel_id = h.id
                                         AND erp.allocation_event_id = $1
            WHERE ehp.allocation_event_id = $1
            GROUP BY h.id, h.name, h.type
            ORDER BY h.name ASC
        `, [eventId]);

        // Room pool grouped by hostel
        const poolRes = await pool.query(`
            SELECT r.id, r.room_number, r.block, r.room_type,
                   r.max_capacity, r.current_occupancy, r.hostel_id,
                   h.name AS hostel_name,
                   erp.added_at
            FROM event_room_pool erp
            JOIN room r   ON r.id = erp.room_id
            JOIN hostel h ON h.id = erp.hostel_id
            WHERE erp.allocation_event_id = $1
            ORDER BY h.name, r.block NULLS FIRST, r.room_number ASC
        `, [eventId]);

        // Batches
        const batchRes = await pool.query(
            `SELECT id, batch_number, start_time, end_time, status FROM batch
             WHERE allocation_event_id = $1 ORDER BY batch_number ASC`,
            [eventId]
        );

        return res.json({
            success: true,
            event: eventRes.rows[0],
            participatingHostels: hostelRes.rows,
            roomPool: poolRes.rows,
            batches: batchRes.rows,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/events ───────────────────────────────────────────────────
// Create or join an allocation event for a student year.
//
// Body:
//   targetYear     — INT (2, 3, 4 …)
//   allocationDate — YYYY-MM-DD, must be a Saturday
//   hostelId       — UUID of the admin's hostel
//   rooms          — ['uuid',...] | 'ALL'
//
// If an active event already exists for targetYear, this admin joins it.
// The allocationDate must match the existing event's date, unless the admin
// explicitly wants to change it (use PATCH /events/:id/date for that).

router.post('/events', adminAuth, requireLevel(2), async (req, res) => {
    const { targetYear, allocationDate, hostelId, rooms } = req.body;

    if (!targetYear || !hostelId || !rooms) {
        return res.status(400).json({
            success: false,
            message: 'targetYear, hostelId, and rooms are required'
        });
    }

    if (allocationDate && !validateSaturday(allocationDate)) {
        return res.status(400).json({ success: false, message: 'Allocation date must be a Saturday' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if an active event exists for this year
        const existingRes = await client.query(
            `SELECT id, allocation_date FROM allocation_event
             WHERE target_year = $1
               AND status != 'ADMIN_MODE'
             LIMIT 1`,
            [targetYear]
        );

        let eventId;
        let existingDate = null;

        if (existingRes.rowCount > 0) {
            // Join existing event
            eventId = existingRes.rows[0].id;
            existingDate = existingRes.rows[0].allocation_date;

            if (allocationDate && existingDate) {
                const reqDate = new Date(allocationDate).toISOString().split('T')[0];
                const extDate = new Date(existingDate).toISOString().split('T')[0];
                if (reqDate !== extDate) {
                    // Return a conflict — admin must use PATCH /events/:id/date to change
                    await client.query('ROLLBACK');
                    return res.status(409).json({
                        success: false,
                        message: `An event for year ${targetYear} already exists with date ${extDate}. ` +
                                 `Use PATCH /api/admin/events/${eventId}/date to change it (affects all hostels).`,
                        eventId,
                        existingDate: extDate,
                    });
                }
            }
        } else {
            // Create new event
            if (!allocationDate) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'allocationDate is required when creating a new event'
                });
            }
            const lobbyOpensAt = computeLobbyOpensAt(allocationDate);
            const newEventRes = await client.query(
                `INSERT INTO allocation_event (target_year, allocation_date, lobby_opens_at, status)
                 VALUES ($1, $2, $3, 'ADMIN_MODE')
                 RETURNING id`,
                [targetYear, allocationDate, lobbyOpensAt]
            );
            eventId = newEventRes.rows[0].id;
        }

        // Register hostel participation
        await client.query(
            `INSERT INTO event_hostel_participation (allocation_event_id, hostel_id)
             VALUES ($1, $2)
             ON CONFLICT (allocation_event_id, hostel_id) DO NOTHING`,
            [eventId, hostelId]
        );

        // Resolve room IDs
        const roomIds = await getRoomIds(hostelId, rooms);
        if (roomIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No rooms found for the given selection' });
        }

        // Replace existing pool entries for this hostel in this event
        await client.query(
            `DELETE FROM event_room_pool
             WHERE allocation_event_id = $1 AND hostel_id = $2`,
            [eventId, hostelId]
        );

        for (const roomId of roomIds) {
            await client.query(
                `INSERT INTO event_room_pool (allocation_event_id, hostel_id, room_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (allocation_event_id, room_id) DO NOTHING`,
                [eventId, hostelId, roomId]
            );
        }

        await client.query('COMMIT');

        // Invalidate caches
        await cacheService.setCache(`event:${eventId}:filters`, null, 0);
        await invalidateRooms(hostelId);

        return res.json({
            success: true,
            message: existingDate
                ? `Joined existing event for year ${targetYear}`
                : `Created new event for year ${targetYear}`,
            eventId,
            roomsAdded: roomIds.length,
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ─── PATCH /api/admin/events/:eventId/date ───────────────────────────────────
// Update the shared allocation date for an event.
// Affects ALL participating hostels.
//
// Body: { allocationDate: "YYYY-MM-DD" }

router.patch('/events/:eventId/date', adminAuth, requireLevel(2), async (req, res) => {
    const { eventId } = req.params;
    const { allocationDate } = req.body;

    if (!allocationDate) {
        return res.status(400).json({ success: false, message: 'allocationDate is required' });
    }
    if (!validateSaturday(allocationDate)) {
        return res.status(400).json({ success: false, message: 'Allocation date must be a Saturday' });
    }

    // Verify admin's hostel participates in this event (optional — any level 2 can change)
    try {
        const lobbyOpensAt = computeLobbyOpensAt(allocationDate);

        const result = await pool.query(
            `UPDATE allocation_event
             SET allocation_date = $1, lobby_opens_at = $2, updated_at = NOW()
             WHERE id = $3
             RETURNING id, target_year, allocation_date, lobby_opens_at, status`,
            [allocationDate, lobbyOpensAt, eventId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        // Invalidate phase cache for this event
        await cacheService.setCache(`phase:event:${eventId}`, null, 0);

        return res.json({
            success: true,
            message: `Allocation date updated to ${allocationDate} for all participating hostels`,
            event: result.rows[0],
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ─── PATCH /api/admin/events/:eventId/rooms ──────────────────────────────────
// Update the room pool for one hostel's contribution to an event.
//
// Body: { hostelId, rooms: ['uuid',...] | 'ALL' }

router.patch('/events/:eventId/rooms', adminAuth, requireLevel(2), async (req, res) => {
    const { eventId } = req.params;
    const { hostelId, rooms } = req.body;

    if (!hostelId || !rooms) {
        return res.status(400).json({ success: false, message: 'hostelId and rooms are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const roomIds = await getRoomIds(hostelId, rooms);
        if (roomIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No rooms found' });
        }

        // Ensure hostel participates
        await client.query(
            `INSERT INTO event_hostel_participation (allocation_event_id, hostel_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [eventId, hostelId]
        );

        // Replace room pool for this hostel
        await client.query(
            `DELETE FROM event_room_pool
             WHERE allocation_event_id = $1 AND hostel_id = $2`,
            [eventId, hostelId]
        );

        for (const roomId of roomIds) {
            await client.query(
                `INSERT INTO event_room_pool (allocation_event_id, hostel_id, room_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (allocation_event_id, room_id) DO NOTHING`,
                [eventId, hostelId, roomId]
            );
        }

        await client.query('COMMIT');

        // Invalidate filter cache
        await cacheService.setCache(`event:${eventId}:filters`, null, 0);
        await invalidateRooms(hostelId);

        return res.json({
            success: true,
            message: `Room pool updated for hostel ${hostelId} in event ${eventId}`,
            roomsAdded: roomIds.length,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ─── POST /api/admin/events/:eventId/phase ───────────────────────────────────
// Trigger a phase transition for an allocation event.
//
// Body: { phase: 'LOBBY' | 'SOFT_LOCK' | 'LIVE_BATCHES' | 'FINAL_SWEEP' | 'ADMIN_MODE' }

router.post('/events/:eventId/phase', adminAuth, requireLevel(2), async (req, res) => {
    const { eventId } = req.params;
    const { phase } = req.body;

    if (!phase) {
        return res.status(400).json({ success: false, message: 'phase is required' });
    }

    try {
        const event = await setCurrentPhase(eventId, phase);
        return res.json({ success: true, message: `Event transitioned to ${phase}`, event });
    } catch (err) {
        return res.status(err.statusCode ?? 500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/events/:eventId/pause ───────────────────────────────────

router.post('/events/:eventId/pause', adminAuth, requireLevel(2), async (req, res) => {
    try {
        const event = await pauseAllocation(req.params.eventId);
        return res.json({ success: true, event });
    } catch (err) {
        return res.status(err.statusCode ?? 500).json({ success: false, message: err.message });
    }
});

// ─── POST /api/admin/events/:eventId/resume ──────────────────────────────────

router.post('/events/:eventId/resume', adminAuth, requireLevel(2), async (req, res) => {
    try {
        const event = await resumeAllocation(req.params.eventId);
        return res.json({ success: true, event });
    } catch (err) {
        return res.status(err.statusCode ?? 500).json({ success: false, message: err.message });
    }
});

// ─── GET /api/admin/events/:eventId/pool ─────────────────────────────────────
// Get the room pool for an event, grouped by hostel.

router.get('/events/:eventId/pool', adminAuth, async (req, res) => {
    try {
        const res2 = await pool.query(`
            SELECT h.id AS hostel_id, h.name AS hostel_name,
                   json_agg(json_build_object(
                       'id', r.id,
                       'room_number', r.room_number,
                       'block', r.block,
                       'room_type', r.room_type,
                       'max_capacity', r.max_capacity,
                       'current_occupancy', r.current_occupancy
                   ) ORDER BY r.block NULLS FIRST, r.room_number) AS rooms
            FROM event_room_pool erp
            JOIN room r   ON r.id   = erp.room_id
            JOIN hostel h ON h.id   = erp.hostel_id
            WHERE erp.allocation_event_id = $1
            GROUP BY h.id, h.name
            ORDER BY h.name
        `, [req.params.eventId]);

        return res.json({ success: true, pool: res2.rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
