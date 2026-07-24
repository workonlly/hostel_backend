import { Router } from "express";

import auth from "../../middleware/middleware.js";
import authorizeRoles from "../../middleware/authorizeRoles.js";

import upload from "../middleware/upload.middleware.js";

import {
    enrollFace,
    reEnrollFace,
    verifyFace,
    deleteFace,
    healthCheck,
    readyCheck,
} from "../controllers/face.controller.js";

const router = Router();

/*
=====================================================
HEALTH & READINESS
=====================================================
*/

router.get(
    "/health",
    auth,
    authorizeRoles("ADMIN", "GUARD"),
    healthCheck
);

router.get(
    "/ready",
    auth,
    authorizeRoles("ADMIN", "GUARD"),
    readyCheck
);

/*
=====================================================
STUDENT ROUTES
=====================================================
*/

// Enroll face
router.post(
    "/enroll",
    auth,
    authorizeRoles("STUDENT"),
    upload.array("photos", 5),
    enrollFace
);

// Re-enroll face
router.put(
    "/re-enroll",
    auth,
    authorizeRoles("STUDENT"),
    upload.array("photos", 5),
    reEnrollFace
);

// Delete all enrolled faces of logged-in student
router.delete(
    "/me",
    auth,
    authorizeRoles("STUDENT"),
    deleteFace
);

/*
=====================================================
GUARD ROUTES
=====================================================
*/

// Verify captured face
router.post(
    "/verify",
    auth,
    authorizeRoles("GUARD"),
    upload.single("capture"),
    verifyFace
);

export default router;