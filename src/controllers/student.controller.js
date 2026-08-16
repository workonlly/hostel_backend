import ApiError from "../utils/apiError.js";
import ApiResponse from "../utils/apiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import pool from "../db/pool.js";

/*
=================================================
SEARCH STUDENT BY NAME OR ROLL NUMBER
=================================================
*/
const searchByNameOrRollno = asyncHandler(async (req, res) => {

    const { name, roll_no } = req.body;

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        Math.min(
            parseInt(req.query.limit) || 10,
            100
        );

    const offset =
        (page - 1) * limit;

    if (!name && !roll_no) {

        throw new ApiError(
            400,
            "Provide either name or roll number"
        );
    }

    const conditions = [];
    const values = [];

    if (roll_no) {

        values.push(roll_no);

        conditions.push(
            `roll_no = $${values.length}`
        );
    }

    if (name) {

        values.push(name);

        conditions.push(
            `name ILIKE '%' || $${values.length} || '%'`
        );
    }

    const whereClause =
        conditions.join(" OR ");

    const dataQuery = 
        `
    SELECT
        s.id,
        s.name,
        s.roll_no,
        s.email,
        s.phone,
        s.department,
        s.hostel,
        s.hostel_id,
        r.room_number AS room,
        s.created_at

    FROM student s

    LEFT JOIN room_assignment ra
        ON s.id = ra.student_id
       AND ra.assignment_status = 'ACTIVE'

    LEFT JOIN room r
        ON ra.room_id = r.id

    WHERE ${whereClause}

    ORDER BY s.created_at DESC

    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2};
`;
    ;

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM student

        WHERE ${whereClause};
    `;

    const dataValues = [
        ...values,
        limit,
        offset
    ];

    const [
        result,
        countResult
    ] = await Promise.all([

        pool.query(
            dataQuery,
            dataValues
        ),

        pool.query(
            countQuery,
            values
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
                students:
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

            result.rows.length
                ? "Students fetched successfully"
                : "No matching students found"
        )
    );
});

/*
=================================================
GET STUDENTS WITH OUTPASSES IN RANGE
=================================================
*/
const sortStudentsInRange = asyncHandler(async (req, res) => {
    const {
        departure_datetime,
        arrival_datetime
    } = req.body;

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    if (!departure_datetime || !arrival_datetime) {
        throw new ApiError(
            400,
            "Provide departure time and arrival time"
        );
    }

    // Get logged-in Warden's hostel
    const wardenResult = await pool.query(
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

    if (wardenResult.rowCount === 0) {
        throw new ApiError(403, "Warden not found.");
    }

    const hostelId = wardenResult.rows[0].hostel_id;

    const dataQuery = `
        SELECT
            s.id AS student_id,
            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,

            r.room_number AS room,

            o.id AS outpass_id,
            o.parent_contact,
            o.outpass_type,
            o.place_of_visit,
            o.purpose,
            o.departure_datetime,
            o.arrival_datetime,
            o.outp_status,
            o.std_status,
            o.created_at

        FROM student s

        JOIN outpass o
            ON o.student_id = s.id

        LEFT JOIN room_assignment ra
            ON s.id = ra.student_id
           AND ra.assignment_status = 'ACTIVE'

        LEFT JOIN room r
            ON ra.room_id = r.id

        WHERE
            s.hostel_id = $1
            AND o.departure_datetime <= $3
            AND o.arrival_datetime >= $2

        ORDER BY
            o.departure_datetime DESC

        LIMIT $4 OFFSET $5;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM student s

        JOIN outpass o
            ON o.student_id = s.id

        WHERE
            s.hostel_id = $1
            AND o.departure_datetime <= $3
            AND o.arrival_datetime >= $2;
    `;

    const [result, countResult] = await Promise.all([
        pool.query(
            dataQuery,
            [
                hostelId,
                departure_datetime,
                arrival_datetime,
                limit,
                offset
            ]
        ),

        pool.query(
            countQuery,
            [
                hostelId,
                departure_datetime,
                arrival_datetime
            ]
        )
    ]);

    const total = parseInt(countResult.rows[0].total);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                students: result.rows,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            },
            result.rows.length
                ? "Students fetched successfully"
                : "No students found"
        )
    );
});

/*
=================================================
GET ALL OUTPASSES BY STATUS
=================================================
*/
const getAllOutpassesByStatus = asyncHandler(async (req, res) => {
    const { outp_status } = req.body;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    if (!outp_status) {
        throw new ApiError(400, "Outpass status is required");
    }

    const allowedStatus = ["Pending", "Approved", "Rejected"];
    if (!allowedStatus.includes(outp_status)) {
        throw new ApiError(400, "Invalid outpass status");
    }

    const dataQuery = `
        SELECT
            o.id AS outpass_id,
            o.student_id,
            o.parent_contact,
            o.outpass_type,
            o.place_of_visit,
            o.purpose,
            o.departure_datetime,
            o.arrival_datetime,
            o.outp_status,
            o.std_status,
            o.created_at,
            o.barcode_token, -- Explicitly selected for evaluation

            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,
            r.room_number AS room

        FROM outpass o
        JOIN student s ON o.student_id = s.id
        LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
        LEFT JOIN room r ON ra.room_id = r.id
        WHERE o.outp_status = $1
        ORDER BY o.created_at DESC
        LIMIT $2 OFFSET $3;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total
        FROM outpass o
        WHERE o.outp_status = $1;
    `;

    const [result, countResult] = await Promise.all([
        pool.query(dataQuery, [outp_status, limit, offset]),
        pool.query(countQuery, [outp_status])
    ]);

    const total = parseInt(countResult.rows[0].total);

    /* ================= FORMAT RESPONSE ================= */
    // Hide the raw barcode token from the client network payload
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
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            },
            result.rows.length
                ? `${outp_status} outpasses fetched successfully`
                : "No outpasses found"
        )
    );
});


/*
=================================================
ASSIGN ATTENDENT TO HOSTEL
=================================================
*/
const assignAttendent = asyncHandler(async (req, res) => {
    const {
        name,
        email,
        phone,
        password
    } = req.body;

    if (!name || !email || !phone || !password) {
        throw new ApiError(
            400,
            "Name, email, phone and password are required."
        );
    }

    /* ==========================================
       GET LOGGED-IN WARDEN'S HOSTEL
    ========================================== */

    const wardenResult = await pool.query(
        `
        SELECT
            h.id AS hostel_id,
            h.name AS hostel_name
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

    if (wardenResult.rowCount === 0) {
        throw new ApiError(
            403,
            "Warden not found."
        );
    }

    const {
        hostel_id,
        hostel_name
    } = wardenResult.rows[0];

    /* ==========================================
       EXISTING ATTENDANT FOR THIS HOSTEL?
    ========================================== */

    const existingResult = await pool.query(
        `
        SELECT
            id,
            email
        FROM attendent
        WHERE hostel_id = $1
        LIMIT 1;
        `,
        [hostel_id]
    );

    /* ==========================================
       IF ATTENDANT EXISTS -> UPDATE
    ========================================== */

    if (existingResult.rowCount > 0) {

        const attendantId =
            existingResult.rows[0].id;

        // Make sure another attendant isn't already using this email
        const duplicateEmail = await pool.query(
            `
            SELECT id
            FROM attendent
            WHERE
                email = $1
                AND id <> $2;
            `,
            [
                email,
                attendantId
            ]
        );

        if (duplicateEmail.rowCount > 0) {
            throw new ApiError(
                409,
                "Email already exists."
            );
        }

        const updated = await pool.query(
            `
            UPDATE attendent
            SET
                name = $1,
                email = $2,
                phone = $3,
                password = $4
            WHERE id = $5
            RETURNING *;
            `,
            [
                name,
                email,
                phone,
                password,
                attendantId
            ]
        );

        return res.status(200).json(
            new ApiResponse(
                200,
                updated.rows[0],
                "Attendant updated successfully."
            )
        );
    }

    /* ==========================================
       CREATE NEW ATTENDANT
    ========================================== */

    const duplicateEmail = await pool.query(
        `
        SELECT id
        FROM attendent
        WHERE email = $1;
        `,
        [email]
    );

    if (duplicateEmail.rowCount > 0) {
        throw new ApiError(
            409,
            "Email already exists."
        );
    }

    const created = await pool.query(
        `
        INSERT INTO attendent (
            name,
            email,
            password,
            phone,
            hostel,
            hostel_id
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6
        )
        RETURNING *;
        `,
        [
            name,
            email,
            password,
            phone,
            hostel_name,
            hostel_id
        ]
    );

    return res.status(201).json(
        new ApiResponse(
            201,
            created.rows[0],
            "Attendant created successfully."
        )
    );
});

