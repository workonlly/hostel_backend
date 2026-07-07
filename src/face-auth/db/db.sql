CREATE TABLE student_face_enrollment (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES student(id) ON DELETE CASCADE,
    zepiris_face_id VARCHAR(128) UNIQUE NOT NULL,
    photo_index SMALLINT NOT NULL CHECK (photo_index BETWEEN 1 AND 5),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, photo_index)
);


-- ### For Student Table
-- ALTER TABLE student
-- ADD COLUMN IF NOT EXISTS face_enrolled BOOLEAN DEFAULT FALSE;