export const validateRows = async (rows, pool) => {
    const failedRows = [];
    const validRows = [];

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    // Hash maps for quick CSV-level duplicate checking
    const csvEmails = new Set();
    const csvRollNos = new Set();

    // Cache DB checks to avoid too many small queries
    const existingEmails = new Set();
    const existingRollNos = new Set();
    const validHostelIds = new Set();

    // Fetch existing emails and roll numbers
    const existingStudentsRes = await pool.query('SELECT email, roll_no FROM student');
    existingStudentsRes.rows.forEach(s => {
        if (s.email) existingEmails.add(s.email.toLowerCase());
        if (s.roll_no) existingRollNos.add(s.roll_no.toLowerCase());
    });

    // Fetch valid hostel IDs
    const hostelsRes = await pool.query('SELECT id FROM hostel');
    hostelsRes.rows.forEach(h => validHostelIds.add(String(h.id)));

    for (const row of rows) {
        const errors = [];
        const rowIndex = row._csvRowIndex;

        // 1. Required fields
        if (!row.name || row.name.trim() === '') errors.push("Missing required field: name");
        if (!row.hostel_id || String(row.hostel_id).trim() === '') errors.push("Missing required field: hostel_id");
        if (!row.department || row.department.trim() === '') errors.push("Missing required field: department");

        // 2. Email format
        let normalizedEmail = null;
        if (row.email) {
            normalizedEmail = row.email.trim().toLowerCase();
            if (!emailRegex.test(normalizedEmail)) {
                errors.push("Invalid email format");
            }
        }

        let normalizedRollNo = null;
        if (row.roll_no) {
            normalizedRollNo = row.roll_no.trim().toLowerCase();
        }

        // 3. Duplicate within CSV
        if (normalizedEmail) {
            if (csvEmails.has(normalizedEmail)) {
                errors.push("Duplicate email found within CSV payload");
            } else {
                csvEmails.add(normalizedEmail);
            }
        }
        
        if (normalizedRollNo) {
            if (csvRollNos.has(normalizedRollNo)) {
                errors.push("Duplicate roll number found within CSV payload");
            } else {
                csvRollNos.add(normalizedRollNo);
            }
        }

        // 4. Duplicate in Database
        if (normalizedEmail && existingEmails.has(normalizedEmail)) {
            errors.push("Email already exists in database");
        }
        
        if (normalizedRollNo && existingRollNos.has(normalizedRollNo)) {
            errors.push("Roll number already exists in database");
        }

        // 5. Invalid hostel_id
        if (row.hostel_id && !validHostelIds.has(String(row.hostel_id))) {
            errors.push(`Invalid hostel_id: ${row.hostel_id} does not exist in database`);
        }

        // 6. Nullify optional individual_rank if empty
        if (row.individual_rank !== undefined && (row.individual_rank === '' || row.individual_rank === null)) {
            row.individual_rank = null;
        }

        if (errors.length > 0) {
            failedRows.push({
                row: rowIndex,
                errors
            });
        } else {
            // Clean up the index before insert
            delete row._csvRowIndex;
            
            // Normalize for insertion
            if (row.email) row.email = normalizedEmail;
            
            validRows.push(row);
        }
    }

    return { validRows, failedRows };
};
