// src/face-auth/services/face.service.js

import pool from "../../db/pool.js";
import ApiError from "../../utils/ApiError.js";
import zepirisService from "./zepiris.service.js";

class FaceService {
    async enrollStudentFaces(studentId, files) {
        if (!files || files.length === 0) {
            throw new ApiError(400, "Please upload at least one image.");
        }

        if (files.length > 5) {
            throw new ApiError(400, "Maximum 5 images are allowed.");
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            // Check student exists
            const studentResult = await client.query(
                "SELECT id FROM student WHERE id = $1",
                [studentId]
            );

            if (studentResult.rowCount === 0) {
                throw new ApiError(404, "Student not found.");
            }

            const enrolledFaces = [];

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const photoIndex = i + 1;
                const faceId = `stu_${studentId}_${photoIndex}`;

                // Enroll in ZepIris
                const zepirisResponse = await zepirisService.enrollFace({
                    faceId,
                    file,
                });

                // Save mapping
                await client.query(
                    `
                    INSERT INTO student_face_enrollment
                    (student_id, zepiris_face_id, photo_index)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (student_id, photo_index)
                    DO UPDATE
                    SET zepiris_face_id = EXCLUDED.zepiris_face_id
                    `,
                    [studentId, faceId, photoIndex]
                );

                enrolledFaces.push({
                    photoIndex,
                    faceId,
                    quality: zepirisResponse.imageQualityAssessment,
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
                studentId,
                enrolledCount: enrolledFaces.length,
                faces: enrolledFaces,
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async verifyStudentFace(file) {
        const searchResult = await zepirisService.searchFace({ file });

        const matches = searchResult.searchResult?.matches || [];

        if (matches.length === 0) {
            throw new ApiError(404, "No matching face found.");
        }

        const bestMatch = matches[0];

        const result = await pool.query(
            `
            SELECT student_id
            FROM student_face_enrollment
            WHERE zepiris_face_id = $1
            `,
            [bestMatch.id]
        );

        if (result.rowCount === 0) {
            throw new ApiError(404, "Matched face is not linked to any student.");
        }

        return {
            studentId: result.rows[0].student_id,
            matchScore: bestMatch.score,
            faceId: bestMatch.id,
        };
    }

    async deleteStudentFace(faceId) {
        await zepirisService.deleteFace(faceId);

        await pool.query(
            `
            DELETE FROM student_face_enrollment
            WHERE zepiris_face_id = $1
            `,
            [faceId]
        );

        return true;
    }
}

export default new FaceService();