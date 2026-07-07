/**
 * roundScheduler.js
 * ============================================================
 * Timing domain: 10-MINUTE ROUND EXECUTION CYCLES
 *
 * Owns:
 *   - Freezing submission windows at minute 10/20/30...
 *   - Calling allocationService.executeBatchRound()
 *   - Advancing the round counter (1 → 2 → ... → 6)
 *   - Broadcasting updated room maps after allocation
 *   - Detecting end of round cycle (after Round 6)
 *   - Crash recovery: re-derives current round from DB
 *
 * Does NOT:
 *   - Activate/deactivate batches → batchScheduler
 *   - Run rollover/penalty logic  → evaluationScheduler
 *   - Contain allocation math     → engine/roundallocator.js
 *
 * Round timing (per batch window):
 *   Round 1: 0–10 min
 *   Round 2: 10–20 min
 *   ...
 *   Round 6: 50–60 min
 *
 * ROUND_DURATION_MS can be overridden via env for testing.
 * ============================================================
 */

import pool from '../../db/pool.js';
import { allocationService } from '../services/allocation.service.js';
import { emit, WS_EVENTS } from '../websocket/emitter.js';
import { ROUND_DURATION_MS, MAX_ROUNDS } from '../constants/testConfig.js';
import { writeAllocationOutput } from '../utils/allocationOutputWriter.js';

// Will be injected to avoid circular dep (evaluationScheduler uses roundScheduler)
let _evaluationScheduler = null;
export function injectEvaluationScheduler(evalSched) {
    _evaluationScheduler = evalSched;
}

// Per-batch state: batchId → { currentRound, frozen, timerId }
const _state = new Map();

// ─────────────────────────────────────────────────────────
// STARTUP RECOVERY
// ─────────────────────────────────────────────────────────

/**
 * Called by batchScheduler during boot when an ACTIVE batch
 * is found. Re-derives which round we're in from timestamps
 * and re-arms the correct timer.
 */
export async function recoverOnBoot(batchId) {
    const batchRes = await pool.query(
        `SELECT * FROM batch WHERE id = $1 AND status = 'ACTIVE'`,
        [batchId]
    );

    if (batchRes.rowCount === 0) return;

    const batch = batchRes.rows[0];
    const now = new Date();
    const startTime = new Date(batch.start_time);

    const elapsedMs = now.getTime() - startTime.getTime();
    const completedRounds = Math.min(
        Math.floor(elapsedMs / ROUND_DURATION_MS),
        MAX_ROUNDS
    );
    const currentRound = completedRounds + 1;

    if (currentRound > MAX_ROUNDS) {
        console.log(`[roundScheduler] Batch ${batchId} already past round 6, no recovery needed`);
        return;
    }

    const msIntoCurrentRound = elapsedMs - (completedRounds * ROUND_DURATION_MS);
    const msUntilFreeze = ROUND_DURATION_MS - msIntoCurrentRound;

    console.log(
        `[roundScheduler] Recovering batch ${batchId} — ` +
        `round ${currentRound}, freeze in ${Math.round(msUntilFreeze / 1000)}s`
    );

    // Check if submissions already happened for rounds we missed
    for (let r = 1; r < currentRound; r++) {
        const processed = await pool.query(
            `SELECT 1 FROM allocation_submission WHERE batch_id = $1 AND round_number = $2 AND is_processed = true`,
            [batchId, r]
        );
        if (processed.rowCount === 0) {
            // Missed a round execution — run it now
            console.warn(`[roundScheduler] Round ${r} was not processed — executing now`);
            await executeRound(batchId, r);
        }
    }

    // Resume from where we are — store the ACTUAL batch start time (from DB)
    // so _armFreezeTimer can compute absolute deadlines correctly.
    const batchStartTime = new Date(batch.start_time).getTime();
    _state.set(batchId, { currentRound, frozen: false, timerId: null, batchStartTime });
    _armFreezeTimer(batchId, currentRound, batchStartTime);
}

// ─────────────────────────────────────────────────────────
// ROUND CYCLE CONTROL
// ─────────────────────────────────────────────────────────

/**
 * Begin the round cycle for a newly activated batch.
 * Called by batchScheduler immediately after startBatch().
 */
export async function startRoundCycle(batchId) {
    console.log(`[roundScheduler] Starting round cycle for batch ${batchId}`);

    // Record the absolute batch start time — used for drift-free round scheduling.
    // Each round's freeze fires at: batchStartTime + (roundNumber × ROUND_DURATION_MS)
    // so processing time inside executeRound does NOT accumulate across rounds.
    const batchStartTime = Date.now();
    _state.set(batchId, { currentRound: 1, frozen: false, timerId: null, batchStartTime });

    const roundEndsAt = new Date(batchStartTime + ROUND_DURATION_MS).toISOString();
    emit(WS_EVENTS.ROUND_OPENED, { batchId, roundNumber: 1, roundEndsAt });

    _armFreezeTimer(batchId, 1, batchStartTime);
}

