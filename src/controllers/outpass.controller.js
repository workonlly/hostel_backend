import asyncHandler from "../utils/asyncHandler.js";
import pool from "../db/pool.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";

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
        parent_contact
    } = req.body;

    const studentId = req.user?.id;

    if (
        !outpass_type ||
        !parent_contact
    ) {
        throw new ApiError(
            400,
            "Required fields are missing"
        );
    }

    // =================================================
    // FETCH STUDENT + HOSTEL
    // =================================================

    const studentQuery = `
        SELECT
            id,
            hostel_id,
            hostel,
            name
        FROM student
        WHERE id = $1;
    `;

    const studentResult = await pool.query(
        studentQuery,
        [studentId]
    );

    if (studentResult.rows.length === 0) {
        throw new ApiError(
            404,
            "Student not found"
        );
    }

    const student =
        studentResult.rows[0];

    // =================================================
    // ENSURE STUDENT ASSIGNED TO HOSTEL
    // =================================================

    if (!student.hostel_id) {
        throw new ApiError(
            400,
            "Student is not assigned to any hostel"
        );
    }

    // =================================================
    // NORMALIZE OUTPASS TYPE
    // =================================================

    const normalizedType =
        outpass_type.trim().toLowerCase();

    if (
        normalizedType !== "local" &&
        normalizedType !== "outstation"
    ) {
        throw new ApiError(
            400,
            "Invalid outpass type"
        );
    }

    const isLocalOutpass =
        normalizedType === "local";

    // =================================================
    // AUTO HANDLE LOCAL OUTPASS
    // =================================================

    const finalPlace =
        isLocalOutpass
            ? "Market"
            : place_of_visit;

    const finalPurpose =
        isLocalOutpass
            ? "Local Visit"
            : purpose;

    // =================================================
    // VALIDATE OUTSTATION DATA
    // =================================================

    if (
        !isLocalOutpass &&
        (!finalPlace || !finalPurpose)
    ) {
        throw new ApiError(
            400,
            "Place of visit and purpose required for Outstation outpass"
        );
    }

    // =================================================
    // CHECK EXISTING ACTIVE OUTPASS
    // =================================================

    const existingQuery = `
        SELECT id
        FROM outpass
        WHERE
            student_id = $1
            AND is_active = true
            AND outp_status IN (
                'Pending',
                'Approved'
            );
    `;

    const existingResult = await pool.query(
        existingQuery,
        [studentId]
    );

    if (existingResult.rows.length > 0) {
        throw new ApiError(
            400,
            "You already have an active outpass request"
        );
    }

    // =================================================
    // VALIDATE DATE/TIME
    // =================================================

    let departure = null;

    const today = new Date()
    if (departure_datetime) {



        departure =
            new Date(departure_datetime);

        if (isLocalOutpass) {
            if (today.getDate() !== departure.getDate() || today.getMonth() !== departure.getMonth()
                || today.getFullYear() !== departure.getFullYear()) {
                throw new ApiError(400, "Departure must be on same day")
            }
        }

        // Allow 30 min tolerance
        if (
            departure.getTime()
            <
            Date.now() - (1000 * 60 * 30)
        ) {
            throw new ApiError(
                400,
                "Departure time cannot be in the past"
            );
        }
    }

    if (arrival_datetime) {

        const arrival =
            new Date(arrival_datetime);

        if (isLocalOutpass && (today.getDate() !== arrival.getDate() ||
            today.getMonth() !== arrival.getMonth() || today.getFullYear() !== arrival.getFullYear()))
            throw new ApiError(400, "Arrival must be on same day")

        if (
            departure &&
            arrival <= departure
        ) {
            throw new ApiError(
                400,
                "Arrival time must be after departure time"
            );
        }
    }

    // =================================================
    // INSERT OUTPASS
    // =================================================

    const query = `
        INSERT INTO outpass (
            student_id,
            outpass_type,
            place_of_visit,
            purpose,
            departure_datetime,
            arrival_datetime,
            parent_contact
        )
        VALUES (
            $1, $2, $3, $4,
            $5, $6, $7
        )
        RETURNING *;
    `;

    const values = [
        studentId,
        normalizedType === "local"
            ? "Local"
            : "Outstation",
        finalPlace,
        finalPurpose,
        departure_datetime || null,
        arrival_datetime || null,
        parent_contact
    ];

    const result = await pool.query(
        query,
        values
    );

    if (
        !result ||
        result.rows.length === 0
    ) {
        throw new ApiError(
            500,
            "Failed to create outpass request"
        );
    }

    // =================================================
    // RESPONSE
    // =================================================

    return res.status(201).json(
        new ApiResponse(
            201,
            {
                ...result.rows[0],

                assigned_hostel: {
                    hostel_id:
                        student.hostel_id,
                    hostel_name:
                        student.hostel
                }
            },
            `Outpass request sent to ${student.hostel} successfully`
        )
    );
});

