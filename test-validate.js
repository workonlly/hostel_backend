import fs from 'fs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    const token = jwt.sign({ id: 'test-user', role: 'STUDENT' }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });

    const form = new FormData();
    const buffer = fs.readFileSync('./src/face-auth/test/ayush.jpeg');
    form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'ayush.jpeg');

    const res = await fetch('http://localhost:5000/api/face-auth/validate', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'role': 'STUDENT',
        },
        body: form
    });
    
    console.log('STATUS:', res.status);
    const text = await res.text();
    console.log('RESPONSE:', text);
}
test();
