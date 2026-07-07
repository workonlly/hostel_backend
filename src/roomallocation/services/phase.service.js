/**
 * phase.service.js
 * Single source of truth for all allocation event phase orchestration.
 *
 * NEW ARCHITECTURE (year-based):
 *   Phase is now tracked on `allocation_event` (not `hostel`).
 *   All functions accept `eventId` (UUID of the allocation_event row).
 *
 * Phases (system_phase_enum):
 *   LOBBY        → students form groups, no submissions
 *   SOFT_LOCK    → groups lock, no new members
 *   LIVE_BATCHES → active batch allocation rounds
 *   FINAL_SWEEP  → leftover assignment pass
 *   ADMIN_MODE   → locked for admin use only
 */

import pool from '../../db/pool.js';
import { SYSTEM_PHASES } from '../constants/phases.js';
import { assignGroupsToBatches } from './softLock.service.js';
import ApiError from '../../utils/apiError.js';
import { getPhase, setPhase, invalidatePhase } from '../../cache/phaseCache.js';

// Valid phase transitions
const VALID_TRANSITIONS = {
    [SYSTEM_PHASES.ADMIN_MODE]:   [SYSTEM_PHASES.LOBBY],
    [SYSTEM_PHASES.LOBBY]:        [SYSTEM_PHASES.SOFT_LOCK, SYSTEM_PHASES.ADMIN_MODE],
    [SYSTEM_PHASES.SOFT_LOCK]:    [SYSTEM_PHASES.LIVE_BATCHES, SYSTEM_PHASES.LOBBY, SYSTEM_PHASES.ADMIN_MODE],
    [SYSTEM_PHASES.LIVE_BATCHES]: [SYSTEM_PHASES.FINAL_SWEEP, SYSTEM_PHASES.ADMIN_MODE],
    [SYSTEM_PHASES.FINAL_SWEEP]:  [SYSTEM_PHASES.ADMIN_MODE],
};

// Redis cache key for an event's phase
const _cacheKey = (eventId) => `phase:event:${eventId}`;

// ─────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────

/**
 * Get current phase + pause state for an allocation event.
 *
 * Cache pattern:
 *   1. Check Redis  →  hit: return immediately
 *   2. Miss / error →  query Postgres, populate cache (5 min TTL), return row
 *
 * @param {string} eventId — UUID of allocation_event
 */
export const getCurrentPhase = async (eventId) => {
    const cacheKey = _cacheKey(eventId);

    // 1. Redis read (reuse phaseCache with event-scoped key)
    const cached = await getPhase(cacheKey);
    if (cached !== null) {
        console.log(`[cache] HIT  ${cacheKey}`);
        return cached;
    }

    // 2. Postgres fallback
    console.log(`[cache] MISS ${cacheKey} — querying Postgres`);
    const result = await pool.query(
        `SELECT id, target_year, status AS current_phase, is_paused,
                allocation_date, lobby_opens_at
         FROM allocation_event WHERE id = $1`,
        [eventId]
    );
    if (result.rows.length === 0) throw new ApiError(404, 'Allocation event not found');

    // 3. Populate cache
    await setPhase(cacheKey, result.rows[0]);
    return result.rows[0];
};

/**
 * Get allocation event for a student.
 * Derives the event from the student's group → housing_group.allocation_event_id,
 * OR from the student's hostel + current_year → event_hostel_participation.
 *
 * @param {number|string} studentId
 * @returns {object|null} allocation_event row or null
 */
export const getEventForStudent = async (studentId) => {
    // Prefer: student's group already has an event assigned
    const groupRes = await pool.query(
        `SELECT hg.allocation_event_id
         FROM student s
         JOIN housing_group hg ON hg.id = s.group_id
         WHERE s.id = $1 AND hg.allocation_event_id IS NOT NULL
         LIMIT 1`,
        [studentId]
    );
    if (groupRes.rowCount > 0) {
        return getCurrentPhase(groupRes.rows[0].allocation_event_id);
    }

    // Fallback: find event for student's hostel + current_year
    const eventRes = await pool.query(
        `SELECT ae.id
         FROM allocation_event ae
         JOIN event_hostel_participation ehp ON ehp.allocation_event_id = ae.id
         JOIN student s ON s.hostel_id = ehp.hostel_id
         WHERE s.id = $1
           AND ae.target_year = s.current_year
           AND ae.status != 'ADMIN_MODE'
         ORDER BY ae.created_at DESC
         LIMIT 1`,
        [studentId]
    );
    if (eventRes.rowCount === 0) return null;
    return getCurrentPhase(eventRes.rows[0].id);
};

// ─────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────

/**
 * Transition an allocation event to a new phase.
 * Validates the transition is legal before applying.
 *
 * @param {string} eventId
 * @param {string} newPhase
 */
