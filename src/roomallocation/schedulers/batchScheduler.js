/**
 * batchScheduler.js
 * ============================================================
 * Timing domain: BATCH LIFECYCLE
 *
 * NEW ARCHITECTURE (year-based):
 *   Batches now belong to an allocation_event (not a hostel).
 *   All hostel_id references replaced with allocation_event_id.
 *
 * Owns:
 *   - Activating batches (PENDING → ACTIVE)
 *   - Closing batches   (ACTIVE  → COMPLETED)
 *   - Queuing the next batch
 *   - Event phase transitions (SOFT_LOCK → LIVE_BATCHES,
 *                              LIVE_BATCHES → FINAL_SWEEP)
 *   - WebSocket BATCH_* events
 *
 * Does NOT:
 *   - Execute allocation rounds  → roundScheduler
 *   - Run evaluations            → evaluationScheduler
 *   - Contain business logic     → services / engine
 *
 * Reliability guarantee:
 *   All state is derived from the DB (batch, allocation_event tables).
 *   Timers are re-derived on startup — safe across restarts.
 * ============================================================
 */

import pool from '../../db/pool.js';
import { setCurrentPhase } from '../services/phase.service.js';
import { SYSTEM_PHASES } from '../constants/phases.js';
import { emit, WS_EVENTS } from '../websocket/emitter.js';

// Will be injected after import to avoid circular deps
let _roundScheduler = null;
let _evaluationScheduler = null;

export function injectDependencies({ roundScheduler, evaluationScheduler }) {
    _roundScheduler = roundScheduler;
    _evaluationScheduler = evaluationScheduler;
}

// Active timers: batchId → { startTimer, endTimer }
const _timers = new Map();

// ─────────────────────────────────────────────────────────
// STARTUP RECOVERY
// ─────────────────────────────────────────────────────────

/**
 * Called once on server boot.
 * Re-derives any in-flight batch state from the DB and
 * re-arms timers so a restart never loses work.
 */
export async function recoverOnBoot() {
    console.log('[batchScheduler] Recovering state from DB...');

    // 1. Resume any currently ACTIVE batch
    const activeRes = await pool.query(
        `SELECT b.*, ae.status AS event_phase, ae.is_paused
         FROM batch b
         JOIN allocation_event ae ON b.allocation_event_id = ae.id
         WHERE b.status = 'ACTIVE'`
    );

    for (const batch of activeRes.rows) {
        const now = new Date();
        const end = new Date(batch.end_time);

        if (now >= end) {
            // Batch window already passed — close it immediately
            console.log(`[batchScheduler] Batch ${batch.batch_number} overdue, closing now`);
            await endBatch(batch.id);
        } else {
            // Re-arm end timer
            console.log(`[batchScheduler] Resuming active batch ${batch.batch_number}`);
            _armEndTimer(batch);

            // Let the round scheduler recover its own state
            if (_roundScheduler) {
                await _roundScheduler.recoverOnBoot(batch.id);
            }
        }
    }

    // 2. Arm start timers for all pending batches
    const pendingRes = await pool.query(
        `SELECT * FROM batch WHERE status = 'PENDING' ORDER BY start_time ASC`
    );

    for (const batch of pendingRes.rows) {
        _armStartTimer(batch);
    }

    console.log(
        `[batchScheduler] Recovery complete. ` +
        `Active: ${activeRes.rowCount}, Pending: ${pendingRes.rowCount}`
    );
}

// ─────────────────────────────────────────────────────────
// INTERNAL TIMER HELPERS
// ─────────────────────────────────────────────────────────

