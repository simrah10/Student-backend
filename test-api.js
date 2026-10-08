const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const request = (options, postData) => {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
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

async function runTests() {
  console.log("=== STARTING BACKEND API VERIFICATION TESTS ===\n");

  let mongoServer;
  let server;
  const PORT = 5001;

  try {
    // 1. Start In-Memory MongoDB Server
    console.log("[1/10] Starting in-memory MongoDB instance...");
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    console.log("✓ In-memory MongoDB running at:", uri);

    // 2. Start Express app and connect Mongoose
    console.log("\n[2/10] Connecting Mongoose and starting Express server...");
    await mongoose.connect(uri);
    console.log("✓ Mongoose connected to MongoDB successfully!");

    const app = require("./server");
    server = app.listen(PORT);
    console.log(`✓ Express test server listening on port ${PORT}`);

    // Helper for making requests
    const api = async (method, path, body = null) => {
      const options = {
        hostname: "localhost",
        port: PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json"
        }
      };
      return await request(options, body);
    };

    // 3. Test Health Endpoint
    console.log("\n[3/10] Testing GET /api/health...");
    const healthRes = await api("GET", "/api/health");
    console.log("Response:", healthRes);
    if (healthRes.status === 200 && healthRes.body.status === "OK") {
      console.log("✓ Health check PASSED!");
    } else {
      throw new Error(`Health check failed: ${JSON.stringify(healthRes)}`);
    }

    // 4. Test Validation on Create Task
    console.log("\n[4/10] Testing Validation on POST /api/tasks (missing required fields)...");
    const invalidRes1 = await api("POST", "/api/tasks", { name: "Incomplete task" });
    if (invalidRes1.status === 400 && invalidRes1.body.success === false) {
      console.log("✓ Correctly rejected missing subject with 400 Bad Request");
    } else {
      throw new Error("Validation check failed: " + JSON.stringify(invalidRes1));
    }

    const invalidRes2 = await api("POST", "/api/tasks", {
      name: "Bad Priority Task",
      subject: "Math",
      dueDate: "2026-10-15",
      priority: "99" // invalid
    });
    if (invalidRes2.status === 400 && invalidRes2.body.message.includes("Invalid priority")) {
      console.log("✓ Correctly rejected invalid priority '99' with 400 Bad Request");
    } else {
      throw new Error("Priority validation failed: " + JSON.stringify(invalidRes2));
    }

    // 5. Test Creating a Task (POST /api/tasks)
    console.log("\n[5/10] Testing POST /api/tasks (Valid task creation)...");
    const newTaskPayload = {
      name: "Complete Java Final Project",
      subject: "Computer Science",
      category: "Assignment",
      priority: "3",
      dueDate: "2026-10-20"
    };
    const createRes = await api("POST", "/api/tasks", newTaskPayload);
    console.log("Response:", createRes);
    if (createRes.status === 201 && createRes.body.success && createRes.body.data.name === newTaskPayload.name) {
      console.log("✓ Task created successfully! Generated ID:", createRes.body.data.id);
    } else {
      throw new Error("Task creation failed: " + JSON.stringify(createRes));
    }

    const createdTaskId = createRes.body.data.id;

    // 6. Test Getting All Tasks (GET /api/tasks)
    console.log("\n[6/10] Testing GET /api/tasks...");
    const getAllRes = await api("GET", "/api/tasks");
    console.log("Response:", getAllRes);
    if (getAllRes.status === 200 && getAllRes.body.success && getAllRes.body.count >= 1) {
      console.log(`✓ Retrieved all tasks successfully! Count: ${getAllRes.body.count}`);
    } else {
      throw new Error("Get all tasks failed: " + JSON.stringify(getAllRes));
    }

    // 7. Test Getting One Task by ID (GET /api/tasks/:id)
    console.log(`\n[7/10] Testing GET /api/tasks/${createdTaskId}...`);
    const getOneRes = await api("GET", `/api/tasks/${createdTaskId}`);
    console.log("Response:", getOneRes);
    if (getOneRes.status === 200 && getOneRes.body.success && getOneRes.body.data.id === createdTaskId) {
      console.log("✓ Retrieved single task by ID successfully!");
    } else {
      throw new Error("Get single task failed: " + JSON.stringify(getOneRes));
    }

    // 8. Test Updating a Task (PUT /api/tasks/:id)
    console.log(`\n[8/10] Testing PUT /api/tasks/${createdTaskId}...`);
    const updatePayload = {
      priority: "2",
      category: "Milestone 1"
    };
    const updateRes = await api("PUT", `/api/tasks/${createdTaskId}`, updatePayload);
    console.log("Response:", updateRes);
    if (updateRes.status === 200 && updateRes.body.data.priority === "2" && updateRes.body.data.category === "Milestone 1") {
      console.log("✓ Task updated successfully!");
    } else {
      throw new Error("Update task failed: " + JSON.stringify(updateRes));
    }

    // 9. Test Toggling Completion (PATCH /api/tasks/:id/complete)
    console.log(`\n[9/10] Testing PATCH /api/tasks/${createdTaskId}/complete...`);
    const toggleRes1 = await api("PATCH", `/api/tasks/${createdTaskId}/complete`);
    console.log("Toggle 1 Response:", toggleRes1);
    if (toggleRes1.status === 200 && toggleRes1.body.data.completed === true) {
      console.log("✓ Task marked as completed successfully!");
    } else {
      throw new Error("Toggle completion failed: " + JSON.stringify(toggleRes1));
    }

    const toggleRes2 = await api("PATCH", `/api/tasks/${createdTaskId}/complete`);
    if (toggleRes2.status === 200 && toggleRes2.body.data.completed === false) {
      console.log("✓ Task toggled back to pending successfully!");
    } else {
      throw new Error("Toggle completion (2) failed: " + JSON.stringify(toggleRes2));
    }

    // 10. Test Deleting a Task (DELETE /api/tasks/:id)
    console.log(`\n[10/10] Testing DELETE /api/tasks/${createdTaskId}...`);
    const deleteRes = await api("DELETE", `/api/tasks/${createdTaskId}`);
    console.log("Delete Response:", deleteRes);
    if (deleteRes.status === 200 && deleteRes.body.success) {
      console.log("✓ Task deleted successfully!");
    } else {
      throw new Error("Delete task failed: " + JSON.stringify(deleteRes));
    }

    // Verify task no longer exists
    const verifyNotFoundRes = await api("GET", `/api/tasks/${createdTaskId}`);
    if (verifyNotFoundRes.status === 404) {
      console.log("✓ Verified task was deleted (404 Not Found returned)!");
    } else {
      throw new Error("Deleted task still returned: " + JSON.stringify(verifyNotFoundRes));
    }

    console.log("\n==============================================");
    console.log("🎉 ALL 10 TESTS PASSED WITH 100% SUCCESS! 🎉");
    console.log("==============================================");

  } catch (error) {
    console.error("\n❌ TEST SUITE FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
    process.exit();
  }
}

runTests();