export const setCurrentPhase = async (eventId, newPhase) => {
    const event = await getCurrentPhase(eventId);

    if (!Object.values(SYSTEM_PHASES).includes(newPhase)) {
        throw new ApiError(400, `Invalid phase: ${newPhase}`);
    }

    const allowed = VALID_TRANSITIONS[event.current_phase] || [];
    if (!allowed.includes(newPhase)) {
        throw new ApiError(400,
            `Cannot transition from ${event.current_phase} → ${newPhase}. ` +
            `Allowed: ${allowed.join(', ') || 'none'}`
        );
    }

    const result = await pool.query(
        `UPDATE allocation_event
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [newPhase, eventId]
    );

    // Side-effect: run batch assignment when entering SOFT_LOCK
    if (event.current_phase === SYSTEM_PHASES.LOBBY && newPhase === SYSTEM_PHASES.SOFT_LOCK) {
        try {
            await assignGroupsToBatches(eventId);
            // Arm timers for all newly-created PENDING batches
            const pendingRes = await pool.query(
                `SELECT id FROM batch WHERE allocation_event_id = $1 AND status = 'PENDING' ORDER BY start_time ASC`,
                [eventId]
            );
            const { scheduleBatch } = await import('../schedulers/batchScheduler.js');
            for (const row of pendingRes.rows) {
                await scheduleBatch(row.id);
            }
        } catch (err) {
            // Log but don't roll back — admin can retry batch assignment
            console.error('[phase.service] softLock batch assignment error:', err.message);
        }
    }

    // Invalidate phase cache so next read reflects the new phase
    await invalidatePhase(_cacheKey(eventId));

    return result.rows[0];
};

/**
 * Pause allocation without changing phase.
 * All submission guards check is_paused first.
 *
 * @param {string} eventId
 */
export const pauseAllocation = async (eventId) => {
    const result = await pool.query(
        `UPDATE allocation_event
         SET is_paused = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id, target_year, status AS current_phase, is_paused`,
        [eventId]
    );
    if (result.rows.length === 0) throw new ApiError(404, 'Allocation event not found');
    await invalidatePhase(_cacheKey(eventId));
    return result.rows[0];
};

/**
 * Resume allocation.
 *
 * @param {string} eventId
 */
export const resumeAllocation = async (eventId) => {
    const result = await pool.query(
        `UPDATE allocation_event
         SET is_paused = FALSE, updated_at = NOW()
         WHERE id = $1
         RETURNING id, target_year, status AS current_phase, is_paused`,
        [eventId]
    );
    if (result.rows.length === 0) throw new ApiError(404, 'Allocation event not found');
    await invalidatePhase(_cacheKey(eventId));
    return result.rows[0];
};

// ─────────────────────────────────────────────────────────
// VALIDATORS  (used as middleware or inside services)
// ─────────────────────────────────────────────────────────

/**
 * Assert allocation event is in a specific phase (or one of many phases).
 * Throws ApiError if not. Use inside service methods.
 *
 * @param {string} eventId
 * @param {string|string[]} requiredPhase
 */
export const validatePhase = async (eventId, requiredPhase) => {
    const event = await getCurrentPhase(eventId);

    if (event.is_paused) {
        throw new ApiError(503, 'Allocation system is currently paused');
    }

    const required = Array.isArray(requiredPhase) ? requiredPhase : [requiredPhase];
    if (!required.includes(event.current_phase)) {
        throw new ApiError(400,
            `Operation not allowed in phase ${event.current_phase}. ` +
            `Required: ${required.join(' or ')}`
        );
    }

    return event;
};

// ─────────────────────────────────────────────────────────
// PHASE-SPECIFIC GUARDS  (use in route middleware)
// ─────────────────────────────────────────────────────────

/** Groups can be created/joined only in LOBBY */
export const canModifyGroups = async (eventId) =>
    validatePhase(eventId, SYSTEM_PHASES.LOBBY);

/** Preferences can be submitted only during LIVE_BATCHES */
export const canSubmitPreferences = async (eventId) =>
    validatePhase(eventId, SYSTEM_PHASES.LIVE_BATCHES);

/** Groups can be locked during SOFT_LOCK or LIVE_BATCHES */
export const canLockGroups = async (eventId) =>
    validatePhase(eventId, [SYSTEM_PHASES.SOFT_LOCK, SYSTEM_PHASES.LIVE_BATCHES]);

/** Convenience: returns true/false without throwing */
export const isPhase = async (eventId, phase) => {
    try {
        await validatePhase(eventId, phase);
        return true;
    } catch {
        return false;
    }
};

/**
 * Admin override is allowed any time EXCEPT during LIVE_BATCHES.
 * Throws ApiError(403) if allocation is currently running.
 *
 * @param {string} eventId
 */
export const canAdminOverride = async (eventId) => {
    const event = await getCurrentPhase(eventId);
    if (event.current_phase === SYSTEM_PHASES.LIVE_BATCHES) {
        throw new ApiError(403,
            'Admin override is disabled during LIVE_BATCHES. ' +
            'Wait until allocation completes or pause the system first.'
        );
    }
    return event;
};
