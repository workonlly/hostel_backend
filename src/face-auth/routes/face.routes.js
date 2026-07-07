import { Router } from "express";

import auth from "../../middleware/middleware.js";

import upload from "../middleware/upload.middleware.js";

import {
    enrollFace,
    verifyFace,
    deleteFace,
    healthCheck,
} from "../controllers/face.controller.js";

const router = Router();

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

router.get("/health", healthCheck);

/*
|--------------------------------------------------------------------------
| Face Enrollment
|--------------------------------------------------------------------------
*/

router.post(
    "/enroll/:studentId",
    auth,
    upload.array("photos", 5),
    enrollFace
);

/*
|--------------------------------------------------------------------------
| Face Verification (Gate Scan)
|--------------------------------------------------------------------------
*/

router.post(
    "/verify",
    auth,
    upload.single("capture"),
    verifyFace
);

/*
|--------------------------------------------------------------------------
| Delete Face
|--------------------------------------------------------------------------
*/

router.delete(
    "/:faceId",
    auth,
    deleteFace
);

export default router;