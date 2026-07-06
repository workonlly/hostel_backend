import { Router } from "express";

import auth from "../middleware/middleware.js";

import {
    createOutpass,
    getMyOutpasses,
    getActiveOutpass,
    getOutpassById,
    cancelOutpass,
    bulkOutpassAction,
    getPendingOutpasses,
    approveOutpass,
    rejectOutpass,
    getLateReturns,
    recordEntry,
    monitorDashboard
} from "../controllers/outpass.controller.js";

const router = Router();

/*
=================================================
STUDENT ROUTES
=================================================
*/

router.post(
    "/create",
    auth,
    createOutpass
);

router.get(
    "/my",
    auth,
    getMyOutpasses
);

router.get(
    "/active",
    auth,
    getActiveOutpass
);

router.patch(
    "/cancel/:id",
    auth,
    cancelOutpass
);

/*
=================================================
ATTENDENT ROUTES
=================================================
*/
router.patch(
  "/bulk-action",
  auth,
  bulkOutpassAction
);
router.get(
    "/pending",
    auth,
    getPendingOutpasses
);

router.patch(
    "/approve/:id",
    auth,
    approveOutpass
);

router.patch(
    "/reject/:id",
    auth,
    rejectOutpass
);

router.get(
    "/late-returns",
    auth,
    getLateReturns
);

/*
=================================================
GUARD ROUTES
=================================================
*/

router.post(
    "/record-entry",
    auth,
    recordEntry
);

/*
=================================================
MONITOR
=================================================
*/

router.get(
    "/monitor",
    // auth,
    monitorDashboard
);

/*
=================================================
GET SINGLE OUTPASS
KEEP THIS LAST
=================================================
*/

router.get(
    "/:id",
    auth,
    getOutpassById
);

export default router;