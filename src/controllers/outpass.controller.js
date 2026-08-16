import asyncHandler from "../utils/asyncHandler.js";
import pool from "../db/pool.js";
import ApiError from "../utils/apiError.js";
import ApiResponse from "../utils/apiResponse.js";
import { logStudentActivity, StudentAction } from "../logging/index.js";
import { getOutpassWithStudentById } from "../notifications/repositories/lateReturn.repository.js";
import { notifyLateReturn, isLateOutstationReturn } from "../notifications/services/lateReturn.service.js";

/*
=================================================
CREATE OUTPASS
POST /api/outpasses
=================================================
*/
const createOutpass = asyncHandler(async (req, res) => {
    const {
        outpass_type,
        place_of_visit,
        purpose,
        departure_datetime,
        arrival_datetime,
        parent_contact,
        is_emergency = false
    } = req.body;

    const studentId = req.user?.id;

    if (!outpass_type || !parent_contact) {
        throw new ApiError(400, "Required fields are missing");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // =================================================
        // FETCH STUDENT + HOSTEL
        // =================================================
        const studentQuery = `
            SELECT
                s.id,
                s.hostel_id,
                s.hostel,
                s.name,
                h.local_outpass_cutoff
            FROM student s
            JOIN hostel h
                ON s.hostel_id = h.id
            WHERE s.id = $1;
        `;

        const studentResult = await client.query(studentQuery, [studentId]);

        if (studentResult.rows.length === 0) {
            throw new ApiError(404, "Student not found");
        }

        const student = studentResult.rows[0];

        // =================================================
        // ENSURE STUDENT ASSIGNED TO HOSTEL
        // =================================================
        if (!student.hostel_id) {
            throw new ApiError(400, "Student is not assigned to any hostel");
        }

        // =================================================
        // NORMALIZE OUTPASS TYPE
        // =================================================
        const normalizedType = outpass_type.trim().toLowerCase();
        const validTypes = ["local", "outstation", "home"];

        if (!validTypes.includes(normalizedType)) {
            throw new ApiError(400, "Invalid outpass type");
        }

        const isLocalOutpass = normalizedType === "local";

        // =================================================
        // VALIDATE EMERGENCY FLAG
        // =================================================
        if (typeof is_emergency !== "boolean") {
            throw new ApiError(400, "Invalid emergency flag.");
        }

        // =================================================
        // AUTO HANDLE LOCAL OUTPASS
        // =================================================
        const trimmedPlace = place_of_visit?.trim();
        const trimmedPurpose = purpose?.trim();

        const finalPlace = isLocalOutpass ? (trimmedPlace || "Local") : trimmedPlace;
        const finalPurpose = isLocalOutpass ? (trimmedPurpose || "Local Visit") : trimmedPurpose;

        // =================================================
        // VALIDATE HOME / OUTSTATION DATA
        // =================================================
        if (!isLocalOutpass && (!finalPlace || !finalPurpose)) {
            throw new ApiError(400, "Place of visit and purpose are required for Home and Outstation outpasses.");
        }

        // =================================================
        // EMERGENCY VALIDATION
        // =================================================
        if (is_emergency && (!purpose || purpose.trim() === "")) {
            throw new ApiError(400, "Purpose is required for emergency outpass.");
        }

        // =================================================
        // CHECK EXISTING ACTIVE OUTPASS
        // =================================================
        const existingQuery = `
            SELECT outpass_type
            FROM outpass
            WHERE
                student_id = $1
                AND is_active = true
                AND outp_status IN ('Pending', 'Approved');
        `;

        const existingResult = await client.query(existingQuery, [studentId]);

        const hasLocal = existingResult.rows.some(row => row.outpass_type === "Local");
        const hasLongTrip = existingResult.rows.some(
            row => row.outpass_type === "Home" || row.outpass_type === "Outstation"
        );

        if (isLocalOutpass && hasLocal) {
            throw new ApiError(400, "You already have an active Local outpass.");
        }

        if (!isLocalOutpass && hasLongTrip) {
            throw new ApiError(400, "You already have an active Home/Outstation outpass.");
        }

        // =================================================
        // VALIDATE DATE/TIME
        // =================================================
        let departure = null;
        const today = new Date();

        if (departure_datetime) {
            departure = new Date(departure_datetime);

            if (isNaN(departure.getTime())) {
                throw new ApiError(400, "Invalid departure date.");
            }

            if (isLocalOutpass) {
                if (
                    today.getDate() !== departure.getDate() || 
                    today.getMonth() !== departure.getMonth() || 
                    today.getFullYear() !== departure.getFullYear()
                ) {
                    throw new ApiError(400, "Departure must be on same day");
                }
            }

            // Allow 30 min tolerance
            if (departure.getTime() < Date.now() - (1000 * 60 * 30)) {
                throw new ApiError(400, "Departure time cannot be in the past");
            }
        }

        if (arrival_datetime) {
            const arrival = new Date(arrival_datetime);

            if (isNaN(arrival.getTime())) {
                throw new ApiError(400, "Invalid arrival date.");
            }

            if (isLocalOutpass && (
                today.getDate() !== arrival.getDate() ||
                today.getMonth() !== arrival.getMonth() || 
                today.getFullYear() !== arrival.getFullYear()
            )) {
                throw new ApiError(400, "Arrival must be on same day");
            }

            if (departure && arrival <= departure) {
                throw new ApiError(400, "Arrival time must be after departure time");
            }
        }

        // =================================================
        // LOCAL OUTPASS CUTOFF VALIDATION
        // =================================================
        if (isLocalOutpass && departure) {
            const departureMinutes = departure.getHours() * 60 + departure.getMinutes();
            const [cutoffHour, cutoffMinute] = student.local_outpass_cutoff.split(":").map(Number);
            const cutoffMinutes = cutoffHour * 60 + cutoffMinute;

            if (departureMinutes > cutoffMinutes && !is_emergency) {
                throw new ApiError(400, "Local outpass departure cannot be after the hostel cutoff time.");
            }
        }

        // =================================================
        // INSERT OUTPASS 
        // Note: Barcode fields explicitly NULL. Token generated ONLY on approval.
        // =================================================
        const query = `
            INSERT INTO outpass (
                student_id,
                outpass_type,
                place_of_visit,
                purpose,
                departure_datetime,
                arrival_datetime,
                parent_contact,
                is_emergency,
                barcode_token,
                barcode_generated_at,
                barcode_revoked_at
            )
            VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                NULL, NULL, NULL
            )
            RETURNING *;
        `;

        const values = [
            studentId,
            normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1),
            finalPlace,
            finalPurpose,
            departure_datetime || null,
            arrival_datetime || null,
            parent_contact,
            is_emergency
        ];

        const result = await client.query(query, values);

        if (!result || result.rows.length === 0) {
            throw new ApiError(500, "Failed to create outpass request");
        }

        await client.query("COMMIT");

        // =================================================
        // RESPONSE
        // =================================================
        const createdOutpass = result.rows[0];

        // Log student activity asynchronously
        logStudentActivity({
            studentId,
            action: StudentAction.OUTPASS_CREATED,
            entityId: createdOutpass.id,
            entityType: 'outpass',
            metadata: {
                outpass_type: createdOutpass.outpass_type,
                place_of_visit: createdOutpass.place_of_visit,
            },
        });

        return res.status(201).json(
            new ApiResponse(
                201,
                {
                    ...createdOutpass,
                    assigned_hostel: {
                        hostel_id: student.hostel_id,
                        hostel_name: student.hostel
                    }
                },
                `Outpass request sent to ${student.hostel} successfully`
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

/*
=================================================
GET MY OUTPASSES
GET /api/outpasses/my
=================================================
*/
const getMyOutpasses = asyncHandler(async (req, res) => {
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(403, "Login with valid credentials");
    }

    const query = `
        SELECT 
            o.*,
            s.hostel,
            s.hostel_id,
            lr.latest_remark
        FROM outpass o
        JOIN student s
            ON o.student_id = s.id
        LEFT JOIN LATERAL (
            SELECT
                json_build_object(
                    'admin_id', r.admin_id,
                    'admin_role', r.admin_role,
                    'remark', r.remark,
                    'created_at', r.created_at
                ) AS latest_remark
            FROM outpass_remarks r
            WHERE r.outpass_id = o.id
            ORDER BY r.created_at DESC
            LIMIT 1
        ) lr ON true
        WHERE o.student_id = $1
        ORDER BY o.created_at DESC;
    `;

    const result = await pool.query(query, [studentId]);

    // Format the response to hide the raw token from the client network payload
    // and provide a clean boolean flag for the frontend UI.
    const safeOutpasses = result.rows.map((row) => {
        const { barcode_token, ...safeRow } = row;
        return {
            ...safeRow,
            has_barcode: !!barcode_token 
        };
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            safeOutpasses,
            "Outpasses fetched successfully"
        )
    );
});
/*
=================================================
BULK OUTPASS ACTION
=================================================
*/

// const bulkOutpassAction = asyncHandler(async (req, res) => {

//     const {
//         outpass_ids,
//         action,
//         remark
//     } = req.body;

//     /* ================= VALIDATION ================= */

//     if (
//         !Array.isArray(outpass_ids) ||
//         outpass_ids.length === 0
//     ) {

//         throw new ApiError(
//             400,
//             "outpass_ids array required"
//         );
//     }

//     if (
//         action !== "approve" &&
//         action !== "reject"
//     ) {

//         throw new ApiError(
//             400,
//             "Invalid action"
//         );
//     }

//     /* ================= DEDUPLICATE & VALIDATE IDS ================= */

//     const uniqueIds =
//         [...new Set(outpass_ids)];

//     if (
//         !uniqueIds.every(
//             id => Number.isInteger(id) && id > 0
//         )
//     ) {

//         throw new ApiError(
//             400,
//             "Invalid outpass IDs."
//         );
//     }

//     /* ================= REMARK VALIDATION ================= */

//     const trimmedRemark =
//         remark?.trim();

//     if (action === "reject") {

//         if (
//             !remark ||
//             trimmedRemark === ""
//         ) {

//             throw new ApiError(
//                 400,
//                 "Remark is required while rejecting outpasses."
//             );
//         }
//     }

//     const client = await pool.connect();

//     try {

//         await client.query("BEGIN");

//         /* ================= ATTENDENT HOSTEL ================= */

//         const hostelQuery = `
//             SELECT hostel_id
//             FROM attendent
//             WHERE id = $1
//             LIMIT 1;
//         `;

//         const hostelResult =
//             await client.query(
//                 hostelQuery,
//                 [req.user.id]
//             );

//         if (
//             hostelResult.rows.length === 0
//         ) {

//             throw new ApiError(
//                 404,
//                 "Attendent not found"
//             );
//         }

//         const hostelId =
//             hostelResult.rows[0]
//                 .hostel_id;

//         /* ================= VERIFY OUTPASSES ================= */

//         const verifyQuery = `
//             SELECT
//                 o.id

//             FROM outpass o

//             JOIN student s
//             ON o.student_id = s.id

//             WHERE
//                 o.id = ANY($1)
//                 AND s.hostel_id = $2
//                 AND o.outp_status = 'Pending'
//                 AND o.is_active = true;
//         `;

//         const verifyResult =
//             await client.query(
//                 verifyQuery,
//                 [
//                     uniqueIds,
//                     hostelId
//                 ]
//             );

//         const validIds =
//             verifyResult.rows.map(
//                 (row) => row.id
//             );

//         if (validIds.length === 0) {

//             throw new ApiError(
//                 400,
//                 "No valid pending outpasses found"
//             );
//         }

//         /* ================= ACTION CONFIG ================= */

//         let status =
//             "Approved";

//         let active =
//             true;

//         if (action === "reject") {

//             status =
//                 "Rejected";

//             active =
//                 false;
//         }

//         /* ================= UPDATE ================= */

//         const updateQuery = `
//             UPDATE outpass

//             SET
//                 outp_status = $1,

//                 is_active = $2,

//                 approved_by = $3,

//                 approved_at =
//                     CURRENT_TIMESTAMP,

//                 updated_at =
//                     CURRENT_TIMESTAMP

//             WHERE id = ANY($4)

//             RETURNING *;
//         `;

//         const updateResult =
//             await client.query(
//                 updateQuery,
//                 [
//                     status,
//                     active,
//                     req.user.id,
//                     validIds
//                 ]
//             );

//         /* ================= INSERT REJECTION REMARKS ================= */

//         if (action === "reject") {

//             const remarkQuery = `
//                 INSERT INTO outpass_remarks (
//                     outpass_id,
//                     admin_id,
//                     admin_role,
//                     remark
//                 )
//                 SELECT
//                     UNNEST($1::int[]),
//                     $2,
//                     $3,
//                     $4;
//             `;

//             await client.query(
//                 remarkQuery,
//                 [
//                     validIds,
//                     req.user.id,
//                     "ATTENDANT",
//                     trimmedRemark
//                 ]
//             );
//         }

//         await client.query("COMMIT");

//         /* ================= RESPONSE ================= */

//         return res.status(200).json(

//             new ApiResponse(
//                 200,
//                 {
//                     action,

//                     affected_count:
//                         updateResult.rows.length,

//                     outpasses:
//                         updateResult.rows,
//                 },

//                 `Bulk ${action} successful`
//             )
//         );

//     } catch (error) {

//         await client.query("ROLLBACK");
//         throw error;

//     } finally {

//         client.release();
//     }
// });
/*


=================================================
GET ACTIVE OUTPASS
GET /api/outpasses/active
=================================================
*/

const bulkOutpassAction = asyncHandler(async (req, res) => {
    const { ids, action, remark } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        throw new ApiError(400, "ids array required");
    }

    if (action !== "approve" && action !== "reject") {
        throw new ApiError(400, "Invalid action");
    }

    const uniqueIds = [...new Set(ids)];

    if (!uniqueIds.every(id => Number.isInteger(Number(id)) && Number(id) > 0)) {
        throw new ApiError(400, "Invalid outpass IDs.");
    }
    const numericIds = uniqueIds.map(Number);

    const trimmedRemark = remark?.trim();

    if (action === "reject" && (!remark || trimmedRemark === "")) {
        throw new ApiError(400, "Remark is required while rejecting outpasses.");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /* ================= RESOLVE HOSTEL (WARDEN OR ATTENDANT) ================= */
        let hostelResult;

        if (req.user.role === "warden") {
            hostelResult = await client.query(
                `
                SELECT h.id AS hostel_id
                FROM admin a
                JOIN hostel h ON h.name = a.hostel
                WHERE a.id = $1 AND a.authority_level = 2
                LIMIT 1;
                `,
                [req.user.id]
            );
        } else if (req.user.role === "attendent" || req.user.role === "attendant") {
            hostelResult = await client.query(
                `SELECT hostel_id FROM attendent WHERE id = $1 LIMIT 1;`,
                [req.user.id]
            );
        } else {
            throw new ApiError(403, "Unauthorized role.");
        }

        if (hostelResult.rowCount === 0) {
            throw new ApiError(404, "Hostel mapping not found.");
        }

        const hostelId = hostelResult.rows[0].hostel_id;

        /* ================= VERIFY OUTPASSES ================= */
        const verifyQuery = `
            SELECT o.id
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            WHERE o.id = ANY($1)
              AND s.hostel_id = $2
              AND o.outp_status = 'Pending'
              AND o.is_active = true;
        `;

        const verifyResult = await client.query(verifyQuery, [numericIds, hostelId]);
        const validIds = verifyResult.rows.map(row => row.id);

        if (validIds.length === 0) {
            throw new ApiError(400, "No valid pending outpasses found");
        }

        /* ================= BULK STATUS UPDATE ================= */
        let status = "Approved";
        let active = true;

        if (action === "reject") {
            status = "Rejected";
            active = false;
        }

        // Dynamically revoke the barcode during the bulk update if rejecting
        let updateQuery = `
            UPDATE outpass
            SET outp_status = $1,
                is_active = $2,
                approved_by = $3,
                approved_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
        `;

        if (action === "reject") {
            updateQuery += `,
                barcode_token = NULL,
                barcode_revoked_at = CURRENT_TIMESTAMP
            `;
        }

        updateQuery += `
            WHERE id = ANY($4)
            RETURNING *;
        `;

        const updateResult = await client.query(
            updateQuery,
            [status, active, req.user.id, validIds]
        );

        /* ================= GENERATE UNIQUE BARCODES FOR APPROVALS ================= */
        if (action === "approve") {
            for (const row of updateResult.rows) {
                let tokenCreated = false;

                for (let attempt = 0; attempt < 5; attempt++) {
                    try {
                        const token = generateBarcodeToken();

                        await client.query(
                            `
                            UPDATE outpass
                            SET
                                barcode_token = $1,
                                barcode_generated_at = CURRENT_TIMESTAMP,
                                barcode_revoked_at = NULL
                            WHERE id = $2
                            `,
                            [token, row.id]
                        );

                        tokenCreated = true;
                        break;
                    } catch (err) {
                        if (err.code === "23505" && attempt < 4) {
                            continue; // Retry on extremely unlikely token collision
                        }
                        throw err;
                    }
                }

                if (!tokenCreated) {
                    throw new Error(`Failed to generate barcode token for outpass ${row.id}`);
                }
            }
        }

        /* ================= INSERT REMARKS (IF REJECTED) ================= */
        if (action === "reject") {
            const adminRole = req.user.role === "warden" ? "WARDEN" : "ATTENDANT";
            const remarkQuery = `
                INSERT INTO outpass_remarks (outpass_id, admin_id, admin_role, remark)
                SELECT UNNEST($1::int[]), $2, $3, $4;
            `;
            await client.query(remarkQuery, [validIds, req.user.id, adminRole, trimmedRemark]);
        }

        await client.query("COMMIT");

        /* ================= FORMAT RESPONSE ================= */
        // Filter out raw token before sending to the client, providing the UI flag
        const safeOutpasses = updateResult.rows.map(row => {
            const { barcode_token, ...safeRow } = row;
            return {
                ...safeRow,
                has_barcode: action === "approve"
            };
        });

        return res.status(200).json(
            new ApiResponse(
                200,
                { 
                    action, 
                    affected_count: safeOutpasses.length, 
                    outpasses: safeOutpasses 
                },
                `Bulk ${action} successful`
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

const getActiveOutpass = asyncHandler(async (req, res) => {
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(400, "Login with valid credentials");
    }

    const query = `
        SELECT
            o.*,
            s.hostel,
            s.hostel_id,
            COALESCE(
                json_agg(
                    json_build_object(
                        'admin_id', r.admin_id,
                        'admin_role', r.admin_role,
                        'remark', r.remark,
                        'created_at', r.created_at
                    )
                    ORDER BY r.created_at ASC
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'::json
            ) AS remarks
        FROM outpass o
        JOIN student s ON o.student_id = s.id
        LEFT JOIN outpass_remarks r ON r.outpass_id = o.id
        WHERE
            o.student_id = $1
            AND o.is_active = true
        GROUP BY
            o.id,
            s.hostel,
            s.hostel_id
        ORDER BY
            CASE
                WHEN o.outpass_type = 'Local' THEN 1
                ELSE 2
            END,
            o.created_at DESC;
    `;

    const result = await pool.query(query, [studentId]);

    // Hide the raw barcode token from the client network payload
    // and provide a clean boolean flag for the frontend UI.
    const safeActiveOutpasses = result.rows.map((row) => {
        const { barcode_token, ...safeRow } = row;
        return {
            ...safeRow,
            has_barcode: !!barcode_token
        };
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            safeActiveOutpasses,
            "Active outpasses fetched successfully"
        )
    );
});

/*
=================================================
GET SINGLE OUTPASS
GET /api/outpasses/:id
=================================================
*/
const getOutpassById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(400, "Login with valid credentials");
    }

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        throw new ApiError(400, "Invalid outpass ID");
    }

    const outpassQuery = `
        SELECT
            o.*,
            s.hostel,
            s.hostel_id
        FROM outpass o
        JOIN student s ON o.student_id = s.id
        WHERE o.id = $1 AND o.student_id = $2;
    `;

    const outpassResult = await pool.query(outpassQuery, [Number(id), studentId]);

    if (outpassResult.rows.length === 0) {
        throw new ApiError(404, "Outpass not found");
    }

    // Hide the raw barcode token from the client network payload
    const { barcode_token, ...safeOutpass } = outpassResult.rows[0];
    safeOutpass.has_barcode = !!barcode_token;

    const remarksQuery = `
        SELECT
            admin_id,
            admin_role,
            remark,
            created_at
        FROM outpass_remarks
        WHERE outpass_id = $1
        ORDER BY created_at ASC;
    `;

    const remarksResult = await pool.query(remarksQuery, [Number(id)]);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                outpass: safeOutpass,
                remarks: remarksResult.rows
            },
            "Outpass fetched successfully"
        )
    );
});