/*
=================================================
GET HOSTEL OUTPASSES BY STATUS
=================================================
*/
// const getHostelOutpassesByStatus = asyncHandler(async (req, res) => {

//     const { outp_status } = req.body;

//     const page =
//         parseInt(req.query.page) || 1;

//     const limit =
//         Math.min(
//             parseInt(req.query.limit) || 10,
//             100
//         );

//     const offset =
//         (page - 1) * limit;

//     if (!outp_status) {

//         throw new ApiError(
//             400,
//             "Outpass status is required"
//         );
//     }

//     const allowedStatus = [
//         "Pending",
//         "Approved",
//         "Rejected"
//     ];

//     if (
//         !allowedStatus.includes(outp_status)
//     ) {

//         throw new ApiError(
//             400,
//             "Invalid outpass status"
//         );
//     }

//     /* ================= ATTENDENT HOSTEL ================= */

//     const hostelQuery = `
//         SELECT hostel_id
//         FROM attendent
//         WHERE id = $1
//         LIMIT 1;
//     `;

//     const hostelResult =
//         await pool.query(
//             hostelQuery,
//             [req.user.id]
//         );

//     if (
//         hostelResult.rows.length === 0
//     ) {

//         throw new ApiError(
//             404,
//             "Attendent not found"
//         );
//     }

