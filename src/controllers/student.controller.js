import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
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

    const dataQuery = `
        SELECT
            id,
            name,
            roll_no,
            email,
            phone,
            department,
            hostel,
            hostel_id,
            physical_room_id,
            created_at

        FROM student

        WHERE ${whereClause}

        ORDER BY created_at DESC

        LIMIT $${values.length + 1}
        OFFSET $${values.length + 2};
    `;

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

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        Math.min(
            parseInt(req.query.limit) || 10,
            100
        );

    const offset =
        (page - 1) * limit;

    if (
        !departure_datetime ||
        !arrival_datetime
    ) {

        throw new ApiError(
            400,
            "Provide departure time and arrival time"
        );
    }

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

        LEFT JOIN room r
        ON s.physical_room_id = r.id

        WHERE
            o.departure_datetime <= $2
            AND
            o.arrival_datetime >= $1

        ORDER BY
            o.departure_datetime DESC

        LIMIT $3 OFFSET $4;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM student s

        JOIN outpass o
        ON o.student_id = s.id

        WHERE
            o.departure_datetime <= $2
            AND
            o.arrival_datetime >= $1;
    `;

    const [
        result,
        countResult
    ] = await Promise.all([

        pool.query(
            dataQuery,
            [
                departure_datetime,
                arrival_datetime,
                limit,
                offset
            ]
        ),

        pool.query(
            countQuery,
            [
                departure_datetime,
                arrival_datetime
            ]
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

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        Math.min(
            parseInt(req.query.limit) || 10,
            100
        );

    const offset =
        (page - 1) * limit;

    if (!outp_status) {
        throw new ApiError(
            400,
            "Outpass status is required"
        );
    }

    const allowedStatus = [
        "Pending",
        "Approved",
        "Rejected"
    ];

    if (
        !allowedStatus.includes(outp_status)
    ) {
        throw new ApiError(
            400,
            "Invalid outpass status"
        );
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

            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,
            r.room_number AS room

        FROM outpass o

        JOIN student s
        ON o.student_id = s.id

        LEFT JOIN room r
        ON s.physical_room_id = r.id

        WHERE
            o.outp_status = $1

        ORDER BY
            o.created_at DESC

        LIMIT $2 OFFSET $3;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM outpass o

        WHERE
            o.outp_status = $1;
    `;

    const [
        result,
        countResult
    ] = await Promise.all([

        pool.query(
            dataQuery,
            [
                outp_status,
                limit,
                offset
            ]
        ),

        pool.query(
            countQuery,
            [outp_status]
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
        attendent_id,
        hostel_id
    } = req.body;

    if (
        !attendent_id ||
        !hostel_id
    ) {

        throw new ApiError(
            400,
            "attendent_id and hostel_id are required"
        );
    }

    const updatedAttendent =
        await pool.query(

            `
            UPDATE attendent

            SET hostel_id = $1

            WHERE id = $2

            RETURNING *;
            `,

            [
                hostel_id,
                attendent_id
            ]
        );

    if (
        updatedAttendent.rowCount === 0
    ) {

        throw new ApiError(
            404,
            "Attendent not found"
        );
    }

    return res.status(200).json(

        new ApiResponse(
            200,
            updatedAttendent.rows[0],
            "Attendent assigned successfully"
        )
    );
});

/*
=================================================
GET HOSTEL OUTPASSES BY STATUS
=================================================
*/
const getHostelOutpassesByStatus = asyncHandler(async (req, res) => {

    const { outp_status } = req.body;

    const page =
        parseInt(req.query.page) || 1;

    const limit =
        Math.min(
            parseInt(req.query.limit) || 10,
            100
        );

    const offset =
        (page - 1) * limit;

    if (!outp_status) {

        throw new ApiError(
            400,
            "Outpass status is required"
        );
    }

    const allowedStatus = [
        "Pending",
        "Approved",
        "Rejected"
    ];

    if (
        !allowedStatus.includes(outp_status)
    ) {

        throw new ApiError(
            400,
            "Invalid outpass status"
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

            s.name,
            s.roll_no,
            s.department,
            s.email,
            s.phone,
            s.hostel,

            r.room_number AS room

        FROM outpass o

        JOIN student s
        ON o.student_id = s.id

        LEFT JOIN room r
        ON s.physical_room_id = r.id

        WHERE
            o.outp_status = $1
            AND s.hostel_id = $2

        ORDER BY
            o.created_at DESC

        LIMIT $3 OFFSET $4;
    `;

    const countQuery = `
        SELECT COUNT(*) AS total

        FROM outpass o

        JOIN student s
        ON o.student_id = s.id

        WHERE
            o.outp_status = $1
            AND s.hostel_id = $2;
    `;

    const [
        result,
        countResult
    ] = await Promise.all([

        pool.query(
            dataQuery,
            [
                outp_status,
                hostelId,
                limit,
                offset
            ]
        ),

        pool.query(
            countQuery,
            [
                outp_status,
                hostelId
            ]
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

            result.rows.length
                ? `${outp_status} hostel outpasses fetched successfully`
                : "No outpasses found"
        )
    );
});

export {
    searchByNameOrRollno,
    sortStudentsInRange,
    getHostelOutpassesByStatus,
    getAllOutpassesByStatus,
    assignAttendent 
};