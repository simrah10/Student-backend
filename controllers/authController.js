const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const Task = require("../models/Task");
const { getJwtSecret } = require("../middleware/auth");
const { sendPasswordResetEmail, sendVerificationOtpEmail } = require("../services/emailService");

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
 * Secret key for OTP hashing
 */
const getOtpSecret = () => {
  return process.env.OTP_SECRET || getJwtSecret();
};

/**
 * Hash a 6-digit OTP using HMAC-SHA256 with a server secret
 */
const hashOtp = (otp) => {
  return crypto
    .createHmac("sha256", getOtpSecret())
    .update(String(otp).trim())
    .digest("hex");
};

/**
 * Generate a cryptographically secure 6-digit OTP
 */
const generateOtp = () => {
  return crypto.randomInt(100000, 1000000).toString();
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

/**
 * Validate password strength against policy:
 * - At least 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 */
const validatePasswordStrength = (password) => {
  if (!password || typeof password !== "string") {
    return {
      isValid: false,
      message: "Password is required"
    };
  }

  if (password.length < 8) {
    return {
      isValid: false,
      message: "Password must be at least 8 characters long"
    };
  }

  if (!/[A-Z]/.test(password)) {
    return {
      isValid: false,
      message: "Password must contain at least one uppercase letter"
    };
  }

  if (!/[a-z]/.test(password)) {
    return {
      isValid: false,
      message: "Password must contain at least one lowercase letter"
    };
  }

  if (!/[0-9]/.test(password)) {
    return {
      isValid: false,
      message: "Password must contain at least one number"
    };
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    return {
      isValid: false,
      message: "Password must contain at least one special character"
    };
  }

  return { isValid: true };
};

// @desc    Register a new user with email & password (generates OTP, requires email verification)
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

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
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
    const existingUser = await User.findOne({ email: normalizedEmail }).select(
      "+emailVerificationLastSent +isEmailVerified"
    );

    if (existingUser) {
      // If user is already verified (or legacy user where isEmailVerified !== false)
      if (existingUser.isEmailVerified !== false) {
        return res.status(400).json({
          success: false,
          message: "An account with this email already exists. Please log in."
        });
      }

      // Existing unverified account: handle safely without creating duplicate users
      const COOLDOWN_MS = 60 * 1000;
      if (existingUser.emailVerificationLastSent) {
        const elapsed = Date.now() - existingUser.emailVerificationLastSent.getTime();
        if (elapsed < COOLDOWN_MS) {
          const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
          return res.status(429).json({
            success: false,
            requiresVerification: true,
            message: `A verification code was recently sent. Please wait ${waitSec} second(s) before requesting a new code.`,
            retryAfter: waitSec,
            email: existingUser.email
          });
        }
      }

      // Update password with new hash if re-registering
      const salt = await bcrypt.genSalt(10);
      existingUser.password = await bcrypt.hash(password, salt);
      existingUser.name = name.trim();

      // Generate new 6-digit OTP and reset attempts
      const otp = generateOtp();
      existingUser.emailVerificationOtp = hashOtp(otp);
      existingUser.emailVerificationExpires = new Date(Date.now() + 5 * 60 * 1000);
      existingUser.emailVerificationAttempts = 0;
      existingUser.emailVerificationLastSent = new Date();
      await existingUser.save();

      // Dispatch verification email via Resend (never log OTP)
      try {
        await sendVerificationOtpEmail({
          to: normalizedEmail,
          name: existingUser.name,
          otp
        });
        console.log(`[AUTH] Verification email dispatched for unverified account ${normalizedEmail}`);
      } catch (emailError) {
        console.error(`[EMAIL ERROR] Failed to send verification email to ${normalizedEmail}:`, emailError.message);
      }

      return res.status(200).json({
        success: true,
        requiresVerification: true,
        message: "Registration pending. A 6-digit verification code has been sent to your email address.",
        user: {
          id: existingUser._id,
          name: existingUser.name,
          email: existingUser.email,
          isEmailVerified: false
        }
      });
    }

    // New registration: hash password and generate OTP
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const otp = generateOtp();
    const hashedOtp = hashOtp(otp);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      isEmailVerified: false,
      emailVerificationOtp: hashedOtp,
      emailVerificationExpires: new Date(Date.now() + 5 * 60 * 1000),
      emailVerificationAttempts: 0,
      emailVerificationLastSent: new Date()
    });

    // Send verification email via Resend (never log OTP)
    try {
      await sendVerificationOtpEmail({
        to: normalizedEmail,
        name: user.name,
        otp
      });
      console.log(`[AUTH] Verification email dispatched for new account ${normalizedEmail}`);
    } catch (emailError) {
      console.error(`[EMAIL ERROR] Failed to send verification email to ${normalizedEmail}:`, emailError.message);
    }

    // Do NOT issue an authenticated JWT until OTP verification succeeds
    return res.status(201).json({
      success: true,
      requiresVerification: true,
      message: "Account created successfully. Please verify your email with the 6-digit code sent to your inbox.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isEmailVerified: false
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Verify email address using 6-digit OTP
// @route   POST /api/auth/verify-email
// @access  Public
const verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email address is required"
      });
    }

    if (!otp || !/^\d{6}$/.test(String(otp).trim())) {
      return res.status(400).json({
        success: false,
        message: "A valid 6-digit verification code is required"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanOtp = String(otp).trim();

    const user = await User.findOne({ email: normalizedEmail }).select(
      "+emailVerificationOtp +emailVerificationExpires +emailVerificationAttempts +isEmailVerified"
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "No account found with this email address"
      });
    }

    if (user.isEmailVerified === true) {
      return res.status(400).json({
        success: false,
        message: "This email address is already verified. Please log in."
      });
    }

    if (!user.emailVerificationOtp || !user.emailVerificationExpires) {
      return res.status(400).json({
        success: false,
        message: "No active verification code found. Please request a new verification code."
      });
    }

    // Check if attempts already reached limit (5)
    if (user.emailVerificationAttempts >= 5) {
      await User.updateOne(
        { _id: user._id },
        { $set: { emailVerificationOtp: null, emailVerificationExpires: null } }
      );
      return res.status(400).json({
        success: false,
        message: "Maximum verification attempts exceeded. Please request a new verification code."
      });
    }

    // Check if expired (5 minutes)
    if (new Date() > user.emailVerificationExpires) {
      await User.updateOne(
        { _id: user._id },
        { $set: { emailVerificationOtp: null, emailVerificationExpires: null } }
      );
      return res.status(400).json({
        success: false,
        message: "Verification code has expired. Please request a new verification code."
      });
    }

    // Compute HMAC-SHA256 of candidate OTP
    const candidateHash = hashOtp(cleanOtp);
    const storedHash = user.emailVerificationOtp;

    // Timing-safe comparison to prevent side-channel timing attacks
    let isMatch = false;
    try {
      const candidateBuffer = Buffer.from(candidateHash, "hex");
      const storedBuffer = Buffer.from(storedHash, "hex");
      if (candidateBuffer.length === storedBuffer.length) {
        isMatch = crypto.timingSafeEqual(candidateBuffer, storedBuffer);
      }
    } catch {
      isMatch = false;
    }

    if (!isMatch) {
      // Atomically increment attempt count
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id, emailVerificationAttempts: { $lt: 5 } },
        { $inc: { emailVerificationAttempts: 1 } },
        { new: true }
      ).select("+emailVerificationAttempts");

      const attemptsCount = updatedUser ? updatedUser.emailVerificationAttempts : 5;
      const remainingAttempts = Math.max(0, 5 - attemptsCount);

      if (attemptsCount >= 5) {
        await User.updateOne(
          { _id: user._id },
          { $set: { emailVerificationOtp: null, emailVerificationExpires: null } }
        );
        return res.status(400).json({
          success: false,
          message: "Maximum verification attempts exceeded. Please request a new verification code.",
          remainingAttempts: 0
        });
      }

      return res.status(400).json({
        success: false,
        message: `Invalid verification code. ${remainingAttempts} attempt(s) remaining.`,
        remainingAttempts
      });
    }

    // Correct OTP: Atomically mark verified and clear OTP data
    const verifiedUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        emailVerificationOtp: storedHash,
        emailVerificationExpires: { $gt: new Date() },
        emailVerificationAttempts: { $lt: 5 }
      },
      {
        $set: {
          isEmailVerified: true,
          emailVerificationOtp: null,
          emailVerificationExpires: null,
          emailVerificationAttempts: 0,
          emailVerificationLastSent: null
        }
      },
      { new: true }
    );

    if (!verifiedUser) {
      return res.status(400).json({
        success: false,
        message: "Verification failed. The code may have expired or been used already."
      });
    }

    // Issue JWT now that verification has succeeded
    const token = generateToken(verifiedUser);

    return res.status(200).json({
      success: true,
      message: "Email verified successfully! You are now logged in.",
      token,
      user: {
        id: verifiedUser._id,
        name: verifiedUser.name,
        email: verifiedUser.email,
        isEmailVerified: true
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Resend 6-digit email verification OTP
// @route   POST /api/auth/resend-verification
// @access  Public
const resendVerification = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email address is required"
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
    const user = await User.findOne({ email: normalizedEmail }).select(
      "+emailVerificationOtp +emailVerificationExpires +emailVerificationAttempts +emailVerificationLastSent +isEmailVerified"
    );

    // If user does not exist: generic response to prevent account enumeration
    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an unverified account with this email exists, a new verification code has been sent."
      });
    }

    // If user is already verified:
    if (user.isEmailVerified !== false) {
      return res.status(400).json({
        success: false,
        message: "This account is already verified. Please log in."
      });
    }

    // Check 60-second cooldown
    const COOLDOWN_MS = 60 * 1000;
    const now = new Date();
    if (user.emailVerificationLastSent) {
      const elapsed = now.getTime() - user.emailVerificationLastSent.getTime();
      if (elapsed < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${retryAfter} second(s) before requesting another verification code.`,
          retryAfter
        });
      }
    }

    // Invalidate previous OTP, generate new 6-digit OTP
    const newOtp = generateOtp();
    const hashedOtp = hashOtp(newOtp);
    const expires = new Date(now.getTime() + 5 * 60 * 1000);

    const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        $or: [
          { emailVerificationLastSent: null },
          { emailVerificationLastSent: { $lte: cooldownCutoff } }
        ]
      },
      {
        $set: {
          emailVerificationOtp: hashedOtp,
          emailVerificationExpires: expires,
          emailVerificationAttempts: 0,
          emailVerificationLastSent: now
        }
      },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(429).json({
        success: false,
        message: "A verification code was recently sent. Please wait before requesting another."
      });
    }

    // Dispatch email via Resend (never log OTP)
    try {
      await sendVerificationOtpEmail({
        to: user.email,
        name: user.name,
        otp: newOtp
      });
      console.log(`[AUTH] Resent verification email to ${user.email}`);
    } catch (emailError) {
      console.error(`[EMAIL ERROR] Failed to resend verification email to ${user.email}:`, emailError.message);
    }

    return res.status(200).json({
      success: true,
      message: "A new verification code has been sent to your email address."
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
    const user = await User.findOne({ email: normalizedEmail }).select("+password +isEmailVerified");

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

    // Check email verification status:
    // Block only if explicitly false. Existing legacy users with undefined or true are allowed.
    if (user.isEmailVerified === false) {
      return res.status(403).json({
        success: false,
        requiresVerification: true,
        message: "Email not verified. Please verify your email before logging in.",
        email: user.email
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

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
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

    // Invalidate reset token and expiry, ensure email is verified
    user.resetPasswordToken = null;
    user.resetPasswordExpire = null;
    user.isEmailVerified = true;
    user.emailVerificationOtp = null;
    user.emailVerificationExpires = null;
    user.emailVerificationAttempts = 0;
    await user.save();

    const authToken = generateToken(user);

    return res.status(200).json({
      success: true,
      message: "Password has been reset successfully",
      token: authToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isEmailVerified: true
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Format user profile object for API responses (safely omitting sensitive fields)
 */
const formatUserProfile = (user) => {
  return {
    id: user._id,
    _id: user._id,
    name: user.name || "",
    email: user.email || "",
    isEmailVerified: user.isEmailVerified !== false,
    avatar: user.avatar || "",
    gender: user.gender || "",
    dateOfBirth: user.dateOfBirth || "",
    phone: user.phone || "",
    institution: user.institution || "",
    degree: user.degree || "",
    department: user.department || "",
    yearOfStudy: user.yearOfStudy || "",
    semester: user.semester || "",
    studentId: user.studentId || "",
    graduationYear: user.graduationYear || "",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

// @desc    Get authenticated user profile
// @route   GET /api/auth/profile
// @access  Private
const getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found"
      });
    }

    const profileData = formatUserProfile(user);
    return res.status(200).json({
      success: true,
      user: profileData,
      profile: profileData,
      data: profileData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update authenticated user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateProfile = async (req, res, next) => {
  try {
    // 1. Identity source: Strictly use req.user._id from JWT, NEVER trust req.body.id or req.body._id
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User profile not found"
      });
    }

    // 2. Email immutability: Email cannot be updated via profile endpoint
    if (req.body.email !== undefined) {
      const submittedEmail = String(req.body.email).toLowerCase().trim();
      if (submittedEmail !== user.email.toLowerCase().trim()) {
        return res.status(400).json({
          success: false,
          message: "Email address cannot be changed through profile update"
        });
      }
    }

    // 3. Name validation
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({
          success: false,
          message: "Full name cannot be empty"
        });
      }
      if (name.length > 100) {
        return res.status(400).json({
          success: false,
          message: "Full name cannot exceed 100 characters"
        });
      }
      user.name = name;
    }

    // 4. Avatar validation (JPEG/PNG/WebP data URL or empty string for removal, max ~500 KB base64 string)
    if (req.body.avatar !== undefined && req.body.avatar !== null) {
      if (typeof req.body.avatar !== "string") {
        return res.status(400).json({
          success: false,
          message: "Avatar must be a valid image data string"
        });
      }
      const avatarStr = req.body.avatar.trim();
      if (avatarStr === "") {
        // Avatar removal
        user.avatar = "";
      } else {
        // Enforce safe size limit (~500 KB)
        if (avatarStr.length > 500 * 1024) {
          return res.status(400).json({
            success: false,
            message: "Avatar image exceeds the allowed size limit (maximum 500 KB)"
          });
        }

        // Validate image data URL prefix & base64 encoding
        const isDataUrl = /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(avatarStr);
        const base64Data = avatarStr.replace(/^data:image\/(jpeg|jpg|png|webp);base64,/i, "").replace(/\s+/g, "");
        const isBase64 = /^[A-Za-z0-9+/=]+$/.test(base64Data);

        if (!isDataUrl || !isBase64) {
          return res.status(400).json({
            success: false,
            message: "Invalid avatar format. Avatar must be a valid JPEG, PNG, or WebP image data URL"
          });
        }

        user.avatar = avatarStr;
      }
    }

    // 5. Gender validation
    if (req.body.gender !== undefined) {
      const gender = String(req.body.gender).trim();
      const allowedGenders = ["Male", "Female", "Prefer not to say", "Other", ""];
      if (!allowedGenders.includes(gender)) {
        return res.status(400).json({
          success: false,
          message: "Invalid gender value. Allowed values are 'Male', 'Female', 'Prefer not to say', 'Other', or empty"
        });
      }
      user.gender = gender;
    }

    // 6. Phone validation (max 25)
    if (req.body.phone !== undefined) {
      const phone = String(req.body.phone).trim();
      if (phone.length > 25) {
        return res.status(400).json({
          success: false,
          message: "Phone number cannot exceed 25 characters"
        });
      }
      user.phone = phone;
    }

    // 7. Institution validation (max 150)
    if (req.body.institution !== undefined) {
      const institution = String(req.body.institution).trim();
      if (institution.length > 150) {
        return res.status(400).json({
          success: false,
          message: "Institution cannot exceed 150 characters"
        });
      }
      user.institution = institution;
    }

    // 8. Degree validation (max 100)
    if (req.body.degree !== undefined) {
      const degree = String(req.body.degree).trim();
      if (degree.length > 100) {
        return res.status(400).json({
          success: false,
          message: "Degree cannot exceed 100 characters"
        });
      }
      user.degree = degree;
    }

    // 9. Department validation (max 100)
    if (req.body.department !== undefined) {
      const department = String(req.body.department).trim();
      if (department.length > 100) {
        return res.status(400).json({
          success: false,
          message: "Department cannot exceed 100 characters"
        });
      }
      user.department = department;
    }

    // 10. Student ID validation (max 50)
    if (req.body.studentId !== undefined) {
      const studentId = String(req.body.studentId).trim();
      if (studentId.length > 50) {
        return res.status(400).json({
          success: false,
          message: "Student ID cannot exceed 50 characters"
        });
      }
      user.studentId = studentId;
    }

    // 11. Graduation Year validation (max 10)
    if (req.body.graduationYear !== undefined) {
      const graduationYear = String(req.body.graduationYear).trim();
      if (graduationYear.length > 10) {
        return res.status(400).json({
          success: false,
          message: "Graduation year cannot exceed 10 characters"
        });
      }
      user.graduationYear = graduationYear;
    }

    // 12. Date of birth (string, max 30)
    if (req.body.dateOfBirth !== undefined) {
      const dateOfBirth = String(req.body.dateOfBirth).trim();
      if (dateOfBirth.length > 30) {
        return res.status(400).json({
          success: false,
          message: "Date of birth cannot exceed 30 characters"
        });
      }
      user.dateOfBirth = dateOfBirth;
    }

    // 13. Year of study & semester (string, max 50)
    if (req.body.yearOfStudy !== undefined) {
      const yearOfStudy = String(req.body.yearOfStudy).trim();
      if (yearOfStudy.length > 50) {
        return res.status(400).json({
          success: false,
          message: "Year of study cannot exceed 50 characters"
        });
      }
      user.yearOfStudy = yearOfStudy;
    }

    if (req.body.semester !== undefined) {
      const semester = String(req.body.semester).trim();
      if (semester.length > 50) {
        return res.status(400).json({
          success: false,
          message: "Semester cannot exceed 50 characters"
        });
      }
      user.semester = semester;
    }

    // Save updated user to MongoDB
    await user.save();

    const profileData = formatUserProfile(user);

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: profileData,
      profile: profileData,
      data: profileData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current authenticated user profile
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  const profileData = formatUserProfile(req.user);
  return res.status(200).json({
    success: true,
    user: profileData
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

// @desc    Change authenticated user password
// @route   PUT /api/auth/change-password, POST /api/auth/change-password, PUT /api/auth/password
// @access  Private
const changePassword = async (req, res, next) => {
  try {
    const currentPassword = req.body.currentPassword || req.body.oldPassword;
    const newPassword = req.body.newPassword || req.body.password;
    const confirmPassword = req.body.confirmPassword || req.body.confirmNewPassword;

    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password is required"
      });
    }

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password is required"
      });
    }

    // Retrieve user with password hash explicitly selected
    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Verify current password with bcrypt
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect"
      });
    }

    // Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message
      });
    }

    // Confirm password if provided
    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match"
      });
    }

    // Prevent reusing current password
    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password"
      });
    }

    // Hash new password using bcryptjs with 10 salt rounds
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password changed successfully"
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Permanently delete authenticated user's account and all associated data
 * DELETE /api/auth/account
 * Private (requires protect middleware)
 */
const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user && req.user._id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required to delete account."
      });
    }

    let isTransactional = false;
    let session = null;

    // Check if MongoDB deployment supports multi-document transactions (e.g. MongoDB Atlas replica set)
    try {
      const topologyType = mongoose.connection?.client?.topology?.description?.type;
      const isReplicaOrSharded = typeof topologyType === "string" && (
        topologyType.includes("ReplicaSet") ||
        topologyType.includes("Sharded")
      );

      if (isReplicaOrSharded) {
        session = await mongoose.startSession();
        await session.withTransaction(
          async () => {
            await Task.deleteMany({ userId: userId }).session(session);
            await User.findByIdAndDelete(userId).session(session);
          },
          {
            readPreference: "primary",
            readConcern: { level: "local" },
            writeConcern: { w: "majority" }
          }
        );
        isTransactional = true;
      }
    } catch (txError) {
      const isUnsupported =
        txError.code === 20 ||
        /replica set|not supported|standalone/i.test(txError.message || "");
      if (isUnsupported) {
        console.warn("MongoDB deployment does not support transactions; using compensated deletion:", txError.message);
        isTransactional = false;
      } else {
        // On a replica set where transactions are supported, the transaction was aborted cleanly.
        // Rethrow so we do not perform unsafe non-atomic deletes on a failing DB.
        throw txError;
      }
    } finally {
      if (session) {
        try {
          await session.endSession();
        } catch (_) {}
      }
    }

    // If transactions are not supported by the deployment, execute compensated failure-safe strategy
    if (!isTransactional) {
      // 1. Delete all user tasks with retry policy
      let taskError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await Task.deleteMany({ userId: userId });
          taskError = null;
          break;
        } catch (err) {
          taskError = err;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 100 * attempt));
        }
      }

      // If task deletion failed after retries, abort BEFORE modifying user document.
      // This leaves the user document and tasks intact, completely preventing orphaned data.
      if (taskError) {
        throw new Error(`Failed to delete user tasks: ${taskError.message}`);
      }

      // 2. Delete user account record with retry policy
      let userError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await User.findByIdAndDelete(userId);
          userError = null;
          break;
        } catch (err) {
          userError = err;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 100 * attempt));
        }
      }

      // 3. Compensation if user document deletion failed after tasks were deleted
      if (userError) {
        // Tasks were removed, but user document deletion failed after 3 retries.
        // Prevent silent inconsistency by releasing original email, invalidating credentials, and deactivating account.
        try {
          const tombstoneEmail = `deleted_${Date.now()}_${userId}@deleted.studentflow.local`;
          const salt = await bcrypt.genSalt(10);
          const scrambledPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), salt);
          await User.updateOne(
            { _id: userId },
            {
              $set: {
                email: tombstoneEmail,
                password: scrambledPassword,
                isEmailVerified: false,
                emailVerificationOtp: null,
                resetPasswordToken: null
              }
            }
          );
          console.warn(`[RECOVERY] Compensated partial deletion for user ${userId}. Email released as ${tombstoneEmail}`);
        } catch (compErr) {
          console.error(`[CRITICAL] Compensation failed for user ${userId}:`, compErr.message);
        }
        throw new Error("Account deletion partially failed and could not be finalized. Your email has been released.");
      }
    }

    return res.status(200).json({
      success: true,
      message: "Your account and all associated data have been permanently deleted."
    });
  } catch (error) {
    console.error("Account deletion error:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while deleting your account. Please try again later."
    });
  }
};

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  forgotPassword,
  resetPassword,
  changePassword,
  validatePasswordStrength,
  getMe,
  getProfile,
  updateProfile,
  logout,
  deleteAccount
};
