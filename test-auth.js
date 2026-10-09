const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Task = require("./models/Task");
const {
  getLastSentEmail,
  setTestEmailHook,
  clearLastSentEmail
} = require("./services/emailService");
const { clearRateLimits } = require("./middleware/rateLimiter");

const request = (options, postData) => {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", (err) => reject(err));
    if (postData) {
      req.write(typeof postData === "string" ? postData : JSON.stringify(postData));
    }
    req.end();
  });
};

async function runAuthTests() {
  console.log("=== STARTING AUTHENTICATION, RESEND EMAIL RESET & TASK ISOLATION TESTS ===\n");
  let mongoServer;
  let server;
  const PORT = 5003;

  try {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "studentflow_test_secret_key_123";
    process.env.FRONTEND_URL = "http://localhost:5000";
    process.env.RESEND_FROM_EMAIL = "StudentFlow <onboarding@resend.dev>";

    await mongoose.connect(uri);
    console.log("✓ In-memory MongoDB connected");

    const app = require("./server");
    server = app.listen(PORT);
    console.log(`✓ Test server running on port ${PORT}\n`);

    const api = async (method, path, body = null, token = null) => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      return request(
        {
          hostname: "localhost",
          port: PORT,
          path,
          method,
          headers
        },
        body
      );
    };

    // 1. Sign Up (User A)
    console.log("[1/17] Testing POST /api/auth/register (User A)...");
    const regResA = await api("POST", "/api/auth/register", {
      name: "Emma Watson",
      email: "emma@oxford.edu",
      password: "password123",
      confirmPassword: "password123"
    });
    if (regResA.status !== 201 || !regResA.body.token) {
      throw new Error(`Registration failed: ${JSON.stringify(regResA.body)}`);
    }
    const tokenA = regResA.body.token;
    console.log("✓ User A registered successfully! JWT session created.");

    // 2. Reject mismatched confirm password
    console.log("\n[2/17] Testing mismatched confirm password validation...");
    const mismatchRes = await api("POST", "/api/auth/register", {
      name: "Mismatch User",
      email: "mismatch@test.com",
      password: "password123",
      confirmPassword: "differentpassword"
    });
    if (mismatchRes.status === 400 && mismatchRes.body.message.includes("match")) {
      console.log("✓ Correctly rejected mismatched passwords with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject mismatched confirmPassword");
    }

    // 3. Reject duplicate email registration
    console.log("\n[3/17] Testing duplicate email rejection...");
    const dupRes = await api("POST", "/api/auth/register", {
      name: "Emma Imposter",
      email: "emma@oxford.edu",
      password: "password456"
    });
    if (dupRes.status === 400 && dupRes.body.message.includes("exists")) {
      console.log("✓ Duplicate registration rejected with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject duplicate email");
    }

    // 4. Login with correct credentials
    console.log("\n[4/17] Testing POST /api/auth/login (Correct credentials)...");
    const loginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "password123"
    });
    if (loginRes.status === 200 && loginRes.body.token) {
      console.log("✓ User A logged in successfully!");
    } else {
      throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
    }

    // 5. Login with incorrect password
    console.log("\n[5/17] Testing POST /api/auth/login (Incorrect password)...");
    const badLoginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "wrongpassword"
    });
    if (badLoginRes.status === 401) {
      console.log("✓ Incorrect password rejected with 401 Unauthorized!");
    } else {
      throw new Error("Failed to reject incorrect password");
    }

    // 6. Forgot Password - Resend email dispatch & verify token NOT in API response
    console.log("\n[6/17] Testing POST /api/auth/forgot-password (Resend Email Dispatch & Privacy)...");
    clearLastSentEmail();
    clearRateLimits();

    const forgotRes = await api("POST", "/api/auth/forgot-password", {
      email: "emma@oxford.edu"
    });

    if (forgotRes.status === 200 && forgotRes.body.success) {
      console.log("✓ Generic success response returned:", forgotRes.body.message);
    } else {
      throw new Error("Forgot password request failed: " + JSON.stringify(forgotRes.body));
    }

    // Verify token is NOT leaked in API response
    if (forgotRes.body.resetToken === undefined) {
      console.log("✓ Security verified: reset token is NOT exposed in API response!");
    } else {
      throw new Error("SECURITY LEAK: resetToken was exposed in API response body!");
    }

    // Verify email was generated and captured
    const sentEmail = getLastSentEmail();
    if (!sentEmail || sentEmail.to !== "emma@oxford.edu") {
      throw new Error("No password reset email was dispatched for emma@oxford.edu");
    }
    if (!sentEmail.resetUrl.includes("token=") || !sentEmail.resetUrl.startsWith("http://localhost:5000/?token=")) {
      throw new Error("Reset URL does not point to frontend with token parameter: " + sentEmail.resetUrl);
    }
    console.log("✓ Resend email payload verified! Target URL:", sentEmail.resetUrl);
    let resetToken = sentEmail.resetToken;

    // 7. Non-existent email returns identical generic message (anti-enumeration check)
    console.log("\n[7/17] Testing Anti-Enumeration with non-existent email...");
    const unknownEmailRes = await api("POST", "/api/auth/forgot-password", {
      email: "ghost@nonexistent.edu"
    });
    if (unknownEmailRes.status === 200 && unknownEmailRes.body.message === forgotRes.body.message) {
      console.log("✓ Non-existent email returned identical response (prevents account enumeration)!");
    } else {
      throw new Error("Anti-enumeration failed");
    }

    // 8. Resend provider failure resilience
    console.log("\n[8/17] Testing Email Provider Failure Resilience...");
    clearRateLimits();
    setTestEmailHook(async () => {
      throw new Error("Simulated Resend API 500 error");
    });
    const providerFailRes = await api("POST", "/api/auth/forgot-password", {
      email: "emma@oxford.edu"
    });
    if (providerFailRes.status === 200 && providerFailRes.body.success) {
      console.log("✓ Provider error handled gracefully without crashing or leaking details!");
    } else {
      throw new Error("Failed to handle email provider error gracefully");
    }
    setTestEmailHook(null); // restore normal hook
    clearRateLimits();

    // 9. Rate limiting on forgot-password requests
    console.log("\n[9/17] Testing Rate Limiting on /api/auth/forgot-password...");
    clearRateLimits();
    let rateLimited = false;
    for (let i = 0; i < 7; i++) {
      const res = await api("POST", "/api/auth/forgot-password", { email: "emma@oxford.edu" });
      if (res.status === 429) {
        rateLimited = true;
        console.log(`✓ Rate limit triggered on attempt ${i + 1} with 429 Too Many Requests!`);
        break;
      }
    }
    if (!rateLimited) {
      throw new Error("Rate limiting did not trigger after multiple attempts");
    }
    clearRateLimits(); // Reset limits for remaining tests

    // 10. Reject invalid / tampered token
    console.log("\n[10/17] Testing invalid/tampered token rejection...");
    const invalidTokenRes = await api("POST", "/api/auth/reset-password", {
      token: "fake_tampered_token_xyz",
      password: "newpassword789",
      confirmPassword: "newpassword789"
    });
    if (invalidTokenRes.status === 400 && invalidTokenRes.body.message.includes("Invalid or expired")) {
      console.log("✓ Tampered token correctly rejected with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject tampered token: " + JSON.stringify(invalidTokenRes.body));
    }

    // 11. Reject expired reset token
    console.log("\n[11/17] Testing expired reset token rejection...");
    // Generate fresh token
    await api("POST", "/api/auth/forgot-password", { email: "emma@oxford.edu" });
    const freshSent = getLastSentEmail();
    const freshToken = freshSent.resetToken;

    // Simulate token expiration in MongoDB
    const emmaUser = await User.findOne({ email: "emma@oxford.edu" });
    emmaUser.resetPasswordExpire = Date.now() - 5000; // Expired 5 seconds ago
    await emmaUser.save();

    const expiredRes = await api("POST", "/api/auth/reset-password", {
      token: freshToken,
      password: "newpassword789",
      confirmPassword: "newpassword789"
    });
    if (expiredRes.status === 400 && expiredRes.body.message.includes("Invalid or expired")) {
      console.log("✓ Expired token correctly rejected with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject expired token: " + JSON.stringify(expiredRes.body));
    }

    // 12. Successful password reset with valid token
    console.log("\n[12/17] Testing Successful Password Reset with valid token...");
    clearRateLimits();
    await api("POST", "/api/auth/forgot-password", { email: "emma@oxford.edu" });
    const validSent = getLastSentEmail();
    const validToken = validSent.resetToken;

    const resetSuccessRes = await api("POST", "/api/auth/reset-password", {
      token: validToken,
      password: "newpassword789",
      confirmPassword: "newpassword789"
    });
    if (resetSuccessRes.status === 200 && resetSuccessRes.body.token) {
      console.log("✓ Password reset successful with valid token! New JWT session returned.");
    } else {
      throw new Error("Password reset failed: " + JSON.stringify(resetSuccessRes.body));
    }

    // 13. Token invalidation / Single-use prevention (token reuse must fail)
    console.log("\n[13/17] Testing single-use token invalidation (token reuse)...");
    const reuseRes = await api("POST", "/api/auth/reset-password", {
      token: validToken,
      password: "anotherpassword123",
      confirmPassword: "anotherpassword123"
    });
    if (reuseRes.status === 400 && reuseRes.body.message.includes("Invalid or expired")) {
      console.log("✓ Token reuse correctly rejected! Token was invalidated after first use.");
    } else {
      throw new Error("Failed to invalidate used reset token");
    }

    // 14. Login with NEW password
    console.log("\n[14/17] Testing Login with NEW password...");
    const newLoginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "newpassword789"
    });
    if (newLoginRes.status === 200 && newLoginRes.body.token) {
      console.log("✓ Logged in with new password successfully!");
    } else {
      throw new Error("Failed to log in with new password");
    }

    // Old password must now fail
    const oldLoginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "password123"
    });
    if (oldLoginRes.status === 401) {
      console.log("✓ Old password correctly rejected after password reset!");
    } else {
      throw new Error("Old password still worked after reset!");
    }

    // 15. Register User B and verify Task Isolation
    console.log("\n[15/17] Testing User B Registration and Task Isolation...");
    const regResB = await api("POST", "/api/auth/register", {
      name: "James Potter",
      email: "james@oxford.edu",
      password: "password321"
    });
    const tokenB = regResB.body.token;

    // User A creates task
    const taskResA = await api("POST", "/api/tasks", {
      id: 1001,
      name: "Emma's Organic Chemistry Lab Report",
      subject: "Chemistry",
      category: "Lab",
      priority: "3",
      dueDate: "2026-10-25"
    }, newLoginRes.body.token);

    if (taskResA.status !== 201) {
      throw new Error("User A task creation failed");
    }

    // User B cannot see or modify User A's task
    const tasksResB = await api("GET", "/api/tasks", null, tokenB);
    if (tasksResB.body.count === 0 && tasksResB.body.data.length === 0) {
      console.log("✓ User B cannot see User A's task!");
    } else {
      throw new Error("Task isolation breached");
    }

    const editResB = await api("PUT", "/api/tasks/1001", { name: "Tampered" }, tokenB);
    const deleteResB = await api("DELETE", "/api/tasks/1001", null, tokenB);
    if (editResB.status === 404 && deleteResB.status === 404) {
      console.log("✓ User B received 404 on all modification attempts (User isolation intact)!");
    } else {
      throw new Error("Task modification isolation breached");
    }

    // 16. Verify GET /api/auth/me
    console.log("\n[16/17] Testing GET /api/auth/me (Profile Verification)...");
    const meUnauth = await api("GET", "/api/auth/me", null, null);
    if (meUnauth.status === 401) {
      console.log("✓ Correctly rejected unauthenticated /api/auth/me with 401 Unauthorized!");
    } else {
      throw new Error("Failed to protect /api/auth/me");
    }

    const meAuthA = await api("GET", "/api/auth/me", null, newLoginRes.body.token);
    if (meAuthA.status === 200 && meAuthA.body.user.email === "emma@oxford.edu") {
      console.log("✓ User A profile retrieved via /api/auth/me successfully!");
    } else {
      throw new Error("Failed to retrieve user profile via /api/auth/me");
    }

    // 17. Verify POST /api/auth/logout
    console.log("\n[17/17] Testing POST /api/auth/logout...");
    const logoutRes = await api("POST", "/api/auth/logout", null, newLoginRes.body.token);
    if (logoutRes.status === 200 && logoutRes.body.success) {
      console.log("✓ User logged out successfully!");
    } else {
      throw new Error("Logout failed: " + JSON.stringify(logoutRes.body));
    }

    console.log("\n==========================================================================================");
    console.log("🎉 ALL 17 AUTHENTICATION, RESEND EMAIL RESET & TASK ISOLATION TESTS PASSED 100%! 🎉");
    console.log("==========================================================================================\n");

  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
}

runAuthTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
