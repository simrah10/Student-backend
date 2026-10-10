const express = require("express");
const router = express.Router();
const {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  toggleTaskComplete,
  deleteTask,
  getTaskStats
} = require("../controllers/taskController");
const { protect } = require("../middleware/auth");

// Require authentication for all task operations (strict user isolation)
router.use(protect);

// Routes for /api/tasks
router.route("/")
  .get(getTasks)
  .post(createTask);

// Task statistics endpoints (must precede /:id)
router.get("/stats", getTaskStats);
router.get("/statistics", getTaskStats);

// Routes for /api/tasks/:id
router.route("/:id")
  .get(getTaskById)
  .put(updateTask)
  .delete(deleteTask);

// Route for toggling completion: PATCH /api/tasks/:id/complete
router.patch("/:id/complete", toggleTaskComplete);

module.exports = router;