/**
 * Stop all timers for a batch (called when batch ends).
 */
export function stopRoundCycle(batchId) {
    const state = _state.get(batchId);
    if (state?.timerId) {
        clearTimeout(state.timerId);
    }
    _state.delete(batchId);
    console.log(`[roundScheduler] Round cycle stopped for batch ${batchId}`);
}

// ─────────────────────────────────────────────────────────
// INTERNAL TIMER HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Arm the freeze timer for a round using an ABSOLUTE deadline.
 *
 * delayMs is calculated as:
 *   targetFireAt = batchStartTime + (roundNumber × ROUND_DURATION_MS)
 *   delay        = targetFireAt - Date.now()
 *
 * This means: even if executeRound() takes 45 seconds, the next round's
 * timer is still anchored to the original batch start, not to when
 * executeRound finished. No drift accumulates across 6 rounds.
 *
 * @param {string} batchId
 * @param {number} round — 1-indexed round number
 * @param {number} batchStartTime — epoch ms when the batch started
 */
function _armFreezeTimer(batchId, round, batchStartTime) {
    const state = _state.get(batchId);
    if (!state) return;

    clearTimeout(state.timerId);

    const targetFireAt = batchStartTime + round * ROUND_DURATION_MS;
    const delayMs      = Math.max(0, targetFireAt - Date.now());

    if (delayMs < 1000) {
        console.warn(
            `[roundScheduler] Round ${round} deadline already past by ${-delayMs}ms — ` +
            'firing immediately. Check for server overload.'
        );
    }

    state.timerId = setTimeout(async () => {
        try {
            await freezeRound(batchId, round);
        } catch (err) {
            console.error(`[roundScheduler] freezeRound failed (batch=${batchId}, round=${round}):`, err.message);
        }
    }, delayMs);

    state.timerId = state.timerId; // keep reference
    _state.set(batchId, state);

    console.log(
        `[roundScheduler] Round ${round} freeze timer set: fires in ${Math.round(delayMs / 1000)}s ` +
        `(absolute target: ${new Date(targetFireAt).toISOString()})`
    );
}

// ─────────────────────────────────────────────────────────
// A. FREEZE CURRENT ROUND
// ─────────────────────────────────────────────────────────

/**
 * Marks the round as frozen — no more submissions accepted.
 * Then immediately executes the allocator.
 */
export async function freezeRound(batchId, round) {
    const state = _state.get(batchId);
    if (!state || state.frozen) return;

    state.frozen = true;
    _state.set(batchId, state);

    console.log(`[roundScheduler] Round ${round} frozen for batch ${batchId}`);
    emit(WS_EVENTS.ROUND_FROZEN, { batchId, round });

    await executeRound(batchId, round);
}

// ─────────────────────────────────────────────────────────
// B. EXECUTE ALLOCATOR
// ─────────────────────────────────────────────────────────

/**
 * Calls the allocation service engine.
 * Results committed to DB inside the engine.
 */
export async function executeRound(batchId, round) {
    console.log(`[roundScheduler] Executing round ${round} for batch ${batchId}`);

    let result;
    try {
        result = await allocationService.executeBatchRound(batchId, round);
    } catch (err) {
        console.error(`[roundScheduler] executeBatchRound error:`, err.message);
        result = { error: err.message };
    }

    console.log(`[roundScheduler] Round ${round} complete:`, result);

    // ── Write CSV + log to outputs/<hostel>/ ─────────────
    try {
        const batchMeta = await pool.query(
            `SELECT b.batch_number, b.allocation_event_id, ae.target_year
             FROM batch b
             JOIN allocation_event ae ON ae.id = b.allocation_event_id
             WHERE b.id = $1`,
            [batchId]
        );

        if (batchMeta.rowCount > 0 && result && !result.error) {
            const { batch_number, allocation_event_id } = batchMeta.rows[0];
            await writeAllocationOutput({
                hostelName:  `event-${allocation_event_id}`,
                hostelId:    allocation_event_id,
                batchId,
                batchNumber: batch_number,
                roundNumber: round,
                results:     result.results ?? [],
                allocated:   result.allocated ?? 0,
                failed:      result.failed ?? 0,
                processed:   result.processed ?? 0,
            });
        }
    } catch (err) {
        // Output write failures must never disrupt allocation
        console.error(`[roundScheduler] writeAllocationOutput error (swallowed):`, err.message);
    }

    emit(WS_EVENTS.ROUND_EXECUTED, { batchId, round, result });

    // Broadcast updated room map
    await broadcastResults(batchId, round);

    // Recalculate ranks for any re-formed groups (from shatter) that finalised
    // during this round. Self-terminating if none exist.
    if (_evaluationScheduler) {
        try {
            const batchRes = await pool.query(
                `SELECT allocation_event_id FROM batch WHERE id = $1`, [batchId]
            );
            if (batchRes.rowCount > 0) {
                await _evaluationScheduler.recalculateGroupRanks(batchRes.rows[0].allocation_event_id);
            }
        } catch (err) {
            console.error(`[roundScheduler] recalculateGroupRanks error:`, err.message);
        }
    }

    // Advance to next round
    await advanceRound(batchId, round);
}

