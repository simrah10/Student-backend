const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      default: () => Date.now(),
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Task must belong to a user"],
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
      trim: true,
      default: ""
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

// Fast compound lookup per user
taskSchema.index({ userId: 1, id: 1 });

module.exports = mongoose.model("Task", taskSchema);
