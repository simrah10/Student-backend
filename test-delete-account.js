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

async function runDeleteAccountTests() {
  console.log("=== STARTING ACCOUNT DELETION & EMAIL REUSE VERIFICATION TESTS ===\n");
  let mongoServer;
  let server;
  const PORT = 5012;

  try {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "studentflow_delete_test_secret_2026";

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

    // Helper to register and verify user with DB OTP lookup
    const registerAndVerify = async (name, email, password) => {
      const regRes = await api("POST", "/api/auth/register", {
        name,
        email,
        password,
        confirmPassword: password
      });

      if (regRes.status !== 201) {
        throw new Error(`Registration failed for ${email}: ${JSON.stringify(regRes.body)}`);
      }

      const user = await User.findOne({ email }).select("+emailVerificationOtp");
      user.isEmailVerified = true;
      user.emailVerificationOtp = null;
      user.emailVerificationExpires = null;
      await user.save();

      const loginRes = await api("POST", "/api/auth/login", { email, password });
      return {
        token: loginRes.body.token,
        user: loginRes.body.user,
        userId: user._id.toString()
      };
    };

    // [1/10] Unauthenticated access rejection
    console.log("[1/10] Testing Unauthenticated Access on DELETE /api/auth/account...");
    const unauthRes = await api("DELETE", "/api/auth/account");
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated deletion, got ${unauthRes.status}`);
    }
    console.log("✓ Unauthenticated request correctly rejected with 401 Unauthorized");

    // [2/10] Invalid token rejection
    console.log("\n[2/10] Testing Invalid / Tampered Token on DELETE /api/auth/account...");
    const badTokenRes = await api("DELETE", "/api/auth/account", null, "invalid.jwt.token");
    if (badTokenRes.status !== 401) {
      throw new Error(`Expected 401 for invalid token, got ${badTokenRes.status}`);
    }
    console.log("✓ Invalid token correctly rejected with 401 Unauthorized");

    // [3/10] Register User A and User B
    console.log("\n[3/10] Setting up User A (target) and User B (isolation check)...");
    const userA = await registerAndVerify("Alice Wonderland", "alice@wonderland.edu", "Password123!");
    const userB = await registerAndVerify("Bob Builder", "bob@builder.edu", "Password123!");
    console.log(`✓ User A registered (ID: ${userA.userId})`);
    console.log(`✓ User B registered (ID: ${userB.userId})`);

    // [4/10] Create Tasks for both users
    console.log("\n[4/10] Creating tasks for User A and User B...");
    const taskA1 = await api("POST", "/api/tasks", {
      name: "Alice Math Task",
      subject: "Math",
      priority: "2",
      dueDate: "2026-10-30"
    }, userA.token);
    const taskA2 = await api("POST", "/api/tasks", {
      name: "Alice Physics Task",
      subject: "Physics",
      priority: "3",
      dueDate: "2026-11-05"
    }, userA.token);

    const taskB1 = await api("POST", "/api/tasks", {
      name: "Bob Architecture Task",
      subject: "Design",
      priority: "1",
      dueDate: "2026-10-28"
    }, userB.token);

    if (taskA1.status !== 201 || taskA2.status !== 201 || taskB1.status !== 201) {
      throw new Error("Failed to create prerequisite tasks");
    }

    const initialTasksA = await Task.countDocuments({ userId: userA.userId });
    const initialTasksB = await Task.countDocuments({ userId: userB.userId });
    if (initialTasksA !== 2 || initialTasksB !== 1) {
      throw new Error(`Initial task counts mismatch: A=${initialTasksA}, B=${initialTasksB}`);
    }
    console.log("✓ User A has 2 tasks, User B has 1 task in database");

    // [5/10] Execute Account Deletion for User A
    console.log("\n[5/10] Executing DELETE /api/auth/account for User A...");
    // Attempt spoofing by passing User B's ID in request body/query - must be ignored!
    const deleteRes = await api("DELETE", "/api/auth/account?userId=" + userB.userId, {
      userId: userB.userId,
      id: userB.userId
    }, userA.token);

    if (deleteRes.status !== 200) {
      throw new Error(`Account deletion failed with status ${deleteRes.status}: ${JSON.stringify(deleteRes.body)}`);
    }
    if (!deleteRes.body.success) {
      throw new Error(`Expected success: true, got ${JSON.stringify(deleteRes.body)}`);
    }
    console.log("✓ User A account deletion returned HTTP 200 with success message");

    // [6/10] Verify User A and User A's tasks are removed from MongoDB
    console.log("\n[6/10] Verifying permanent deletion of User A data from MongoDB...");
    const deletedUserA = await User.findById(userA.userId);
    if (deletedUserA !== null) {
      throw new Error("User A document still exists in MongoDB!");
    }
    const remainingTasksA = await Task.countDocuments({ userId: userA.userId });
    if (remainingTasksA !== 0) {
      throw new Error(`User A still has ${remainingTasksA} tasks in MongoDB!`);
    }
    console.log("✓ User A record completely deleted from MongoDB");
    console.log("✓ All tasks belonging to User A completely purged from MongoDB");

    // [7/10] Verify User B and User B's tasks are completely untouched
    console.log("\n[7/10] Verifying User B isolation (User B must remain untouched)...");
    const preservedUserB = await User.findById(userB.userId);
    if (!preservedUserB || preservedUserB.email !== "bob@builder.edu") {
      throw new Error("User B was improperly affected by User A's deletion!");
    }
    const remainingTasksB = await Task.countDocuments({ userId: userB.userId });
    if (remainingTasksB !== 1) {
      throw new Error(`User B tasks modified! Expected 1, found ${remainingTasksB}`);
    }
    console.log("✓ User B account document verified intact");
    console.log("✓ User B tasks verified intact and isolated");

    // [8/10] Verify User A's old JWT is rejected on protected endpoints
    console.log("\n[8/10] Verifying that User A's old token cannot access protected APIs...");
    const meRes = await api("GET", "/api/auth/me", null, userA.token);
    if (meRes.status !== 401) {
      throw new Error(`Expected 401 for deleted user token on /auth/me, got ${meRes.status}`);
    }
    const tasksRes = await api("GET", "/api/tasks", null, userA.token);
    if (tasksRes.status !== 401) {
      throw new Error(`Expected 401 for deleted user token on /tasks, got ${tasksRes.status}`);
    }
    const deleteAgainRes = await api("DELETE", "/api/auth/account", null, userA.token);
    if (deleteAgainRes.status !== 401) {
      throw new Error(`Expected 401 for deleted user token on /auth/account, got ${deleteAgainRes.status}`);
    }
    console.log("✓ Old JWT rejected with 401 on /api/auth/me");
    console.log("✓ Old JWT rejected with 401 on /api/tasks");
    console.log("✓ Old JWT rejected with 401 on /api/auth/account");

    // [9/10] Email Reuse: Registering a brand new account with Alice's original email
    console.log("\n[9/10] Testing Email Reuse: Registering new account with alice@wonderland.edu...");
    const newRegRes = await api("POST", "/api/auth/register", {
      name: "Alice Brand New",
      email: "alice@wonderland.edu",
      password: "NewPassword456!",
      confirmPassword: "NewPassword456!"
    });

    if (newRegRes.status !== 201) {
      throw new Error(`Email reuse registration failed: ${JSON.stringify(newRegRes.body)}`);
    }
    console.log("✓ Registration succeeded with previously deleted email address!");

    // Verify and log in as the newly registered Alice
    const newAliceDoc = await User.findOne({ email: "alice@wonderland.edu" });
    if (!newAliceDoc) {
      throw new Error("New user document not found in MongoDB!");
    }
    if (newAliceDoc._id.toString() === userA.userId) {
      throw new Error("Security Alert: MongoDB reused the exact same _id for the new user!");
    }
    console.log(`✓ New account has a distinct unique MongoDB ID: ${newAliceDoc._id.toString()} (Old ID was: ${userA.userId})`);

    newAliceDoc.isEmailVerified = true;
    newAliceDoc.emailVerificationOtp = null;
    await newAliceDoc.save();

    const newLoginRes = await api("POST", "/api/auth/login", {
      email: "alice@wonderland.edu",
      password: "NewPassword456!"
    });

    if (newLoginRes.status !== 200 || !newLoginRes.body.token) {
      throw new Error(`Login failed for reused email: ${JSON.stringify(newLoginRes.body)}`);
    }
    const newAliceToken = newLoginRes.body.token;
    console.log("✓ Logged into new account with new credentials");

    // [10/10] Confirm new account starts with clean slate and old token is blocked from new account
    console.log("\n[10/10] Verifying clean slate and token segregation...");
    const newTasksRes = await api("GET", "/api/tasks", null, newAliceToken);
    if (newTasksRes.status !== 200 || newTasksRes.body.data.length !== 0) {
      throw new Error(`Expected 0 tasks for fresh account, found ${newTasksRes.body.data.length}`);
    }
    console.log("✓ Fresh account starts with 0 tasks (old tasks were not restored)");

    const oldTokenAttackRes = await api("GET", "/api/tasks", null, userA.token);
    if (oldTokenAttackRes.status !== 401) {
      throw new Error(`Security breach: Old token was accepted! Status: ${oldTokenAttackRes.status}`);
    }
    console.log("✓ User A's old JWT remains rejected with 401 and cannot access new account!");

    // Create a new task under the new account
    const freshTask = await api("POST", "/api/tasks", {
      name: "Brand New Semester Project",
      subject: "AI",
      priority: "3",
      dueDate: "2026-11-20"
    }, newAliceToken);
    if (freshTask.status !== 201) {
      throw new Error("Failed to create task in new account");
    }
    console.log("✓ New account can create and manage tasks normally");

    console.log("\n==========================================================================");
    console.log("🎉 ALL 10 ACCOUNT DELETION & EMAIL REUSE TESTS PASSED WITH 100%! 🎉");
    console.log("==========================================================================");

  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
}

runDeleteAccountTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
