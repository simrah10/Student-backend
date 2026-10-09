const express = require("express");
const router = express.Router();
const {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  toggleTaskComplete,
  deleteTask
} = require("../controllers/taskController");
const { protect } = require("../middleware/auth");

// Require authentication for all task operations (strict user isolation)
router.use(protect);

// Routes for /api/tasks
router.route("/")
  .get(getTasks)
  .post(createTask);

// Routes for /api/tasks/:id
router.route("/:id")
  .get(getTaskById)
  .put(updateTask)
  .delete(deleteTask);

// Route for toggling completion: PATCH /api/tasks/:id/complete
router.patch("/:id/complete", toggleTaskComplete);

module.exports = router;
