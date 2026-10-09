const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { getJwtSecret } = require("../middleware/auth");
const { sendPasswordResetEmail } = require("../services/emailService");

// Resolve frontend base URL for password reset links
const getFrontendUrl = () => {
  if (process.env.FRONTEND_URL && process.env.FRONTEND_URL.trim()) {
    return process.env.FRONTEND_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
    return process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.CLIENT_URL && process.env.CLIENT_URL.trim() && process.env.CLIENT_URL !== "*") {
    const firstOrigin = process.env.CLIENT_URL.split(",")[0].trim();
    if (firstOrigin && firstOrigin !== "*") return firstOrigin.replace(/\/+$/, "");
  }
  return `http://localhost:${process.env.PORT || 5000}`;
};

/**
 * Generate signed JWT token
 */
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      name: user.name
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
};

// @desc    Register a new user with email & password
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Full name is required"
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email address is required"
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address"
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long"
      });
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists. Please log in."
      });
    }

    // Hash password securely with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword
    });

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Log in with email & password
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please provide both email and password"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const token = generateToken(user);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Request password reset link via Resend email
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide your registered email address"
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (user) {
      // Generate 32-byte secure random token
      const resetToken = crypto.randomBytes(32).toString("hex");

      // Store SHA-256 hash in database with 15-minute expiry
      const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");
      user.resetPasswordToken = hashedToken;
      user.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
      await user.save();

      // Construct frontend reset URL
      const frontendBase = getFrontendUrl();
      const resetUrl = `${frontendBase}/?token=${encodeURIComponent(resetToken)}`;

      // Dispatch reset email via Resend (never log or expose token)
      try {
        await sendPasswordResetEmail({
          to: normalizedEmail,
          name: user.name,
          resetUrl,
          resetToken
        });
        console.log(`[AUTH] Password reset email queued for ${normalizedEmail}`);
      } catch (emailError) {
        console.error(`[EMAIL ERROR] Failed to send reset email to ${normalizedEmail}:`, emailError.message);
      }
    }

    // Always return generic success message to prevent user enumeration
    return res.status(200).json({
      success: true,
      message: "If an account with that email exists, password reset instructions have been sent to your email."
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reset password using valid token
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = async (req, res, next) => {
  try {
    const { token, password, confirmPassword } = req.body;

    if (!token || !token.trim()) {
      return res.status(400).json({
        success: false,
        message: "Password reset token is required"
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long"
      });
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match"
      });
    }

    // Hash the token to compare with the database stored hash
    const hashedToken = crypto.createHash("sha256").update(token.trim()).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired password reset token. Please request a new one."
      });
    }

    // Hash the new password securely
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Invalidate reset token and expiry
    user.resetPasswordToken = null;
    user.resetPasswordExpire = null;
    await user.save();

    const authToken = generateToken(user);

    return res.status(200).json({
      success: true,
      message: "Password has been reset successfully",
      token: authToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current authenticated user profile
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  return res.status(200).json({
    success: true,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email
    }
  });
};

// @desc    Logout (invalidates local session)
// @route   POST /api/auth/logout
// @access  Public
const logout = (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Logged out successfully"
  });
};

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  logout
};
