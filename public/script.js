/**
 * StudentFlow - Student Productivity Management System
 * Complete Email/Password Authentication & User-Specific Task Persistence
 */

// Production API Base URL
const PRODUCTION_API_URL = "https://student-backend-wdxq.onrender.com/api";

/**
 * Resolve the API Base URL based on hosting environment
 * - Priority 1: Explicit window.STUDENTFLOW_API_URL or localStorage ("studentflow_api_base_url")
 * - Priority 2: GitHub Pages (*.github.io) -> ALWAYS uses PRODUCTION_API_URL (never /api or localhost)
 * - Priority 3: HTML Meta tag <meta name="api-base-url" content="..."> (if configured)
 * - Priority 4: Local development (file://, localhost dev server on port other than 5000) -> http://localhost:5000/api
 * - Priority 5: Backend same-origin hosting (localhost:5000 or same origin) -> /api
 * - Default: PRODUCTION_API_URL
 */
function getApiBaseUrl() {
    // 1. Runtime override via window or localStorage
    const runtimeOverride = window.STUDENTFLOW_API_URL ||
        localStorage.getItem("studentflow_api_base_url");
    if (runtimeOverride && runtimeOverride.trim()) {
        return runtimeOverride.trim().replace(/\/+$/, "");
    }

    const hostname = window.location.hostname || "";
    const isGitHubPages = hostname.includes("github.io");

    // 2. On deployed GitHub Pages, ALWAYS use the production API URL (never /api or localhost)
    if (isGitHubPages) {
        return PRODUCTION_API_URL;
    }

    // 3. HTML meta tag configuration
    const metaTag = document.querySelector('meta[name="api-base-url"]');
    const metaUrl = metaTag ? metaTag.getAttribute("content") : null;
    if (metaUrl && metaUrl.trim()) {
        return metaUrl.trim().replace(/\/+$/, "");
    }

    // 4. Local dev environment (Live Server, Vite, file://, etc.)
    const isLocalFrontendOnly =
        window.location.protocol === "file:" ||
        ((hostname === "localhost" || hostname === "127.0.0.1") &&
         window.location.port !== "" &&
         window.location.port !== "5000");

    if (isLocalFrontendOnly) {
        return "http://localhost:5000/api";
    }

    // 5. Backend same-origin serving (e.g. Express serving public folder)
    if (window.location.origin === "https://student-backend-wdxq.onrender.com" ||
        (hostname === "localhost" && window.location.port === "5000")) {
        return "/api";
    }

    // 6. Default to production API
    return PRODUCTION_API_URL;
}

const API_BASE_URL = getApiBaseUrl();

// Application State
let tasks = [];
let currentUser = null;
let currentAuthMode = "login"; // "login" | "signup" | "forgot" | "reset"
let editingTaskId = null;

// ============================================================
// INITIALIZATION & SESSION RESTORATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Check for URL parameters (e.g. ?token=xxxx for reset password)
    const urlParams = new URLSearchParams(window.location.search);
    const resetTokenParam = urlParams.get("token") || urlParams.get("resetToken");

    if (resetTokenParam) {
        switchAuthMode("reset");
        const tokenInput = document.getElementById("resetTokenInput");
        if (tokenInput) tokenInput.value = resetTokenParam;
        return;
    }

    // 2. Check for existing authenticated session
    const token = localStorage.getItem("studentflow_token");
    if (token) {
        await verifyAndRestoreSession(token);
    } else {
        showAuthScreen();
    }

    // 3. Bind navigation buttons
    setupNavigationListeners();
});

/**
 * Verify session token against backend /api/auth/me
 */
