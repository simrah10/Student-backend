const mongoose = require("mongoose");
const Task = require("../models/Task");

// Helper to look up task by either numeric custom id or MongoDB ObjectId, respecting user ownership
const findTaskByIdAndUser = async (idParam, userId) => {
  if (!userId) return null;
  const query = { userId };

  const numericId = Number(idParam);
  if (!isNaN(numericId)) {
    const task = await Task.findOne({ id: numericId, ...query });
    if (task) return task;
  }

  if (mongoose.Types.ObjectId.isValid(idParam)) {
    const task = await Task.findOne({ _id: idParam, ...query });
    if (task) return task;
  }

  return null;
};

// @desc    Get tasks (filtered strictly by authenticated user)
// @route   GET /api/tasks
// @access  Protected / Optional
const getTasks = async (req, res, next) => {
  try {
    const tasks = await Task.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      count: tasks.length,
      data: tasks
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single task by id (scoped to authenticated user)
// @route   GET /api/tasks/:id
// @access  Protected / Optional
const getTaskById = async (req, res, next) => {
  try {
    const userId = req.user ? req.user._id : null;
    const task = await findTaskByIdAndUser(req.params.id, userId);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: `Task with id '${req.params.id}' not found`
      });
    }

    return res.status(200).json({
      success: true,
      data: task
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new task associated with authenticated user
// @route   POST /api/tasks
// @access  Protected / Optional
const createTask = async (req, res, next) => {
  try {
    const { id, name, subject, category, priority, dueDate, completed } = req.body;

    // Validate required fields
    if (!name || !name.toString().trim()) {
      return res.status(400).json({
        success: false,
        message: "Task name is required"
      });
    }

    if (!subject || !subject.toString().trim()) {
      return res.status(400).json({
        success: false,
        message: "Subject is required"
      });
    }

    if (!dueDate || !dueDate.toString().trim()) {
      return res.status(400).json({
        success: false,
        message: "Due date is required"
      });
    }

    // Validate priority if provided, default to '1' (Low)
    const priorityVal = priority !== undefined ? String(priority).trim() : "1";
    if (!["1", "2", "3"].includes(priorityVal)) {
      return res.status(400).json({
        success: false,
        message: "Invalid priority value. Allowed values are '1' (Low), '2' (Medium), or '3' (High)"
      });
    }

    const newTask = new Task({
      id: id && !isNaN(Number(id)) ? Number(id) : Date.now(),
      userId: req.user._id,
      name: name.toString().trim(),
      subject: subject.toString().trim(),
      category: category ? category.toString().trim() : "",
      priority: priorityVal,
      dueDate: dueDate.toString().trim(),
      completed: Boolean(completed)
    });

    const savedTask = await newTask.save();

    return res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: savedTask
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "A task with this ID already exists"
      });
    }
    next(error);
  }
};

// @desc    Update a task (scoped to authenticated user)
// @route   PUT /api/tasks/:id
// @access  Protected / Optional
const updateTask = async (req, res, next) => {
  try {
    const userId = req.user ? req.user._id : null;
    const task = await findTaskByIdAndUser(req.params.id, userId);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: `Task with id '${req.params.id}' not found`
      });
    }

    const { name, subject, category, priority, dueDate, completed } = req.body;

    if (name !== undefined) {
      if (!name.toString().trim()) {
        return res.status(400).json({
          success: false,
          message: "Task name cannot be empty"
        });
      }
      task.name = name.toString().trim();
    }

    if (subject !== undefined) {
      if (!subject.toString().trim()) {
        return res.status(400).json({
          success: false,
          message: "Subject cannot be empty"
        });
      }
      task.subject = subject.toString().trim();
    }

    if (category !== undefined) {
      task.category = category ? category.toString().trim() : "";
    }

    if (priority !== undefined) {
      const priorityVal = String(priority).trim();
      if (!["1", "2", "3"].includes(priorityVal)) {
        return res.status(400).json({
          success: false,
          message: "Invalid priority value. Allowed values are '1' (Low), '2' (Medium), or '3' (High)"
        });
      }
      task.priority = priorityVal;
    }

    if (dueDate !== undefined) {
      if (!dueDate.toString().trim()) {
        return res.status(400).json({
          success: false,
          message: "Due date cannot be empty"
        });
      }
      task.dueDate = dueDate.toString().trim();
    }

    if (completed !== undefined) {
      task.completed = Boolean(completed);
    }

    const updatedTask = await task.save();

    return res.status(200).json({
      success: true,
      message: "Task updated successfully",
      data: updatedTask
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle task completion status (scoped to authenticated user)
// @route   PATCH /api/tasks/:id/complete
// @access  Protected / Optional
const toggleTaskComplete = async (req, res, next) => {
  try {
    const userId = req.user ? req.user._id : null;
    const task = await findTaskByIdAndUser(req.params.id, userId);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: `Task with id '${req.params.id}' not found`
      });
    }

    task.completed = !task.completed;
    const updatedTask = await task.save();

    return res.status(200).json({
      success: true,
      message: `Task marked as ${updatedTask.completed ? "completed" : "pending"}`,
      data: updatedTask
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a task (scoped to authenticated user)
// @route   DELETE /api/tasks/:id
// @access  Protected / Optional
const deleteTask = async (req, res, next) => {
  try {
    const userId = req.user ? req.user._id : null;
    const task = await findTaskByIdAndUser(req.params.id, userId);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: `Task with id '${req.params.id}' not found`
      });
    }

    await task.deleteOne();

    return res.status(200).json({
      success: true,
      message: "Task deleted successfully"
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  toggleTaskComplete,
  deleteTask
};
