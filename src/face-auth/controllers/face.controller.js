import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";

import faceService from "../services/face.service.js";

export const enrollFace = asyncHandler(async (req, res) => {
    const result = await faceService.enrollStudentFaces(
        req.params.studentId,
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
    const result = await faceService.verifyStudentFace(req.file);

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face verified successfully."
        )
    );
});

export const deleteFace = asyncHandler(async (req, res) => {
    const result = await faceService.deleteStudentFace(
        req.params.faceId
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            "Face deleted successfully."
        )
    );
});

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