function _armStartTimer(batch) {
    const now = new Date();
    const start = new Date(batch.start_time);
    const delayMs = Math.max(0, start.getTime() - now.getTime());

    const existing = _timers.get(batch.id) || {};
    clearTimeout(existing.startTimer);

    existing.startTimer = setTimeout(async () => {
        try {
            await startBatch(batch.id);
        } catch (err) {
            console.error(`[batchScheduler] startBatch failed for ${batch.id}:`, err.message);
        }
    }, delayMs);

    _timers.set(batch.id, existing);
    console.log(
        `[batchScheduler] Start timer armed for batch ${batch.batch_number} in ${Math.round(delayMs / 1000)}s`
    );
}

function _armEndTimer(batch) {
    const now = new Date();
    const end = new Date(batch.end_time);
    const delayMs = Math.max(0, end.getTime() - now.getTime());

    const existing = _timers.get(batch.id) || {};
    clearTimeout(existing.endTimer);

    existing.endTimer = setTimeout(async () => {
        try {
            await endBatch(batch.id);
        } catch (err) {
            console.error(`[batchScheduler] endBatch failed for ${batch.id}:`, err.message);
        }
    }, delayMs);

    _timers.set(batch.id, existing);
    console.log(
        `[batchScheduler] End timer armed for batch ${batch.batch_number} in ${Math.round(delayMs / 1000)}s`
    );
}

// ─────────────────────────────────────────────────────────
// A. ACTIVATE BATCH
// ─────────────────────────────────────────────────────────

/**
 * Transition PENDING → ACTIVE.
 * Emits BATCH_STARTED, transitions event phase if this is
 * the first batch, then hands off to roundScheduler.
 */
export async function startBatch(batchId) {
    const batchRes = await pool.query(
        `UPDATE batch SET status = 'ACTIVE' WHERE id = $1 AND status = 'PENDING' RETURNING *`,
        [batchId]
    );

    if (batchRes.rowCount === 0) {
        console.warn(`[batchScheduler] startBatch: batch ${batchId} not found or not PENDING`);
        return;
    }

    const batch = batchRes.rows[0];
    const eventId = batch.allocation_event_id;
    console.log(`[batchScheduler] Batch ${batch.batch_number} activated (event ${eventId})`);

    // ── HARD LOCK: first action on batch start ─────────────
    // All SOFT_LOCKED groups assigned to this batch are immediately
    // HARD_LOCKED: no new members can be accepted from this point.
    const hardLockRes = await pool.query(
        `UPDATE housing_group
         SET status = 'HARD_LOCKED'
         WHERE batch_id = $1
           AND status = 'SOFT_LOCKED'`,
        [batchId]
    );
    console.log(
        `[batchScheduler] Hard-locked ${hardLockRes.rowCount} groups for batch ${batch.batch_number}`
    );

    // Transition event phase to LIVE_BATCHES if not already
    await transitionSystemPhase(eventId, SYSTEM_PHASES.LIVE_BATCHES);

    // Arm the end timer
    _armEndTimer(batch);

    // Emit to all clients watching this event's channel
    emit(WS_EVENTS.BATCH_STARTED, {
        batchId:     batch.id,
        batchNumber: batch.batch_number,
        eventId,
        startTime:   batch.start_time,
        endTime:     batch.end_time,
    }, eventId);

    // Hand off to round scheduler to begin Round 1
    if (_roundScheduler) {
        await _roundScheduler.startRoundCycle(batchId);
    }
}

// ─────────────────────────────────────────────────────────
// B. CLOSE BATCH
// ─────────────────────────────────────────────────────────

/**
 * Transition ACTIVE → COMPLETED.
 * Stops submissions, emits BATCH_ENDED, triggers evaluations.
 */
