import express from "express";
import { allocationService } from "./services/allocation.service.js";
import auth from "../middleware/middleware.js";
import pool from "../db/pool.js";
import { emit, WS_EVENTS } from "./websocket/emitter.js";

const router = express.Router();
router.use(auth);

// =====================================================
// EXECUTE BATCH ROUND
// =====================================================
router.post("/run", async (req, res) => {
    try {
        const { batchId, roundNumber, roundDurationMs } = req.body;

        if (!batchId || !roundNumber) {
            return res.status(400).json({
                success: false,
                message: "batchId and roundNumber are required"
            });
        }

        const result = await allocationService.executeBatchRound(batchId, roundNumber);

        // Keep websocket clients in sync when this manual endpoint is used.
        const batchRes = await pool.query(
            `SELECT allocation_event_id, end_time FROM batch WHERE id = $1`,
            [batchId]
        );
        if (batchRes.rowCount > 0) {
            const eventId = batchRes.rows[0].allocation_event_id;
            const batchEndTime = batchRes.rows[0].end_time;
            const rooms = await allocationService.getLiveRoomMap(eventId);

            emit(WS_EVENTS.ROUND_EXECUTED, { batchId, round: roundNumber, result }, eventId);
            emit(WS_EVENTS.ROOM_MAP_UPDATED, { eventId, batchId, round: roundNumber, rooms }, eventId);

            // Emit ROUND_OPENED for the next round if still within the batch
            const nextRound = roundNumber + 1;
            const TOTAL_ROUNDS = 6;
            if (nextRound <= TOTAL_ROUNDS) {
                const durationMs = roundDurationMs ?? (10 * 60 * 1000);
                const roundEndsAt = new Date(Date.now() + durationMs).toISOString();
                emit(WS_EVENTS.ROUND_OPENED, {
                    batchId,
                    eventId,
                    roundNumber: nextRound,
                    roundEndsAt,
                }, eventId);
            }
        }

        res.status(200).json({
            success: true,
            result
        });

    } catch (error) {
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
});

// =====================================================
// OPEN ROUND (sets real round timer on all clients)
// =====================================================
router.post("/dev/open-round", async (req, res) => {
    try {
        const { batchId, roundNumber, roundDurationMs } = req.body;
        if (!batchId || !roundNumber) {
            return res.status(400).json({ success: false, message: "batchId and roundNumber are required" });
        }
        const batchRes = await pool.query(`SELECT allocation_event_id FROM batch WHERE id = $1`, [batchId]);
        if (batchRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Batch not found" });
        }
        const eventId = batchRes.rows[0].allocation_event_id;
        const durationMs = roundDurationMs ?? (10 * 60 * 1000);
        const roundEndsAt = new Date(Date.now() + durationMs).toISOString();

        emit(WS_EVENTS.ROUND_OPENED, { batchId, eventId, roundNumber, roundEndsAt }, eventId);

        res.status(200).json({ success: true, roundNumber, roundEndsAt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// =====================================================
// SUBMIT PREFERENCES
// =====================================================
router.post("/submit-preferences", async (req, res) => {
    try {
        const result = await allocationService.submitPreferences(req.body);
        res.status(200).json({ success: true, result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

// =====================================================
// LIVE ROOM MAP — now event-scoped
// =====================================================
router.get("/rooms/:eventId", async (req, res) => {
    try {
        const result = await allocationService.getLiveRoomMap(req.params.eventId, req.query.studentId);
        res.status(200).json({ success: true, rooms: result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

// =====================================================
// ROOM FILTERS — now event-scoped
// =====================================================
router.get("/filters/:eventId", async (req, res) => {
    try {
        const result = await allocationService.getRoomFilters(req.params.eventId);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

// =====================================================
// ALLOCATION STATUS
// =====================================================
router.get("/status/:studentId", async (req, res) => {
    try {
        const result = await allocationService.getAllocationStatus(req.params.studentId);
        res.status(200).json({ success: true, result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

// =====================================================
// BATCH RESULTS
// =====================================================
router.get("/results/:batchId", async (req, res) => {
    try {
        const result = await allocationService.getBatchResults(req.params.batchId);
        res.status(200).json({ success: true, result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

// =====================================================
// ALL BATCHES FOR EVENT (Timeline)
// =====================================================
router.get("/batches/:eventId", async (req, res) => {
    try {
        const result = await allocationService.getBatches(req.params.eventId);
        res.status(200).json({ success: true, result });
    } catch (error) {
        // Fallback since getBatches might not exist
        const db = (await import("../db/pool.js")).default;
        const batchesRes = await db.query(
            `SELECT id as batch_id, batch_number, start_time, end_time, status
             FROM batch WHERE allocation_event_id = $1 ORDER BY batch_number ASC`,
            [req.params.eventId]
        );
        res.status(200).json({ success: true, batches: batchesRes.rows });
    }
});

// =====================================================
// DEV TOOLS
// =====================================================
router.post("/dev/advance-phase", async (req, res) => {
    try {
        const { setCurrentPhase } = await import("./services/phase.service.js");
        const { emit, WS_EVENTS }  = await import("./websocket/emitter.js");
        const { eventId, targetPhase } = req.body;
        await setCurrentPhase(eventId, targetPhase);
        emit(WS_EVENTS.PHASE_CHANGED, { eventId, phase: targetPhase }, eventId);
        console.log(`[Backend] Phase manually advanced to ${targetPhase} for event ${eventId}`);
        res.status(200).json({ success: true, message: `Advanced to ${targetPhase}` });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

router.post("/dev/reset-phase", async (req, res) => {
    try {
        const { eventId } = req.body;
        const db = (await import("../db/pool.js")).default;
        const { emit, WS_EVENTS } = await import("./websocket/emitter.js");

        await db.query('BEGIN');
        // Reset all room assignments for rooms in event pool
        await db.query(
            `DELETE FROM room_assignment WHERE room_id IN (
                SELECT room_id FROM event_room_pool WHERE allocation_event_id = $1
             )`,
            [eventId]
        );
        // Clear submissions
        await db.query(
            `DELETE FROM allocation_submission WHERE batch_id IN (
                SELECT id FROM batch WHERE allocation_event_id = $1
             )`,
            [eventId]
        );
        // Unlock groups
        await db.query(
            `UPDATE housing_group
             SET status = 'FORMING', batch_id = NULL
             WHERE allocation_event_id = $1`,
            [eventId]
        );
        // Delete batches
        await db.query(`DELETE FROM batch WHERE allocation_event_id = $1`, [eventId]);
        // Reset event phase
        await db.query(
            `UPDATE allocation_event SET status = 'LOBBY', updated_at = NOW() WHERE id = $1`,
            [eventId]
        );
        await db.query('COMMIT');

        emit(WS_EVENTS.PHASE_CHANGED, { eventId, phase: 'LOBBY' }, eventId);
        res.status(200).json({ success: true, message: 'Event reset to LOBBY. All locks lifted and batches destroyed.' });
    } catch (error) {
        const db = (await import("../db/pool.js")).default;
        await db.query('ROLLBACK');
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post("/dev/add-bot", async (req, res) => {
    try {
        const { groupId } = req.body;
        const db = (await import("../db/pool.js")).default;
        
        const botRes = await db.query(
            `SELECT id FROM student WHERE name LIKE 'Bot %' AND group_id IS NULL LIMIT 1`
        );
        if (botRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'No unassigned bots left. Run seed script.' });
        }
        
        const botId = botRes.rows[0].id;
        
        await db.query(
            `UPDATE student SET group_id = $1, is_allotted = false WHERE id = $2`,
            [groupId, botId]
        );
        
        res.status(200).json({ success: true, message: 'Bot added to squad' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;