import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const auth = (req, res, next) => {

    const authHeader = req.headers.authorization || "";

    const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : req.headers.token;

    if (!token) {
        return res.status(401).json({
            message: "Token is required"
        });
    }

    try {

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        req.user = decoded;

        next();

    } catch {

        return res.status(401).json({
            message: "Invalid token"
        });

    }
};

export default auth;