/*
=================================================
GET MY OUTPASSES
GET /api/outpasses/my
=================================================
*/
const getMyOutpasses = asyncHandler(async (req, res) => {

    const studentId = req.user?.id;

    if(!studentId){
        throw new ApiError(403,"Login with valid credentials")
    }

    const query = `
        SELECT 
            o.*,
            s.hostel,
            s.hostel_id
        FROM outpass o
        JOIN student s
        ON o.student_id = s.id
        WHERE o.student_id = $1
        ORDER BY o.created_at DESC;
    `;

    const result = await pool.query(
        query,
        [studentId]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows,
            "Outpasses fetched successfully"
        )
    );
});
/*
=================================================
BULK OUTPASS ACTION
=================================================
*/

const bulkOutpassAction = asyncHandler(async (req, res) => {

        const {
            outpass_ids,
            action
        } = req.body;

        /* ================= VALIDATION ================= */

        if (
            !Array.isArray(outpass_ids) ||
            outpass_ids.length === 0
        ) {

            throw new ApiError(
                400,
                "outpass_ids array required"
            );
        }

        if (
            action !== "approve" &&
            action !== "reject"
        ) {

            throw new ApiError(
                400,
                "Invalid action"
            );
        }

        /* ================= ATTENDENT HOSTEL ================= */

        const hostelQuery = `
        SELECT hostel_id
        FROM attendent
        WHERE id = $1
        LIMIT 1;
    `;

        const hostelResult =
            await pool.query(
                hostelQuery,
                [req.user.id]
            );

        if (
            hostelResult.rows.length === 0
        ) {

            throw new ApiError(
                404,
                "Attendent not found"
            );
        }

        const hostelId =
            hostelResult.rows[0]
                .hostel_id;

        /* ================= VERIFY OUTPASSES ================= */

        const verifyQuery = `
        SELECT
            o.id

        FROM outpass o

        JOIN student s
        ON o.student_id = s.id

        WHERE
            o.id = ANY($1)
            AND s.hostel_id = $2
            AND o.outp_status = 'Pending'
            AND o.is_active = true;
    `;

        const verifyResult =
            await pool.query(
                verifyQuery,
                [
                    outpass_ids,
                    hostelId
                ]
            );

        const validIds =
            verifyResult.rows.map(
                (row) => row.id
            );

        if (validIds.length === 0) {

            throw new ApiError(
                400,
                "No valid pending outpasses found"
            );
        }

        /* ================= ACTION CONFIG ================= */

        let status =
            "Approved";

        let active =
            true;

        if (action === "reject") {

            status =
                "Rejected";

            active =
                false;
        }

        /* ================= UPDATE ================= */

        const updateQuery = `
        UPDATE outpass

        SET
            outp_status = $1,

            is_active = $2,

            approved_by = $3,

            approved_at =
                CURRENT_TIMESTAMP,

            updated_at =
                CURRENT_TIMESTAMP

        WHERE id = ANY($4)

        RETURNING *;
    `;

        const updateResult =
            await pool.query(
                updateQuery,
                [
                    status,
                    active,
                    req.user.id,
                    validIds
                ]
            );

        /* ================= RESPONSE ================= */

        return res.status(200).json(

            new ApiResponse(
                200,
                {
                    action,

                    affected_count:
                        updateResult.rows.length,

                    outpasses:
                        updateResult.rows,
                },

                `Bulk ${action} successful`
            )
        );
    });
