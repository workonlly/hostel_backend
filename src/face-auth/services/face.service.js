// src/face-auth/services/face.service.js

import { randomUUID } from "crypto";

import pool from "../../db/pool.js";
import ApiError from "../../utils/ApiError.js";

import zepirisService from "./zepiris.service.js";

class FaceService {
    constructor() {
        this.MATCH_THRESHOLD = Number(
            process.env.ZEPIRIS_MATCH_THRESHOLD ?? 0.5
        );
    }

    mapZepirisError(error) {
        if (error instanceof ApiError) {
            throw error;
        }

        const response = error?.response;
        const data = response?.data;

        // ZepIris IQA Failure (422)
        if (
            response?.status === 422 &&
            data?.detail?.message === "image_quality_check_failed"
        ) {
            const assessment = data.detail.imageQualityAssessment;

            if (!assessment.blur?.is_sharp) {
                throw new ApiError(
                    422,
                    "Image is blurry. Please upload a clearer image."
                );
            }

            if (!assessment.spoof?.is_live) {
                throw new ApiError(
                    422,
                    "Spoof image detected. Please upload a live face."
                );
            }

            if (!assessment.nsfw?.is_safe) {
                throw new ApiError(
                    422,
                    "Uploaded image failed safety validation."
                );
            }

            throw new ApiError(
                422,
                "Image quality check failed."
            );
        }

        if (error?.cause?.code === "ECONNREFUSED") {
            throw new ApiError(
                503,
                "Face authentication service is currently unavailable."
            );
        }

        throw new ApiError(
            500,
            "Unable to communicate with face authentication service."
        );
    }

    async cleanupEnrolledFaces(faceIds) {
        for (const faceId of faceIds) {
            try {
                await zepirisService.deleteFace(faceId);
            } catch (_) {
                // Ignore cleanup failures.
            }
        }
    }