//     const hostelId =
//         hostelResult.rows[0]
//             .hostel_id;

//     /* ================= DATA QUERY ================= */

//     const dataQuery = `
//         SELECT
//             o.id AS outpass_id,
//             o.student_id,
//             o.parent_contact,
//             o.outpass_type,
//             o.place_of_visit,
//             o.purpose,
//             o.departure_datetime,
//             o.arrival_datetime,
//             o.outp_status,
//             o.std_status,
//             o.created_at,

//             s.name,
//             s.roll_no,
//             s.department,
//             s.email,
//             s.phone,
//             s.hostel,

//             r.room_number AS room

//         FROM outpass o

//         JOIN student s
//         ON o.student_id = s.id

//         LEFT JOIN room_assignment ra
//     ON s.id = ra.student_id
//    AND ra.assignment_status = 'ACTIVE'

// LEFT JOIN room r
//     ON ra.room_id = r.id

//         WHERE
//             o.outp_status = $1
//             AND s.hostel_id = $2

//         ORDER BY
//             o.created_at DESC

//         LIMIT $3 OFFSET $4;
//     `;

//     const countQuery = `
//         SELECT COUNT(*) AS total

//         FROM outpass o

//         JOIN student s
//         ON o.student_id = s.id

//         WHERE
//             o.outp_status = $1
//             AND s.hostel_id = $2;
//     `;

//     const [
//         result,
//         countResult
//     ] = await Promise.all([

//         pool.query(
//             dataQuery,
//             [
//                 outp_status,
//                 hostelId,
//                 limit,
//                 offset
//             ]
//         ),

//         pool.query(
//             countQuery,
//             [
//                 outp_status,
//                 hostelId
//             ]
//         )
//     ]);

//     const total =
//         parseInt(
//             countResult.rows[0].total
//         );

//     return res.status(200).json(

//         new ApiResponse(
//             200,
//             {
//                 outpasses:
//                     result.rows,

//                 pagination: {
//                     page,
//                     limit,
//                     total,

//                     totalPages:
//                         Math.ceil(
//                             total / limit
//                         ),

//                     hasNextPage:
//                         page <
//                         Math.ceil(
//                             total / limit
//                         ),

//                     hasPrevPage:
//                         page > 1
//                 }
//             },

