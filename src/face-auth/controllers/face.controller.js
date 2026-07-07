// src/face-auth/controllers/face.controller.js

import asyncHandler from "../../utils/asyncHandler.js";
import ApiResponse from "../../utils/ApiResponse.js";
import ApiError from "../../utils/ApiError.js";

import faceService from "../services/face.service.js";

export const enrollFace = asyncHandler(async (req, res) => {
    const { studentId } = req.params;

    if (!req.files || req.files.length === 0) {
        throw new ApiError(400, "Please upload at least one image.");
    }

    const result = await faceService.enrollStudentFaces(
        studentId,
        req.files
    );

    return res.status(201).json(
        new ApiResponse(
            201,
            result,
            "Face enrollment completed successfully."
        )
    );
});

export const verifyFace = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new ApiError(400, "Face image is required.");
    }

    const result = await faceService.searchStudentByFace(req.file);

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face verified successfully."
        )
    );
});

export const deleteFace = asyncHandler(async (req, res) => {
    const { faceId } = req.params;

    if (!faceId) {
        throw new ApiError(400, "Face ID is required.");
    }

    await faceService.deleteStudentFace(faceId);

    return res.status(200).json(
        new ApiResponse(
            200,
            null,
            "Face deleted successfully."
        )
    );
});

export const healthCheck = asyncHandler(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(
            200,
            {
                status: "healthy",
            },
            "Face authentication service is running."
        )
    );
});