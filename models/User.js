const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"]
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please provide a valid email address"
      ],
      index: true
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters long"],
      select: false
    },
    avatar: {
      type: String,
      default: ""
    },
    gender: {
      type: String,
      enum: {
        values: ["Male", "Female", "Prefer not to say", "Other", ""],
        message: "Invalid gender value. Allowed values are 'Male', 'Female', 'Prefer not to say', 'Other', or ''"
      },
      default: ""
    },
    dateOfBirth: {
      type: String,
      default: ""
    },
    phone: {
      type: String,
      maxlength: [25, "Phone cannot exceed 25 characters"],
      trim: true,
      default: ""
    },
    institution: {
      type: String,
      maxlength: [150, "Institution cannot exceed 150 characters"],
      trim: true,
      default: ""
    },
    degree: {
      type: String,
      maxlength: [100, "Degree cannot exceed 100 characters"],
      trim: true,
      default: ""
    },
    department: {
      type: String,
      maxlength: [100, "Department cannot exceed 100 characters"],
      trim: true,
      default: ""
    },
    yearOfStudy: {
      type: String,
      trim: true,
      default: ""
    },
    semester: {
      type: String,
      trim: true,
      default: ""
    },
    studentId: {
      type: String,
      maxlength: [50, "Student ID cannot exceed 50 characters"],
      trim: true,
      default: ""
    },
    graduationYear: {
      type: String,
      maxlength: [10, "Graduation year cannot exceed 10 characters"],
      trim: true,
      default: ""
    },
    resetPasswordToken: {
      type: String,
      default: null,
      select: false
    },
    resetPasswordExpire: {
      type: Date,
      default: null,
      select: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("User", userSchema);