//             result.rows.length
//                 ? `${outp_status} hostel outpasses fetched successfully`
//                 : "No outpasses found"
//         )
//     );
// });
const getHostelOutpassesByStatus = asyncHandler(async (req, res) => {
    const { outp_status } = req.body;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    if (!outp_status) {
        throw new ApiError(400, "Outpass status is required");
    }

    const allowedStatus = ["Pending", "Approved", "Rejected"];
    if (!allowedStatus.includes(outp_status)) {
        throw new ApiError(400, "Invalid outpass status");
    }

    /* ================= RESOLVE HOSTEL (WARDEN OR ATTENDANT) ================= */
    let hostelResult;

    if (req.user.role === "warden") {
        hostelResult = await pool.query(
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
        throw new ApiError(403, "Unauthorized role.");
    }

    if (hostelResult.rowCount === 0) {
        throw new ApiError(404, "Hostel mapping not found.");
    }

    const hostelId = hostelResult.rows[0].hostel_id;

    /* ================= DATA QUERY ================= */
    const dataQuery = `
        SELECT
            o.id AS outpass_id,
            o.student_id,
            o.parent_contact,
            o.outpass_type,
            o.place_of_visit,
            o.purpose,
            o.departure_datetime,
            o.arrival_datetime,
            o.outp_status,
            o.std_status,
            o.created_at,
            o.barcode_token, -- explicitly select the token for evaluation

            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,
            r.room_number AS room

        FROM outpass o
        JOIN student s ON o.student_id = s.id
        LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
        LEFT JOIN room r ON ra.room_id = r.id

        WHERE o.outp_status = $1
          AND s.hostel_id = $2

        ORDER BY o.created_at DESC
        LIMIT $3 OFFSET $4;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total
        FROM outpass o
        JOIN student s ON o.student_id = s.id
        WHERE o.outp_status = $1
          AND s.hostel_id = $2;
    `;

    const [result, countResult] = await Promise.all([
        pool.query(dataQuery, [outp_status, hostelId, limit, offset]),
        pool.query(countQuery, [outp_status, hostelId])
    ]);

    const total = parseInt(countResult.rows[0].total);

    /* ================= FORMAT RESPONSE ================= */
    // Hide the raw barcode token from the client network payload
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
                pagination: {
                    page, 
                    limit, 
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page < Math.ceil(total / limit),
                    hasPrevPage: page > 1
                }
            },
            result.rows.length
                ? `${outp_status} hostel outpasses fetched successfully`
                : "No outpasses found"
        )
    );
});
/*

=================================================
GET OUTPASS DETAILS
ADMIN (ATTENDANT)
GET /api/admin/outpasses/:id
=================================================
*/
const getOutpassDetails = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const attendantId = req.user?.id;

    console.log("req.params.id =", req.params.id);

    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        throw new ApiError(400, "Invalid outpass ID");
    }

    /* ================= ATTENDANT HOSTEL ================= */
    const hostelQuery = `
        SELECT hostel_id
        FROM attendent
        WHERE id = $1
        LIMIT 1;
    `;

    const hostelResult = await pool.query(hostelQuery, [attendantId]);

    if (hostelResult.rows.length === 0) {
        throw new ApiError(404, "Attendant not found");
    }

    const hostelId = hostelResult.rows[0].hostel_id;

    /* ================= FETCH OUTPASS ================= */
    const outpassQuery = `
        SELECT
            o.*,
            s.id AS student_id,
            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,
            s.hostel_id,
            r.room_number AS room
        FROM outpass o
        JOIN student s ON o.student_id = s.id
        LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
        LEFT JOIN room r ON ra.room_id = r.id
        WHERE o.id = $1 AND s.hostel_id = $2;
    `;

    const outpassResult = await pool.query(outpassQuery, [Number(id), hostelId]);

    if (outpassResult.rows.length === 0) {
        throw new ApiError(404, "Outpass not found");
    }

    /* ================= FETCH REMARKS ================= */
    const remarksQuery = `
        SELECT
            id,
            admin_id,
            admin_role,
            remark,
            created_at
        FROM outpass_remarks
        WHERE outpass_id = $1
        ORDER BY created_at ASC, id ASC;
    `;

    const remarksResult = await pool.query(remarksQuery, [Number(id)]);

    /* ================= FORMAT RESPONSE ================= */
    // Hide the raw barcode token from the client network payload
    const { barcode_token, ...safeOutpass } = outpassResult.rows[0];
    safeOutpass.has_barcode = !!barcode_token;

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                outpass: safeOutpass,
                remarks: remarksResult.rows
            },
            "Outpass details fetched successfully"
        )
    );
});
    
    export const getStudentHistory = asyncHandler(async (req, res) => {
    const studentId = req.params.id;
    if (!studentId) {
        throw new ApiError(400, "Student ID is required");
    }

    // 1. Fetch Student Profile
    const studentQuery = `
        SELECT
            s.id, s.name, s.roll_no, s.email, s.phone,
            s.department, s.degree_type, s.current_year, s.joining_year,
            s.hostel, s.hostel_id,
            r.room_number AS room
        FROM student s
        LEFT JOIN room_assignment ra ON s.id = ra.student_id AND ra.assignment_status = 'ACTIVE'
        LEFT JOIN room r ON ra.room_id = r.id
        WHERE s.id = $1
    `;
    const studentResult = await pool.query(studentQuery, [studentId]);

    if (studentResult.rowCount === 0) {
        throw new ApiError(404, "Student not found");
    }

    // 2. Fetch Outpasses
    const outpassQuery = `
        SELECT *
        FROM outpass
        WHERE student_id = $1
        ORDER BY created_at DESC
    `;
    
    // 3. Fetch Visit Logs
    const visitLogQuery = `
        SELECT vl.*, o.outpass_type, o.place_of_visit
        FROM visit_log vl
        JOIN outpass o ON vl.outpass_id = o.id
        WHERE vl.student_id = $1
        ORDER BY vl.actual_departure DESC NULLS LAST
    `;

    // 4. Fetch Complaints
    const complaintQuery = `
        SELECT *
        FROM complaint
        WHERE student_id = $1
        ORDER BY date_created DESC
    `;

    const [outpassResult, visitLogResult, complaintResult] = await Promise.all([
        pool.query(outpassQuery, [studentId]),
        pool.query(visitLogQuery, [studentId]),
        pool.query(complaintQuery, [studentId])
    ]);

    return res.status(200).json(
        new ApiResponse(200, {
            profile: studentResult.rows[0],
            outpasses: outpassResult.rows,
            visit_logs: visitLogResult.rows,
            complaints: complaintResult.rows
        }, "Student history fetched successfully")
    );
});

