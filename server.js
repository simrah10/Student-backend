require("dotenv").config();
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const taskRoutes = require("./routes/taskRoutes");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

// CORS Configuration (supports frontend on Render, Vercel, or local dev)
const clientUrl = process.env.CLIENT_URL;
const allowedOrigins = clientUrl && clientUrl !== "*"
  ? clientUrl.split(",").map((origin) => origin.trim())
  : null;

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server, curl, mobile apps, or same-origin requests (origin is undefined)
    if (!origin) return callback(null, true);
    if (!allowedOrigins || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS policy does not allow access from origin ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Helper to safely format MongoDB URI: handles special characters in password and strips template brackets
const formatMongoUri = (rawUri) => {
  if (!rawUri || typeof rawUri !== "string") return rawUri;
  const trimmed = rawUri.trim();

  const protocolMatch = trimmed.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!protocolMatch) return trimmed;
  const [, protocol, rest] = protocolMatch;

  const atIndex = rest.lastIndexOf("@");
  if (atIndex === -1) return trimmed; // No credentials in URI (e.g. local MongoDB)

  const userInfo = rest.slice(0, atIndex);
  const hostAndRest = rest.slice(atIndex + 1);

  const colonIndex = userInfo.indexOf(":");
  let username = colonIndex !== -1 ? userInfo.slice(0, colonIndex) : userInfo;
  let password = colonIndex !== -1 ? userInfo.slice(colonIndex + 1) : "";

  // Strip accidental placeholder angle brackets (< >) from templates
  if (username.startsWith("<") && username.endsWith(">")) {
    username = username.slice(1, -1);
  }
  if (password.startsWith("<") && password.endsWith(">")) {
    password = password.slice(1, -1);
  }

  // Safely URL-encode credentials to handle special characters (@, :, #, %, etc.)
  const safeEncode = (str) => {
    try {
      return encodeURIComponent(decodeURIComponent(str));
    } catch {
      return encodeURIComponent(str);
    }
  };

  return `${protocol}${safeEncode(username)}:${safeEncode(password)}@${hostAndRest}`;
};

// MongoDB Database Connection
const connectDB = async () => {
  if (!MONGO_URI) {
    console.warn("⚠️  MongoDB Warning: MONGO_URI is not set in environment variables. Please set MONGO_URI to connect to your database.");
    return;
  }

  const cleanUri = formatMongoUri(MONGO_URI);

  try {
    const conn = await mongoose.connect(cleanUri);
    console.log(`✓ MongoDB Connected successfully: ${conn.connection.host}`);
  } catch (error) {
    console.error(`✗ MongoDB Connection Error: ${error.message}`);
  }
};

connectDB();

// Health Check Endpoints (used by Render and frontend to check API readiness)
const healthHandler = (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  return res.status(200).json({
    status: isDbConnected ? "OK" : "DEGRADED",
    message: isDbConnected ? "Student Productivity API is running" : "Database disconnected",
    environment: process.env.NODE_ENV || "development",
    uptime: Math.floor(process.uptime()),
    database: isDbConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
};

app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

// Serve static frontend files if public folder exists
app.use(express.static(path.join(__dirname, "public")));

// API status route
app.get("/api", (req, res) => {
  return res.status(200).json({
    status: "OK",
    message: "Student Productivity Backend API is active",
    version: "1.0.0",
    endpoints: {
      health: "/api/health",
      tasks: "/api/tasks"
    }
  });
});

const authRoutes = require("./routes/authRoutes");

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);

// 404 Not Found Handler
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl} - Route not found`
  });
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error("Unhandled Server Error:", err);
  return res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});

// Start Server (only listen if not in test/submodule mode)
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`API Base URL: http://localhost:${PORT}/api/tasks`);
    console.log(`Health Check: http://localhost:${PORT}/api/health`);
  });
}

module.exports = app;
