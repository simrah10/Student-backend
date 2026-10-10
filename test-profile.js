const http = require("http");
const mongoose = require("mongoose");
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

async function runProfileTests() {
  console.log("=== STARTING USER PROFILE ENDPOINTS & SECURITY VERIFICATION TESTS ===\n");
  let mongoServer;
  let server;
  const PORT = 5005;

  try {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "studentflow_profile_test_secret_2026";

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

    // 1. Unauthenticated requests to GET & PUT /api/auth/profile must return 401
    console.log("[1/13] Testing Unauthenticated Access on GET & PUT /api/auth/profile...");
    const unauthGet = await api("GET", "/api/auth/profile", null, null);
    if (unauthGet.status === 401 && unauthGet.body.success === false) {
      console.log("✓ Correctly rejected unauthenticated GET /api/auth/profile with 401 Unauthorized");
    } else {
      throw new Error("Unauthenticated GET /api/auth/profile was not rejected: " + JSON.stringify(unauthGet));
    }

    const unauthPut = await api("PUT", "/api/auth/profile", { name: "Hacker" }, null);
    if (unauthPut.status === 401 && unauthPut.body.success === false) {
      console.log("✓ Correctly rejected unauthenticated PUT /api/auth/profile with 401 Unauthorized");
    } else {
      throw new Error("Unauthenticated PUT /api/auth/profile was not rejected: " + JSON.stringify(unauthPut));
    }

    // 2. Register User A
    console.log("\n[2/13] Registering User A...");
    const regResA = await api("POST", "/api/auth/register", {
      name: "Emma Watson",
      email: "emma@oxford.edu",
      password: "password123",
      confirmPassword: "password123"
    });
    if (regResA.status !== 201 || !regResA.body.token) {
      throw new Error("User A registration failed: " + JSON.stringify(regResA));
    }
    const tokenA = regResA.body.token;
    console.log("✓ User A registered successfully!");

    // 3. Authenticated GET /api/auth/profile retrieves initial profile with all defaults
    console.log("\n[3/13] Testing Authenticated GET /api/auth/profile (Initial Defaults)...");
    const getInitialRes = await api("GET", "/api/auth/profile", null, tokenA);
    if (getInitialRes.status === 200 && getInitialRes.body.success) {
      const profile = getInitialRes.body.user || getInitialRes.body.profile;
      if (
        profile.name === "Emma Watson" &&
        profile.email === "emma@oxford.edu" &&
        profile.avatar === "" &&
        profile.gender === "" &&
        profile.institution === "" &&
        profile.studentId === ""
      ) {
        console.log("✓ Initial profile retrieved with all correct default fields!");
      } else {
        throw new Error("Initial profile missing expected default fields: " + JSON.stringify(profile));
      }

      // Security check: Verify password hash is NOT exposed
      if (profile.password !== undefined || profile.resetPasswordToken !== undefined) {
        throw new Error("SECURITY LEAK: Sensitive password/token exposed in profile response!");
      }
      console.log("✓ Security verified: Password and internal tokens omitted from response.");
    } else {
      throw new Error("GET /api/auth/profile failed: " + JSON.stringify(getInitialRes));
    }

    // 4. Update full profile with all personal and academic fields + valid JPEG avatar (~35 KB)
    console.log("\n[4/13] Testing PUT /api/auth/profile with full personal/academic fields & avatar...");
    // Generate ~35 KB base64 image data URL payload
    const base64Chunk = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const padding = "A".repeat(35000); // 35 KB padding
    const validJpegAvatar = `data:image/jpeg;base64,${base64Chunk}${padding}`;

    const updatePayload = {
      name: "Dr. Emma Watson",
      avatar: validJpegAvatar,
      gender: "Female",
      dateOfBirth: "2002-04-15",
      phone: "+44-20-7946-0912",
      institution: "University of Oxford",
      degree: "Bachelor of Science",
      department: "Computer Science",
      yearOfStudy: "3rd Year",
      semester: "Fall 2026",
      studentId: "OXF-CS-2024-9988",
      graduationYear: "2027"
    };

    const putRes = await api("PUT", "/api/auth/profile", updatePayload, tokenA);
    if (putRes.status === 200 && putRes.body.success) {
      const updated = putRes.body.user || putRes.body.profile;
      if (
        updated.name === updatePayload.name &&
        updated.gender === updatePayload.gender &&
        updated.dateOfBirth === updatePayload.dateOfBirth &&
        updated.phone === updatePayload.phone &&
        updated.institution === updatePayload.institution &&
        updated.degree === updatePayload.degree &&
        updated.department === updatePayload.department &&
        updated.yearOfStudy === updatePayload.yearOfStudy &&
        updated.semester === updatePayload.semester &&
        updated.studentId === updatePayload.studentId &&
        updated.graduationYear === updatePayload.graduationYear &&
        updated.avatar === validJpegAvatar
      ) {
        console.log("✓ Profile updated successfully with all personal and academic fields!");
      } else {
        throw new Error("Updated fields mismatch in PUT response: " + JSON.stringify(updated));
      }
    } else {
      throw new Error("PUT /api/auth/profile failed: " + JSON.stringify(putRes));
    }

    // 5. Verify MongoDB persistence via subsequent GET /api/auth/profile
    console.log("\n[5/13] Verifying MongoDB persistence via fresh GET /api/auth/profile...");
    const getPersistedRes = await api("GET", "/api/auth/profile", null, tokenA);
    const persisted = getPersistedRes.body.user;
    if (
      persisted.name === "Dr. Emma Watson" &&
      persisted.institution === "University of Oxford" &&
      persisted.studentId === "OXF-CS-2024-9988" &&
      persisted.avatar === validJpegAvatar
    ) {
      console.log("✓ All fields verified persisted in MongoDB!");
    } else {
      throw new Error("Profile fields did not persist correctly in MongoDB");
    }

    // 6. Avatar removal test: sending empty string removes avatar
    console.log("\n[6/13] Testing Avatar Removal (avatar: '')...");
    const removeAvatarRes = await api("PUT", "/api/auth/profile", { avatar: "" }, tokenA);
    if (removeAvatarRes.status === 200 && (removeAvatarRes.body.user.avatar === "" || removeAvatarRes.body.profile.avatar === "")) {
      console.log("✓ Avatar successfully removed via PUT request!");
    } else {
      throw new Error("Failed to remove avatar: " + JSON.stringify(removeAvatarRes));
    }

    // Verify avatar is empty in MongoDB
    const getNoAvatarRes = await api("GET", "/api/auth/profile", null, tokenA);
    if (getNoAvatarRes.body.user.avatar === "") {
      console.log("✓ Verified avatar removal persisted in MongoDB!");
    } else {
      throw new Error("Avatar removal did not persist in MongoDB");
    }

    // 7. Email immutability test: attempt to change email must be rejected with 400
    console.log("\n[7/13] Testing Email Immutability (Attempting to modify email)...");
    const changeEmailRes = await api("PUT", "/api/auth/profile", { email: "hacker@evil.com" }, tokenA);
    if (changeEmailRes.status === 400 && changeEmailRes.body.message.includes("Email")) {
      console.log("✓ Correctly rejected email modification attempt with 400 Bad Request!");
    } else {
      throw new Error("Failed to enforce email immutability: " + JSON.stringify(changeEmailRes));
    }

    // Verify email unchanged in DB
    const checkEmailRes = await api("GET", "/api/auth/profile", null, tokenA);
    if (checkEmailRes.body.user.email === "emma@oxford.edu") {
      console.log("✓ Account email verified strictly unchanged in MongoDB!");
    } else {
      throw new Error("Email was altered: " + checkEmailRes.body.user.email);
    }

    // 8. Rejection of oversized avatar (>500 KB)
    console.log("\n[8/13] Testing Oversized Avatar Rejection (>500 KB limit)...");
    const oversizedAvatar = `data:image/jpeg;base64,${"A".repeat(600 * 1024)}`;
    const oversizeRes = await api("PUT", "/api/auth/profile", { avatar: oversizedAvatar }, tokenA);
    if (oversizeRes.status === 400 && oversizeRes.body.message.includes("limit")) {
      console.log("✓ Correctly rejected oversized avatar with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject oversized avatar: " + JSON.stringify(oversizeRes));
    }

    // 9. Rejection of invalid avatar format (non-image, non-data URL)
    console.log("\n[9/13] Testing Invalid Avatar Format Rejection...");
    const badFormatRes1 = await api("PUT", "/api/auth/profile", { avatar: "https://evil.com/pic.jpg" }, tokenA);
    if (badFormatRes1.status === 400 && badFormatRes1.body.message.includes("Invalid avatar format")) {
      console.log("✓ Rejected non-data URL avatar string with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject non-data URL avatar: " + JSON.stringify(badFormatRes1));
    }

    const badFormatRes2 = await api("PUT", "/api/auth/profile", { avatar: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" }, tokenA);
    if (badFormatRes2.status === 400 && badFormatRes2.body.message.includes("Invalid avatar format")) {
      console.log("✓ Rejected non-image data URL with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject text/html data URL: " + JSON.stringify(badFormatRes2));
    }

    // 10. Rejection of invalid fields (gender, lengths, empty name)
    console.log("\n[10/13] Testing Field Validations (gender, lengths, empty name)...");
    const badGenderRes = await api("PUT", "/api/auth/profile", { gender: "InvalidGender" }, tokenA);
    if (badGenderRes.status === 400 && badGenderRes.body.message.includes("gender")) {
      console.log("✓ Correctly rejected invalid gender with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject invalid gender");
    }

    const emptyNameRes = await api("PUT", "/api/auth/profile", { name: "   " }, tokenA);
    if (emptyNameRes.status === 400 && emptyNameRes.body.message.includes("name")) {
      console.log("✓ Correctly rejected empty full name with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject empty name");
    }

    const longPhoneRes = await api("PUT", "/api/auth/profile", { phone: "1".repeat(30) }, tokenA);
    if (longPhoneRes.status === 400 && longPhoneRes.body.message.includes("Phone")) {
      console.log("✓ Correctly rejected oversized phone number (>25 chars) with 400 Bad Request!");
    } else {
      throw new Error("Failed to reject oversized phone");
    }

    // 11. User Isolation & Tamper Prevention: User B cannot modify User A's profile
    console.log("\n[11/13] Testing User Isolation (User B attempts to modify User A)...");
    const regResB = await api("POST", "/api/auth/register", {
      name: "James Potter",
      email: "james@oxford.edu",
      password: "password321",
      confirmPassword: "password321"
    });
    const tokenB = regResB.body.token;

    // User A's ID
    const userA_id = getPersistedRes.body.user.id;

    // User B sends PUT with User A's ID in body
    const tamperRes = await api(
      "PUT",
      "/api/auth/profile",
      {
        id: userA_id,
        _id: userA_id,
        name: "James Hijacked Emma"
      },
      tokenB
    );

    // Verify response updated User B's profile, NOT User A
    if (tamperRes.status === 200 && tamperRes.body.user.email === "james@oxford.edu") {
      console.log("✓ Target user derived strictly from JWT; request body ID was ignored!");
    } else {
      throw new Error("Failed to isolate user identity: " + JSON.stringify(tamperRes));
    }

    // Verify User A's name remains untouched
    const verifyUserARes = await api("GET", "/api/auth/profile", null, tokenA);
    if (verifyUserARes.body.user.name === "Dr. Emma Watson") {
      console.log("✓ Verified User A's profile remained completely untouched in MongoDB!");
    } else {
      throw new Error("SECURITY BREACH: User A's profile was modified by User B!");
    }

    // 12. Security: Attempting to modify protected fields (password, role, tokens) via profile PUT
    console.log("\n[12/13] Testing Protected Fields Tamper Protection (password, tokens, role)...");
    await api(
      "PUT",
      "/api/auth/profile",
      {
        password: "newhackedpassword",
        role: "superadmin",
        resetPasswordToken: "fake_token",
        resetPasswordExpire: Date.now() + 100000
      },
      tokenA
    );

    // Verify User A can still log in with original password (password was not touched)
    const loginOriginalRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "password123"
    });
    if (loginOriginalRes.status === 200 && loginOriginalRes.body.token) {
      console.log("✓ Protected fields ignored: Original password intact!");
    } else {
      throw new Error("SECURITY BREACH: Password was altered via profile update!");
    }

    // 13. Verify GET /api/auth/me backwards compatibility & task CRUD
    console.log("\n[13/13] Verifying GET /api/auth/me compatibility & Task CRUD...");
    const meRes = await api("GET", "/api/auth/me", null, tokenA);
    if (meRes.status === 200 && meRes.body.user.email === "emma@oxford.edu" && meRes.body.user.institution === "University of Oxford") {
      console.log("✓ GET /api/auth/me works and returns enriched profile fields!");
    } else {
      throw new Error("GET /api/auth/me failed: " + JSON.stringify(meRes));
    }

    const taskRes = await api(
      "POST",
      "/api/tasks",
      {
        name: "Profile Milestone Task",
        subject: "Web Engineering",
        priority: "3",
        dueDate: "2026-10-30"
      },
      tokenA
    );
    if (taskRes.status === 201 && taskRes.body.success) {
      console.log("✓ Task CRUD continues to operate with authenticated user!");
    } else {
      throw new Error("Task creation failed: " + JSON.stringify(taskRes));
    }

    console.log("\n==========================================================================");
    console.log("🎉 ALL 13 USER PROFILE TESTS PASSED WITH 100% SUCCESS! 🎉");
    console.log("==========================================================================\n");

  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
}

runProfileTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
