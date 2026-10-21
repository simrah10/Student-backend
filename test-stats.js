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

async function runStatsTests() {
  console.log("=== STARTING TASK STATISTICS & METRICS VERIFICATION TESTS ===\n");

  let mongoServer;
  let server;
  const PORT = 5006;

  try {
    // 1. Start In-Memory MongoDB Server
    console.log("[1/14] Starting in-memory MongoDB instance...");
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    process.env.MONGO_URI = uri;
    process.env.PORT = PORT;
    process.env.NODE_ENV = "test";
    console.log("✓ In-memory MongoDB running at:", uri);

    // 2. Connect Mongoose & Start Express
    console.log("\n[2/14] Connecting Mongoose and starting Express server...");
    await mongoose.connect(uri);
    const app = require("./server");
    server = app.listen(PORT);
    console.log(`✓ Express test server listening on port ${PORT}`);

    // Helper for making requests
    const api = async (method, path, body = null, token = null) => {
      const headers = {
        "Content-Type": "application/json"
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const options = {
        hostname: "localhost",
        port: PORT,
        path,
        method,
        headers
      };
      return await request(options, body);
    };

    // 3. Test Unauthenticated Access to Stats Endpoints
    console.log("\n[3/14] Testing Unauthenticated Access on GET /api/tasks/stats & /api/tasks/statistics...");
    const unauthStats = await api("GET", "/api/tasks/stats", null, null);
    if (unauthStats.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated /stats, got ${unauthStats.status}`);
    }
    const unauthStatistics = await api("GET", "/api/tasks/statistics", null, null);
    if (unauthStatistics.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated /statistics, got ${unauthStatistics.status}`);
    }
    console.log("✓ Unauthenticated access safely rejected with 401 Unauthorized for both endpoints!");

    // 4. Register Test User A
    console.log("\n[4/14] Registering User A...");
    const regResA = await api("POST", "/api/auth/register", {
      name: "Alice Statistician",
      email: "alice@stats.test",
      password: "Password123!"
    });
    if (regResA.status !== 201 || !regResA.body.token) {
      throw new Error("Failed to register User A: " + JSON.stringify(regResA));
    }
    const tokenA = regResA.body.token;
    console.log("✓ User A registered, JWT acquired.");

    // 5. Test Initial Stats (Zero tasks)
    console.log("\n[5/14] Testing initial stats for User A (zero tasks)...");
    const initialStatsRes = await api("GET", "/api/tasks/stats", null, tokenA);
    if (initialStatsRes.status !== 200 || !initialStatsRes.body.success) {
      throw new Error("Failed to get initial stats: " + JSON.stringify(initialStatsRes));
    }
    const initData = initialStatsRes.body.data;
    if (
      initData.total !== 0 ||
      initData.completed !== 0 ||
      initData.pending !== 0 ||
      initData.overdue !== 0 ||
      initData.completionRate !== 0
    ) {
      throw new Error("Initial stats should all be 0: " + JSON.stringify(initData));
    }
    console.log("✓ Initial stats correctly return 0 for total, completed, pending, overdue, and completionRate!");

    // Set a known reference date for testing: e.g. 2026-10-15
    const refToday = "2026-10-15";
    const statsUrlWithRef = `/api/tasks/stats?today=${refToday}`;

    // 6. Create Tasks with Different Statuses and Dates
    // We will create:
    // Task 1: Overdue task (incomplete, dueDate = 2026-10-10 < 2026-10-15)
    // Task 2: Due Today task (incomplete, dueDate = 2026-10-15 == 2026-10-15) -> Pending
    // Task 3: Future task (incomplete, dueDate = 2026-10-25 > 2026-10-15) -> Pending
    // Task 4: Undated task (incomplete, no dueDate) -> Pending
    // Task 5: Completed task with past dueDate (dueDate = 2026-10-01) -> Completed (Must NOT be overdue!)
    // Task 6: Completed task with future dueDate (dueDate = 2026-10-30) -> Completed
    console.log(`\n[6/14] Creating 6 diverse tasks for User A (using reference date ${refToday})...`);

    const task1Res = await api("POST", "/api/tasks", {
      name: "Overdue Math Homework",
      subject: "Math",
      category: "Assignment",
      priority: "3",
      dueDate: "2026-10-10",
      completed: false
    }, tokenA);
    const task1 = task1Res.body.data;

    const task2Res = await api("POST", "/api/tasks", {
      name: "Physics Lab Report Due Today",
      subject: "Physics",
      category: "Lab",
      priority: "2",
      dueDate: "2026-10-15",
      completed: false
    }, tokenA);
    const task2 = task2Res.body.data;

    const task3Res = await api("POST", "/api/tasks", {
      name: "Future Chemistry Presentation",
      subject: "Chemistry",
      category: "Project",
      priority: "1",
      dueDate: "2026-10-25",
      completed: false
    }, tokenA);
    const task3 = task3Res.body.data;

    const task4Res = await api("POST", "/api/tasks", {
      name: "Undated Literature Reading",
      subject: "Literature",
      category: "Reading",
      priority: "1",
      completed: false
    }, tokenA);
    const task4 = task4Res.body.data;

    const task5Res = await api("POST", "/api/tasks", {
      name: "Completed Past Exam Prep",
      subject: "Math",
      category: "Exam",
      priority: "3",
      dueDate: "2026-10-01",
      completed: true
    }, tokenA);
    const task5 = task5Res.body.data;

    const task6Res = await api("POST", "/api/tasks", {
      name: "Completed Early Project",
      subject: "Computer Science",
      category: "Project",
      priority: "2",
      dueDate: "2026-10-30",
      completed: true
    }, tokenA);
    const task6 = task6Res.body.data;

    console.log("✓ Successfully created 6 tasks spanning overdue, due-today, future, undated, and completed.");

    // 7. Verify Task APIs return all required frontend fields
    console.log("\n[7/14] Verifying GET /api/tasks returns all fields needed by Chart.js & frontend stats...");
    const allTasksRes = await api("GET", "/api/tasks", null, tokenA);
    if (allTasksRes.status !== 200 || !Array.isArray(allTasksRes.body.data)) {
      throw new Error("Failed to fetch tasks: " + JSON.stringify(allTasksRes));
    }
    const sampleTask = allTasksRes.body.data[0];
    const requiredFields = ["id", "name", "subject", "priority", "dueDate", "completed", "userId"];
    for (const field of requiredFields) {
      if (sampleTask[field] === undefined) {
        throw new Error(`Missing expected field '${field}' on task object!`);
      }
    }
    console.log("✓ GET /api/tasks contains all required fields: id, name, subject, priority, dueDate, completed, userId.");

    // 8. Verify Statistics Calculation & Invariant: completed + pending + overdue === total
    console.log(`\n[8/14] Verifying Statistics calculation on ${statsUrlWithRef}...`);
    const statsRes = await api("GET", statsUrlWithRef, null, tokenA);
    if (statsRes.status !== 200 || !statsRes.body.success) {
      throw new Error("Failed to fetch stats: " + JSON.stringify(statsRes));
    }
    const s = statsRes.body.data;
    console.log("Calculated Stats:", s);

    // Expected numbers:
    // Total: 6
    // Completed: 2 (task5, task6)
    // Overdue: 1 (task1: incomplete and 2026-10-10 < 2026-10-15)
    // Pending: 3 (task2: due today 2026-10-15, task3: due future 2026-10-25, task4: undated)
    // Completion rate: round(2 / 6 * 100) = 33%
    if (s.total !== 6) throw new Error(`Expected total 6, got ${s.total}`);
    if (s.completed !== 2) throw new Error(`Expected completed 2, got ${s.completed}`);
    if (s.overdue !== 1) throw new Error(`Expected overdue 1, got ${s.overdue}`);
    if (s.pending !== 3) throw new Error(`Expected pending 3, got ${s.pending}`);
    if (s.completionRate !== 33) throw new Error(`Expected completionRate 33, got ${s.completionRate}`);

    // Invariant check
    if (s.completed + s.pending + s.overdue !== s.total) {
      throw new Error(`Invariant failed: ${s.completed} + ${s.pending} + ${s.overdue} !== ${s.total}`);
    }
    console.log("✓ Invariant verified: completed (2) + pending (3) + overdue (1) === total (6)!");
    console.log("✓ Completion rate correctly calculated as 33%!");

    // 9. Test Aliased Endpoint /api/tasks/statistics
    console.log("\n[9/14] Testing /api/tasks/statistics alias endpoint...");
    const statsAliasRes = await api("GET", `/api/tasks/statistics?today=${refToday}`, null, tokenA);
    if (statsAliasRes.status !== 200 || statsAliasRes.body.total !== 6) {
      throw new Error("Alias /statistics failed: " + JSON.stringify(statsAliasRes));
    }
    console.log("✓ Alias /api/tasks/statistics returned identical valid statistics!");

    // 10. Test Dynamic Updates: Mark Overdue Task 1 as Completed
    console.log("\n[10/14] Testing dynamic update: Marking overdue task as completed...");
    const completeRes = await api("PATCH", `/api/tasks/${task1.id}/complete`, null, tokenA);
    if (completeRes.status !== 200 || completeRes.body.data.completed !== true) {
      throw new Error("Failed to complete task1: " + JSON.stringify(completeRes));
    }

    const statsAfterComplete = (await api("GET", statsUrlWithRef, null, tokenA)).body.data;
    // Now:
    // Completed: 3 (task1, task5, task6)
    // Overdue: 0
    // Pending: 3 (task2, task3, task4)
    // Total: 6
    // Completion rate: round(3 / 6 * 100) = 50%
    console.log("Stats after completing overdue task:", statsAfterComplete);
    if (
      statsAfterComplete.completed !== 3 ||
      statsAfterComplete.overdue !== 0 ||
      statsAfterComplete.pending !== 3 ||
      statsAfterComplete.total !== 6 ||
      statsAfterComplete.completionRate !== 50
    ) {
      throw new Error("Stats not dynamically updated after completing task: " + JSON.stringify(statsAfterComplete));
    }
    if (statsAfterComplete.completed + statsAfterComplete.pending + statsAfterComplete.overdue !== statsAfterComplete.total) {
      throw new Error("Invariant failed after completion update");
    }
    console.log("✓ Overdue task converted to completed; overdue became 0, completed became 3, completionRate became 50%!");

    // 11. Test Dynamic Updates: Edit Due Date of Pending Task 3 to past (making it overdue)
    console.log("\n[11/14] Testing dynamic update: Editing due date of pending task to make it overdue...");
    const editDueDateRes = await api("PUT", `/api/tasks/${task3.id}`, {
      dueDate: "2026-10-05" // past relative to 2026-10-15
    }, tokenA);
    if (editDueDateRes.status !== 200 || editDueDateRes.body.data.dueDate !== "2026-10-05") {
      throw new Error("Failed to update dueDate: " + JSON.stringify(editDueDateRes));
    }

    const statsAfterDueDateEdit = (await api("GET", statsUrlWithRef, null, tokenA)).body.data;
    // Now:
    // Completed: 3
    // Overdue: 1 (task3)
    // Pending: 2 (task2, task4)
    // Total: 6
    // Completion rate: 50%
    console.log("Stats after editing due date:", statsAfterDueDateEdit);
    if (
      statsAfterDueDateEdit.completed !== 3 ||
      statsAfterDueDateEdit.overdue !== 1 ||
      statsAfterDueDateEdit.pending !== 2 ||
      statsAfterDueDateEdit.total !== 6
    ) {
      throw new Error("Stats not dynamically updated after due date update: " + JSON.stringify(statsAfterDueDateEdit));
    }
    console.log("✓ Task 3 dynamically shifted from pending to overdue!");

    // 12. Test Dynamic Updates: Delete Task
    console.log("\n[12/14] Testing dynamic update: Deleting a completed task...");
    const deleteRes = await api("DELETE", `/api/tasks/${task6.id}`, null, tokenA);
    if (deleteRes.status !== 200 || !deleteRes.body.success) {
      throw new Error("Failed to delete task: " + JSON.stringify(deleteRes));
    }

    const statsAfterDelete = (await api("GET", statsUrlWithRef, null, tokenA)).body.data;
    // Now:
    // Total: 5
    // Completed: 2 (task1, task5)
    // Overdue: 1 (task3)
    // Pending: 2 (task2, task4)
    // Completion rate: round(2 / 5 * 100) = 40%
    console.log("Stats after deletion:", statsAfterDelete);
    if (
      statsAfterDelete.total !== 5 ||
      statsAfterDelete.completed !== 2 ||
      statsAfterDelete.overdue !== 1 ||
      statsAfterDelete.pending !== 2 ||
      statsAfterDelete.completionRate !== 40
    ) {
      throw new Error("Stats not dynamically updated after task deletion: " + JSON.stringify(statsAfterDelete));
    }
    if (statsAfterDelete.completed + statsAfterDelete.pending + statsAfterDelete.overdue !== statsAfterDelete.total) {
      throw new Error("Invariant failed after deletion");
    }
    console.log("✓ Deletion dynamically reflected: total became 5, completed became 2, completionRate became 40%!");

    // 13. Test User Data Isolation
    console.log("\n[13/14] Testing strict User Data Isolation (User B cannot see User A's stats)...");
    const regResB = await api("POST", "/api/auth/register", {
      name: "Bob Observer",
      email: "bob@stats.test",
      password: "Password123!"
    });
    if (regResB.status !== 201 || !regResB.body.token) {
      throw new Error("Failed to register User B: " + JSON.stringify(regResB));
    }
    const tokenB = regResB.body.token;

    // User B should initially have 0 tasks
    const statsUserB = (await api("GET", "/api/tasks/stats", null, tokenB)).body.data;
    if (statsUserB.total !== 0 || statsUserB.completed !== 0) {
      throw new Error("User B saw non-zero stats: " + JSON.stringify(statsUserB));
    }

    // Create 1 task for User B
    await api("POST", "/api/tasks", {
      name: "Bob Solo Task",
      subject: "Economics",
      priority: "2",
      dueDate: "2026-10-20",
      completed: true
    }, tokenB);

    const statsUserBAfter = (await api("GET", "/api/tasks/stats", null, tokenB)).body.data;
    if (statsUserBAfter.total !== 1 || statsUserBAfter.completed !== 1 || statsUserBAfter.completionRate !== 100) {
      throw new Error("User B stats mismatch: " + JSON.stringify(statsUserBAfter));
    }

    // Verify User A's stats remain strictly 5 tasks
    const statsUserAFinal = (await api("GET", statsUrlWithRef, null, tokenA)).body.data;
    if (statsUserAFinal.total !== 5 || statsUserAFinal.completed !== 2) {
      throw new Error("User A stats contaminated by User B: " + JSON.stringify(statsUserAFinal));
    }
    console.log("✓ Complete data isolation verified: User A has 5 tasks, User B has 1 task. Neither can access or influence the other!");

    // 14. Verify Breakdown Categories (Priority, Subject, Category)
    console.log("\n[14/14] Verifying Priority, Subject, and Category breakdowns...");
    if (
      !statsUserAFinal.breakdown ||
      !statsUserAFinal.breakdown.byPriority ||
      !statsUserAFinal.breakdown.bySubject ||
      !statsUserAFinal.breakdown.byCategory
    ) {
      throw new Error("Missing breakdown fields: " + JSON.stringify(statsUserAFinal.breakdown));
    }
    console.log("Breakdowns:", statsUserAFinal.breakdown);
    console.log("✓ Priority, Subject, and Category breakdowns verified!");

    console.log("\n=======================================================");
    console.log("🎉 ALL 14 TASK STATISTICS TESTS PASSED WITH 100%! 🎉");
    console.log("=======================================================\n");

  } catch (error) {
    console.error("\n❌ STATS TEST SUITE FAILED:", error);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
    process.exit();
  }
}

runStatsTests();