    async enrollStudentFaces(studentId, files) {
        if (!studentId) {
            throw new ApiError(400, "Student ID is required.");
        }

        if (!files || files.length === 0) {
            throw new ApiError(
                400,
                "Please upload at least one face image."
            );
        }

        if (files.length > 5) {
            throw new ApiError(
                400,
                "Maximum 5 face images are allowed."
            );
        }

        const client = await pool.connect();
        const enrolledFaceIds = [];

        try {
            await client.query("BEGIN");

            // Lock student row to avoid concurrent enrollment
            const studentResult = await client.query(
                `
                SELECT id, face_enrolled
                FROM student
                WHERE id = $1
                FOR UPDATE
                `,
                [studentId]
            );

            if (studentResult.rowCount === 0) {
                throw new ApiError(404, "Student not found.");
            }

            const student = studentResult.rows[0];

            if (student.face_enrolled) {
                throw new ApiError(
                    409,
                    "Face is already enrolled for this student."
                );
            }

            const enrolledFaces = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                const faceId = randomUUID();

                let zepirisResponse;

                try {
                    zepirisResponse =
                        await zepirisService.enrollFace({
                            faceId,
                            file,
                        });
                } catch (error) {
                    this.mapZepirisError(error);
                }

                enrolledFaceIds.push(faceId);

                await client.query(
                    `
                    INSERT INTO student_face_enrollment
                    (
                        student_id,
                        zepiris_face_id,
                        photo_index
                    )
                    VALUES ($1, $2, $3)
                    `,
                    [
                        studentId,
                        faceId,
                        i + 1,
                    ]
                );

                enrolledFaces.push({
                    faceId,
                    photoIndex: i + 1,
                    imageQuality:
                        zepirisResponse.imageQualityAssessment,
                });
            }

            await client.query(
                `
                UPDATE student
                SET face_enrolled = TRUE
                WHERE id = $1
                `,
                [studentId]
            );

            await client.query("COMMIT");

            return {
                success: true,
                studentId,
                enrolledCount: enrolledFaces.length,
                faces: enrolledFaces,
            };
        } catch (error) {
            await client.query("ROLLBACK");

            if (enrolledFaceIds.length) {
                await this.cleanupEnrolledFaces(enrolledFaceIds);
            }

            throw error;
        } finally {
            client.release();
        }
    }
        async verifyStudentFace(file) {
        if (!file) {
            throw new ApiError(400, "Face image is required.");
        }

        let searchResult;

        try {
            searchResult = await zepirisService.searchFace({
                file,
            });
        } catch (error) {
            this.mapZepirisError(error);
        }

        const matches = searchResult.searchResult?.matches ?? [];

        if (matches.length === 0) {
            throw new ApiError(
                404,
                "Face not recognized. Please try again or use manual search."
            );
        }

        const bestMatch = matches[0];

        // ZepIris uses cosine distance
        // Lower score = Better match
        if (bestMatch.score > this.MATCH_THRESHOLD) {
            throw new ApiError(
                401,
                "Face verification failed."
            );
        }

        const mappingResult = await pool.query(
            `
            SELECT student_id
            FROM student_face_enrollment
            WHERE zepiris_face_id = $1
            `,
            [bestMatch.id]
        );

        if (mappingResult.rowCount === 0) {
            throw new ApiError(
                404,
                "Matched face is not linked to any student."
            );
        }

        const studentId = mappingResult.rows[0].student_id;

        const studentResult = await pool.query(
            `
            SELECT
                id,
                name,
                roll_no,
                hostel_id,
                email,
                phone_no,
                face_enrolled
            FROM student
            WHERE id = $1
            `,
            [studentId]
        );

        if (studentResult.rowCount === 0) {
            throw new ApiError(
                404,
                "Student record not found."
            );
        }

        const outpassResult = await pool.query(
            `
            SELECT
                id,
                outp_status,
                departure_datetime,
                destination,
                reason,
                std_status,
                parent_contact
            FROM outpass
            WHERE
                student_id = $1
                AND is_active = TRUE
                AND outp_status = 'Approved'
            `,
            [studentId]
        );

        if (outpassResult.rowCount > 1) {
            throw new ApiError(
                500,
                "Multiple active outpasses found for this student."
            );
        }

        return {
            matched: true,

            matchScore: bestMatch.score,

            threshold: this.MATCH_THRESHOLD,

            imageQualityAssessment:
                searchResult.imageQualityAssessment,

            student: studentResult.rows[0],

            outpass:
                outpassResult.rowCount === 1
                    ? outpassResult.rows[0]
                    : null,

            hasActiveOutpass:
                outpassResult.rowCount === 1,
        };
    }
        async deleteStudentFace(faceId) {
        if (!faceId) {
            throw new ApiError(400, "Face ID is required.");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            // Check mapping exists
            const mappingResult = await client.query(
                `
                SELECT
                    student_id,
                    zepiris_face_id
                FROM student_face_enrollment
                WHERE zepiris_face_id = $1
                FOR UPDATE
                `,
                [faceId]
            );

            if (mappingResult.rowCount === 0) {
                throw new ApiError(
                    404,
                    "Face record not found."
                );
            }

            const { student_id } = mappingResult.rows[0];

            // Delete from ZepIris
            try {
                await zepirisService.deleteFace(faceId);
            } catch (error) {
                this.mapZepirisError(error);
            }

            // Delete mapping
            await client.query(
                `
                DELETE FROM student_face_enrollment
                WHERE zepiris_face_id = $1
                `,
                [faceId]
            );

            // Check if student still has enrolled faces
            const remainingFaces = await client.query(
                `
                SELECT COUNT(*)::INTEGER AS total
                FROM student_face_enrollment
                WHERE student_id = $1
                `,
                [student_id]
            );

            if (remainingFaces.rows[0].total === 0) {
                await client.query(
                    `
                    UPDATE student
                    SET face_enrolled = FALSE
                    WHERE id = $1
                    `,
                    [student_id]
                );
            }

            await client.query("COMMIT");

            return {
                success: true,
                deletedFaceId: faceId,
                remainingFaces: remainingFaces.rows[0].total,
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async healthCheck() {
        try {
            return await zepirisService.healthCheck();
        } catch (error) {
            this.mapZepirisError(error);
        }
    }
}

export default new FaceService();