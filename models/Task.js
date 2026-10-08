const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
      default: () => Date.now(),
      index: true
    },
    name: {
      type: String,
      required: [true, "Task name is required"],
      trim: true
    },
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true
    },
    category: {
      type: String,
      trim: true,
      default: ""
    },
    priority: {
      type: String,
      required: [true, "Priority is required"],
      enum: {
        values: ["1", "2", "3"],
        message: "Priority must be '1' (Low), '2' (Medium), or '3' (High)"
      },
      default: "1"
    },
    dueDate: {
      type: String,
      required: [true, "Due date is required"],
      trim: true
    },
    completed: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("Task", taskSchema);
