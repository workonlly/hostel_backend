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

        this.MAX_FACE_IMAGES = 5;
    }

    mapZepirisError(error) {
        if (error instanceof ApiError) {
            throw error;
        }

        const response = error?.response;
        const data = response?.data;

        // -------------------------------
        // Image Quality Validation Errors
        // -------------------------------
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
                    "Spoof image detected. Please use a live face."
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
                "Image quality validation failed."
            );
        }

        // -------------------------------
        // Service unavailable
        // -------------------------------
        if (
            error?.cause?.code === "ECONNREFUSED" ||
            response?.status === 503
        ) {
            throw new ApiError(
                503,
                "Face authentication service is currently unavailable."
            );
        }

        // -------------------------------
        // Timeout
        // -------------------------------
        if (
            error?.name === "AbortError" ||
            error?.code === "ETIMEDOUT"
        ) {
            throw new ApiError(
                504,
                "Face authentication service timed out."
            );
        }

        throw new ApiError(
            500,
            "Unable to communicate with face authentication service."
        );
    }
        async cleanupEnrolledFaces(faceIds = []) {
        if (!faceIds.length) {
            return;
        }

        for (const faceId of faceIds) {
            try {
                await zepirisService.deleteFace(faceId);
            } catch (_) {
                // Ignore cleanup failures.
            }
        }
    }

    async getStudentForEnrollment(client, studentId) {
        const result = await client.query(
            `
            SELECT
                id,
                face_enrolled
            FROM student
            WHERE id = $1
            FOR UPDATE
            `,
            [studentId]
        );

        if (result.rowCount === 0) {
            throw new ApiError(
                404,
                "Student not found."
            );
        }

        return result.rows[0];
    }

    validateEnrollmentFiles(files) {
        if (!files || files.length === 0) {
            throw new ApiError(
                400,
                "Please upload at least one face image."
            );
        }

        if (files.length > this.MAX_FACE_IMAGES) {
            throw new ApiError(
                400,
                `Maximum ${this.MAX_FACE_IMAGES} face images are allowed.`
            );
        }
    }
        async enrollStudentFaces(studentId, files) {
        if (!studentId) {
            throw new ApiError(400, "Student ID is required.");
        }

        this.validateEnrollmentFiles(files);

        const client = await pool.connect();

        // Used for cleanup if transaction fails
        const enrolledFaceIds = [];

        try {
            await client.query("BEGIN");

            const student = await this.getStudentForEnrollment(
                client,
                studentId
            );

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

                let enrollResponse;

                try {
                    enrollResponse =
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
                    imageQualityAssessment:
                        enrollResponse.imageQualityAssessment,
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
                message: "Face enrolled successfully.",

                studentId,

                enrolledCount: enrolledFaces.length,

                faces: enrolledFaces,
            };
        } catch (error) {
            await client.query("ROLLBACK");

            // Remove already enrolled faces from ZepIris
            if (enrolledFaceIds.length) {
                await this.cleanupEnrolledFaces(
                    enrolledFaceIds
                );
            }

            throw error;
        } finally {
            client.release();
        }
    }
        async removeStudentFaces(client, studentId) {
        const mappingResult = await client.query(
            `
            SELECT zepiris_face_id
            FROM student_face_enrollment
            WHERE student_id = $1
            `,
            [studentId]
        );

        const faceIds = mappingResult.rows.map(
            (row) => row.zepiris_face_id
        );

        // Delete from ZepIris
        for (const faceId of faceIds) {
            try {
                await zepirisService.deleteFace(faceId);
            } catch (error) {
                this.mapZepirisError(error);
            }
        }

        // Delete mappings
        await client.query(
            `
            DELETE FROM student_face_enrollment
            WHERE student_id = $1
            `,
            [studentId]
        );

        await client.query(
            `
            UPDATE student
            SET face_enrolled = FALSE
            WHERE id = $1
            `,
            [studentId]
        );

        return faceIds.length;
    }
        async reEnrollStudentFaces(studentId, files) {
        if (!studentId) {
            throw new ApiError(400, "Student ID is required.");
        }

        this.validateEnrollmentFiles(files);

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const student = await this.getStudentForEnrollment(
                client,
                studentId
            );

            if (student.face_enrolled) {
                await this.removeStudentFaces(
                    client,
                    studentId
                );
            }

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        // Fresh enrollment
        return await this.enrollStudentFaces(
            studentId,
            files
        );
    }
        async verifyStudentFace(file) {
        if (!file) {
            throw new ApiError(
                400,
                "Face image is required."
            );
        }

        let searchResult;

        try {
            searchResult =
                await zepirisService.searchFace({
                    file,
                });
        } catch (error) {
            this.mapZepirisError(error);
        }

        const matches =
            searchResult.searchResult?.matches ?? [];

        if (matches.length === 0) {
            throw new ApiError(
                404,
                "Face not recognized. Please try again or use manual search."
            );
        }

        // Best match returned by ZepIris
        const bestMatch = matches[0];

        // Lower cosine distance = Better match
        if (bestMatch.score > this.MATCH_THRESHOLD) {
            throw new ApiError(
                401,
                "Face verification failed."
            );
        }

        const result = await pool.query(
            `
            SELECT
                s.id,
                s.name,
                s.roll_no,
                s.email,
                s.phone_no,
                s.hostel_id,
                s.face_enrolled,

                o.id AS outpass_id,
                o.destination,
                o.reason,
                o.departure_datetime,
                o.parent_contact,
                o.outp_status,
                o.std_status

            FROM student_face_enrollment sfe

            JOIN student s
            ON sfe.student_id = s.id

            LEFT JOIN outpass o
            ON
                o.student_id = s.id
                AND o.is_active = TRUE
                AND o.outp_status = 'Approved'

            WHERE sfe.zepiris_face_id = $1
            `,
            [bestMatch.id]
        );

        if (result.rowCount === 0) {
            throw new ApiError(
                404,
                "Matched face is not linked to any student."
            );
        }

        const row = result.rows[0];

        return {
            matched: true,

            matchScore: bestMatch.score,

            threshold: this.MATCH_THRESHOLD,

            imageQualityAssessment:
                searchResult.imageQualityAssessment,

            student: {
                id: row.id,
                name: row.name,
                roll_no: row.roll_no,
                email: row.email,
                phone_no: row.phone_no,
                hostel_id: row.hostel_id,
                face_enrolled: row.face_enrolled,
            },

            outpass: row.outpass_id
                ? {
                      id: row.outpass_id,
                      destination: row.destination,
                      reason: row.reason,
                      departure_datetime:
                          row.departure_datetime,
                      parent_contact:
                          row.parent_contact,
                      outp_status:
                          row.outp_status,
                      std_status:
                          row.std_status,
                  }
                : null,

            hasActiveOutpass:
                row.outpass_id !== null,
        };
    }
        async deleteStudentFaces(studentId) {
        if (!studentId) {
            throw new ApiError(
                400,
                "Student ID is required."
            );
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const student = await this.getStudentForEnrollment(
                client,
                studentId
            );

            if (!student.face_enrolled) {
                throw new ApiError(
                    404,
                    "No enrolled face found for this student."
                );
            }

            const deletedFaces = await this.removeStudentFaces(
                client,
                studentId
            );

            await client.query("COMMIT");

            return {
                success: true,
                message: "Face enrollment deleted successfully.",
                deletedFaces,
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

    async readyCheck() {
        try {
            return await zepirisService.readyCheck();
        } catch (error) {
            this.mapZepirisError(error);
        }
    }
}

export default new FaceService();