/*
=================================================
GET ACTIVE OUTPASS
GET /api/outpasses/active
=================================================
*/
const getActiveOutpass = asyncHandler(async (req, res) => {

    const studentId = req.user?.id;

    if(!studentId) throw new ApiError(400,"Login with valid Id")

    const query = `
        SELECT *
        FROM outpass
        WHERE student_id = $1
        AND is_active = true
        LIMIT 1;
    `;

    const result = await pool.query(
        query,
        [studentId]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows[0] || null,
            "Active outpass fetched successfully"
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

    const query = `
        SELECT *
        FROM outpass
        WHERE id = $1
        AND student_id = $2;
    `;

    const result = await pool.query(
        query,
        [id, studentId]
    );

    if (result.rows.length === 0) {
        throw new ApiError(
            404,
            "Outpass not found"
        );
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows[0],
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

    const existingQuery = `
        SELECT *
        FROM outpass
        WHERE id = $1
        AND student_id = $2;
    `;

    const existingResult = await pool.query(
        existingQuery,
        [id, studentId]
    );

    if (existingResult.rows.length === 0) {
        throw new ApiError(
            404,
            "Outpass not found"
        );
    }

    const outpass =
        existingResult.rows[0];

    if (outpass.std_status === "Out") {
        throw new ApiError(
            400,
            "Cannot cancel after exiting campus"
        );
    }

    const updateQuery = `
        UPDATE outpass
        SET
            outp_status = 'Rejected',
            is_active = false,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
    `;

    const updatedResult = await pool.query(
        updateQuery,
        [id]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            updatedResult.rows[0],
            "Outpass cancelled successfully"
        )
    );
});

/*
=================================================
GET PENDING OUTPASSES
HOSTEL-WISE MMCA ACCESS
=================================================
*/
const getPendingOutpasses = asyncHandler(async (req, res) => {

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        parseInt(req.query.limit) || 10;

    const offset =
        (page - 1) * limit;

    /* =========================================
       GET ATTENDENT HOSTEL
    ========================================= */

    const hostelQuery = `
        SELECT hostel_id
        FROM attendent
        WHERE id = $1
        LIMIT 1;
    `;

    const hostelResult =
        await pool.query(
            hostelQuery,
            [req.user.id]
        );

    if (
        hostelResult.rows.length === 0
    ) {

        throw new ApiError(
            404,
            "Attendent not found"
        );
    }

    const hostelId =
        hostelResult.rows[0].hostel_id;

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
        
        LEFT JOIN room r
        ON s.physical_room_id = r.id

        WHERE
            o.outp_status = 'Pending'
            AND s.hostel_id = $1

        ORDER BY
            o.created_at DESC

        LIMIT $2 OFFSET $3;
    `;

    const result =
        await pool.query(
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

    const countResult =
        await pool.query(
            countQuery,
            [hostelId]
        );

    const total =
        parseInt(
            countResult.rows[0].total
        );

    /* =========================================
       RESPONSE
    ========================================= */

    return res.status(200).json(

        new ApiResponse(
            200,
            {
                outpasses:
                    result.rows,

                pagination: {
                    page,
                    limit,
                    total,
                    totalPages:
                        Math.ceil(
                            total / limit
                        ),
                },
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
    const attendentId = req.user?.id 

    if(!id || !attendentId){
        throw new ApiError(400,"Outpass Id or Admin Id is missing")
    }

    const hostelQuery = `
    SELECT hostel_id
    FROM attendent
    WHERE id = $1
    LIMIT 1;
`;

    const hostelResult = await pool.query(
        hostelQuery,
        [attendentId]
    );

    if (hostelResult.rows.length === 0) {
        throw new ApiError(
            404,
            "Attendent not found"
        );
    }

    const hostelId =
        hostelResult.rows[0].hostel_id;

    // =========================
    // Verify Hostel Ownership
    // =========================

    const verifyQuery = `
        SELECT o.id
        FROM outpass o
        JOIN student s
        ON o.student_id = s.id
        WHERE
            o.id = $1
            AND s.hostel_id = $2;
    `;

    const verifyResult = await pool.query(
        verifyQuery,
        [id, hostelId]
    );

    if (verifyResult.rows.length === 0) {
        throw new ApiError(
            403,
            "Unauthorized hostel access"
        );
    }

    const query = `
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

    const result = await pool.query(
        query,
        [attendentId, id]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows[0],
            "Outpass approved successfully"
        )
    );
});

/*
=================================================
REJECT OUTPASS
=================================================
*/
const rejectOutpass = asyncHandler(async (req, res) => {

    const { id } = req.params;

    const hostelQuery = `
    SELECT hostel_id
    FROM attendent
    WHERE id = $1
    LIMIT 1;
`;

    const hostelResult = await pool.query(
        hostelQuery,
        [req.user.id]
    );

    if (hostelResult.rows.length === 0) {
        throw new ApiError(
            404,
            "Attendent not found"
        );
    }

    const hostelId =
        hostelResult.rows[0].hostel_id;

    const verifyQuery = `
        SELECT o.id
        FROM outpass o
        JOIN student s
        ON o.student_id = s.id
        WHERE
            o.id = $1
            AND s.hostel_id = $2;
    `;

    const verifyResult = await pool.query(
        verifyQuery,
        [id, hostelId]
    );

    if (verifyResult.rows.length === 0) {
        throw new ApiError(
            403,
            "Unauthorized hostel access"
        );
    }

    const query = `
        UPDATE outpass
        SET
            outp_status = 'Rejected',
            is_active = false,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
    `;

    const result = await pool.query(
        query,
        [id]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result.rows[0],
            "Outpass rejected successfully"
        )
    );
});

