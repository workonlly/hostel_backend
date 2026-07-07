import { Router } from "express";

import auth from "../../middleware/middleware.js";
import authorizeRoles from "../../middleware/authorizeRoles.js";

import upload from "../middleware/upload.middleware.js";

import {
    enrollFace,
    reEnrollFace,
    verifyFace,
    deleteMyFace,
    healthCheck,
    readyCheck,
} from "../controllers/face.controller.js";

const router = Router();

/*
|--------------------------------------------------------------------------
| Health & Readiness
|--------------------------------------------------------------------------
| Health  -> Checks if Face Authentication module is reachable
| Ready   -> Checks if ZepIris is ready to serve requests
|--------------------------------------------------------------------------
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
|--------------------------------------------------------------------------
| Student Face Enrollment
|--------------------------------------------------------------------------
| Student uploads 1-5 face images.
|--------------------------------------------------------------------------
*/

router.post(
    "/enroll",
    auth,
    authorizeRoles("STUDENT"),
    upload.array("photos", 5),
    enrollFace
);

/*
|--------------------------------------------------------------------------
| Student Face Re-enrollment
|--------------------------------------------------------------------------
| Deletes previous enrollment and uploads new face images.
|--------------------------------------------------------------------------
*/

router.put(
    "/re-enroll",
    auth,
    authorizeRoles("STUDENT"),
    upload.array("photos", 5),
    reEnrollFace
);

/*
|--------------------------------------------------------------------------
| Student Delete Face Enrollment
|--------------------------------------------------------------------------
| Removes all enrolled faces of the authenticated student.
|--------------------------------------------------------------------------
*/

router.delete(
    "/me",
    auth,
    authorizeRoles("STUDENT"),
    deleteMyFace
);

/*
|--------------------------------------------------------------------------
| Guard Face Verification
|--------------------------------------------------------------------------
| Guard captures a student's face and verifies identity.
|--------------------------------------------------------------------------
*/

router.post(
    "/verify",
    auth,
    authorizeRoles("GUARD"),
    upload.single("capture"),
    verifyFace
);

export default router;