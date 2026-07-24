import asyncHandler from "../../utils/asyncHandler.js";
import ApiResponse from "../../utils/ApiResponse.js";

import faceService from "../services/face.service.js";

/*
=====================================================
STUDENT
=====================================================
*/

export const enrollFace = asyncHandler(async (req, res) => {
    const result = await faceService.enrollStudentFaces(
        req.user.id,
        req.files
    );

    return res.status(201).json(
        new ApiResponse(
            201,
            result,
            "Face enrolled successfully."
        )
    );
});

export const reEnrollFace = asyncHandler(async (req, res) => {
    const result = await faceService.reEnrollStudentFaces(
        req.user.id,
        req.files
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face re-enrolled successfully."
        )
    );
});

export const deleteFace = asyncHandler(async (req, res) => {
    const result = await faceService.deleteStudentFaces(
        req.user.id
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face deleted successfully."
        )
    );
});

/*
=====================================================
GUARD
=====================================================
*/

export const verifyFace = asyncHandler(async (req, res) => {
    const result = await faceService.verifyStudentFace(
        req.file
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face verified successfully."
        )
    );
});

/*
=====================================================
HEALTH
=====================================================
*/

export const healthCheck = asyncHandler(async (req, res) => {
    const result = await faceService.healthCheck();

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face authentication service is healthy."
        )
    );
});

export const readyCheck = asyncHandler(async (req, res) => {
    const result = await faceService.readyCheck();

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face authentication service is ready."
        )
    );
});