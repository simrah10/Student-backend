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

/**
 * Format user profile object for API responses (safely omitting sensitive fields)
 */
const formatUserProfile = (user) => {
  return {
    id: user._id,
    _id: user._id,
    name: user.name || "",
    email: user.email || "",
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

module.exports = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  getProfile,
  updateProfile,
  logout
};
