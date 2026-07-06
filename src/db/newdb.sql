-- =========================================================
-- INITIALIZATION
-- =========================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================================
-- 1. ENUM TYPES (For Room Allocation Engine)
-- =========================================================
CREATE TYPE request_type_enum AS ENUM (
    'INVITE_FROM_PRIMARY',
    'APPLICATION_FROM_STUDENT'
);

CREATE TYPE request_status_enum AS ENUM (
    'PENDING',
    'ACCEPTED',
    'REJECTED',
    'CANCELED'
);

CREATE TYPE batch_status_enum AS ENUM (
    'PENDING',
    'ACTIVE',
    'EVALUATING',
    'COMPLETED'
);

CREATE TYPE assigned_by_enum AS ENUM (
    'ALGORITHM',
    'ROLLOVER_PROTECTION',
    'FINAL_SWEEP',
    'ADMIN'
);

CREATE TYPE system_phase_enum AS ENUM (
    'LOBBY',
    'SOFT_LOCK',
    'LIVE_BATCHES',
    'FINAL_SWEEP',
    'ADMIN_MODE'
);

CREATE TYPE group_status_enum AS ENUM (
    'FORMING',
    'SOFT_LOCKED',
    'HARD_LOCKED',
    'ALLOCATED',
    'SHATTERED',
    'PENALIZED'
);

CREATE TYPE allocation_result_enum AS ENUM (
    'PENDING',
    'ALLOCATED',
    'FAILED',
    'ROLLED_OVER',
    'PENALIZED'
);

CREATE TYPE assignment_status_enum AS ENUM (
    'UPCOMING',
    'ACTIVE',
    'PAST'
);

CREATE TYPE room_type_enum AS ENUM (
    'Student',
    'Guest',
    'Reserved'
);


