# Student Productivity Web - Backend API

A robust, RESTful Node.js and Express backend with MongoDB (Mongoose) built for the **Student Productivity Management System (StudentFlow)**.

---

## 📋 Overview

This backend provides a complete API for managing academic tasks (CRUD, status toggling, filtering, and priority tracking). It is designed to match the exact task data model of the StudentFlow frontend while operating completely independently.

> **Note:** The existing frontend continues to use its native `localStorage` engine. This backend is fully structured and prepared for future frontend integration or external API consumption.

---

## 🛠️ Technologies Used

- **Node.js**: Server-side JavaScript runtime
- **Express.js**: Fast, minimalist web framework
- **MongoDB**: NoSQL document database
- **Mongoose**: Object Data Modeling (ODM) library with built-in schema validation
- **dotenv**: Environment variable management
- **CORS**: Cross-Origin Resource Sharing enabled for frontend communication
- **Nodemon**: Development hot-reloading tool

---

## 📁 Folder Structure

```
backend/
├── server.js                 # Express application entry point & MongoDB connection
├── package.json              # Project dependencies, scripts, and metadata
├── .env.example              # Template for environment variables
├── models/
│   └── Task.js               # Mongoose Task schema and model
├── routes/
│   └── taskRoutes.js         # REST route definitions
├── controllers/
│   └── taskController.js     # Request handlers, validations, and business logic
└── README.md                 # Complete backend documentation
```

---

## ⚙️ Environment Variables

Create a `.env` file in the `backend/` directory by copying the `.env.example`:

```bash
cp .env.example .env
```

Define the following variables:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Port number on which the server listens | `5000` |
| `MONGO_URI` | MongoDB connection URI string | `mongodb://localhost:27017/student-productivity` or MongoDB Atlas URI |
| `JWT_SECRET` | Secret key for signing authentication JWT tokens | Secure random string (e.g. 64-char hex) |
| `CLIENT_URL` | Allowed CORS frontend origins (comma-separated or `*`) | `https://studentflow.onrender.com` or `*` |
| `RESEND_API_KEY` | Resend API Key for sending password reset emails | `re_123456789...` |
| `RESEND_FROM_EMAIL` | Sender email address for password reset emails | `StudentFlow <onboarding@resend.dev>` or verified domain |
| `FRONTEND_URL` | Frontend base URL for generating password reset links | `http://localhost:5000` or production frontend URL |

---

## 🗄️ MongoDB Setup

You can connect to either a local MongoDB instance or a cloud MongoDB Atlas database:

### Option A: Local MongoDB
1. Ensure MongoDB Community Server is installed and running:
   ```bash
   mongod
   ```
2. Set your `.env` connection string:
   ```env
   MONGO_URI=mongodb://localhost:27017/student-productivity
   ```

### Option B: MongoDB Atlas (Cloud)
1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Create a database user and allow your IP address in Network Access.
3. Copy your connection string into `.env`:
   ```env
   MONGO_URI=mongodb+srv://<username>:<password>@cluster0.mongodb.net/student-productivity?retryWrites=true&w=majority
   ```

---

## 🚀 Installation & Running

### 1. Install Dependencies
Navigate into the `backend` folder and run:

```bash
cd backend
npm install
```

### 2. Start the Server

- **Production Mode:**
  ```bash
  npm start
  ```
- **Development Mode (with auto-restart on changes):**
  ```bash
  npm run dev
  ```

Once started, the server will output:
```
Server is running on port 5000
API Base URL: http://localhost:5000/api/tasks
Health Check: http://localhost:5000/api/health
```

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health check endpoint returning API & DB status |
| `GET` | `/api/tasks` | Retrieve all tasks (sorted newest first) |
| `GET` | `/api/tasks/:id` | Retrieve a single task by custom numeric `id` or MongoDB `_id` |
| `POST` | `/api/tasks` | Create a new task (validates required fields and priority) |
| `PUT` | `/api/tasks/:id` | Update an existing task |
| `PATCH` | `/api/tasks/:id/complete` | Toggle the completion status (`completed` boolean) |
| `DELETE` | `/api/tasks/:id` | Delete a task |

---

## 📝 Data Schema & Validation

The Task model strictly conforms to the frontend data model:

| Field | Type | Required | Constraints / Default |
| :--- | :--- | :--- | :--- |
| `id` | Number | Yes | Unique identifier (defaults to `Date.now()`) |
| `name` | String | Yes | Task title / description |
| `subject` | String | Yes | Course/subject name (e.g. `"Java"`, `"Calculus"`) |
| `category` | String | No | Default: `""` (e.g. `"Assignment"`, `"Exam"`) |
| `priority` | String | Yes | Allowed values: `"1"` (Low), `"2"` (Medium), `"3"` (High) |
| `dueDate` | String | Yes | Format: `"YYYY-MM-DD"` |
| `completed` | Boolean | No | Default: `false` |

---

## 📬 Example Requests & Responses

### 1. Health Check
`GET http://localhost:5000/api/health`

**Response (`200 OK`):**
```json
{
  "status": "OK",
  "message": "Student Productivity API is running",
  "database": "connected"
}
```

---

### 2. Create Task
`POST http://localhost:5000/api/tasks`

**Request Body:**
```json
{
  "name": "Complete Data Structures Lab 3",
  "subject": "Data Structures",
  "category": "Lab",
  "priority": "3",
  "dueDate": "2026-10-15"
}
```

**Response (`201 Created`):**
```json
{
  "success": true,
  "message": "Task created successfully",
  "data": {
    "id": 1728325492100,
    "name": "Complete Data Structures Lab 3",
    "subject": "Data Structures",
    "category": "Lab",
    "priority": "3",
    "dueDate": "2026-10-15",
    "completed": false,
    "_id": "67041a87b12e...",
    "createdAt": "2026-10-07T18:24:52.100Z",
    "updatedAt": "2026-10-07T18:24:52.100Z"
  }
}
```

---

### 3. Get All Tasks
`GET http://localhost:5000/api/tasks`

**Response (`200 OK`):**
```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "id": 1728325492100,
      "name": "Complete Data Structures Lab 3",
      "subject": "Data Structures",
      "category": "Lab",
      "priority": "3",
      "dueDate": "2026-10-15",
      "completed": false
    }
  ]
}
```

---

### 4. Toggle Completion
`PATCH http://localhost:5000/api/tasks/1728325492100/complete`

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Task marked as completed",
  "data": {
    "id": 1728325492100,
    "name": "Complete Data Structures Lab 3",
    "completed": true
  }
}
```

---

### 5. Update Task
`PUT http://localhost:5000/api/tasks/1728325492100`

**Request Body:**
```json
{
  "priority": "2",
  "category": "Homework"
}
```

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Task updated successfully",
  "data": {
    "id": 1728325492100,
    "name": "Complete Data Structures Lab 3",
    "subject": "Data Structures",
    "category": "Homework",
    "priority": "2",
    "dueDate": "2026-10-15",
    "completed": true
  }
}
```

---

### 6. Delete Task
`DELETE http://localhost:5000/api/tasks/1728325492100`

**Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Task deleted successfully"
}
```