/*
=================================================
CANCEL OUTPASS
PATCH /api/outpasses/:id/cancel
=================================================
*/
const cancelOutpass = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const studentId = req.user?.id;

    if (!studentId) {
        throw new ApiError(400, "Login with valid credentials");
    }

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        throw new ApiError(400, "Invalid outpass ID");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existingQuery = `
            SELECT *
            FROM outpass
            WHERE id = $1 AND student_id = $2;
        `;

        const existingResult = await client.query(existingQuery, [Number(id), studentId]);

        if (existingResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
        }

        const outpass = existingResult.rows[0];

        if (!outpass.is_active) {
            throw new ApiError(400, "Outpass is already inactive.");
        }

        // Allow cancellation only if the outpass is Pending or Approved
        if (!["Pending", "Approved"].includes(outpass.outp_status)) {
            throw new ApiError(400, "Only pending or approved outpasses can be cancelled.");
        }

        // Student has already left the campus
        if (outpass.std_status === "Out") {
            throw new ApiError(400, "Cannot cancel after exiting campus.");
        }

        /* ================= CANCEL OUTPASS & REVOKE BARCODE ================= */
        const updateQuery = `
            UPDATE outpass
            SET
                outp_status = 'Rejected',
                is_active = false,
                barcode_token = NULL,
                barcode_revoked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *;
        `;

        const updatedResult = await client.query(updateQuery, [Number(id)]);

        await client.query("COMMIT");

        return res.status(200).json(
            new ApiResponse(
                200,
                updatedResult.rows[0],
                "Outpass cancelled successfully"
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});
/*
=================================================
GET PENDING OUTPASSES
HOSTEL-WISE MMCA ACCESS
=================================================
*/
const getPendingOutpasses = asyncHandler(async (req, res) => {

    const page = Math.max(
        1,
        parseInt(req.query.page, 10) || 1
    );

    const limit = Math.min(
        100,
        Math.max(
            1,
            parseInt(req.query.limit, 10) || 10
        )
    );

    const offset = (page - 1) * limit;

    /* =========================================
       GET USER HOSTEL
    ========================================= */

    let hostelResult;

    if (req.user.role === "warden") {

        hostelResult = await pool.query(
            `
            SELECT
                h.id AS hostel_id
            FROM admin a
            JOIN hostel h
                ON h.name = a.hostel
            WHERE
                a.id = $1
                AND a.authority_level = 2
            LIMIT 1;
            `,
            [req.user.id]
        );

    } else if (
        req.user.role === "attendent" ||
        req.user.role === "attendant"
    ) {

        hostelResult = await pool.query(
            `
            SELECT hostel_id
            FROM attendent
            WHERE id = $1
            LIMIT 1;
            `,
            [req.user.id]
        );

    } else {

        throw new ApiError(
            403,
            "Unauthorized role."
        );
    }

    if (hostelResult.rowCount === 0) {
        throw new ApiError(
            404,
            "Hostel mapping not found."
        );
    }

    const hostelId = hostelResult.rows[0].hostel_id;

    /* =========================================
       FETCH PENDING OUTPASSES
    ========================================= */

    const query = `
        SELECT
            o.id,
            o.student_id,
            o.outpass_type,
            o.place_of_visit,
            o.purpose,
            o.departure_datetime,
            o.arrival_datetime,
            o.parent_contact,
            o.is_emergency,
            o.is_active,
            o.outp_status,
            o.std_status,
            o.created_at,
            o.updated_at,
            o.approved_at,

            s.name,
            s.email,
            s.roll_no,
            s.phone,
            s.department,
            r.room_number AS room,
            s.hostel,
            s.hostel_id

        FROM outpass o

        JOIN student s
            ON o.student_id = s.id

        LEFT JOIN room_assignment ra
            ON s.id = ra.student_id
           AND ra.assignment_status = 'ACTIVE'

        LEFT JOIN room r
            ON ra.room_id = r.id

        WHERE
            o.outp_status = 'Pending'
            AND s.hostel_id = $1

        ORDER BY
            o.created_at DESC

        LIMIT $2 OFFSET $3;
    `;

    const result = await pool.query(
        query,
        [
            hostelId,
            limit,
            offset
        ]
    );

    /* =========================================
       TOTAL COUNT
    ========================================= */

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM outpass o

        JOIN student s
            ON o.student_id = s.id

        WHERE
            o.outp_status = 'Pending'
            AND s.hostel_id = $1;
    `;

    const countResult = await pool.query(
        countQuery,
        [hostelId]
    );

    const total = parseInt(
        countResult.rows[0].total
    );

    /* =========================================
       RESPONSE
    ========================================= */

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                outpasses: result.rows,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage:
                        page < Math.ceil(total / limit),
                    hasPrevPage:
                        page > 1
                }
            },
            "Pending outpasses fetched successfully"
        )
    );
});

/*
=================================================
APPROVE OUTPASS
=================================================
*/
const approveOutpass = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const adminId = req.user?.id;
    const { remark } = req.body;

    /* ================= VALIDATION ================= */
    if (!id || !adminId) {
        throw new ApiError(400, "Outpass Id or Admin Id is missing");
    }

    const outpassId = Number(id);

    if (!Number.isInteger(outpassId) || outpassId <= 0) {
        throw new ApiError(400, "Invalid outpass id");
    }

    const trimmedRemark = remark?.trim();
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /* ================= GET USER HOSTEL ================= */
        let hostelResult;

        if (req.user.role === "warden") {
            hostelResult = await client.query(
                `
                SELECT h.id AS hostel_id
                FROM admin a
                JOIN hostel h ON h.name = a.hostel
                WHERE a.id = $1 AND a.authority_level = 2
                LIMIT 1;
                `,
                [adminId]
            );
        } else if (req.user.role === "attendent" || req.user.role === "attendant") {
            hostelResult = await client.query(
                `
                SELECT hostel_id
                FROM attendent
                WHERE id = $1
                LIMIT 1;
                `,
                [adminId]
            );
        } else {
            throw new ApiError(403, "Unauthorized role.");
        }

        if (hostelResult.rowCount === 0) {
            throw new ApiError(404, "Hostel mapping not found.");
        }

        const hostelId = hostelResult.rows[0].hostel_id;

        /* ================= VERIFY HOSTEL OWNERSHIP ================= */
        const verifyQuery = `
            SELECT o.id
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            WHERE o.id = $1
              AND s.hostel_id = $2
              AND o.outp_status = 'Pending'
              AND o.is_active = true;
        `;

        const verifyResult = await client.query(verifyQuery, [outpassId, hostelId]);

        if (verifyResult.rowCount === 0) {
            throw new ApiError(403, "Unauthorized hostel access or outpass is not pending.");
        }

        /* ================= APPROVE OUTPASS ================= */
        const updateQuery = `
            UPDATE outpass
            SET
                outp_status = 'Approved',
                updated_at = CURRENT_TIMESTAMP,
                approved_at = CURRENT_TIMESTAMP,
                approved_by = $1
            WHERE
                id = $2
                AND outp_status = 'Pending'
                AND is_active = true
            RETURNING *;
        `;

        const updateResult = await client.query(updateQuery, [adminId, outpassId]);

        if (updateResult.rowCount === 0) {
            throw new ApiError(400, "Failed to approve outpass.");
        }

        /* ================= GENERATE BARCODE TOKEN ================= */
        let barcodeToken = null;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                barcodeToken = generateBarcodeToken();

                await client.query(
                    `
                    UPDATE outpass
                    SET
                        barcode_token = $1,
                        barcode_generated_at = CURRENT_TIMESTAMP,
                        barcode_revoked_at = NULL
                    WHERE id = $2
                    `,
                    [barcodeToken, outpassId]
                );

                break; // Break out of loop if successful
            } catch (err) {
                // PostgreSQL unique violation (code 23505) indicates a token collision
                if (err.code === "23505" && attempt < 4) {
                    continue; 
                }
                throw err;
            }
        }

        /* ================= REMARK ================= */
        if (trimmedRemark) {
            const adminRole = req.user.role === "warden" ? "WARDEN" : "ATTENDANT";

            await client.query(
                `
                INSERT INTO outpass_remarks (
                    outpass_id, admin_id, admin_role, remark
                )
                VALUES ($1, $2, $3, $4);
                `,
                [outpassId, adminId, adminRole, trimmedRemark]
            );
        }

        await client.query("COMMIT");

        // Merge the newly generated token into the response object
        const finalOutpass = {
            ...updateResult.rows[0],
            barcode_token: barcodeToken,
            has_barcode: true
        };

        return res.status(200).json(
            new ApiResponse(
                200,
                finalOutpass,
                "Outpass approved successfully."
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

/*
=================================================
REJECT OUTPASS
=================================================
*/
const rejectOutpass = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const adminId = req.user?.id;
    const { remark } = req.body;

    /* ================= VALIDATION ================= */
    if (!id || !adminId) {
        throw new ApiError(400, "Outpass Id or Admin Id is missing");
    }

    const outpassId = Number(id);

    if (!Number.isInteger(outpassId) || outpassId <= 0) {
        throw new ApiError(400, "Invalid outpass id");
    }

    const trimmedRemark = remark?.trim();

    if (!trimmedRemark) {
        throw new ApiError(400, "Remark is required while rejecting outpasses.");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /* ================= GET USER HOSTEL ================= */
        let hostelResult;

        if (req.user.role === "warden") {
            hostelResult = await client.query(
                `
                SELECT h.id AS hostel_id
                FROM admin a
                JOIN hostel h ON h.name = a.hostel
                WHERE a.id = $1 AND a.authority_level = 2
                LIMIT 1;
                `,
                [adminId]
            );
        } else if (req.user.role === "attendent" || req.user.role === "attendant") {
            hostelResult = await client.query(
                `
                SELECT hostel_id
                FROM attendent
                WHERE id = $1
                LIMIT 1;
                `,
                [adminId]
            );
        } else {
            throw new ApiError(403, "Unauthorized role.");
        }

        if (hostelResult.rowCount === 0) {
            throw new ApiError(404, "Hostel mapping not found.");
        }

        const hostelId = hostelResult.rows[0].hostel_id;

        /* ================= VERIFY HOSTEL OWNERSHIP ================= */
        const verifyQuery = `
            SELECT o.id
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            WHERE o.id = $1
              AND s.hostel_id = $2
              AND o.outp_status = 'Pending'
              AND o.is_active = true;
        `;

        const verifyResult = await client.query(verifyQuery, [outpassId, hostelId]);

        if (verifyResult.rowCount === 0) {
            throw new ApiError(403, "Unauthorized hostel access or outpass is not pending.");
        }

        /* ================= REJECT OUTPASS & REVOKE BARCODE ================= */
        const updateQuery = `
            UPDATE outpass
            SET
                outp_status = 'Rejected',
                is_active = false,
                barcode_token = NULL,
                barcode_revoked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE
                id = $1
                AND outp_status = 'Pending'
                AND is_active = true
            RETURNING *;
        `;

        const updateResult = await client.query(updateQuery, [outpassId]);

        if (updateResult.rowCount === 0) {
            throw new ApiError(400, "Failed to reject outpass.");
        }

        /* ================= INSERT REMARK ================= */
        const adminRole = req.user.role === "warden" ? "WARDEN" : "ATTENDANT";

        await client.query(
            `
            INSERT INTO outpass_remarks (
                outpass_id, admin_id, admin_role, remark
            )
            VALUES ($1, $2, $3, $4);
            `,
            [outpassId, adminId, adminRole, trimmedRemark]
        );

        await client.query("COMMIT");

        return res.status(200).json(
            new ApiResponse(
                200,
                updateResult.rows[0],
                "Outpass rejected successfully."
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});

/*
=================================================
GET LATE RETURNS
HOSTEL-WISE
=================================================
*/
const getLateReturns = asyncHandler(async (req, res) => {
    let { date, from, to } = req.query;

    if (!date) {
        date = new Date().toISOString().split('T')[0];
    }
    if (!from) {
        from = "20:00:00";
    }

    const upperBound = to || "23:59:59";
    const userRole = req.user?.role || '';
    
    let hostelId = null;

    if (userRole === 'attendant' || userRole === 'attendent') {
        const hostelQuery = `
            SELECT hostel_id
            FROM attendent
            WHERE id = $1
            LIMIT 1;
        `;
        const hostelResult = await pool.query(hostelQuery, [req.user.id]);
        if (hostelResult.rows.length === 0) {
            throw new ApiError(404, "Attendent not found");
        }
        hostelId = hostelResult.rows[0].hostel_id;
    } else if (userRole === 'warden') {
        const hostelQuery = `
           SELECT
    h.id AS hostel_id
FROM admin a
JOIN hostel h
    ON h.name = a.hostel
WHERE
    a.id = $1
    AND a.authority_level = 2
LIMIT 1;
        `;
        const hostelResult = await pool.query(hostelQuery, [req.user.id]);
        if (hostelResult.rows.length > 0) {
            hostelId = hostelResult.rows[0].hostel_id;
        }
    }
    // chief-warden has no specific hostelId restriction

    let query = `
    SELECT
        o.*,
        s.name,
        s.roll_no,
        s.department,
        s.hostel,
        vl.actual_arrival
    FROM outpass o
    JOIN student s
        ON o.student_id = s.id
    JOIN visit_log vl
        ON vl.outpass_id = o.id
    WHERE
        o.outpass_type = 'Local'
        AND DATE(vl.actual_arrival) = $1
        AND vl.actual_arrival::time BETWEEN $2::time AND $3::time
    `;
    const params = [date, from, upperBound];

    if (hostelId) {
        query += ` AND s.hostel_id = $4`;
        params.push(hostelId);
    }

    query += ` ORDER BY vl.actual_arrival DESC;`;

    const result = await pool.query(query, params);

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows,
            "Late returns fetched successfully"
        )
    );
});

/*
=================================================
GUARD EXIT / ENTRY
=================================================
*/
const recordEntry = asyncHandler(async (req, res) => {
    const { outpass_id, action, gate } = req.body;
    const guardId = req.user?.id;

    if (!outpass_id || !action) {
        throw new ApiError(400, "outpass_id and action required");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const outpassQuery = `
            SELECT
                o.*,
                s.name,
                s.roll_no
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            WHERE o.id = $1;
        `;

        const outpassResult = await client.query(outpassQuery, [outpass_id]);

        if (outpassResult.rows.length === 0) {
            throw new ApiError(404, "Outpass not found");
        }

        const outpass = outpassResult.rows[0];

        // =========================
        // EXIT
        // =========================
        if (action === "exit") {
            if (outpass.outp_status !== "Approved") {
                throw new ApiError(400, "Outpass not approved");
            }
            if (outpass.std_status === "Out") {
                throw new ApiError(400, "Student already outside");
            }

            const visitQuery = `
                INSERT INTO visit_log (
                    outpass_id, student_id, gate, exit_guard_id
                )
                VALUES ($1, $2, $3, $4);
            `;

            await client.query(visitQuery, [
                outpass.id,
                outpass.student_id,
                gate || "Main Gate",
                guardId
            ]);

            await client.query(
                `
                UPDATE outpass
                SET std_status = 'Out', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1;
                `,
                [outpass.id]
            );

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        student_name: outpass.name,
                        roll_no: outpass.roll_no,
                        status: "Out"
                    },
                    "Exit recorded successfully"
                )
            );
        }

        // =========================
        // ENTRY
        // =========================
        if (action === "enter") {
            if (outpass.std_status !== "Out") {
                throw new ApiError(400, "Student already inside");
            }

            await client.query(
                `
                UPDATE visit_log
                SET
                    actual_arrival = CURRENT_TIMESTAMP,
                    entry_guard_id = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = (
                    SELECT id
                    FROM visit_log
                    WHERE outpass_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                );
                `,
                [outpass.id, guardId]
            );

            await client.query(
                `
                UPDATE outpass
                SET
                    std_status = 'In',
                    is_active = false,
                    barcode_token = NULL,
                    barcode_revoked_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1;
                `,
                [outpass.id]
            );

            await client.query("COMMIT");

            // Fire-and-forget late-return notification. Purely additive:
            // notifyLateReturn() never throws, and this is not awaited, so it
            // cannot delay or break the entry response above.
            const actualArrivalAt = new Date();
            if (isLateOutstationReturn(outpass, actualArrivalAt)) {
                getOutpassWithStudentById(outpass.id)
                    .then((fullOutpass) => {
                        if (!fullOutpass) return;
                        fullOutpass.actual_arrival = actualArrivalAt;
                        return notifyLateReturn(fullOutpass, { triggerSource: "CHECK_IN" });
                    })
                    .catch((err) =>
                        console.error("[notifications] Check-in late-return hook failed:", err.message)
                    );
            }

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        student_name: outpass.name,
                        roll_no: outpass.roll_no,
                        status: "In"
                    },
                    "Entry recorded successfully"
                )
            );
        }

        throw new ApiError(400, "Invalid action");

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});


/*
=================================================
MONITOR DASHBOARD
=================================================
*/
const monitorDashboard = asyncHandler(async (req, res) => {
    const updated_since = req.query.updated_since;

    if (updated_since) {
        const ts = new Date(updated_since);
        if (isNaN(ts.getTime())) {
            throw new ApiError(400, "Invalid updated_since timestamp");
        }

        const deltaQuery = `
            SELECT
                o.*,
                s.id AS student_id,
                s.name,
                s.roll_no,
                s.department,
                s.email,
                s.phone,
                r.room_number AS room,
                s.hostel,
                s.hostel_id,
                s.degree_type
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
            LEFT JOIN room r ON ra.room_id = r.id
            WHERE (o.updated_at > $1 OR o.created_at > $1)
              AND o.outp_status = 'Approved'
              AND o.is_active = true
            ORDER BY o.updated_at ASC;
        `;

        const result = await pool.query(deltaQuery, [ts.toISOString()]);

        // Hide raw token from network payload
        const safeDeltaOutpasses = result.rows.map(row => {
            const { barcode_token, ...safeRow } = row;
            return {
                ...safeRow,
                has_barcode: !!barcode_token
            };
        });

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    outpasses: safeDeltaOutpasses,
                    delta: true,
                    server_time: new Date().toISOString()
                },
                "Delta outpass updates fetched successfully"
            )
        );
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const dataQuery = `
        SELECT
            o.*,
            s.id AS student_id,
            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            r.room_number AS room,
            s.hostel,
            s.hostel_id,
            s.degree_type
        FROM outpass o
        JOIN student s ON o.student_id = s.id
        LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
        LEFT JOIN room r ON ra.room_id = r.id
        WHERE o.outp_status = 'Approved'
          AND o.is_active = true
        ORDER BY o.created_at DESC
        LIMIT $1 OFFSET $2;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total
        FROM outpass
        WHERE outp_status = 'Approved'
          AND is_active = true;
    `;

    const [result, countResult] = await Promise.all([
        pool.query(dataQuery, [limit, offset]),
        pool.query(countQuery)
    ]);

    const total = parseInt(countResult.rows[0].total);

    // Hide raw token from network payload
    const safeOutpasses = result.rows.map(row => {
        const { barcode_token, ...safeRow } = row;
        return {
            ...safeRow,
            has_barcode: !!barcode_token
        };
    });

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                outpasses: safeOutpasses,
                server_time: new Date().toISOString(),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            },
            "Monitoring dashboard data fetched successfully"
        )
    );
});

/*
=================================================
GUARD OFFLINE SYNC
POST /api/outpasses/sync-logs
Receives the batch of PENDING action_logs from the guard terminal,
replays each one against the DB, and returns synced_ids.
=================================================
*/
const syncGuardLogs = asyncHandler(async (req, res) => {
    const { logs } = req.body;

    if (!Array.isArray(logs) || logs.length === 0) {
        throw new ApiError(400, "logs array is required");
    }

    // Sort incoming logs chronologically by timestamp so exits process before entries
    const sortedLogs = [...logs].sort((a, b) => {
        const timeA = new Date(a.timestamp || a.actioned_at || 0).getTime();
        const timeB = new Date(b.timestamp || b.actioned_at || 0).getTime();
        return timeA - timeB;
    });

    const synced_ids = [];
    const failed_ids = [];

    const client = await pool.connect();
    console.log(`[syncGuardLogs] Starting processing for ${sortedLogs.length} logs`);

    try {
        for (const log of sortedLogs) {
            console.log(`[syncGuardLogs] Processing log: ${JSON.stringify(log)}`);
            const { id, outpass_id, action, gate, remark, timestamp } = log;

            if (!id || !outpass_id || !action) {
                console.log(`[syncGuardLogs] Missing fields`);
                failed_ids.push(id || 'unknown');
                continue;
            }

            const actionedAt = timestamp ? new Date(timestamp) : new Date();

            const existingLog = await client.query(
                `SELECT id FROM guard_action_log WHERE id = $1`,
                [id]
            );

            if (existingLog.rows.length > 0) {
                console.log(`[syncGuardLogs] Log ${id} already exists`);
                synced_ids.push(id);
                continue;
            }

            try {
                await client.query("BEGIN");

                const outpassRes = await client.query(
                    `SELECT id, student_id, outp_status, std_status, outpass_type
                     FROM outpass WHERE id = $1 FOR UPDATE`,
                    [outpass_id]
                );

                if (outpassRes.rows.length === 0) {
                    await client.query("ROLLBACK");
                    console.log(`[syncGuardLogs] Outpass not found for id ${outpass_id}`);
                    failed_ids.push(id);
                    continue;
                }

                const outpass = outpassRes.rows[0];

                if (action === "exit") {
                    if (outpass.std_status === "In" && outpass.outp_status === "Approved") {
                        await client.query(
                            `INSERT INTO visit_log (outpass_id, student_id, gate, exit_guard_id, actual_departure)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [outpass_id, outpass.student_id, gate || "Main Gate", req.user?.id || null, actionedAt]
                        );

                        await client.query(
                            `UPDATE outpass SET std_status = 'Out', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                            [outpass_id]
                        );

                        logStudentActivity({
                            studentId: outpass.student_id,
                            action: StudentAction.CAMPUS_EXIT,
                            entityId: outpass_id,
                            entityType: 'outpass',
                            metadata: { gate: gate || 'Main Gate', remark }
                        });
                    } else if (outpass.std_status === "Out") {
                        // Already out
                    } else {
                        await client.query("ROLLBACK");
                        console.log(`[syncGuardLogs] Action exit failed conditions: std_status=${outpass.std_status}, outp_status=${outpass.outp_status}`);
                        failed_ids.push(id);
                        continue;
                    }
                } else if (action === "enter") {
                    if (outpass.std_status === "Out") {
                        await client.query(
                            `UPDATE visit_log
                             SET actual_arrival = $1, entry_guard_id = $2
                             WHERE outpass_id = $3 AND actual_arrival IS NULL`,
                            [actionedAt, req.user?.id || null, outpass_id]
                        );

                        await client.query(
                            `UPDATE outpass
                             SET std_status = 'In', is_active = false, updated_at = CURRENT_TIMESTAMP
                             WHERE id = $1`,
                            [outpass_id]
                        );

                        logStudentActivity({
                            studentId: outpass.student_id,
                            action: StudentAction.CAMPUS_ENTRY,
                            entityId: outpass_id,
                            entityType: 'outpass',
                            metadata: { gate: gate || 'Main Gate', remark }
                        });
                    } else if (outpass.std_status === "In") {
                        // Already in
                    } else {
                        await client.query("ROLLBACK");
                        console.log(`[syncGuardLogs] Action enter failed conditions: std_status=${outpass.std_status}`);
                        failed_ids.push(id);
                        continue;
                    }
                } else {
                    await client.query("ROLLBACK");
                    console.log(`[syncGuardLogs] Unknown action: ${action}`);
                    failed_ids.push(id);
                    continue;
                }

                await client.query(
                    `INSERT INTO guard_action_log (id, outpass_id, action, gate, remark, guard_id, actioned_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (id) DO NOTHING`,
                    [id, outpass_id, action, gate || "Main Gate", remark || "", req.user?.id || null, actionedAt]
                );

                await client.query("COMMIT");
                console.log(`[syncGuardLogs] Successfully processed log ${id}`);
                synced_ids.push(id);

            } catch (err) {
                try { await client.query("ROLLBACK"); } catch (e) {}
                console.log(`[syncGuardLogs] Failed to sync log ${id}: ${err.message}`);
                failed_ids.push(id);
            }
        }
    } catch (fatalErr) {
        console.log(`[syncGuardLogs] FATAL ERROR during batch: ${fatalErr.message}`);
    } finally {
        client.release();
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            { synced_ids, failed_ids },
            `Synced ${synced_ids.length} log(s), failed ${failed_ids.length}`
        )
    );
});


// =================================================
// 1. STUDENT VIEW: Fetch Barcode Image
// =================================================
export const getOutpassBarcode = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const requester = req.user;

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        throw new ApiError(400, "Invalid outpass ID");
    }

    const isStaff = ["warden", "chief-warden", "attendent", "attendant", "guard"].includes(requester?.role);

    const query = isStaff
        ? `SELECT id, student_id, barcode_token, outp_status, is_active FROM outpass WHERE id = $1`
        : `SELECT id, student_id, barcode_token, outp_status, is_active FROM outpass WHERE id = $1 AND student_id = $2`;

    const params = isStaff ? [id] : [id, requester.id];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
        throw new ApiError(404, "Outpass not found");
    }

    const outpass = result.rows[0];

    if (outpass.outp_status !== "Approved" || !outpass.is_active || !outpass.barcode_token) {
        throw new ApiError(400, "Barcode is not available for this outpass");
    }

    // Generate the base64 PNG image from the token
    const barcodeDataUrl = await generateBarcodeImage(outpass.barcode_token);

    return res.status(200).json(
        new ApiResponse(200, { barcodeDataUrl }, "Barcode fetched successfully")
    );
});

// =================================================
// 2. GUARD PC: Scan & Verify Barcode
// =================================================
export const scanOutpassBarcode = asyncHandler(async (req, res) => {
    const { token: rawToken, gate } = req.body;
    const guardId = req.user?.id;

    if (!rawToken) throw new ApiError(400, "Barcode token is required");

    // Removes the "OUTPASS:" prefix
    const token = parseBarcodePayload(rawToken);
    
    if (!token) throw new ApiError(400, "Invalid barcode format");

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // FOR UPDATE locks the row, preventing double-scan race conditions
        const result = await client.query(
            `
            SELECT
                o.*,
                s.name,
                s.roll_no,
                s.department,
                s.hostel,
                s.phone
            FROM outpass o
            JOIN student s ON o.student_id = s.id
            WHERE o.barcode_token = $1
            FOR UPDATE OF o
            `,
            [token]
        );

        if (result.rows.length === 0) {
            throw new ApiError(404, "Invalid or unrecognized barcode");
        }

        const outpass = result.rows[0];

        if (outpass.outp_status !== "Approved" || !outpass.is_active) {
            throw new ApiError(400, "This outpass is no longer active");
        }

        const gateName = gate || "Main Gate";
        
        // Automatically determine if the student is leaving or returning
        const action = outpass.std_status === "Out" ? "entry" : "exit";

        if (action === "exit") {
            // --- EXIT LOGIC ---
            await client.query(
                `
                INSERT INTO visit_log (outpass_id, student_id, gate, exit_guard_id)
                VALUES ($1, $2, $3, $4)
                `,
                [outpass.id, outpass.student_id, gateName, guardId]
            );

            await client.query(
                `
                UPDATE outpass
                SET std_status = 'Out', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                `,
                [outpass.id]
            );
        } else {
            // --- ENTRY LOGIC ---
            await client.query(
                `
                UPDATE visit_log
                SET actual_arrival = CURRENT_TIMESTAMP, entry_guard_id = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = (
                    SELECT id FROM visit_log WHERE outpass_id = $1 ORDER BY created_at DESC LIMIT 1
                )
                `,
                [outpass.id, guardId]
            );

            // Close the outpass upon re-entry and kill the barcode permanently
            await client.query(
                `
                UPDATE outpass
                SET 
                    std_status = 'In', 
                    is_active = false, 
                    barcode_token = NULL,
                    barcode_revoked_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                `,
                [outpass.id]
            );
        }

        await client.query("COMMIT");

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    action,
                    outpass: {
                        id: outpass.id,
                        outpass_type: outpass.outpass_type,
                        place_of_visit: outpass.place_of_visit,
                        std_status: action === "exit" ? "Out" : "In",
                    },
                    student: {
                        id: outpass.student_id,
                        name: outpass.name,
                        roll_no: outpass.roll_no,
                        department: outpass.department,
                        hostel: outpass.hostel,
                    },
                },
                action === "exit" ? "Exit authorized successfully" : "Entry authorized successfully"
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});



export {
    createOutpass,
    getMyOutpasses,
    getActiveOutpass,
    getOutpassById,
    cancelOutpass,
    bulkOutpassAction,
    getPendingOutpasses,
    approveOutpass,
    rejectOutpass,
    getLateReturns,
    recordEntry,
    monitorDashboard,
    syncGuardLogs
};