const bulkRecordEntry = asyncHandler(async (req, res) => {
    const { outpass_ids, action, gate } = req.body;
    const guardId = req.user?.id;

    if (!Array.isArray(outpass_ids) || outpass_ids.length === 0) {
        throw new ApiError(400, "No outpasses selected");
    }

    if (action !== "exit" && action !== "enter") {
        throw new ApiError(400, "Invalid action");
    }

    // normalize / dedupe ids defensively
    const ids = [...new Set(outpass_ids.map((id) => Number(id)))].filter(
        (id) => Number.isInteger(id)
    );

    if (ids.length === 0) {
        throw new ApiError(400, "No valid outpasses selected");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        let processed = [];

        if (action === "exit") {
            /* ============ ATOMIC EXIT (update + insert in one shot) ============ */
            const result = await client.query(
                `
                WITH updated AS (
                    UPDATE outpass o
                    SET
                        std_status = 'Out',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE
                        o.id = ANY($1::int[])
                        AND o.outp_status = 'Approved'
                        AND o.std_status IS DISTINCT FROM 'Out'
                    RETURNING o.id AS outpass_id, o.student_id
                ),
                inserted AS (
                    INSERT INTO visit_log (
                        outpass_id,
                        student_id,
                        gate,
                        exit_guard_id
                    )
                    SELECT
                        outpass_id,
                        student_id,
                        $2,
                        $3
                    FROM updated
                    RETURNING outpass_id
                )
                SELECT
                    u.outpass_id,
                    u.student_id,
                    s.name,
                    s.roll_no
                FROM updated u
                JOIN student s ON s.id = u.student_id;
                `,
                [ids, gate || "Main Gate", guardId]
            );

            processed = result.rows.map((row) => ({
                outpass_id: row.outpass_id,
                student_name: row.name,
                roll_no: row.roll_no,
                status: "Out"
            }));

        } else {
            /* ============ ATOMIC ENTRY (update outpass + update latest visit_log) ============ */
            const result = await client.query(
                `
                WITH updated AS (
                    UPDATE outpass o
                    SET
                        std_status = 'In',
                        is_active = false,
                        barcode_token = NULL,
                        barcode_revoked_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE
                        o.id = ANY($1::int[])
                        AND o.std_status = 'Out'
                    RETURNING o.id AS outpass_id, o.student_id
                ),
                latest_visit AS (
                    SELECT DISTINCT ON (v.outpass_id)
                        v.id,
                        v.outpass_id
                    FROM visit_log v
                    WHERE v.outpass_id IN (SELECT outpass_id FROM updated)
                    ORDER BY v.outpass_id, v.created_at DESC
                ),
                updated_visit AS (
                    UPDATE visit_log v
                    SET
                        actual_arrival = CURRENT_TIMESTAMP,
                        entry_guard_id = $2,
                        updated_at = CURRENT_TIMESTAMP
                    FROM latest_visit lv
                    WHERE v.id = lv.id
                    RETURNING v.outpass_id
                )
                SELECT
                    u.outpass_id,
                    u.student_id,
                    s.name,
                    s.roll_no
                FROM updated u
                JOIN student s ON s.id = u.student_id;
                `,
                [ids, guardId]
            );

            processed = result.rows.map((row) => ({
                outpass_id: row.outpass_id,
                student_name: row.name,
                roll_no: row.roll_no,
                status: "In"
            }));
        }

        /* ============ Figure out skipped ids + reasons ============ */
        const processedIds = new Set(processed.map((p) => p.outpass_id));
        const remainingIds = ids.filter((id) => !processedIds.has(id));

        let skipped = [];

        if (remainingIds.length > 0) {
            const statusResult = await client.query(
                `
                SELECT id, outp_status, std_status
                FROM outpass
                WHERE id = ANY($1::int[]);
                `,
                [remainingIds]
            );

            const statusMap = new Map(
                statusResult.rows.map((row) => [row.id, row])
            );

            skipped = remainingIds.map((id) => {
                const row = statusMap.get(id);

                if (!row) return { outpass_id: id, reason: "Not Found" };

                if (action === "exit") {
                    if (row.outp_status !== "Approved") return { outpass_id: id, reason: "Not Approved" };
                    if (row.std_status === "Out") return { outpass_id: id, reason: "Already Out" };
                    return { outpass_id: id, reason: "Invalid State" };
                }

                // action === "enter"
                if (row.std_status === "In") return { outpass_id: id, reason: "Already In" };
                if (row.std_status !== "Out") return { outpass_id: id, reason: "Not Out" };
                return { outpass_id: id, reason: "Invalid State" };
            });
        }

        await client.query("COMMIT");

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    processed_count: processed.length,
                    processed,
                    skipped_count: skipped.length,
                    skipped
                },
                `Bulk ${action} completed successfully`
            )
        );

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
});


