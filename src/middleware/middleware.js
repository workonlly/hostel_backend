import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();
const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.headers.token;
    const { role } = req.headers;

    if (!token || !role) {
        return res.status(401).json({ message: 'Token and role are required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded.role !== role) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        req.user = decoded;
        return next();
    } catch (err) {
        console.error(`[Auth] Token verification failed: ${err.message}`);
        return res.status(401).json({ message: 'Invalid token' });
    }
}

export default auth;