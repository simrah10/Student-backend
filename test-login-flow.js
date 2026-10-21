const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("./models/User");
const Task = require("./models/Task");

const request = (options, postData) => {
  return new Promise((resolve, reject) => {
    const payload = postData !== null && postData !== undefined
      ? (typeof postData === "string" ? postData : JSON.stringify(postData))
      : null;

    if (payload) {
      options.headers = options.headers || {};
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

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
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
};

async function runLoginFlowTests() {
  console.log("=== STARTING STUDENTFLOW LOGIN FLOW & OTP ISOLATION TESTS ===\n");
  let mongoServer;
  let server;
  const PORT = 5015;

  try {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "studentflow_login_flow_secret_2026";

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

    // -------------------------------------------------------------------------
    // TEST D: Signup still requires email OTP verification
    // -------------------------------------------------------------------------
    console.log("[Test D] Testing Signup Requires Email OTP Verification...");
    const regRes = await api("POST", "/api/auth/register", {
      name: "Daniel Jackson",
      email: "daniel@stargate.edu",
      password: "Password123!",
      confirmPassword: "Password123!"
    });

    if (regRes.status !== 201) {
      throw new Error(`Expected 201 on register, got ${regRes.status}: ${JSON.stringify(regRes.body)}`);
    }
    if (!regRes.body.requiresVerification) {
      throw new Error("Expected requiresVerification: true in registration response");
    }
    if (regRes.body.token) {
      throw new Error("Security Violation: JWT issued upon registration before OTP verification!");
    }

    const unverifiedUser = await User.findOne({ email: "daniel@stargate.edu" }).select("+emailVerificationOtp");
    if (!unverifiedUser || unverifiedUser.isEmailVerified !== false) {
      throw new Error("User document should exist with isEmailVerified: false");
    }
    if (!unverifiedUser.emailVerificationOtp) {
      throw new Error("User document missing emailVerificationOtp hash in database");
    }
    console.log("✓ Signup creates unverified account with hashed OTP and returns requiresVerification: true (no JWT)");

    // -------------------------------------------------------------------------
    // TEST C: An unverified user cannot log in
    // -------------------------------------------------------------------------
    console.log("\n[Test C] Testing Unverified User Cannot Log In...");
    const unverifiedLoginRes = await api("POST", "/api/auth/login", {
      email: "daniel@stargate.edu",
      password: "Password123!"
    });

    if (unverifiedLoginRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden for unverified login, got ${unverifiedLoginRes.status}`);
    }
    if (!unverifiedLoginRes.body.requiresVerification) {
      throw new Error("Expected requiresVerification: true in login rejection");
    }
    if (unverifiedLoginRes.body.token) {
      throw new Error("Security Violation: JWT token issued to unverified user on login!");
    }
    if (!unverifiedLoginRes.body.message.includes("Email not verified") && !unverifiedLoginRes.body.message.includes("verify your email")) {
      throw new Error(`Unexpected message on unverified login: ${unverifiedLoginRes.body.message}`);
    }
    // Verify that the old confusing message mentioning code was sent during login is NOT returned
    if (unverifiedLoginRes.body.message.includes("A 6-digit verification code was sent to your email")) {
      throw new Error("Rejection message should not state that a code was sent during login!");
    }
    console.log("✓ Unverified login rejected with 403 Forbidden and clear message without issuing JWT");

    // -------------------------------------------------------------------------
    // Complete OTP verification for Daniel
    // -------------------------------------------------------------------------
    unverifiedUser.isEmailVerified = true;
    unverifiedUser.emailVerificationOtp = null;
    unverifiedUser.emailVerificationExpires = null;
    await unverifiedUser.save();
    console.log("✓ User email verified in database (simulating successful registration OTP verification)");

    // -------------------------------------------------------------------------
    // TEST A: A verified user can log in with email and password without OTP
    // -------------------------------------------------------------------------
    console.log("\n[Test A] Testing Verified User Can Log In with Email and Password Directly (No OTP)...");
    const verifiedLoginRes = await api("POST", "/api/auth/login", {
      email: "daniel@stargate.edu",
      password: "Password123!"
    });

    if (verifiedLoginRes.status !== 200) {
      throw new Error(`Expected 200 OK for verified user login, got ${verifiedLoginRes.status}: ${JSON.stringify(verifiedLoginRes.body)}`);
    }
    if (!verifiedLoginRes.body.token) {
      throw new Error("Expected authentication token in login response for verified user");
    }
    if (verifiedLoginRes.body.requiresOtp || verifiedLoginRes.body.requiresVerification) {
      throw new Error("Login response should not require secondary OTP for verified user!");
    }
    const authToken = verifiedLoginRes.body.token;
    console.log("✓ Verified user logged in successfully with email & password, received JWT without any OTP prompt");

    // -------------------------------------------------------------------------
    // TEST B: Login does not send a new OTP email
    // -------------------------------------------------------------------------
    console.log("\n[Test B] Verifying Login Does Not Generate or Send New OTP...");
    const userAfterLogin = await User.findOne({ email: "daniel@stargate.edu" }).select("+emailVerificationOtp");
    if (userAfterLogin.emailVerificationOtp !== null && userAfterLogin.emailVerificationOtp !== undefined) {
      throw new Error(`User emailVerificationOtp was unexpectedly set during login: ${userAfterLogin.emailVerificationOtp}`);
    }
    console.log("✓ No OTP was generated, stored, or sent during login");

    // -------------------------------------------------------------------------
    // TEST E: An incorrect password is rejected
    // -------------------------------------------------------------------------
    console.log("\n[Test E] Testing Incorrect Password Rejection...");
    const wrongPassRes = await api("POST", "/api/auth/login", {
      email: "daniel@stargate.edu",
      password: "WrongPassword999!"
    });
    if (wrongPassRes.status !== 401) {
      throw new Error(`Expected 401 for wrong password, got ${wrongPassRes.status}`);
    }
    console.log("✓ Incorrect password properly rejected with 401 Unauthorized");

    // -------------------------------------------------------------------------
    // TEST F: Forgot password and password reset still work
    // -------------------------------------------------------------------------
    console.log("\n[Test F] Testing Forgot Password and Password Reset Flow...");
    const forgotRes = await api("POST", "/api/auth/forgot-password", {
      email: "daniel@stargate.edu"
    });
    if (forgotRes.status !== 200 || !forgotRes.body.success) {
      throw new Error(`Forgot password failed: ${JSON.stringify(forgotRes.body)}`);
    }

    // Retrieve hashed reset token from DB
    const userWithReset = await User.findOne({ email: "daniel@stargate.edu" }).select("+resetPasswordToken +resetPasswordExpire");
    if (!userWithReset.resetPasswordToken) {
      throw new Error("Password reset token was not generated in database!");
    }

    // Set a known raw token
    const crypto = require("crypto");
    const testRawToken = "test_reset_token_secret_1234567890abcdef";
    userWithReset.resetPasswordToken = crypto.createHash("sha256").update(testRawToken).digest("hex");
    userWithReset.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
    await userWithReset.save();

    const resetRes = await api("POST", "/api/auth/reset-password", {
      token: testRawToken,
      password: "NewPassword789!",
      confirmPassword: "NewPassword789!"
    });
    if (resetRes.status !== 200 || !resetRes.body.success) {
      throw new Error(`Reset password failed: ${JSON.stringify(resetRes.body)}`);
    }

    // Verify login with new password
    const newLoginRes = await api("POST", "/api/auth/login", {
      email: "daniel@stargate.edu",
      password: "NewPassword789!"
    });
    if (newLoginRes.status !== 200 || !newLoginRes.body.token) {
      throw new Error("Failed to log in with newly reset password");
    }
    console.log("✓ Forgot password & password reset flows verified and working correctly");

    // -------------------------------------------------------------------------
    // TEST G: Protected endpoints still reject unauthorized users
    // -------------------------------------------------------------------------
    console.log("\n[Test G] Testing Protected Endpoints Reject Unauthorized Users...");
    const noTokenRes = await api("GET", "/api/tasks");
    if (noTokenRes.status !== 401) {
      throw new Error(`Expected 401 for missing token on /api/tasks, got ${noTokenRes.status}`);
    }

    const badTokenRes = await api("GET", "/api/tasks", null, "bogus.jwt.token");
    if (badTokenRes.status !== 401) {
      throw new Error(`Expected 401 for invalid token on /api/tasks, got ${badTokenRes.status}`);
    }

    const validTokenRes = await api("GET", "/api/tasks", null, newLoginRes.body.token);
    if (validTokenRes.status !== 200) {
      throw new Error(`Expected 200 for valid token on /api/tasks, got ${validTokenRes.status}`);
    }
    console.log("✓ Protected endpoints correctly reject missing/invalid tokens and accept valid JWT");

    // -------------------------------------------------------------------------
    // TEST H: Account deletion, email reuse, and old-token invalidation
    // -------------------------------------------------------------------------
    console.log("\n[Test H] Testing Account Deletion, Email Reuse, and Old-Token Invalidation...");
    const activeToken = newLoginRes.body.token;

    // Create a task
    await api("POST", "/api/tasks", {
      name: "Daniel SG-1 Mission Report",
      subject: "Archaeology",
      priority: "2",
      dueDate: "2026-11-15"
    }, activeToken);

    // Delete account
    const deleteRes = await api("DELETE", "/api/auth/account", null, activeToken);
    if (deleteRes.status !== 200 || !deleteRes.body.success) {
      throw new Error(`Delete account failed: ${JSON.stringify(deleteRes.body)}`);
    }

    // Old token must be rejected
    const oldTokenCheck = await api("GET", "/api/auth/me", null, activeToken);
    if (oldTokenCheck.status !== 401) {
      throw new Error(`Old token was not invalidated after account deletion! Status: ${oldTokenCheck.status}`);
    }

    // Email reuse: Register anew with the same email
    const reRegRes = await api("POST", "/api/auth/register", {
      name: "Daniel Jackson Reborn",
      email: "daniel@stargate.edu",
      password: "RebornPassword123!",
      confirmPassword: "RebornPassword123!"
    });
    if (reRegRes.status !== 201 || !reRegRes.body.requiresVerification) {
      throw new Error(`Email reuse registration failed: ${JSON.stringify(reRegRes.body)}`);
    }
    console.log("✓ Account deletion invalidated old JWT and freed email for immediate reuse");

    console.log("\n==========================================================================");
    console.log("🎉 ALL TESTS (A through H) FOR LOGIN FLOW & OTP ISOLATION PASSED 100%! 🎉");
    console.log("==========================================================================");

  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
}

runLoginFlowTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
