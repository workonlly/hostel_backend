-- =========================================================
-- migration_year_based_alloc.sql
-- Migrate from hostel-scoped to year/event-based architecture.
--
-- SAFE TO RUN on a live database (additive steps first,
-- then destructive steps only after code is deployed).
--
-- Run in two passes:
--   PASS 1 (before deploy): Steps 1-6 — adds new tables/columns
--   PASS 2 (after deploy):  Steps 7-9 — drops legacy columns/tables
-- =========================================================

BEGIN;

-- ─── PASS 1: Additive changes (run BEFORE deploying new code) ────────────────

-- 1. Create allocation_event
CREATE TABLE IF NOT EXISTS allocation_event (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_year      INT  NOT NULL,
    allocation_date  TIMESTAMP WITH TIME ZONE,
    lobby_opens_at   TIMESTAMP WITH TIME ZONE,
    status           system_phase_enum NOT NULL DEFAULT 'ADMIN_MODE',
    is_paused        BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_year   ON allocation_event(target_year);
CREATE INDEX IF NOT EXISTS idx_event_status ON allocation_event(status);

-- 2. Create event_hostel_participation
CREATE TABLE IF NOT EXISTS event_hostel_participation (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    allocation_event_id UUID NOT NULL REFERENCES allocation_event(id) ON DELETE CASCADE,
    hostel_id           UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    joined_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(allocation_event_id, hostel_id)
);
CREATE INDEX IF NOT EXISTS idx_ehp_event  ON event_hostel_participation(allocation_event_id);
CREATE INDEX IF NOT EXISTS idx_ehp_hostel ON event_hostel_participation(hostel_id);

-- 3. Create event_room_pool
CREATE TABLE IF NOT EXISTS event_room_pool (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    allocation_event_id UUID NOT NULL REFERENCES allocation_event(id) ON DELETE CASCADE,
    hostel_id           UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    room_id             UUID NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    added_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(allocation_event_id, room_id)
);
CREATE INDEX IF NOT EXISTS idx_erp_event  ON event_room_pool(allocation_event_id);
CREATE INDEX IF NOT EXISTS idx_erp_hostel ON event_room_pool(hostel_id);
CREATE INDEX IF NOT EXISTS idx_erp_room   ON event_room_pool(room_id);

-- 4. Add current_year to student
ALTER TABLE student
    ADD COLUMN IF NOT EXISTS current_year INTEGER;

-- Backfill: compute from joining_year (adjust academic year logic as needed)
-- e.g. a student who joined in 2023 is in year 3 in 2025-26
UPDATE student
SET current_year = (EXTRACT(YEAR FROM NOW())::INT - joining_year + 1)
WHERE current_year IS NULL AND joining_year IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_student_year ON student(current_year);

-- 5. Add allocation_event_id to housing_group
ALTER TABLE housing_group
    ADD COLUMN IF NOT EXISTS allocation_event_id UUID REFERENCES allocation_event(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_housing_group_event ON housing_group(allocation_event_id);

-- 6. Add allocation_event_id to batch + migrate data
ALTER TABLE batch
    ADD COLUMN IF NOT EXISTS allocation_event_id UUID REFERENCES allocation_event(id) ON DELETE RESTRICT;

-- NOTE: Steps below backfill the new allocation_event rows from existing hostel data.
-- For each hostel that has batches, create a placeholder allocation_event
-- and link all its batches + groups to it. Adjust target_year as needed.

DO $$
DECLARE
    h RECORD;
    ev_id UUID;
BEGIN
    FOR h IN
        SELECT DISTINCT b.hostel_id,
               ho.current_phase,
               ho.allocation_date,
               ho.lobby_opens_at,
               ho.is_paused
        FROM batch b
        JOIN hostel ho ON ho.id = b.hostel_id
        WHERE b.allocation_event_id IS NULL
    LOOP
        -- Create one allocation_event per hostel (target_year defaults to 2; admin can correct)
        INSERT INTO allocation_event (target_year, allocation_date, lobby_opens_at, status, is_paused)
        VALUES (2, h.allocation_date, h.lobby_opens_at,
                COALESCE(h.current_phase::text, 'ADMIN_MODE')::system_phase_enum,
                COALESCE(h.is_paused, FALSE))
        RETURNING id INTO ev_id;

        -- Link the hostel to the event
        INSERT INTO event_hostel_participation (allocation_event_id, hostel_id)
        VALUES (ev_id, h.hostel_id)
        ON CONFLICT DO NOTHING;

        -- Migrate all rooms from allocation_room_pool (if table exists) to event_room_pool
        IF EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'allocation_room_pool'
        ) THEN
            INSERT INTO event_room_pool (allocation_event_id, hostel_id, room_id)
            SELECT ev_id, r.hostel_id, arp.room_id
            FROM allocation_room_pool arp
            JOIN room r ON r.id = arp.room_id
            WHERE arp.source_hostel_id = h.hostel_id
            ON CONFLICT DO NOTHING;
        END IF;

        -- Assign batches to this event
        UPDATE batch
        SET allocation_event_id = ev_id
        WHERE hostel_id = h.hostel_id
          AND allocation_event_id IS NULL;

        -- Assign housing_groups to this event via their batch
        UPDATE housing_group hg
        SET allocation_event_id = ev_id
        FROM batch b
        WHERE b.id = hg.batch_id
          AND b.allocation_event_id = ev_id
          AND hg.allocation_event_id IS NULL;

        RAISE NOTICE 'Created event % for hostel %', ev_id, h.hostel_id;
    END LOOP;
END $$;

-- ─── PASS 2: Destructive changes (run AFTER new code is deployed & verified) ──

-- 7. Drop legacy columns from hostel
-- (Run manually after confirming no code references them)
-- ALTER TABLE hostel DROP COLUMN IF EXISTS current_phase;
-- ALTER TABLE hostel DROP COLUMN IF EXISTS is_paused;
-- ALTER TABLE hostel DROP COLUMN IF EXISTS allocation_date;
-- ALTER TABLE hostel DROP COLUMN IF EXISTS lobby_opens_at;
-- ALTER TABLE hostel DROP COLUMN IF EXISTS target_hostel_id;
-- ALTER TABLE hostel DROP COLUMN IF EXISTS source_hostel_id;

-- 8. Make batch.allocation_event_id NOT NULL (after backfill is confirmed complete)
-- ALTER TABLE batch ALTER COLUMN allocation_event_id SET NOT NULL;

-- 9. Drop old allocation_room_pool table
-- DROP TABLE IF EXISTS allocation_room_pool;

-- 10. Remove old hostel_id from batch (after event_id is confirmed)
-- ALTER TABLE batch DROP COLUMN IF EXISTS hostel_id;

-- 11. Remove old unique constraint on batch_number (was globally unique)
-- ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_batch_number_key;
-- ALTER TABLE batch ADD CONSTRAINT batch_number_per_event UNIQUE(allocation_event_id, batch_number);
-- (Already handled in new schema; only needed if migrating existing DB with old constraint)

COMMIT;
