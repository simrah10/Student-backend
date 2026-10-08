const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Task = require("./models/Task");

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
  console.log("=== STARTING EMAIL/PASSWORD AUTHENTICATION & TASK ISOLATION TESTS ===\n");
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
    console.log("[1/12] Testing POST /api/auth/register (User A)...");
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
    console.log("\n[2/12] Testing mismatched confirm password validation...");
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
    console.log("\n[3/12] Testing duplicate email rejection...");
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
    console.log("\n[4/12] Testing POST /api/auth/login (Correct credentials)...");
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
    console.log("\n[5/12] Testing POST /api/auth/login (Incorrect password)...");
    const badLoginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "wrongpassword"
    });
    if (badLoginRes.status === 401) {
      console.log("✓ Incorrect password rejected with 401 Unauthorized!");
    } else {
      throw new Error("Failed to reject incorrect password");
    }

    // 6. Forgot Password - generate expiring token
    console.log("\n[6/12] Testing POST /api/auth/forgot-password...");
    const forgotRes = await api("POST", "/api/auth/forgot-password", {
      email: "emma@oxford.edu"
    });
    if (forgotRes.status === 200 && forgotRes.body.resetToken) {
      console.log("✓ Secure temporary reset token generated successfully!");
    } else {
      throw new Error("Forgot password failed");
    }
    const resetToken = forgotRes.body.resetToken;

    // 7. Reset Password with token
    console.log("\n[7/12] Testing POST /api/auth/reset-password...");
    const resetRes = await api("POST", "/api/auth/reset-password", {
      token: resetToken,
      password: "newpassword789",
      confirmPassword: "newpassword789"
    });
    if (resetRes.status === 200 && resetRes.body.token) {
      console.log("✓ Password reset successful with new password!");
    } else {
      throw new Error(`Reset password failed: ${JSON.stringify(resetRes.body)}`);
    }

    // 8. Login with NEW password
    console.log("\n[8/12] Testing Login with NEW password...");
    const newLoginRes = await api("POST", "/api/auth/login", {
      email: "emma@oxford.edu",
      password: "newpassword789"
    });
    if (newLoginRes.status === 200 && newLoginRes.body.token) {
      console.log("✓ Logged in with new password successfully!");
    } else {
      throw new Error("Failed to log in with new password");
    }

    // 9. Reusing old reset token must fail
    console.log("\n[9/12] Testing reset token invalidation after use...");
    const reuseRes = await api("POST", "/api/auth/reset-password", {
      token: resetToken,
      password: "anotherpassword"
    });
    if (reuseRes.status === 400) {
      console.log("✓ Token reuse correctly rejected! Token was invalidated.");
    } else {
      throw new Error("Failed to invalidate used reset token");
    }

    // 10. Register User B
    console.log("\n[10/12] Registering User B (James)...");
    const regResB = await api("POST", "/api/auth/register", {
      name: "James Potter",
      email: "james@oxford.edu",
      password: "password321"
    });
    const tokenB = regResB.body.token;
    console.log("✓ User B registered successfully!");

    // 11. User A creates a task
    console.log("\n[11/12] User A creates task 1001...");
    const taskResA = await api("POST", "/api/tasks", {
      id: 1001,
      name: "Emma's Organic Chemistry Lab Report",
      subject: "Chemistry",
      category: "Lab",
      priority: "3",
      dueDate: "2026-10-25"
    }, tokenA);
    if (taskResA.status !== 201) {
      throw new Error(`Task creation failed: ${JSON.stringify(taskResA.body)}`);
    }
    console.log("✓ User A created task 1001!");

    // 12. TASK ISOLATION: User B cannot view, edit, complete, or delete User A's task
    console.log("\n[12/12] TASK ISOLATION: Verifying User B cannot access User A's task...");
    const tasksResB = await api("GET", "/api/tasks", null, tokenB);
    if (tasksResB.body.count === 0 && tasksResB.body.data.length === 0) {
      console.log("✓ User B sees 0 tasks (cannot view User A's task)!");
    } else {
      throw new Error("TASK ISOLATION BREACH: User B could see User A's task");
    }

    const editResB = await api("PUT", "/api/tasks/1001", { name: "Tampered" }, tokenB);
    const deleteResB = await api("DELETE", "/api/tasks/1001", null, tokenB);
    const toggleResB = await api("PATCH", "/api/tasks/1001/complete", null, tokenB);

    if (editResB.status === 404 && deleteResB.status === 404 && toggleResB.status === 404) {
      console.log("✓ User B received 404 on all unauthorized modification attempts!");
    } else {
      throw new Error("TASK ISOLATION BREACH: User B was able to modify/delete User A's task");
    }

    console.log("\n==================================================================");
    console.log("🎉 ALL 12 AUTHENTICATION & TASK ISOLATION TESTS PASSED 100%! 🎉");
    console.log("==================================================================\n");

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
