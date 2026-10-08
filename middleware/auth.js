const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Dynamic JWT secret getter so changes to process.env are respected
const getJwtSecret = () => process.env.JWT_SECRET || "studentflow_jwt_secret_dev_2026";

/**
 * Protect middleware:
 * Validates JWT in Authorization: Bearer <token>
 * Attaches authenticated user to req.user
 */
const protect = async (req, res, next) => {
  let token = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.headers["x-auth-token"]) {
    token = req.headers["x-auth-token"];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access denied. Authentication token required."
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User session expired or user no longer exists."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token."
    });
  }
};

/**
 * Optional auth middleware:
 * If token is provided, attaches req.user. If not, continues without error.
 */
const optionalAuth = async (req, res, next) => {
  let token = null;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.headers["x-auth-token"]) {
    token = req.headers["x-auth-token"];
  }

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.id).select("-password");
    if (user) {
      req.user = user;
    }
  } catch {
    // Ignore invalid token in optionalAuth
  }

  next();
};

module.exports = {
  protect,
  optionalAuth,
  getJwtSecret
};
