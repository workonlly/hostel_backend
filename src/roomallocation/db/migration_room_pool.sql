-- ============================================================
-- MIGRATION: allocation_room_pool
-- ============================================================
-- Replaces the single target_hostel_id FK on the hostel table
-- with a granular, room-level allocation pool.
--
-- Key design decisions:
--   • source_hostel_id  → the FROM hostel (whose students participate)
--   • room_id           → one room that is part of that pool
--   • Multiple FROM hostels may share rooms from the same TO hostel,
--     but an admin must configure non-overlapping sets per cycle.
--     Enforcement is at the application layer (the configurator
--     warns when a room is already pooled by another FROM hostel
--     for the same allocation date window).
--   • target_hostel_id on the hostel table is KEPT for informational
--     purposes (display, backward compat) but is no longer the
--     source of truth for room availability.
-- ============================================================

CREATE TABLE IF NOT EXISTS allocation_room_pool (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    room_id          UUID NOT NULL REFERENCES room(id)   ON DELETE CASCADE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_hostel_id, room_id)
);

-- Index for the two most common access patterns:
--   1. getLiveRoomMap  → WHERE source_hostel_id = $1
--   2. submitPreferences validation → WHERE room_id = $1
CREATE INDEX IF NOT EXISTS idx_arp_source ON allocation_room_pool(source_hostel_id);
CREATE INDEX IF NOT EXISTS idx_arp_room   ON allocation_room_pool(room_id);