/*
=================================================
GET LATE RETURNS
HOSTEL-WISE
=================================================
*/
const getLateReturns = asyncHandler(async (req, res) => {

    const hostelQuery = `
    SELECT hostel_id
    FROM attendent
    WHERE id = $1
    LIMIT 1;
`;

    const hostelResult = await pool.query(
        hostelQuery,
        [req.user.id]
    );

    if (hostelResult.rows.length === 0) {
        throw new ApiError(
            404,
            "Attendent not found"
        );
    }

    const hostelId =
        hostelResult.rows[0].hostel_id;

    const query = `
        SELECT
            o.*,
            s.name,
            s.roll_no,
            s.department
        FROM outpass o
        JOIN student s
        ON o.student_id = s.id
        WHERE
            o.std_status = 'Out'
            AND o.arrival_datetime IS NOT NULL
            AND CURRENT_TIMESTAMP > o.arrival_datetime
            AND s.hostel_id = $1;
    `;

    const result = await pool.query(
        query,
        [hostelId]
    );

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

    const {
        outpass_id,
        action,
        gate
    } = req.body;

    const guardId =
        req.user?.id;

    if (
        !outpass_id ||
        !action
    ) {
        throw new ApiError(
            400,
            "outpass_id and action required"
        );
    }

    const client =
        await pool.connect();

    try {

        await client.query("BEGIN");

        const outpassQuery = `
            SELECT
                o.*,
                s.name,
                s.roll_no
            FROM outpass o
            JOIN student s
            ON o.student_id = s.id
            WHERE o.id = $1;
        `;

        const outpassResult =
            await client.query(
                outpassQuery,
                [outpass_id]
            );

        if (
            outpassResult.rows.length === 0
        ) {
            throw new ApiError(
                404,
                "Outpass not found"
            );
        }

        const outpass =
            outpassResult.rows[0];

        // =========================
        // EXIT
        // =========================

        if (action === "exit") {

            if (
                outpass.outp_status !== "Approved"
            ) {
                throw new ApiError(
                    400,
                    "Outpass not approved"
                );
            }

            if (
                outpass.std_status === "Out"
            ) {
                throw new ApiError(
                    400,
                    "Student already outside"
                );
            }

            const visitQuery = `
                INSERT INTO visit_log (
                    outpass_id,
                    student_id,
                    gate,
                    exit_guard_id
                )
                VALUES ($1, $2, $3, $4);
            `;

            await client.query(
                visitQuery,
                [
                    outpass.id,
                    outpass.student_id,
                    gate || "Main Gate",
                    guardId
                ]
            );

            await client.query(
                `
                UPDATE outpass
                SET
                    std_status = 'Out',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1;
                `,
                [outpass.id]
            );

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        student_name:
                            outpass.name,
                        roll_no:
                            outpass.roll_no,
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

            if (
                outpass.std_status !== "Out"
            ) {
                throw new ApiError(
                    400,
                    "Student already inside"
                );
            }

            await client.query(
                `
                UPDATE visit_log
                SET
                    actual_arrival =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = (
                    SELECT id
                    FROM visit_log
                    WHERE outpass_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1
                );
                `,
                [outpass.id]
            );

            await client.query(
                `
                UPDATE outpass
                SET
                    std_status = 'In',
                    is_active = false,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1;
                `,
                [outpass.id]
            );

            await client.query("COMMIT");

            return res.status(200).json(
                new ApiResponse(
                    200,
                    {
                        student_name:
                            outpass.name,
                        roll_no:
                            outpass.roll_no,
                        status: "In"
                    },
                    "Entry recorded successfully"
                )
            );
        }

        throw new ApiError(
            400,
            "Invalid action"
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
MONITOR DASHBOARD
=================================================
*/
const monitorDashboard = asyncHandler(async (req, res) => {

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        parseInt(req.query.limit) || 10;

    const offset =
        (page - 1) * limit;

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
            s.hostel_id

        FROM outpass o

        JOIN student s
        ON o.student_id = s.id

        LEFT JOIN room r
        ON s.physical_room_id = r.id

        ORDER BY o.created_at DESC

        LIMIT $1 OFFSET $2;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total
        FROM outpass;
    `;

    const [
        result,
        countResult
    ] = await Promise.all([
        pool.query(
            dataQuery,
            [limit, offset]
        ),
        pool.query(
            countQuery
        )
    ]);

    const total =
        parseInt(
            countResult.rows[0].total
        );

    return res.status(200).json(

        new ApiResponse(
            200,
            {
                outpasses:
                    result.rows,

                pagination: {
                    page,
                    limit,
                    total,

                    totalPages:
                        Math.ceil(
                            total / limit
                        ),

                    hasNextPage:
                        page <
                        Math.ceil(
                            total / limit
                        ),

                    hasPrevPage:
                        page > 1
                }
            },

            "Monitoring dashboard data fetched successfully"
        )
    );
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
    monitorDashboard
};