// ─────────────────────────────────────────────────────────
// C. BROADCAST ROOM MAP
// ─────────────────────────────────────────────────────────

/**
 * Fetches the current live room map and emits to all clients.
 */
export async function broadcastResults(batchId, round) {
    try {
        const batchRes = await pool.query(
            `SELECT allocation_event_id FROM batch WHERE id = $1`,
            [batchId]
        );
        if (batchRes.rowCount === 0) return;

        const { allocation_event_id } = batchRes.rows[0];
        const roomMap = await allocationService.getLiveRoomMap(allocation_event_id);

        // Pusher has a 10 KB per-message limit.
        // Strip heavy occupants arrays before broadcasting;
        // clients that need occupant detail will re-fetch via REST.
        const slimRooms = roomMap.map(({ occupants: _o, ...rest }) => rest);

        emit(WS_EVENTS.ROOM_MAP_UPDATED, { eventId: allocation_event_id, batchId, round, rooms: slimRooms }, allocation_event_id);
    } catch (err) {
        console.error(`[roundScheduler] broadcastResults error:`, err.message);
    }
}

// ─────────────────────────────────────────────────────────
// D. ADVANCE ROUND COUNTER
// ─────────────────────────────────────────────────────────

/**
 * Increments round counter and either reopens submissions
 * or ends the cycle if we just finished round 6.
 */
export async function advanceRound(batchId, completedRound) {
    const nextRound = completedRound + 1;

    if (nextRound > MAX_ROUNDS) {
        // F. Detect final round — cycle complete
        await _endRoundCycle(batchId);
        return;
    }

    // E. Reopen submission window for next round
    const state = _state.get(batchId);
    if (!state) return;

    // Run shatter check before opening submissions for next round.
    // If any group's size now exceeds the largest available room,
    // dissolve them so they can regroup into smaller squads.
    if (_evaluationScheduler) {
        try {
            await _evaluationScheduler.checkShatteredGroups(batchId);
        } catch (err) {
            console.error(`[roundScheduler] shatter check error (round ${nextRound}):`, err.message);
        }
    }

    state.currentRound = nextRound;
    state.frozen = false;
    _state.set(batchId, state);

    console.log(`[roundScheduler] Submission window open for round ${nextRound}`);

    // Use absolute deadline for the new round
    const roundEndsAt = new Date(state.batchStartTime + nextRound * ROUND_DURATION_MS).toISOString();
    emit(WS_EVENTS.ROUND_OPENED, { batchId, roundNumber: nextRound, roundEndsAt });

    // Use the stored batchStartTime for absolute deadline — no drift
    _armFreezeTimer(batchId, nextRound, state.batchStartTime);
}

// ─────────────────────────────────────────────────────────
// F. DETECT FINAL ROUND
// ─────────────────────────────────────────────────────────

async function _endRoundCycle(batchId) {
    console.log(`[roundScheduler] All rounds complete for batch ${batchId}`);
    stopRoundCycle(batchId);
    emit(WS_EVENTS.ROUND_CYCLE_DONE, { batchId });
    // batchScheduler's end-timer will close the batch formally
}

// ─────────────────────────────────────────────────────────
// QUERY HELPERS (used by services to check round state)
// ─────────────────────────────────────────────────────────

/**
 * Returns the current active round number for a batch,
 * derived purely from DB timestamps — safe after restart.
 */
export function getCurrentRoundForBatch(batchId) {
    return _state.get(batchId)?.currentRound ?? null;
}

/**
 * Returns whether the current round is frozen (submissions blocked).
 */
export function isRoundFrozen(batchId) {
    return _state.get(batchId)?.frozen ?? false;
}