export const updateOutpassCutoff = asyncHandler(async (req, res) => {
    const { cutoffTime } = req.body;

    if (!cutoffTime) {
        throw new ApiError(400, "Cutoff time is required.");
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

    if (!timeRegex.test(cutoffTime)) {
        throw new ApiError(
            400,
            "Invalid time format. Expected HH:MM or HH:MM:SS."
        );
    }

    const adminId = req.user.id;

    const hostelResult = await pool.query(
        `
        SELECT h.id AS hostel_id
        FROM admin a
        JOIN hostel h
            ON h.name = a.hostel
        WHERE a.id = $1
          AND a.authority_level = 2
        LIMIT 1
        `,
        [adminId]
    );

    if (hostelResult.rowCount === 0) {
        throw new ApiError(403, "Warden not found.");
    }

    const hostelId = hostelResult.rows[0].hostel_id;

    const result = await pool.query(
        `
        UPDATE hostel
        SET local_outpass_cutoff = $1
        WHERE id = $2
        RETURNING id, name, local_outpass_cutoff
        `,
        [cutoffTime, hostelId]
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                cutoffTime: result.rows[0].local_outpass_cutoff,
                hostel: result.rows[0].name
            },
            "Outpass submission deadline updated successfully."
        )
    );
});

export const getOutpassCutoff = asyncHandler(async (req, res) => {
    const adminId = req.user.id;

    const result = await pool.query(
        `
        SELECT
            h.id,
            h.name,
            h.local_outpass_cutoff
        FROM admin a
        JOIN hostel h
            ON h.name = a.hostel
        WHERE a.id = $1
          AND a.authority_level = 2
        LIMIT 1
        `,
        [adminId]
    );

    if (result.rowCount === 0) {
        throw new ApiError(404, "Warden or hostel not found.");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                cutoffTime: result.rows[0].local_outpass_cutoff,
                hostel: result.rows[0].name
            },
            "Outpass submission deadline fetched successfully."
        )
    );
});

export {
    searchByNameOrRollno,
    sortStudentsInRange,
    getOutpassDetails,
    bulkRecordEntry,
    getHostelOutpassesByStatus,
    getAllOutpassesByStatus,
    assignAttendent,
};