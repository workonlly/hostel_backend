/**
 * allocationLogger.js — Audit Log Layer
 * ============================================================
 * Centralised, append-only logging for all allocation events.
 *
 * RULE: Logging MUST NEVER break allocation.
 *       Every public function is wrapped in try/catch.
 *       A logging failure is console.error'd and swallowed.
 *
 * All log functions accept an optional `client` parameter.
 * When passed, they write inside the caller's transaction.
 * When omitted, they use pool directly (best-effort).
 * ============================================================
 */

import pool from '../../db/pool.js';

// ─────────────────────────────────────────────────────────
// INTERNAL WRITE (safe — never throws)
// ─────────────────────────────────────────────────────────

async function _write(type, payload, client) {
    const entry = {
        type,
        ...payload,
        logged_at: new Date().toISOString(),
    };

    // Console always — zero risk
    console.log(`[allocationLogger] ${type}`, entry);

    // Persist to DB using pool (NOT the caller's transaction client).
    // Reason: if allocation_logs table doesn't exist and we use the
    // transaction client, the failing INSERT poisons the connection and
    // silently aborts the caller's transaction. Pool gets a fresh
    // connection each time, so a missing table is fully harmless.
    try {
        await pool.query(
            `INSERT INTO allocation_logs (event_type, payload, logged_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [type, JSON.stringify(payload)]
        );
    } catch {
        // Table may not exist yet — console output above is the fallback.
    }
}

// ─────────────────────────────────────────────────────────
// ALLOCATION SUCCESS / FAILURE
// ─────────────────────────────────────────────────────────

export async function logAllocationSuccess({
    batchId, roundNumber, groupId, roomId, studentIds, client,
} = {}) {
    try {
        await _write('ALLOCATION_SUCCESS', { batchId, roundNumber, groupId, roomId, studentIds }, client);
    } catch (err) {
        console.error('[allocationLogger] logAllocationSuccess error (swallowed):', err.message);
    }
}

export async function logAllocationFailure({
    batchId, roundNumber, groupId, reason, triedRooms, client,
} = {}) {
    try {
        await _write('ALLOCATION_FAILURE', { batchId, roundNumber, groupId, reason, triedRooms }, client);
    } catch (err) {
        console.error('[allocationLogger] logAllocationFailure error (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// ROLLOVER LOGS
// ─────────────────────────────────────────────────────────

export async function logRollover({ batchId, groupId, nextBatchId, reason, client } = {}) {
    try {
        await _write('ROLLOVER', { batchId, groupId, nextBatchId, reason }, client);
    } catch (err) {
        console.error('[allocationLogger] logRollover error (swallowed):', err.message);
    }
}

export async function logRolloverSkipped({ batchId, groupId, reason, client } = {}) {
    try {
        await _write('ROLLOVER_SKIPPED', { batchId, groupId, reason }, client);
    } catch (err) {
        console.error('[allocationLogger] logRolloverSkipped error (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// PENALTY LOGS
// ─────────────────────────────────────────────────────────

export async function logGhostPenalty({ batchId, groupId, memberIds, client } = {}) {
    try {
        await _write('GHOST_PENALTY', { batchId, groupId, memberIds }, client);
    } catch (err) {
        console.error('[allocationLogger] logGhostPenalty error (swallowed):', err.message);
    }
}

export async function logShatter({ groupId, groupSize, largestAvailable, client } = {}) {
    try {
        await _write('SHATTER', { groupId, groupSize, largestAvailable }, client);
    } catch (err) {
        console.error('[allocationLogger] logShatter error (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// FINAL SWEEP LOGS
// ─────────────────────────────────────────────────────────

export async function logFinalSweepAssignment({ hostelId, studentId, roomId, client } = {}) {
    try {
        await _write('FINAL_SWEEP_ASSIGNMENT', { hostelId, studentId, roomId }, client);
    } catch (err) {
        console.error('[allocationLogger] logFinalSweepAssignment error (swallowed):', err.message);
    }
}

export async function logFinalSweepSkipped({ hostelId, studentId, reason, client } = {}) {
    try {
        await _write('FINAL_SWEEP_SKIPPED', { hostelId, studentId, reason }, client);
    } catch (err) {
        console.error('[allocationLogger] logFinalSweepSkipped error (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// RANK IMPORT / BATCH ASSIGNMENT LOGS
// ─────────────────────────────────────────────────────────

export async function logRankImport({ updated, skipped, total, uploadedBy, client } = {}) {
    try {
        await _write('RANK_IMPORT', { updated, skipped, total, uploadedBy }, client);
    } catch (err) {
        console.error('[allocationLogger] logRankImport error (swallowed):', err.message);
    }
}

export async function logBatchAssignment({ hostelId, assigned, unassigned, batches, client } = {}) {
    try {
        await _write('BATCH_ASSIGNMENT', { hostelId, assigned, unassigned, batches }, client);
    } catch (err) {
        console.error('[allocationLogger] logBatchAssignment error (swallowed):', err.message);
    }
}

// ─────────────────────────────────────────────────────────
// GENERIC EVENT
// ─────────────────────────────────────────────────────────

export async function logEvent(type, payload, client) {
    try {
        await _write(type, payload, client);
    } catch (err) {
        console.error('[allocationLogger] logEvent error (swallowed):', err.message);
    }
}
