const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized",
            });
        }

        const userRole = req.user.role ? req.user.role.toUpperCase() : "";
        const allowedRolesUpper = allowedRoles.map(r => r.toUpperCase());

        if (!allowedRolesUpper.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: "Forbidden",
            });
        }

        next();
    };
};

export default authorizeRoles;