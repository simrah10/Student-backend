const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("./models/User");

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

async function runPasswordSecurityTests() {
  console.log("=== STARTING PASSWORD SECURITY & POLICY VERIFICATION TESTS ===\n");

  let mongoServer;
  let server;
  const PORT = 5007;

  try {
    // 1. Setup in-memory MongoDB
    console.log("[1/10] Starting in-memory MongoDB...");
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test_password_security_secret_2026";
    await mongoose.connect(uri);
    console.log("✓ In-memory MongoDB connected");

    const app = require("./server");
    server = app.listen(PORT);
    console.log(`✓ Test server running on port ${PORT}`);

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

    // 2. Test Registration Password Policy Failures
    console.log("\n[2/10] Testing registration rejection for weak passwords...");

    const weakTests = [
      {
        desc: "Password shorter than 8 chars",
        pass: "Short1!",
        expected: "Password must be at least 8 characters long"
      },
      {
        desc: "Password missing uppercase letter",
        pass: "lowercase123!",
        expected: "Password must contain at least one uppercase letter"
      },
      {
        desc: "Password missing lowercase letter",
        pass: "UPPERCASE123!",
        expected: "Password must contain at least one lowercase letter"
      },
      {
        desc: "Password missing number",
        pass: "NoDigitsHere!",
        expected: "Password must contain at least one number"
      },
      {
        desc: "Password missing special character",
        pass: "NoSpecialChar123",
        expected: "Password must contain at least one special character"
      }
    ];

    for (const test of weakTests) {
      const res = await api("POST", "/api/auth/register", {
        name: "Test User",
        email: `test_${Date.now()}@example.com`,
        password: test.pass,
        confirmPassword: test.pass
      });

      if (res.status === 400 && res.body.message === test.expected) {
        console.log(`✓ Correctly rejected: ${test.desc} -> "${res.body.message}"`);
      } else {
        throw new Error(`Failed policy test for ${test.desc}. Got: ${JSON.stringify(res.body)}`);
      }
    }

    // 3. Register user with valid strong password
    console.log("\n[3/10] Testing registration with valid strong password...");
    const strongPassword = "SecurePassword123#";
    const regRes = await api("POST", "/api/auth/register", {
      name: "Hannah Abbot",
      email: "hannah@hogwarts.edu",
      password: strongPassword,
      confirmPassword: strongPassword
    });

    if (regRes.status !== 201 || !regRes.body.token) {
      throw new Error(`Registration failed with valid password: ${JSON.stringify(regRes.body)}`);
    }
    const token = regRes.body.token;
    console.log("✓ Registration succeeded with valid strong password!");

    // 4. Verify MongoDB Password Storage & Field Protection
    console.log("\n[4/10] Inspecting raw MongoDB document for password hashing & privacy...");
    // Default findOne (select: false)
    const userDefault = await User.findOne({ email: "hannah@hogwarts.edu" });
    if (userDefault.password !== undefined) {
      throw new Error("Password field was leaked in default query! select: false failed.");
    }
    console.log("✓ User password is omitted from default queries (select: false intact).");

    // Explicit select("+password")
    const userWithPass = await User.findOne({ email: "hannah@hogwarts.edu" }).select("+password");
    if (!userWithPass.password) {
      throw new Error("Could not retrieve password hash with explicit select");
    }
    if (userWithPass.password === strongPassword) {
      throw new Error("CRITICAL SECURITY VIOLATION: Password stored in plain text in MongoDB!");
    }
    // Verify bcrypt hash structure: $2a$10$ or $2b$10$
    if (!/^\$2[ab]\$10\$/.test(userWithPass.password)) {
      throw new Error(`Password not hashed with bcrypt 10 salt rounds: ${userWithPass.password}`);
    }
    console.log("✓ Password verified securely hashed in MongoDB with bcrypt 10 rounds:", userWithPass.password.substring(0, 20) + "...");

    // Verify API responses never return password or hash
    if (regRes.body.password || regRes.body.user?.password) {
      throw new Error("Password leaked in registration API response!");
    }
    console.log("✓ Password and password hash are completely omitted from API response.");

    // 5. Test Login Verification
    console.log("\n[5/10] Testing login with valid & invalid passwords...");
    const loginOk = await api("POST", "/api/auth/login", {
      email: "hannah@hogwarts.edu",
      password: strongPassword
    });
    if (loginOk.status !== 200 || !loginOk.body.token) {
      throw new Error("Login failed with valid password");
    }
    console.log("✓ Login with valid strong password succeeded!");

    const loginFail = await api("POST", "/api/auth/login", {
      email: "hannah@hogwarts.edu",
      password: "WrongPassword999!"
    });
    if (loginFail.status === 401) {
      console.log("✓ Login with wrong password correctly rejected with 401 Unauthorized.");
    } else {
      throw new Error("Wrong password was not rejected: " + JSON.stringify(loginFail));
    }

    // 6. Test Legacy User Compatibility (Users created before policy change)
    console.log("\n[6/10] Testing legacy user compatibility (older password without new policy)...");
    const legacyPlain = "oldpass6";
    const legacySalt = await bcrypt.genSalt(10);
    const legacyHashed = await bcrypt.hash(legacyPlain, legacySalt);

    await User.create({
      name: "Legacy Student",
      email: "legacy@hogwarts.edu",
      password: legacyHashed
    });

    const legacyLogin = await api("POST", "/api/auth/login", {
      email: "legacy@hogwarts.edu",
      password: legacyPlain
    });
    if (legacyLogin.status === 200 && legacyLogin.body.token) {
      console.log("✓ Legacy user successfully logged in without being forced into a reset!");
    } else {
      throw new Error("Legacy user login failed: " + JSON.stringify(legacyLogin.body));
    }

    // 7. Test Password Reset Policy Enforcement
    console.log("\n[7/10] Testing password reset enforces strong password policy...");
    // Create a reset token for Hannah
    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const hashedResetToken = crypto.createHash("sha256").update(rawResetToken).digest("hex");
    userWithPass.resetPasswordToken = hashedResetToken;
    userWithPass.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
    await userWithPass.save();

    // Try resetting with weak password
    const resetWeak = await api("POST", "/api/auth/reset-password", {
      token: rawResetToken,
      password: "weak",
      confirmPassword: "weak"
    });
    if (resetWeak.status === 400 && resetWeak.body.message.includes("at least 8 characters")) {
      console.log("✓ Reset password correctly rejected weak password (<8 chars)!");
    } else {
      throw new Error("Reset password failed to reject weak password: " + JSON.stringify(resetWeak.body));
    }

    // Reset with strong password
    const resetStrongPass = "ResetPassword999$";
    const resetSuccess = await api("POST", "/api/auth/reset-password", {
      token: rawResetToken,
      password: resetStrongPass,
      confirmPassword: resetStrongPass
    });
    if (resetSuccess.status !== 200 || !resetSuccess.body.token) {
      throw new Error("Password reset failed with strong password: " + JSON.stringify(resetSuccess.body));
    }
    console.log("✓ Password reset succeeded with strong password!");

    // Verify login with newly reset password
    const resetLogin = await api("POST", "/api/auth/login", {
      email: "hannah@hogwarts.edu",
      password: resetStrongPass
    });
    if (resetLogin.status === 200) {
      console.log("✓ Logged in with reset password successfully!");
    } else {
      throw new Error("Login failed with reset password");
    }

    // 8. Test Authenticated Password Change Endpoint (PUT /api/auth/change-password)
    console.log("\n[8/10] Testing Authenticated Password Change Endpoint (Security & Validation)...");
    const activeToken = resetLogin.body.token;

    // Unauthenticated access
    const unauthChange = await api("PUT", "/api/auth/change-password", {
      currentPassword: resetStrongPass,
      newPassword: "BrandNewPass123!"
    }, null);
    if (unauthChange.status === 401) {
      console.log("✓ Unauthenticated password change correctly rejected with 401 Unauthorized.");
    } else {
      throw new Error("Unauthenticated password change was not blocked");
    }

    // Incorrect current password
    const wrongCurrentPass = await api("PUT", "/api/auth/change-password", {
      currentPassword: "IncorrectCurrentPassword1!",
      newPassword: "BrandNewPass123!"
    }, activeToken);
    if (wrongCurrentPass.status === 400 && wrongCurrentPass.body.message.includes("Current password is incorrect")) {
      console.log("✓ Wrong current password rejected with 400 Bad Request.");
    } else {
      throw new Error("Wrong current password was not rejected: " + JSON.stringify(wrongCurrentPass.body));
    }

    // Weak new password
    const weakNewPass = await api("PUT", "/api/auth/change-password", {
      currentPassword: resetStrongPass,
      newPassword: "nouppercase123!"
    }, activeToken);
    if (weakNewPass.status === 400 && weakNewPass.body.message.includes("uppercase")) {
      console.log("✓ Weak new password rejected during change-password with requirement message.");
    } else {
      throw new Error("Weak new password was not rejected: " + JSON.stringify(weakNewPass.body));
    }

    // Mismatched confirmPassword
    const mismatchChange = await api("PUT", "/api/auth/change-password", {
      currentPassword: resetStrongPass,
      newPassword: "BrandNewPass123!",
      confirmPassword: "DifferentPass123!"
    }, activeToken);
    if (mismatchChange.status === 400 && mismatchChange.body.message.includes("match")) {
      console.log("✓ Mismatched confirmPassword rejected during password change.");
    } else {
      throw new Error("Mismatched confirmPassword was not rejected");
    }

    // Same password as current password
    const samePassChange = await api("PUT", "/api/auth/change-password", {
      currentPassword: resetStrongPass,
      newPassword: resetStrongPass
    }, activeToken);
    if (samePassChange.status === 400 && samePassChange.body.message.includes("different")) {
      console.log("✓ Reusing identical current password rejected.");
    } else {
      throw new Error("Identical password reuse was not rejected");
    }

    // 9. Execute Valid Password Change
    console.log("\n[9/10] Executing valid password change...");
    const changedStrongPass = "BrandNewPass123!";
    const validChange = await api("PUT", "/api/auth/change-password", {
      currentPassword: resetStrongPass,
      newPassword: changedStrongPass,
      confirmPassword: changedStrongPass
    }, activeToken);
    if (validChange.status === 200 && validChange.body.success) {
      console.log("✓ Password changed successfully via PUT /api/auth/change-password!");
    } else {
      throw new Error("Valid password change failed: " + JSON.stringify(validChange.body));
    }

    // Check raw MongoDB to verify new hash with 10 rounds
    const userAfterChange = await User.findOne({ email: "hannah@hogwarts.edu" }).select("+password");
    if (!/^\$2[ab]\$10\$/.test(userAfterChange.password)) {
      throw new Error("Updated password hash is invalid: " + userAfterChange.password);
    }
    console.log("✓ Updated password verified hashed with bcrypt 10 rounds in MongoDB.");

    // 10. Verify Login with New Changed Password & Invalidation of Old Password
    console.log("\n[10/10] Verifying login with changed password and rejection of old password...");
    const loginChanged = await api("POST", "/api/auth/login", {
      email: "hannah@hogwarts.edu",
      password: changedStrongPass
    });
    if (loginChanged.status === 200 && loginChanged.body.token) {
      console.log("✓ Login with newly changed password succeeded!");
    } else {
      throw new Error("Login failed with newly changed password");
    }

    const loginOldFails = await api("POST", "/api/auth/login", {
      email: "hannah@hogwarts.edu",
      password: resetStrongPass
    });
    if (loginOldFails.status === 401) {
      console.log("✓ Previous password correctly rejected with 401 Unauthorized!");
    } else {
      throw new Error("Old password still worked after change!");
    }

    console.log("\n===============================================================");
    console.log("🎉 ALL 10 PASSWORD SECURITY & POLICY TESTS PASSED 100%! 🎉");
    console.log("===============================================================\n");

  } catch (error) {
    console.error("\n❌ PASSWORD SECURITY TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
    process.exit();
  }
}

runPasswordSecurityTests();