-- =========================================================
-- 2. CORE INFRASTRUCTURE
-- =========================================================
CREATE TABLE hostel (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    type VARCHAR(100),
    total_capacity INT DEFAULT 0,
    current_phase system_phase_enum DEFAULT 'ADMIN_MODE',
    is_paused BOOLEAN DEFAULT FALSE,
    allocation_date TIMESTAMP WITH TIME ZONE,
    lobby_opens_at TIMESTAMP WITH TIME ZONE,
    -- From/To hostel mapping for cross-hostel allocation:
    -- target_hostel_id: rooms from this hostel will be shown/allocated to students of THIS hostel
    target_hostel_id UUID REFERENCES hostel(id) ON DELETE SET NULL,
    -- source_hostel_id: reverse link — students from this hostel are being allocated into THIS hostel
    source_hostel_id UUID REFERENCES hostel(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    authority_level INTEGER NOT NULL CHECK (authority_level IN (1,2,3)),
    hostel VARCHAR(255) REFERENCES hostel(name),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE room (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE RESTRICT,
    room_number VARCHAR(50) NOT NULL,
    block VARCHAR(50) DEFAULT NULL,
    room_type room_type_enum DEFAULT 'Student',
    max_capacity INT NOT NULL CHECK (max_capacity IN (1,2,3,4,5,6)),
    current_occupancy INT DEFAULT 0 CHECK (current_occupancy >= 0 AND current_occupancy <= max_capacity),
    UNIQUE(hostel_id, block, room_number)
);

CREATE TABLE batch (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE RESTRICT,
    batch_number INT UNIQUE NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    status batch_status_enum DEFAULT 'PENDING',
    CHECK (end_time > start_time)
);


-- =========================================================
-- 3. STUDENT & HOUSING GROUP (Resolving Circular FK)
-- =========================================================

-- Create student table first without the group_id foreign key
CREATE TABLE student (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    father_name VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    password VARCHAR(255),
    hostel VARCHAR(255) NOT NULL,
    hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    roll_no VARCHAR(100) UNIQUE,
    phone VARCHAR(255),
    parent_number VARCHAR(20),
    category VARCHAR(50),
    blood_group VARCHAR(10),
    state VARCHAR(100),
    address TEXT,
    pincode VARCHAR(20),
    department VARCHAR(255) NOT NULL,
    cgpa NUMERIC(4,2),
    joining_year INTEGER,
    individual_rank INTEGER,
    is_allotted BOOLEAN DEFAULT FALSE,
    physical_room_id UUID REFERENCES room(id) ON DELETE SET NULL,
    allocated_room_id UUID REFERENCES room(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (joining_year, individual_rank)
);

CREATE TABLE housing_group (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    primary_applicant_id INTEGER NOT NULL REFERENCES student(id),
    group_rank INT,
    batch_id UUID REFERENCES batch(id) ON DELETE SET NULL,
    status group_status_enum DEFAULT 'FORMING',
    rollover_count INT DEFAULT 0,
    is_rollover_priority BOOLEAN DEFAULT FALSE
);

-- Now add the group_id linking back to the housing_group
ALTER TABLE student 
ADD COLUMN group_id UUID REFERENCES housing_group(id) ON DELETE SET NULL;


-- =========================================================
-- 4. ALLOCATION ENGINE TABLES
-- =========================================================

CREATE TABLE group_request (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES housing_group(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    request_type request_type_enum NOT NULL,
    status request_status_enum DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE allocation_submission (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID NOT NULL REFERENCES housing_group(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
    submitted_by INTEGER NOT NULL REFERENCES student(id),
    round_number INT NOT NULL CHECK (round_number >= 1 AND round_number <= 6),
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_processed BOOLEAN DEFAULT FALSE,
    allocation_result allocation_result_enum DEFAULT 'PENDING',
    effective_group_rank INT NOT NULL,
    effective_leader_rank INT NOT NULL,
    effective_group_size INT NOT NULL,
    UNIQUE(group_id, batch_id, round_number)
);

CREATE TABLE submission_preference (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id UUID NOT NULL REFERENCES allocation_submission(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    preference_order INT NOT NULL CHECK (preference_order >= 1 AND preference_order <= 10),
    UNIQUE(submission_id, room_id),
    UNIQUE(submission_id, preference_order)
);

CREATE TABLE room_assignment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id UUID NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    assigned_by assigned_by_enum NOT NULL,
    assignment_status assignment_status_enum DEFAULT 'UPCOMING',
    valid_from DATE,
    valid_until DATE,
    ended_at TIMESTAMP WITH TIME ZONE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

-- ─── Allocation Room Pool ─────────────────────────────────────────────────────
-- Replaces the single target_hostel_id FK on the hostel table with a
-- granular, room-level pool that can span multiple TO hostels.
--
-- Design:
--   • source_hostel_id — the FROM hostel (whose students participate)
--   • room_id          — one room included in that hostel's pool
--   • Multiple FROM hostels may reference rooms from the same TO hostel
--     as long as they don't share the exact same rooms for the same cycle.
--   • target_hostel_id on hostel is KEPT for display / backward compat
--     but is no longer the engine's source of truth.
CREATE TABLE allocation_room_pool (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    room_id          UUID NOT NULL REFERENCES room(id)   ON DELETE CASCADE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_hostel_id, room_id)
);



-- =========================================================
-- 5. STAFF, COMPLAINTS, AND LOGISTICS (Original Schema 1)
-- =========================================================

CREATE TABLE attendent (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(255) NOT NULL,
    hostel VARCHAR(255) NOT NULL,
    hostel_id UUID NOT NULL REFERENCES hostel(id) ON DELETE CASCADE,
    approved_by BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE guard (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(255) NOT NULL,
    approved_by BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE complaint (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled',
    description TEXT NOT NULL,
    hostel VARCHAR(255) NOT NULL,
    status VARCHAR(255) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved')),
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_by INTEGER NULL REFERENCES attendent(id) ON DELETE SET NULL,
    resolved_at TIMESTAMP NULL,
    resolved_description TEXT NULL,
    upvotes INTEGER DEFAULT 0
);

CREATE TABLE outpass (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    outpass_type VARCHAR(50) NOT NULL CHECK (outpass_type IN ('Local', 'Outstation')),
    place_of_visit VARCHAR(255),
    purpose TEXT,
    departure_datetime TIMESTAMP,
    arrival_datetime TIMESTAMP,
    parent_contact VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    outp_status VARCHAR(50) DEFAULT 'Pending' CHECK (outp_status IN ('Pending', 'Approved', 'Rejected')),
    std_status VARCHAR(50) DEFAULT 'In' CHECK (std_status IN ('In', 'Out')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP,
    approved_by INTEGER REFERENCES attendent(id) ON DELETE SET NULL
);

CREATE TABLE visit_log (
    id SERIAL PRIMARY KEY,
    outpass_id INTEGER NOT NULL REFERENCES outpass(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    actual_departure TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actual_arrival TIMESTAMP,
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    gate VARCHAR(100),
    exit_guard_id INTEGER REFERENCES guard(id) ON DELETE SET NULL
);


-- =========================================================
-- 6. INDEXES (Optimized for both schemas)
-- =========================================================

-- General Queries
CREATE INDEX idx_student_hostel ON student(hostel_id);
CREATE INDEX idx_outpass_student ON outpass(student_id);
CREATE INDEX idx_outpass_status ON outpass(outp_status);
CREATE INDEX idx_visit_log_student ON visit_log(student_id);
CREATE INDEX idx_visit_log_outpass ON visit_log(outpass_id);
CREATE INDEX idx_complaint_student ON complaint(student_id);
CREATE INDEX idx_complaint_status ON complaint(status);

-- Room Allocation Engine Queries
CREATE INDEX idx_student_individual_rank ON student(individual_rank);
CREATE INDEX idx_housing_group_batch_id ON housing_group(batch_id);
CREATE INDEX idx_housing_group_group_rank ON housing_group(group_rank);
CREATE INDEX idx_room_occupancy ON room(max_capacity, current_occupancy);

-- Allocation Room Pool
CREATE INDEX idx_arp_source ON allocation_room_pool(source_hostel_id);
CREATE INDEX idx_arp_room   ON allocation_room_pool(room_id);

CREATE UNIQUE INDEX idx_unique_active_assignment ON room_assignment(student_id) WHERE assignment_status = 'ACTIVE';
CREATE UNIQUE INDEX idx_unique_upcoming_assignment ON room_assignment(student_id) WHERE assignment_status = 'UPCOMING';
CREATE UNIQUE INDEX idx_unique_active_request ON group_request(group_id, student_id) WHERE status IN ('PENDING', 'ACCEPTED');

-- =========================================================
-- 10. VIEWS
-- =========================================================

CREATE OR REPLACE VIEW v_housing_group_with_size AS
SELECT
    hg.*,
    (
        SELECT COUNT(*)
        FROM student s
        WHERE s.group_id = hg.id
    ) AS group_size
FROM housing_group hg;

-- =========================================================
-- 12. TRIGGERS
-- =========================================================

-- -------------------------------------------------
-- Group Capacity Validation
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION check_group_capacity()
RETURNS TRIGGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    IF NEW.group_id IS NOT NULL THEN
        -- Lock the row to prevent race conditions during insertion
        PERFORM 1 FROM housing_group WHERE id = NEW.group_id FOR UPDATE;

        SELECT COUNT(*)
        INTO v_count
        FROM student
        WHERE group_id = NEW.group_id AND id <> NEW.id;

        IF v_count >= 4 THEN
            RAISE EXCEPTION 'Group % is already at maximum capacity (4)', NEW.group_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_group_capacity
BEFORE INSERT OR UPDATE OF group_id
ON student
FOR EACH ROW
EXECUTE FUNCTION check_group_capacity();

-- -------------------------------------------------
-- Prevent Group Modification After Lock
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_illegal_group_modification()
RETURNS TRIGGER AS $$
DECLARE
    v_status group_status_enum;
BEGIN
    IF OLD.group_id IS NOT NULL THEN
        SELECT status
        INTO v_status
        FROM housing_group
        WHERE id = OLD.group_id;

        IF v_status IN ('SOFT_LOCKED', 'HARD_LOCKED', 'ALLOCATED') THEN
            RAISE EXCEPTION 'Group modifications are forbidden after lock';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_illegal_group_modification
BEFORE UPDATE OF group_id
ON student
FOR EACH ROW
WHEN (OLD.group_id IS DISTINCT FROM NEW.group_id)
EXECUTE FUNCTION prevent_illegal_group_modification();

-- -------------------------------------------------
-- Validate Primary Applicant (Squad Leader)
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION validate_primary_applicant()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM student
        WHERE id = NEW.primary_applicant_id AND group_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'Primary applicant must belong to the same group';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trigger_validate_primary_applicant
AFTER INSERT OR UPDATE OF primary_applicant_id
ON housing_group
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_primary_applicant();

-- -------------------------------------------------
-- Handle Leader Leaving
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION handle_primary_applicant_leave()
RETURNS TRIGGER AS $$
DECLARE
    v_new_primary INTEGER;
BEGIN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.group_id IS DISTINCT FROM NEW.group_id) THEN
        IF OLD.group_id IS NOT NULL THEN
            -- Check if the person leaving was the primary applicant
            IF EXISTS (
                SELECT 1 FROM housing_group WHERE id = OLD.group_id AND primary_applicant_id = OLD.id
            ) THEN
                -- Find the remaining student with the highest CGPA (lowest rank number)
                SELECT id
                INTO v_new_primary
                FROM student
                WHERE group_id = OLD.group_id AND id <> OLD.id
                ORDER BY individual_rank ASC
                LIMIT 1;

                IF v_new_primary IS NOT NULL THEN
                    -- Pass leadership to them
                    UPDATE housing_group
                    SET primary_applicant_id = v_new_primary
                    WHERE id = OLD.group_id;
                ELSE
                    -- Group is empty, dissolve it
                    DELETE FROM housing_group
                    WHERE id = OLD.group_id;
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_handle_primary_applicant
AFTER UPDATE OF group_id OR DELETE
ON student
FOR EACH ROW
EXECUTE FUNCTION handle_primary_applicant_leave();

-- -------------------------------------------------
-- Dynamic Snapshot Synchronization
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION sync_student_room_snapshot()
RETURNS TRIGGER AS $$
DECLARE
    v_active_room UUID;
    v_upcoming_room UUID;
    v_student_id INTEGER;
BEGIN
    v_student_id := COALESCE(NEW.student_id, OLD.student_id);

    SELECT room_id INTO v_active_room
    FROM room_assignment
    WHERE student_id = v_student_id AND assignment_status = 'ACTIVE'
    LIMIT 1;

    SELECT room_id INTO v_upcoming_room
    FROM room_assignment
    WHERE student_id = v_student_id AND assignment_status = 'UPCOMING'
    LIMIT 1;

    -- Update the fast-read columns in the student table
    UPDATE student
    SET physical_room_id = v_active_room,
        allocated_room_id = v_upcoming_room,
        is_allotted = (v_active_room IS NOT NULL OR v_upcoming_room IS NOT NULL)
    WHERE id = v_student_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_sync_student_room
AFTER INSERT OR UPDATE OF assignment_status OR DELETE
ON room_assignment
FOR EACH ROW
EXECUTE FUNCTION sync_student_room_snapshot();

-- -------------------------------------------------
-- Room Occupancy Recalculation
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION recalculate_room_occupancy()
RETURNS TRIGGER AS $$
BEGIN
    -- Subtract from OLD room if updating or deleting
    IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
        IF OLD.room_id IS NOT NULL THEN
            UPDATE room
            SET current_occupancy = (
                SELECT COUNT(*) FROM room_assignment
                WHERE room_id = OLD.room_id AND assignment_status IN ('ACTIVE', 'UPCOMING')
            )
            WHERE id = OLD.room_id;
        END IF;
    END IF;

    -- Add to NEW room if inserting or updating
    IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
        IF NEW.room_id IS NOT NULL THEN
            UPDATE room
            SET current_occupancy = (
                SELECT COUNT(*) FROM room_assignment
                WHERE room_id = NEW.room_id AND assignment_status IN ('ACTIVE', 'UPCOMING')
            )
            WHERE id = NEW.room_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_room_occupancy
AFTER INSERT OR UPDATE OF room_id, assignment_status OR DELETE
ON room_assignment
FOR EACH ROW
EXECUTE FUNCTION recalculate_room_occupancy();

-- -------------------------------------------------
-- Validate Submission Timing
-- -------------------------------------------------
CREATE OR REPLACE FUNCTION validate_submission_window()
RETURNS TRIGGER AS $$
DECLARE
    v_start TIMESTAMP WITH TIME ZONE;
    v_end TIMESTAMP WITH TIME ZONE;
BEGIN
    SELECT start_time, end_time
    INTO v_start, v_end
    FROM batch
    WHERE id = NEW.batch_id;

    IF CURRENT_TIMESTAMP < v_start OR CURRENT_TIMESTAMP > v_end THEN
        RAISE EXCEPTION 'Submission outside allowed batch window';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_validate_submission_window
BEFORE INSERT
ON allocation_submission
FOR EACH ROW
EXECUTE FUNCTION validate_submission_window();

-- =========================================================
-- 13. ROOM ASSIGNMENT PROCEDURE
-- =========================================================
CREATE OR REPLACE FUNCTION assign_student_to_room(
    p_student_id INTEGER,
    p_room_id UUID,
    p_assigned_by assigned_by_enum
)
RETURNS BOOLEAN AS $$
DECLARE
    v_current_occupancy INT;
    v_max_capacity INT;
BEGIN
    -- 1. Ensure student exists
    IF NOT EXISTS (SELECT 1 FROM student WHERE id = p_student_id) THEN
        RAISE EXCEPTION 'Student % does not exist', p_student_id;
    END IF;

    -- 2. Lock the room row to prevent double booking race conditions
    SELECT current_occupancy, max_capacity
    INTO v_current_occupancy, v_max_capacity
    FROM room
    WHERE id = p_room_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Room % does not exist', p_room_id;
    END IF;

    -- 3. Check Capacity
    IF v_current_occupancy >= v_max_capacity THEN
        RAISE EXCEPTION 'Room % is already at maximum capacity', p_room_id;
    END IF;

    -- 4. Mark any previous UPCOMING assignment for this student as PAST
    UPDATE room_assignment
    SET assignment_status = 'PAST', ended_at = CURRENT_TIMESTAMP
    WHERE student_id = p_student_id AND assignment_status = 'UPCOMING';

    -- 5. Insert new assignment
    INSERT INTO room_assignment (
        room_id, student_id, assigned_by, assignment_status
    ) VALUES (
        p_room_id, p_student_id, p_assigned_by, 'UPCOMING'
    );

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