async function verifyAndRestoreSession(token) {
    try {
        const res = await fetch(`${API_BASE_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            localStorage.setItem("studentflow_user", JSON.stringify(currentUser));
            showDashboardScreen();
            await loadUserTasks();
        } else {
            // Token expired or invalid
            handleLogout(false);
        }
    } catch (err) {
        console.warn("Could not reach auth server, checking local session cache:", err.message);
        const cachedUser = localStorage.getItem("studentflow_user");
        if (cachedUser) {
            currentUser = JSON.parse(cachedUser);
            showDashboardScreen();
            await loadUserTasks();
        } else {
            showAuthScreen();
        }
    }
}

// ============================================================
// AUTHENTICATION HANDLERS
// ============================================================

/**
 * Handle Login Submission
 */
async function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const submitBtn = document.getElementById("loginSubmitBtn");

    if (!email || !password) {
        showAuthAlert("Please provide both email and password.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Logging in...");
    clearAuthAlert();

    try {
        const res = await fetch(`${API_BASE_URL}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem("studentflow_token", data.token);
            localStorage.setItem("studentflow_user", JSON.stringify(data.user));
            currentUser = data.user;

            showAuthAlert("Login successful! Redirecting...", "success");
            setTimeout(async () => {
                showDashboardScreen();
                await loadUserTasks();
            }, 400);
        } else {
            showAuthAlert(data.message || "Invalid email or password", "error");
        }
    } catch (err) {
        showAuthAlert(`Network error: Could not connect to ${API_BASE_URL}`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Log In");
    }
}

/**
 * Handle Sign Up Submission
 */
async function handleSignup(event) {
    event.preventDefault();

    const name = document.getElementById("signupName").value.trim();
    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;
    const confirmPassword = document.getElementById("signupConfirmPassword").value;
    const submitBtn = document.getElementById("signupSubmitBtn");

    if (!name || !email || !password || !confirmPassword) {
        showAuthAlert("Please fill in all required fields.", "error");
        return;
    }

    if (password.length < 6) {
        showAuthAlert("Password must be at least 6 characters long.", "error");
        return;
    }

    if (password !== confirmPassword) {
        showAuthAlert("Passwords do not match.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Creating Account...");
    clearAuthAlert();

    try {
        const res = await fetch(`${API_BASE_URL}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password, confirmPassword })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem("studentflow_token", data.token);
            localStorage.setItem("studentflow_user", JSON.stringify(data.user));
            currentUser = data.user;

            showAuthAlert("Account created successfully! Loading your dashboard...", "success");
            setTimeout(async () => {
                showDashboardScreen();
                await loadUserTasks();
            }, 500);
        } else {
            showAuthAlert(data.message || "Registration failed", "error");
        }
    } catch (err) {
        showAuthAlert(`Network error: Could not reach backend server`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Create Account");
    }
}

/**
 * Handle Forgot Password Request
 */
async function handleForgotPassword(event) {
    event.preventDefault();

    const email = document.getElementById("forgotEmail").value.trim();
    const submitBtn = document.getElementById("forgotSubmitBtn");

    if (!email) {
        showAuthAlert("Please enter your registered email address.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Generating Reset Link...");
    clearAuthAlert();

    try {
        const res = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            showAuthAlert(data.message, "success");

            // In local/development testing, if resetToken was returned, automatically transition to reset form
            if (data.resetToken) {
                setTimeout(() => {
                    switchAuthMode("reset");
                    const tokenInput = document.getElementById("resetTokenInput");
                    if (tokenInput) tokenInput.value = data.resetToken;
                    showAuthAlert("Reset token auto-filled! Please enter your new password below.", "success");
                }, 1000);
            }
        } else {
            showAuthAlert(data.message || "Failed to process request", "error");
        }
    } catch (err) {
        showAuthAlert(`Unable to connect to server: ${err.message}`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Send Reset Instructions");
    }
}

/**
 * Handle Reset Password Submission
 */
async function handleResetPassword(event) {
    event.preventDefault();

    const token = document.getElementById("resetTokenInput").value.trim();
    const password = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmNewPassword").value;
    const submitBtn = document.getElementById("resetSubmitBtn");

    if (!token || !password || !confirmPassword) {
        showAuthAlert("Please fill in all fields.", "error");
        return;
    }

    if (password.length < 6) {
        showAuthAlert("New password must be at least 6 characters long.", "error");
        return;
    }

    if (password !== confirmPassword) {
        showAuthAlert("Passwords do not match.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Setting New Password...");
    clearAuthAlert();

    try {
        const res = await fetch(`${API_BASE_URL}/auth/reset-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, password, confirmPassword })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            localStorage.setItem("studentflow_token", data.token);
            localStorage.setItem("studentflow_user", JSON.stringify(data.user));
            currentUser = data.user;

            showAuthAlert("Password updated successfully! Welcome back.", "success");
            setTimeout(async () => {
                showDashboardScreen();
                await loadUserTasks();
            }, 600);
        } else {
            showAuthAlert(data.message || "Invalid or expired token", "error");
        }
    } catch (err) {
        showAuthAlert(`Network error: ${err.message}`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Set New Password");
    }
}

/**
 * Handle Logout
 */
async function handleLogout(callBackend = true) {
    const token = localStorage.getItem("studentflow_token");

    if (callBackend && token) {
        try {
            await fetch(`${API_BASE_URL}/auth/logout`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` }
            });
        } catch {
            // Ignore offline logout error
        }
    }

    // Invalidate local session & clear memory
    localStorage.removeItem("studentflow_token");
    localStorage.removeItem("studentflow_user");
    currentUser = null;
    tasks = [];

    // Reset task form & search inputs
    clearForm();
    clearTaskView();

    showAuthScreen();
}

// ============================================================
// UI NAVIGATION & FORM VIEW SWITCHING
// ============================================================

function switchAuthMode(mode) {
    currentAuthMode = mode;
    clearAuthAlert();

    // Elements
    const authTabs = document.getElementById("authTabs");
    const loginTabBtn = document.getElementById("loginTabBtn");
    const signupTabBtn = document.getElementById("signupTabBtn");

    const loginForm = document.getElementById("loginForm");
    const signupForm = document.getElementById("signupForm");
    const forgotForm = document.getElementById("forgotForm");
    const resetForm = document.getElementById("resetForm");

    const authTitle = document.getElementById("authTitle");
    const authSubtitle = document.getElementById("authSubtitle");

    // Hide all forms
    loginForm.style.display = "none";
    signupForm.style.display = "none";
    forgotForm.style.display = "none";
    resetForm.style.display = "none";

    if (mode === "login") {
        authTabs.style.display = "flex";
        loginTabBtn.classList.add("active");
        signupTabBtn.classList.remove("active");
        loginForm.style.display = "block";
        authTitle.textContent = "Welcome to StudentFlow";
        authSubtitle.textContent = "Sign in to manage your tasks, schedules, and academic progress.";
    } else if (mode === "signup") {
        authTabs.style.display = "flex";
        loginTabBtn.classList.remove("active");
        signupTabBtn.classList.add("active");
        signupForm.style.display = "block";
        authTitle.textContent = "Create an Account";
        authSubtitle.textContent = "Join StudentFlow to start organizing your academic workflow.";
    } else if (mode === "forgot") {
        authTabs.style.display = "none";
        forgotForm.style.display = "block";
        authTitle.textContent = "Reset Password";
        authSubtitle.textContent = "Enter your email address and we'll generate your secure reset instructions.";
    } else if (mode === "reset") {
        authTabs.style.display = "none";
        resetForm.style.display = "block";
        authTitle.textContent = "Create New Password";
        authSubtitle.textContent = "Enter your reset token and your new password to restore access.";
    }
}

function showAuthScreen() {
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("mainApp").style.display = "none";
    switchAuthMode("login");
}

function showDashboardScreen() {
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("mainApp").style.display = "flex";
    updateUserProfileUI();
    setActiveButton("dashboardBtn");
}

function togglePasswordVisibility(inputId, toggleBtn) {
    const input = document.getElementById(inputId);
    if (!input) return;

    if (input.type === "password") {
        input.type = "text";
        toggleBtn.textContent = "🙈";
    } else {
        input.type = "password";
        toggleBtn.textContent = "👁️";
    }
}

function setBtnLoading(btn, isLoading, text) {
    if (!btn) return;
    btn.disabled = isLoading;
    const span = btn.querySelector("span");
    if (span) {
        span.textContent = text;
    } else {
        btn.textContent = text;
    }
}

function showAuthAlert(message, type = "error") {
    const alertBox = document.getElementById("authAlert");
    alertBox.textContent = message;
    alertBox.className = `auth-alert ${type}`;
    alertBox.style.display = "block";
}

function clearAuthAlert() {
    const alertBox = document.getElementById("authAlert");
    alertBox.style.display = "none";
    alertBox.textContent = "";
}

function updateUserProfileUI() {
    if (!currentUser) return;

    const name = currentUser.name || "Student";
    const email = currentUser.email || "";
    const initial = (name[0] || "S").toUpperCase();

    // Sidebar Profile
    const sidebarName = document.getElementById("sidebarUserName");
    const sidebarEmail = document.getElementById("sidebarUserEmail");
    const sidebarInitials = document.getElementById("sidebarUserInitials");

    if (sidebarName) sidebarName.textContent = name;
    if (sidebarEmail) sidebarEmail.textContent = email;
    if (sidebarInitials) sidebarInitials.textContent = initial;

    // Topbar Profile
    const topbarName = document.getElementById("topbarUserName");
    const topbarInitials = document.getElementById("topbarUserInitials");

    if (topbarName) topbarName.textContent = name;
    if (topbarInitials) topbarInitials.textContent = initial;
}

// ============================================================
// TASK DATA & CRUD WITH REST BACKEND (USER ISOLATION)
// ============================================================

/**
 * Returns Authorization header with JWT token
 */
function getAuthHeaders() {
    const token = localStorage.getItem("studentflow_token");
    const headers = { "Content-Type": "application/json" };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * Load tasks for the current user from backend
 */
async function loadUserTasks() {
    try {
        const res = await fetch(`${API_BASE_URL}/tasks`, {
            headers: getAuthHeaders()
        });

        if (res.ok) {
            const result = await res.json();
            tasks = result.data || [];
        } else if (res.status === 401) {
            handleLogout(false);
            return;
        } else {
            // Fallback to local storage cache for this user
            const cached = localStorage.getItem(`tasks_${currentUser?.id || "guest"}`);
            tasks = cached ? JSON.parse(cached) : [];
        }
    } catch (err) {
        console.warn("Could not load tasks from API, using cached data:", err.message);
        const cached = localStorage.getItem(`tasks_${currentUser?.id || "guest"}`);
        tasks = cached ? JSON.parse(cached) : [];
    }

    saveTasksLocal();
    displayTasks();
}

/**
 * Save tasks locally per-user for caching
 */
function saveTasksLocal() {
    if (currentUser) {
        localStorage.setItem(`tasks_${currentUser.id}`, JSON.stringify(tasks));
    }
}

/**
 * Add or Save Task
 */
async function addTask() {
    const taskName = document.getElementById("taskInput").value.trim();
    const subject = document.getElementById("subjectInput").value.trim();
    const category = document.getElementById("categoryInput").value.trim();
    const priority = document.getElementById("priorityInput").value;
    const dueDate = document.getElementById("dueDateInput").value;

    if (taskName === "" || subject === "" || dueDate === "") {
        alert("Please fill in the required fields: Task Name, Subject, and Due Date.");
        return;
    }

    const taskPayload = {
        name: taskName,
        subject: subject,
        category: category,
        priority: priority,
        dueDate: dueDate,
        completed: false
    };

    if (editingTaskId) {
        // UPDATE Existing Task
        try {
            const res = await fetch(`${API_BASE_URL}/tasks/${editingTaskId}`, {
                method: "PUT",
                headers: getAuthHeaders(),
                body: JSON.stringify(taskPayload)
            });

            if (res.ok) {
                const result = await res.json();
                const index = tasks.findIndex(t => t.id === editingTaskId || t._id === editingTaskId);
                if (index !== -1) tasks[index] = result.data;
            } else {
                const t = tasks.find(t => t.id === editingTaskId || t._id === editingTaskId);
                if (t) Object.assign(t, taskPayload);
            }
        } catch {
            const t = tasks.find(t => t.id === editingTaskId || t._id === editingTaskId);
            if (t) Object.assign(t, taskPayload);
        }

        editingTaskId = null;
        document.getElementById("formHeading").textContent = "Add New Task";
        document.getElementById("saveTaskBtn").textContent = "Add Task";
    } else {
        // CREATE New Task
        taskPayload.id = Date.now();

        try {
            const res = await fetch(`${API_BASE_URL}/tasks`, {
                method: "POST",
                headers: getAuthHeaders(),
                body: JSON.stringify(taskPayload)
            });

            if (res.ok) {
                const result = await res.json();
                tasks.unshift(result.data);
            } else {
                tasks.unshift(taskPayload);
            }
        } catch {
            tasks.unshift(taskPayload);
        }
    }

    saveTasksLocal();
    clearForm();
    displayTasks();
}

/**
 * Toggle Task Completion
 */
async function completeTask(id) {
    const task = tasks.find(t => t.id === id || t._id === id);
    if (!task) return;

    task.completed = !task.completed;
    saveTasksLocal();
    displayTasks();

    try {
        await fetch(`${API_BASE_URL}/tasks/${id}/complete`, {
            method: "PATCH",
            headers: getAuthHeaders()
        });
    } catch (err) {
        console.warn("Could not sync task complete status with server:", err.message);
    }
}

/**
 * Edit Task (Loads into form)
 */
function editTask(id) {
    const task = tasks.find(t => t.id === id || t._id === id);
    if (!task) return;

    document.getElementById("taskInput").value = task.name;
    document.getElementById("subjectInput").value = task.subject;
    document.getElementById("categoryInput").value = task.category || "";
    document.getElementById("priorityInput").value = task.priority || "1";
    document.getElementById("dueDateInput").value = task.dueDate;

    editingTaskId = task.id || task._id;
    document.getElementById("formHeading").textContent = "Edit Task";
    document.getElementById("saveTaskBtn").textContent = "Update Task";

    openTaskForm();
}

/**
 * Delete Task
 */
async function deleteTask(id) {
    const confirmDelete = confirm("Are you sure you want to delete this task?");
    if (!confirmDelete) return;

    tasks = tasks.filter(t => t.id !== id && t._id !== id);
    saveTasksLocal();
    displayTasks();

    try {
        await fetch(`${API_BASE_URL}/tasks/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });
    } catch (err) {
        console.warn("Could not sync task deletion with server:", err.message);
    }
}

/**
 * Display Tasks with search, filtering, and sorting
 */
function displayTasks(filter = "all") {
    const taskList = document.getElementById("taskList");
    const searchText = (document.getElementById("searchInput")?.value || "").toLowerCase();
    const sortOption = document.getElementById("sortSelect")?.value || "default";

    taskList.innerHTML = "";
    const today = new Date().toISOString().split("T")[0];

    function getDueDateText(dueDate) {
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);

        const taskDate = new Date(dueDate);
        taskDate.setHours(0, 0, 0, 0);

        const difference = Math.round((taskDate - todayDate) / (1000 * 60 * 60 * 24));

        if (difference === 0) return "Today";
        if (difference === 1) return "Tomorrow";
        if (difference === -1) return "Yesterday";
        return dueDate;
    }

    let filteredTasks = tasks.filter(task =>
        task.name.toLowerCase().includes(searchText)
    );

    if (filter === "pending") {
        filteredTasks = filteredTasks.filter(task => !task.completed);
    } else if (filter === "completed") {
        filteredTasks = filteredTasks.filter(task => task.completed);
    } else if (filter === "overdue") {
        filteredTasks = filteredTasks.filter(task => !task.completed && task.dueDate < today);
    }

    if (sortOption === "priorityHigh") {
        filteredTasks.sort((a, b) => b.priority - a.priority);
    } else if (sortOption === "priorityLow") {
        filteredTasks.sort((a, b) => a.priority - b.priority);
    } else if (sortOption === "dueSoon") {
        filteredTasks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    } else if (sortOption === "dueLate") {
        filteredTasks.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    }

    if (filteredTasks.length === 0) {
        let message = "No tasks found.";
        if (filter === "pending") message = "No pending tasks.";
        if (filter === "completed") message = "No completed tasks.";
        if (filter === "overdue") message = "No overdue tasks.";
        if (searchText !== "") message = "No tasks found matching your search.";

        taskList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📝</div>
                <h3>${message}</h3>
                <p>Your tasks will appear here.</p>
            </div>
        `;

        updateDashboard();
        updateStatistics();
        updateSubjectSummary();
        updateCategorySummary();
        return;
    }

    filteredTasks.forEach(task => {
        const taskDiv = document.createElement("div");
        taskDiv.className = "task";
        if (task.completed) taskDiv.classList.add("completed");

        let priorityText = "Low";
        if (task.priority === "2") priorityText = "Medium";
        if (task.priority === "3") priorityText = "High";

        let statusText = "Pending";
        if (task.completed) {
            statusText = "Completed";
        } else if (task.dueDate < today) {
            statusText = "Overdue";
        }

        const taskId = task.id || task._id;

        taskDiv.innerHTML = `
            <h3>${escapeHtml(task.name)}</h3>
            <p><strong>Subject:</strong> ${escapeHtml(task.subject)}</p>
            <p><strong>Category:</strong> ${escapeHtml(task.category || "General")}</p>
            <p>
                <strong>Priority:</strong> 
                <span class="priority-${priorityText.toLowerCase()}">${priorityText}</span>
            </p>
            <p><strong>Due Date:</strong> ${getDueDateText(task.dueDate)}</p>
            <p><strong>Status:</strong> ${statusText}</p>
            <div class="task-buttons">
                <button onclick="completeTask(${typeof taskId === 'number' ? taskId : `'${taskId}'`})">
                    ${task.completed ? "Mark Pending" : "Complete"}
                </button>
                <button onclick="editTask(${typeof taskId === 'number' ? taskId : `'${taskId}'`})">
                    Edit
                </button>
                <button onclick="deleteTask(${typeof taskId === 'number' ? taskId : `'${taskId}'`})">
                    Delete
                </button>
            </div>
        `;

        taskList.appendChild(taskDiv);
    });

    updateDashboard();
    updateStatistics();
    updateSubjectSummary();
    updateCategorySummary();
}

function updateDashboard() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const today = new Date().toISOString().split("T")[0];
    const overdue = tasks.filter(t => !t.completed && t.dueDate < today).length;

    document.getElementById("totalTasks").textContent = total;
    document.getElementById("completedTasks").textContent = completed;
    document.getElementById("pendingTasks").textContent = pending;
    document.getElementById("overdueTasks").textContent = overdue;

    let progress = 0;
    if (total > 0) {
        progress = Math.round((completed / total) * 100);
    }

    document.getElementById("progressText").textContent = progress + "%";
    document.getElementById("progressFill").style.width = progress + "%";
}

function updateStatistics() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const today = new Date().toISOString().split("T")[0];
    const overdue = tasks.filter(t => !t.completed && t.dueDate < today).length;

    document.getElementById("statsTotal").textContent = total;
    document.getElementById("statsCompleted").textContent = completed;
    document.getElementById("statsPending").textContent = pending;
    document.getElementById("statsOverdue").textContent = overdue;
}

function updateSubjectSummary() {
    const subjectSummary = document.getElementById("subjectSummary");
    subjectSummary.innerHTML = "";
    const subjects = {};

    tasks.forEach(task => {
        if (task.subject) {
            const subjectName = task.subject.trim();
            const subjectKey = subjectName.toLowerCase();
            if (subjects[subjectKey]) {
                subjects[subjectKey].count++;
            } else {
                subjects[subjectKey] = { name: subjectName, count: 1 };
            }
        }
    });

    for (let s in subjects) {
        const div = document.createElement("div");
        div.className = "subject-summary-item";
        div.innerHTML = `
            <span>${escapeHtml(subjects[s].name)}</span>
            <strong>${subjects[s].count} task(s)</strong>
        `;
        subjectSummary.appendChild(div);
    }

    if (Object.keys(subjects).length === 0) {
        subjectSummary.innerHTML = "<p>No subjects available yet.</p>";
    }
}

function updateCategorySummary() {
    const categorySummary = document.getElementById("categorySummary");
    categorySummary.innerHTML = "";
    const categories = {};

    tasks.forEach(task => {
        if (task.category) {
            const categoryName = task.category.trim();
            const categoryKey = categoryName.toLowerCase();
            if (categories[categoryKey]) {
                categories[categoryKey].count++;
            } else {
                categories[categoryKey] = { name: categoryName, count: 1 };
            }
        }
    });

    for (let c in categories) {
        const div = document.createElement("div");
        div.className = "subject-summary-item";
        div.innerHTML = `
            <span>${escapeHtml(categories[c].name)}</span>
            <strong>${categories[c].count} task(s)</strong>
        `;
        categorySummary.appendChild(div);
    }

    if (Object.keys(categories).length === 0) {
        categorySummary.innerHTML = "<p>No categories available yet.</p>";
    }
}

// Helpers
function openTaskForm() {
    document.getElementById("taskForm").scrollIntoView({ behavior: "smooth" });
    document.getElementById("taskInput").focus();
}

function clearForm() {
    document.getElementById("taskInput").value = "";
    document.getElementById("subjectInput").value = "";
    document.getElementById("categoryInput").value = "";
    document.getElementById("priorityInput").value = "1";
    document.getElementById("dueDateInput").value = "";
    editingTaskId = null;
    document.getElementById("formHeading").textContent = "Add New Task";
    document.getElementById("saveTaskBtn").textContent = "Add Task";
}

function clearTaskView() {
    document.getElementById("searchInput").value = "";
    document.getElementById("sortSelect").value = "default";
    displayTasks("all");
    setActiveButton("myTasksBtn");
}

function setActiveButton(buttonId) {
    document.querySelectorAll(".nav-item").forEach(btn => btn.classList.remove("active"));
    const selected = document.getElementById(buttonId);
    if (selected) selected.classList.add("active");
}

function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Navigation event bindings
function setupNavigationListeners() {
    document.getElementById("dashboardBtn").addEventListener("click", () => {
        setActiveButton("dashboardBtn");
        window.scrollTo({ top: 0, behavior: "smooth" });
        displayTasks("all");
    });

    document.getElementById("myTasksBtn").addEventListener("click", () => {
        setActiveButton("myTasksBtn");
        displayTasks("all");
        document.getElementById("tasksSection").scrollIntoView({ behavior: "smooth" });
    });

    document.getElementById("pendingBtn").addEventListener("click", () => {
        setActiveButton("pendingBtn");
        displayTasks("pending");
        document.getElementById("tasksSection").scrollIntoView({ behavior: "smooth" });
    });

    document.getElementById("completedBtn").addEventListener("click", () => {
        setActiveButton("completedBtn");
        displayTasks("completed");
        document.getElementById("tasksSection").scrollIntoView({ behavior: "smooth" });
    });

    document.getElementById("overdueBtn").addEventListener("click", () => {
        setActiveButton("overdueBtn");
        displayTasks("overdue");
        document.getElementById("tasksSection").scrollIntoView({ behavior: "smooth" });
    });

    document.getElementById("statisticsBtn").addEventListener("click", () => {
        setActiveButton("statisticsBtn");
        updateStatistics();
        document.getElementById("statisticsSection").scrollIntoView({ behavior: "smooth" });
    });
}
