import { getRoomsByHostel, getAllHostels } from '../services/room.service.js';
import { getAllGroups } from '../services/group.service.js';
import { allocationService } from '../services/allocation.service.js';

/*
=================================================
SUBMIT ROOM PREFERENCE
  (redirected to allocation.service.submitPreferences
   which writes to allocation_submission +
   submission_preference — the actual DB tables)
=================================================
*/

export const submitPreferenceController = async (req, res) => {
    try {
        const {
            groupId,
            submittedBy,
            hostelId,
            batchNumber,
            roundNumber,
            preferences,   // array of room IDs in order
        } = req.body;

        const result = await allocationService.submitPreferences({
            groupId,
            submittedBy,
            hostelId,
            batchNumber,
            roundNumber,
            preferences,
        });

        res.status(200).json({ success: true, ...result });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
};

/*
=================================================
GET ALL ROOMS FOR A HOSTEL
=================================================
*/

export const getAllRoomsController = async (req, res) => {
    try {
        const { hostelId } = req.query;
        if (!hostelId) {
            return res.status(400).json({ success: false, message: 'hostelId query param is required' });
        }

        // Resolve the target (to) hostel — students see rooms from the target hostel, not their own
        const { default: pool } = await import('../../db/pool.js');
        const targetRes = await pool.query(
            `SELECT COALESCE(target_hostel_id, id) AS room_hostel_id,
                    target_hostel_id
             FROM hostel WHERE id = $1`,
            [hostelId]
        );
        if (targetRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Hostel not found' });
        }

        const { room_hostel_id: roomHostelId, target_hostel_id: targetHostelId } = targetRes.rows[0];

        const rooms = await getRoomsByHostel(roomHostelId);
        res.status(200).json({
            success: true,
            rooms,
            roomHostelId,
            // Inform the client whether rooms are from a different hostel
            isCrossHostel: targetHostelId !== null,
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
};

/*
=================================================
GET ALL GROUPS
=================================================
*/

export const getAllGroupsController = async (req, res) => {
    try {
        const groups = await getAllGroups();
        res.status(200).json({ success: true, groups });
    } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, message: error.message });
    }
};