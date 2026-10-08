require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const taskRoutes = require("./routes/taskRoutes");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

// CORS Configuration (supports frontend on Render, Vercel, or local dev)
const clientUrl = process.env.CLIENT_URL;
const corsOptions = {
  origin: clientUrl && clientUrl !== "*"
    ? clientUrl.split(",").map((origin) => origin.trim())
    : "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// MongoDB Database Connection
const connectDB = async () => {
  if (!MONGO_URI) {
    console.warn("⚠️  MongoDB Warning: MONGO_URI is not set in .env. Please set MONGO_URI to connect to your database.");
    return;
  }

  try {
    const conn = await mongoose.connect(MONGO_URI);
    console.log(`✓ MongoDB Connected successfully: ${conn.connection.host}`);
  } catch (error) {
    console.error(`✗ MongoDB Connection Error: ${error.message}`);
  }
};

connectDB();

// Health Check Endpoint (used by Render and frontend to check API readiness)
app.get("/api/health", (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  return res.status(200).json({
    status: "OK",
    message: "Student Productivity API is running",
    environment: process.env.NODE_ENV || "development",
    uptime: Math.floor(process.uptime()),
    database: isDbConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString()
  });
});

// Root welcome route
app.get("/", (req, res) => {
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

// API Routes
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
