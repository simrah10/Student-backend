const express = require("express");
const router = express.Router();
const {
  register,
  verifyEmail,
  resendVerification,
  login,
  forgotPassword,
  resetPassword,
  changePassword,
  getMe,
  getProfile,
  updateProfile,
  logout,
  deleteAccount
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { forgotPasswordRateLimiter } = require("../middleware/rateLimiter");

// Public routes
router.post("/register", register);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", resendVerification);
router.post("/login", login);
router.post("/forgot-password", forgotPasswordRateLimiter, forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/logout", logout);

// Protected routes
router.get("/me", protect, getMe);
router.route("/profile")
  .get(protect, getProfile)
  .put(protect, updateProfile);

// Authenticated password change routes
router.put("/change-password", protect, changePassword);
router.post("/change-password", protect, changePassword);
router.put("/password", protect, changePassword);

// Authenticated permanent account deletion
router.delete("/account", protect, deleteAccount);

module.exports = router;
