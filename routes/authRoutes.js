const express = require("express");
const router = express.Router();
const {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  logout
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { forgotPasswordRateLimiter } = require("../middleware/rateLimiter");

// Public routes
router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPasswordRateLimiter, forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/logout", logout);

// Protected routes
router.get("/me", protect, getMe);

module.exports = router;
