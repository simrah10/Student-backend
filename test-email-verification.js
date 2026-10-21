const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("./models/User");
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

async function runEmailVerificationTests() {
  console.log("=== STARTING EMAIL OTP VERIFICATION & BACKWARD COMPATIBILITY TEST SUITE ===\n");

  let mongoServer;
  let server;
  const PORT = 5011;

  try {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "studentflow_test_email_verification_secret_2026";
    process.env.OTP_SECRET = "studentflow_test_otp_hmac_secret_2026";
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

    // -------------------------------------------------------------
    // Test 1: Successful registration & OTP email request
    // -------------------------------------------------------------
    console.log("[1/15] Testing user registration with OTP dispatch (Alice)...");
    clearLastSentEmail();

    const regAlice = await api("POST", "/api/auth/register", {
      name: "Alice Smith",
      email: "alice@oxford.edu",
      password: "SecurePassword123!",
      confirmPassword: "SecurePassword123!"
    });

    if (regAlice.status !== 201) {
      throw new Error(`Expected 201 Created for registration, got: ${regAlice.status} - ${JSON.stringify(regAlice.body)}`);
    }
    if (regAlice.body.token) {
      throw new Error("Security Violation: JWT token was issued before email verification!");
    }
    if (!regAlice.body.requiresVerification) {
      throw new Error("Expected requiresVerification: true in response body");
    }

    const emailAlice = getLastSentEmail();
    if (!emailAlice || emailAlice.to !== "alice@oxford.edu") {
      throw new Error(`Expected email dispatched to alice@oxford.edu, got: ${JSON.stringify(emailAlice)}`);
    }
    if (!emailAlice.otp || !/^\d{6}$/.test(emailAlice.otp)) {
      throw new Error(`Expected valid 6-digit OTP in email, got: ${emailAlice ? emailAlice.otp : "null"}`);
    }

    // Inspect MongoDB for Alice
    const aliceInDb = await User.findOne({ email: "alice@oxford.edu" }).select(
      "+emailVerificationOtp +emailVerificationExpires +emailVerificationAttempts"
    );
    if (!aliceInDb) throw new Error("Alice document not found in DB");
    if (aliceInDb.isEmailVerified !== false) {
      throw new Error(`Expected isEmailVerified to be false, got: ${aliceInDb.isEmailVerified}`);
    }
    if (aliceInDb.emailVerificationOtp === emailAlice.otp) {
      throw new Error("Security Violation: OTP is stored in plaintext in the database!");
    }
    if (!aliceInDb.emailVerificationOtp || aliceInDb.emailVerificationOtp.length !== 64) {
      throw new Error("Expected 64-char hex HMAC-SHA256 hashed OTP in database");
    }
    console.log("✓ Registration succeeded without JWT, OTP generated and hashed securely, verification email queued.");

    // -------------------------------------------------------------
    // Test 2: Unverified login rejection
    // -------------------------------------------------------------
    console.log("\n[2/15] Testing login rejection for unverified user...");
    const loginUnverified = await api("POST", "/api/auth/login", {
      email: "alice@oxford.edu",
      password: "SecurePassword123!"
    });

    if (loginUnverified.status !== 403) {
      throw new Error(`Expected 403 Forbidden for unverified login, got: ${loginUnverified.status}`);
    }
    if (!loginUnverified.body.requiresVerification) {
      throw new Error("Expected requiresVerification: true in login rejection");
    }
    if (loginUnverified.body.token) {
      throw new Error("Security Violation: Token issued to unverified user on login!");
    }
    console.log("✓ Unverified login correctly rejected with 403 Forbidden.");

    // -------------------------------------------------------------
    // Test 3: Protected API rejection for unverified user
    // -------------------------------------------------------------
    console.log("\n[3/15] Testing protect middleware rejection for unverified user...");
    // Simulate a crafted or leaked token for Alice
    const craftedToken = jwt.sign(
      { id: aliceInDb._id, email: aliceInDb.email, name: aliceInDb.name },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    const protectedRes = await api("GET", "/api/auth/me", null, craftedToken);
    if (protectedRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden from protect middleware for unverified user, got: ${protectedRes.status}`);
    }
    console.log("✓ Protected endpoint correctly rejected unverified token with 403 Forbidden.");

    // -------------------------------------------------------------
    // Test 4: Incorrect OTP verification
    // -------------------------------------------------------------
    console.log("\n[4/15] Testing verification with incorrect OTP...");
    const badOtpRes = await api("POST", "/api/auth/verify-email", {
      email: "alice@oxford.edu",
      otp: "000000"
    });

    if (badOtpRes.status !== 400) {
      throw new Error(`Expected 400 Bad Request for incorrect OTP, got: ${badOtpRes.status}`);
    }
    if (badOtpRes.body.remainingAttempts !== 4) {
      throw new Error(`Expected 4 remaining attempts, got: ${badOtpRes.body.remainingAttempts}`);
    }
    console.log("✓ Incorrect OTP rejected with remaining attempts counter (4 left).");

    // -------------------------------------------------------------
    // Test 5: Exhaust 5 failed verification attempts
    // -------------------------------------------------------------
    console.log("\n[5/15] Testing 5 failed verification attempts lockout...");
    for (let i = 2; i <= 5; i++) {
      const res = await api("POST", "/api/auth/verify-email", {
        email: "alice@oxford.edu",
        otp: "111111"
      });
      if (res.status !== 400) {
        throw new Error(`Expected 400 on attempt ${i}, got: ${res.status}`);
      }
      if (i === 5) {
        if (!res.body.message.includes("Maximum verification attempts exceeded")) {
          throw new Error(`Expected maximum attempts exceeded message, got: ${res.body.message}`);
        }
      }
    }

    // Verify OTP was invalidated in DB
    const aliceLocked = await User.findOne({ email: "alice@oxford.edu" }).select("+emailVerificationOtp");
    if (aliceLocked.emailVerificationOtp !== null) {
      throw new Error("Expected OTP to be invalidated (null) after 5 failed attempts");
    }

    // Trying with the original correct OTP should now fail
    const tryCorrectAfterLockout = await api("POST", "/api/auth/verify-email", {
      email: "alice@oxford.edu",
      otp: emailAlice.otp
    });
    if (tryCorrectAfterLockout.status !== 400) {
      throw new Error("Lockout failed: original OTP was still accepted after 5 failures!");
    }
    console.log("✓ 5 failed attempts properly locked out and invalidated OTP.");

    // -------------------------------------------------------------
    // Test 6: OTP Resend Cooldown (60 seconds)
    // -------------------------------------------------------------
    console.log("\n[6/15] Testing 60-second cooldown on resend verification...");
    const cooldownRes = await api("POST", "/api/auth/resend-verification", {
      email: "alice@oxford.edu"
    });
    if (cooldownRes.status !== 429) {
      throw new Error(`Expected 429 Too Many Requests within 60s cooldown, got: ${cooldownRes.status}`);
    }
    if (!cooldownRes.body.retryAfter) {
      throw new Error("Expected retryAfter value in 429 response");
    }
    console.log("✓ Resend cooldown strictly enforced with 429 Too Many Requests.");

    // Advance cooldown in database
    await User.updateOne(
      { email: "alice@oxford.edu" },
      { $set: { emailVerificationLastSent: new Date(Date.now() - 65 * 1000) } }
    );

    clearLastSentEmail();
    const resendSuccess = await api("POST", "/api/auth/resend-verification", {
      email: "alice@oxford.edu"
    });
    if (resendSuccess.status !== 200 || !resendSuccess.body.success) {
      throw new Error(`Expected 200 OK after cooldown, got: ${resendSuccess.status} - ${JSON.stringify(resendSuccess.body)}`);
    }

    const emailAliceNew = getLastSentEmail();
    if (!emailAliceNew || !emailAliceNew.otp) {
      throw new Error("Expected new verification email to be sent");
    }
    console.log("✓ Resend succeeded after cooldown expired, new OTP generated.");

    // -------------------------------------------------------------
    // Test 7: Previous OTP invalidation after resend
    // -------------------------------------------------------------
    console.log("\n[7/15] Testing invalidation of previous OTP after resend...");
    const tryOldOtp = await api("POST", "/api/auth/verify-email", {
      email: "alice@oxford.edu",
      otp: emailAlice.otp
    });
    if (tryOldOtp.status !== 400) {
      throw new Error("Old OTP was accepted after a new OTP was generated!");
    }
    console.log("✓ Previous OTP successfully invalidated after resend.");

    // -------------------------------------------------------------
    // Test 8: Expired OTP
    // -------------------------------------------------------------
    console.log("\n[8/15] Testing expired OTP rejection...");
    clearLastSentEmail();
    const regBob = await api("POST", "/api/auth/register", {
      name: "Bob Jones",
      email: "bob@cambridge.edu",
      password: "StrongPass123$",
      confirmPassword: "StrongPass123$"
    });
    if (regBob.status !== 201) throw new Error("Failed to register Bob");
    const bobEmail = getLastSentEmail();

    // Expire Bob's OTP by setting expiration to the past
    await User.updateOne(
      { email: "bob@cambridge.edu" },
      { $set: { emailVerificationExpires: new Date(Date.now() - 1000) } }
    );

    const expiredRes = await api("POST", "/api/auth/verify-email", {
      email: "bob@cambridge.edu",
      otp: bobEmail.otp
    });
    if (expiredRes.status !== 400 || !expiredRes.body.message.includes("expired")) {
      throw new Error(`Expected 400 with expiry message, got: ${expiredRes.status} - ${JSON.stringify(expiredRes.body)}`);
    }
    console.log("✓ Expired OTP correctly rejected.");

    // -------------------------------------------------------------
    // Test 9: Correct OTP verification
    // -------------------------------------------------------------
    console.log("\n[9/15] Testing successful OTP verification (Alice)...");
    const verifyAlice = await api("POST", "/api/auth/verify-email", {
      email: "alice@oxford.edu",
      otp: emailAliceNew.otp
    });

    if (verifyAlice.status !== 200) {
      throw new Error(`Expected 200 OK on correct OTP verification, got: ${verifyAlice.status} - ${JSON.stringify(verifyAlice.body)}`);
    }
    if (!verifyAlice.body.token) {
      throw new Error("Expected JWT token in successful verification response");
    }
    if (verifyAlice.body.user.isEmailVerified !== true) {
      throw new Error("Expected user.isEmailVerified: true");
    }

    const aliceVerifiedDb = await User.findOne({ email: "alice@oxford.edu" }).select(
      "+emailVerificationOtp +emailVerificationExpires +emailVerificationAttempts"
    );
    if (aliceVerifiedDb.isEmailVerified !== true) {
      throw new Error("Database isEmailVerified is not true");
    }
    if (aliceVerifiedDb.emailVerificationOtp !== null || aliceVerifiedDb.emailVerificationExpires !== null) {
      throw new Error("OTP fields were not cleared after successful verification");
    }
    console.log("✓ OTP verified successfully, JWT issued, database OTP fields purged.");

    // -------------------------------------------------------------
    // Test 10: Successful login after verification
    // -------------------------------------------------------------
    console.log("\n[10/15] Testing normal login after email verification...");
    const loginVerified = await api("POST", "/api/auth/login", {
      email: "alice@oxford.edu",
      password: "SecurePassword123!"
    });

    if (loginVerified.status !== 200 || !loginVerified.body.token) {
      throw new Error(`Expected 200 OK and token for verified user login, got: ${loginVerified.status}`);
    }
    console.log("✓ Verified user logged in successfully with valid JWT.");

    // -------------------------------------------------------------
    // Test 11: Protected API access for verified user
    // -------------------------------------------------------------
    console.log("\n[11/15] Testing protected endpoint access with verified JWT...");
    const meRes = await api("GET", "/api/auth/me", null, loginVerified.body.token);
    if (meRes.status !== 200 || !meRes.body.user) {
      throw new Error(`Expected 200 from /api/auth/me, got: ${meRes.status}`);
    }
    if (meRes.body.user.isEmailVerified !== true) {
      throw new Error("Expected isEmailVerified: true in user profile");
    }
    console.log("✓ Protected endpoint accessible with verified JWT session.");

    // -------------------------------------------------------------
    // Test 12: Duplicate registration handling
    // -------------------------------------------------------------
    console.log("\n[12/15] Testing duplicate registration handling...");
    // 12a: Verified user duplicate registration
    const dupVerified = await api("POST", "/api/auth/register", {
      name: "Alice Imposter",
      email: "alice@oxford.edu",
      password: "NewPassword123!",
      confirmPassword: "NewPassword123!"
    });
    if (dupVerified.status !== 400 || !dupVerified.body.message.includes("already exists")) {
      throw new Error(`Expected 400 "already exists" for duplicate verified user, got: ${dupVerified.status}`);
    }
    console.log("✓ Duplicate registration for verified user correctly rejected with 400.");

    // 12b: Pending unverified user re-registering
    // Bob is currently unverified. Cooldown test:
    const bobReregisterCooldown = await api("POST", "/api/auth/register", {
      name: "Bob Jones Updated",
      email: "bob@cambridge.edu",
      password: "NewBobPassword123#",
      confirmPassword: "NewBobPassword123#"
    });
    if (bobReregisterCooldown.status !== 429) {
      throw new Error(`Expected 429 for rapid re-registration of unverified account, got: ${bobReregisterCooldown.status}`);
    }

    // Bypass cooldown for testing
    await User.updateOne(
      { email: "bob@cambridge.edu" },
      { $set: { emailVerificationLastSent: new Date(Date.now() - 65 * 1000) } }
    );

    clearLastSentEmail();
    const bobReregister = await api("POST", "/api/auth/register", {
      name: "Bob Jones Updated",
      email: "bob@cambridge.edu",
      password: "NewBobPassword123#",
      confirmPassword: "NewBobPassword123#"
    });
    if (bobReregister.status !== 200 || !bobReregister.body.requiresVerification) {
      throw new Error(`Expected 200 with requiresVerification for pending user re-register, got: ${bobReregister.status}`);
    }

    // Ensure no duplicate users were created in MongoDB
    const bobCount = await User.countDocuments({ email: "bob@cambridge.edu" });
    if (bobCount !== 1) {
      throw new Error(`Expected exactly 1 document for Bob, found: ${bobCount}`);
    }

    // Verify Bob can verify with new OTP and log in with new password
    const bobNewEmail = getLastSentEmail();
    const bobVerifyRes = await api("POST", "/api/auth/verify-email", {
      email: "bob@cambridge.edu",
      otp: bobNewEmail.otp
    });
    if (bobVerifyRes.status !== 200) throw new Error("Bob failed to verify with new OTP");

    const bobLoginNewPass = await api("POST", "/api/auth/login", {
      email: "bob@cambridge.edu",
      password: "NewBobPassword123#"
    });
    if (bobLoginNewPass.status !== 200) throw new Error("Bob failed to login with new password");
    console.log("✓ Pending unverified accounts handled safely without creating duplicate users.");

    // -------------------------------------------------------------
    // Test 13: Backward compatibility for existing legacy accounts
    // -------------------------------------------------------------
    console.log("\n[13/15] Testing backward compatibility for legacy accounts...");
    // Create a legacy user directly in MongoDB without isEmailVerified set
    const salt = await bcrypt.genSalt(10);
    const legacyPasswordHash = await bcrypt.hash("LegacyPassword123!", salt);
    const legacyUser = await User.collection.insertOne({
      name: "Legacy User",
      email: "legacy@studentflow.dev",
      password: legacyPasswordHash,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Check DB document has no isEmailVerified field
    const rawLegacy = await User.collection.findOne({ _id: legacyUser.insertedId });
    if (rawLegacy.isEmailVerified !== undefined) {
      throw new Error("Test setup error: legacy user already has isEmailVerified field");
    }

    // Test legacy user login
    const legacyLogin = await api("POST", "/api/auth/login", {
      email: "legacy@studentflow.dev",
      password: "LegacyPassword123!"
    });
    if (legacyLogin.status !== 200 || !legacyLogin.body.token) {
      throw new Error(`Legacy user login failed: ${legacyLogin.status} - ${JSON.stringify(legacyLogin.body)}`);
    }

    // Test protected API access for legacy user
    const legacyProfile = await api("GET", "/api/auth/me", null, legacyLogin.body.token);
    if (legacyProfile.status !== 200) {
      throw new Error(`Legacy user protected access failed: ${legacyProfile.status}`);
    }
    console.log("✓ Existing legacy accounts without verification field can log in and access APIs without disruption.");

    // -------------------------------------------------------------
    // Test 14: Resend email failures handled gracefully
    // -------------------------------------------------------------
    console.log("\n[14/15] Testing email service failure handling...");
    setTestEmailHook(async () => {
      throw new Error("Simulated Resend API connection error");
    });

    const regFailEmail = await api("POST", "/api/auth/register", {
      name: "David Error",
      email: "david@error.com",
      password: "ErrorPassword123!",
      confirmPassword: "ErrorPassword123!"
    });

    // Registration should succeed gracefully without crashing
    if (regFailEmail.status !== 201 || !regFailEmail.body.requiresVerification) {
      throw new Error(`Expected registration to succeed gracefully despite email failure, got: ${regFailEmail.status}`);
    }
    setTestEmailHook(null);
    console.log("✓ Email service errors handled securely and gracefully without crashing registration.");

    // -------------------------------------------------------------
    // Test 15: Password reset remains operational
    // -------------------------------------------------------------
    console.log("\n[15/15] Testing password reset flow functionality...");
    clearLastSentEmail();
    clearRateLimits();

    const forgotRes = await api("POST", "/api/auth/forgot-password", {
      email: "alice@oxford.edu"
    });
    if (forgotRes.status !== 200 || !forgotRes.body.success) {
      throw new Error("Forgot password request failed");
    }

    const resetEmail = getLastSentEmail();
    if (!resetEmail || !resetEmail.resetToken) {
      throw new Error("Password reset email was not dispatched");
    }

    const resetRes = await api("POST", "/api/auth/reset-password", {
      token: resetEmail.resetToken,
      password: "NewAlicePassword123!",
      confirmPassword: "NewAlicePassword123!"
    });
    if (resetRes.status !== 200 || !resetRes.body.token) {
      throw new Error(`Reset password failed: ${resetRes.status}`);
    }

    // Verify login with new password
    const loginNewPass = await api("POST", "/api/auth/login", {
      email: "alice@oxford.edu",
      password: "NewAlicePassword123!"
    });
    if (loginNewPass.status !== 200 || !loginNewPass.body.token) {
      throw new Error("Login with reset password failed");
    }
    console.log("✓ Password reset flow remains fully functional.");

    console.log("\n=======================================================");
    console.log("🎉 ALL 15 EMAIL OTP VERIFICATION TESTS PASSED SUCCESSFULLY!");
    console.log("=======================================================");
  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
}

runEmailVerificationTests().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});
