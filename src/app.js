import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import pool from "./db/pool.js";

// === Our Room Allocation Routes ===
import groupRoutes from "./roomallocation/groups/groups.routes.js";
import roomRoutes from "./roomallocation/rooms/rooms.routes.js";
import hostelRoutes from "./roomallocation/hostels/hostels.routes.js";
import preferenceRoutes from "./roomallocation/preferences/preferences.routes.js";
import allocationRoutes from "./roomallocation/allocation.routes.js";
import adminRoutes from "./roomallocation/admin/admin.routes.js";
import eventRoutes from "./roomallocation/admin/event.routes.js";
import wardenRoutes from "./roomallocation/first-year-allocation/warden.routes.js";

import importRoutes from "./imports/import.routes.js";

import outpassRoutes from "./routes/outpass.routes.js";
import studentRoutes from "./routes/student.routes.js";

// Working Routes
import authRoutes from "../working-routes/auth.js";
import complaintRoutes from "../working-routes/complaint.js";
import outpassRoutesWorking from "../working-routes/outpass.js";

// Face Authentication Routes
import faceAuthRoutes from "./face-auth/routes/face.routes.js";

const app = express();

/*
=====================================================
GLOBAL MIDDLEWARES
=====================================================
*/

app.use(
    cors({
        origin: true,
        credentials: true,
    })
);

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true,
    })
);

app.use(cookieParser());

/*
=====================================================
REQUEST LOGGER
=====================================================
*/

app.use((req, res, next) => {
    console.log(`${req.method} ${req.originalUrl}`);
    next();
});

/*
=====================================================
HEALTH CHECK ROUTES
=====================================================
*/

// Root Route
app.get("/", (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Hostel Backend Running Successfully",
    });
});

// Debug Route
app.post("/debug", (req, res) => {
    console.log("BODY:", req.body);

    return res.status(200).json({
        success: true,
        body: req.body,
    });
});

// Database Test Route
app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        return res.status(200).json({
            success: true,
            message: "Database connected successfully",
            data: result.rows[0],
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

/*
=====================================================
API ROUTES
=====================================================
*/

// Authentication
app.use("/auth", authRoutes);
app.use("/api/auth", authRoutes);

// Working Routes
app.use("/complaint", complaintRoutes);
app.use("/outpass", outpassRoutesWorking);

// Outpass
app.use("/api/outpasses", outpassRoutes);

// Complaints
app.use("/api/complaints", complaintRoutes);

// Students
app.use("/api/students", studentRoutes);

// Face Authentication
app.use("/api/face-auth", faceAuthRoutes);

// === Room Allocation ===
app.use("/api/groups", groupRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/hostels", hostelRoutes);
app.use("/api/preferences", preferenceRoutes);
app.use("/api/allocation", allocationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", eventRoutes);  // Year-based allocation event management
app.use("/api/warden", wardenRoutes);

// Import Routes
app.use("/api/import", importRoutes);

/*
=====================================================
404 HANDLER
=====================================================
*/

app.use((req, res) => {
    return res.status(404).json({
        success: false,
        message: "Route not found",
    });
});

/*
=====================================================
GLOBAL ERROR HANDLER
=====================================================
*/

app.use((err, req, res, next) => {
    console.error(err);

    return res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
        errors: err.errors || [],
    });
});

export default app;