export async function endBatch(batchId) {
    const batchRes = await pool.query(
        `UPDATE batch SET status = 'COMPLETED' WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
        [batchId]
    );

    if (batchRes.rowCount === 0) {
        console.warn(`[batchScheduler] endBatch: batch ${batchId} not found or not ACTIVE`);
        return;
    }

    const batch = batchRes.rows[0];
    const eventId = batch.allocation_event_id;
    console.log(`[batchScheduler] Batch ${batch.batch_number} completed (event ${eventId})`);

    // Clear timers
    const timers = _timers.get(batchId);
    if (timers) {
        clearTimeout(timers.startTimer);
        clearTimeout(timers.endTimer);
        _timers.delete(batchId);
    }

    // Stop round scheduler for this batch
    if (_roundScheduler) {
        _roundScheduler.stopRoundCycle(batchId);
    }

    emit(WS_EVENTS.BATCH_ENDED, {
        batchId:     batch.id,
        batchNumber: batch.batch_number,
        eventId,
    }, eventId);

    // Trigger post-batch evaluations (rollover, penalties, shatter)
    if (_evaluationScheduler) {
        await _evaluationScheduler.runPostBatchEvaluation(batchId, eventId);
    }

    // Try to activate the next queued batch
    await activateNextBatch(eventId, batch.batch_number);
}

// ─────────────────────────────────────────────────────────
// C. QUEUE NEXT BATCH
// ─────────────────────────────────────────────────────────

/**
 * Find the next PENDING batch for the event and arm its timer.
 * If none exists, transition to FINAL_SWEEP.
 *
 * @param {string} eventId — UUID of allocation_event
 * @param {number} completedBatchNumber
 */
export async function activateNextBatch(eventId, completedBatchNumber) {
    const nextRes = await pool.query(
        `SELECT * FROM batch
         WHERE allocation_event_id = $1
           AND status = 'PENDING'
           AND batch_number > $2
         ORDER BY batch_number ASC
         LIMIT 1`,
        [eventId, completedBatchNumber]
    );

    if (nextRes.rowCount === 0) {
        // No more pending batches — transition event phase to FINAL_SWEEP
        console.log(`[batchScheduler] No more pending batches for event ${eventId}. Transitioning to FINAL_SWEEP.`);
        await transitionSystemPhase(eventId, SYSTEM_PHASES.FINAL_SWEEP);
        return;
    }

    const nextBatch = nextRes.rows[0];
    console.log(`[batchScheduler] Next batch ${nextBatch.batch_number} queued (event ${eventId})`);

    emit(WS_EVENTS.NEXT_BATCH_READY, {
        batchId:     nextBatch.id,
        batchNumber: nextBatch.batch_number,
        eventId,
        startTime:   nextBatch.start_time,
    }, eventId);

    _armStartTimer(nextBatch);
}

// ─────────────────────────────────────────────────────────
// D. EVENT PHASE TRANSITIONS
// ─────────────────────────────────────────────────────────

/**
 * Safely transition allocation event phase.
 * No-ops if already in target phase (idempotent for recovery).
 *
 * @param {string} eventId — UUID of allocation_event
 * @param {string} targetPhase
 */
export async function transitionSystemPhase(eventId, targetPhase) {
    try {
        const eventRes = await pool.query(
            `SELECT status FROM allocation_event WHERE id = $1`,
            [eventId]
        );

        if (eventRes.rows[0]?.status === targetPhase) {
            return; // Already correct — no-op
        }

        await setCurrentPhase(eventId, targetPhase);
        console.log(`[batchScheduler] Event ${eventId} → ${targetPhase}`);

        emit(WS_EVENTS.PHASE_CHANGED, { eventId, phase: targetPhase }, eventId);
    } catch (err) {
        // Log but don't crash — phase may already be correct after restart
        console.warn(`[batchScheduler] transitionSystemPhase warning: ${err.message}`);
    }
}

/**
 * Manually enqueue a batch (for admin use or testing).
 * Creates start/end timers immediately.
 *
 * @param {string} batchId
 */
export async function scheduleBatch(batchId) {
    const res = await pool.query(`SELECT * FROM batch WHERE id = $1`, [batchId]);
    if (res.rowCount === 0) throw new Error(`Batch ${batchId} not found`);
    _armStartTimer(res.rows[0]);
}
