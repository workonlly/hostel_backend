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
        const { batchId, roundNumber } = req.body;

        if (!batchId || !roundNumber) {
            return res.status(400).json({
                success: false,
                message: "batchId and roundNumber are required"
            });
        }

        const result = await allocationService.executeBatchRound(batchId, roundNumber);

        // Keep websocket clients in sync when this manual endpoint is used.
        const batchRes = await pool.query(
            `SELECT hostel_id FROM batch WHERE id = $1`,
            [batchId]
        );
        if (batchRes.rowCount > 0) {
            const hostelId = batchRes.rows[0].hostel_id;
            const rooms = await allocationService.getLiveRoomMap(hostelId);
            emit(WS_EVENTS.ROUND_EXECUTED, { batchId, round: roundNumber, result }, hostelId);
            emit(WS_EVENTS.ROOM_MAP_UPDATED, { hostelId, batchId, round: roundNumber, rooms }, hostelId);
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
// LIVE ROOM MAP
// =====================================================
router.get("/rooms/:hostelId", async (req, res) => {
    try {
        const result = await allocationService.getLiveRoomMap(req.params.hostelId, req.query.studentId);
        res.status(200).json({ success: true, rooms: result });
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
// ALL BATCHES FOR HOSTEL (Timeline)
// =====================================================
router.get("/batches/:hostelId", async (req, res) => {
    try {
        const result = await allocationService.getBatches(req.params.hostelId);
        res.status(200).json({ success: true, result });
    } catch (error) {
        // Fallback since getBatches might not exist
        const db = (await import("../db/pool.js")).default;
        const batchesRes = await db.query(
            `SELECT id as batch_id, batch_number, start_time, end_time, status 
             FROM batch WHERE hostel_id = $1 ORDER BY batch_number ASC`,
            [req.params.hostelId]
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
        const { hostelId, targetPhase } = req.body;
        await setCurrentPhase(hostelId, targetPhase);
        // Broadcast so all connected clients refetch without a manual page reload
        emit(WS_EVENTS.PHASE_CHANGED, { hostelId, phase: targetPhase }, hostelId);
        console.log(`[Backend] Phase manually advanced to ${targetPhase} for hostel ${hostelId}`);
        res.status(200).json({ success: true, message: `Advanced to ${targetPhase}` });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
});

router.post("/dev/reset-phase", async (req, res) => {
    try {
        const { hostelId } = req.body;
        const db = (await import("../db/pool.js")).default;
        const { emit, WS_EVENTS } = await import("./websocket/emitter.js");
        
        await db.query('BEGIN');
        await db.query(`DELETE FROM room_assignment WHERE room_id IN (SELECT id FROM room WHERE hostel_id = $1)`, [hostelId]);
        await db.query(`DELETE FROM allocation_submission WHERE batch_id IN (SELECT id FROM batch WHERE hostel_id = $1)`, [hostelId]);
        await db.query(`UPDATE housing_group SET status = 'FORMING', batch_id = NULL WHERE id IN (SELECT group_id FROM student WHERE hostel_id = $1)`, [hostelId]);
        await db.query(`DELETE FROM batch WHERE hostel_id = $1`, [hostelId]);
        await db.query(`UPDATE hostel SET current_phase = 'LOBBY' WHERE id = $1`, [hostelId]);
        await db.query('COMMIT');
        
        // Broadcast phase reset to all connected clients
        emit(WS_EVENTS.PHASE_CHANGED, { hostelId, phase: 'LOBBY' }, hostelId);
        res.status(200).json({ success: true, message: 'Phase reset to LOBBY. All locks lifted and batches destroyed.' });
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