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

// Routing State
const VALID_ROUTES = ["dashboard", "tasks", "pending", "completed", "overdue", "statistics"];
const DEFAULT_ROUTE = "dashboard";
let currentRoute = "dashboard";

// ============================================================
// INITIALIZATION & SESSION RESTORATION
// ============================================================

/**
 * Safely extracts password reset token from URL query parameters or hash
 * Supports: ?token=..., ?resetToken=..., #token=..., #?token=...
 */
function getResetTokenFromUrl() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        let token = urlParams.get("token") || urlParams.get("resetToken");
        if (token && token.trim()) return token.trim();

        if (window.location.hash) {
            const hash = window.location.hash.substring(1);
            const hashParams = new URLSearchParams(hash.startsWith("?") ? hash : "?" + hash);
            token = hashParams.get("token") || hashParams.get("resetToken");
            if (token && token.trim()) return token.trim();
        }
    } catch (e) {
        console.warn("Could not extract reset token from URL:", e);
    }
    return null;
}

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Check for URL parameters (e.g. ?token=xxxx from emailed reset link)
    const resetTokenParam = getResetTokenFromUrl();

    if (resetTokenParam) {
        switchAuthMode("reset");
        const tokenInput = document.getElementById("resetTokenInput");
        if (tokenInput) tokenInput.value = resetTokenParam;
        const resetTokenGroup = document.getElementById("resetTokenGroup");
        if (resetTokenGroup) resetTokenGroup.style.display = "none";
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

    const emailInput = document.getElementById("forgotEmail");
    const email = emailInput ? emailInput.value.trim() : "";
    const submitBtn = document.getElementById("forgotSubmitBtn");

    if (!email) {
        showAuthAlert("Please enter your registered email address.", "error");
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showAuthAlert("Please enter a valid email address.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Sending Reset Link...");
    clearAuthAlert();

    try {
        const res = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            // Display clear generic confirmation message
            showAuthAlert(
                data.message || "If an account with that email exists, password reset instructions have been sent to your email. Please check your inbox and spam folder.",
                "success"
            );
            if (emailInput) emailInput.value = "";
        } else {
            showAuthAlert(data.message || "Unable to process password reset request. Please try again later.", "error");
        }
    } catch (err) {
        showAuthAlert("Network error: Could not reach authentication server. Please check your connection and try again.", "error");
    } finally {
        setBtnLoading(submitBtn, false, "Send Reset Instructions");
    }
}

/**
 * Handle Reset Password Submission
 */
async function handleResetPassword(event) {
    event.preventDefault();

    const tokenInput = document.getElementById("resetTokenInput");
    const token = (tokenInput ? tokenInput.value.trim() : "") || getResetTokenFromUrl();
    const newPasswordInput = document.getElementById("newPassword");
    const confirmNewPasswordInput = document.getElementById("confirmNewPassword");
    const password = newPasswordInput ? newPasswordInput.value : "";
    const confirmPassword = confirmNewPasswordInput ? confirmNewPasswordInput.value : "";
    const submitBtn = document.getElementById("resetSubmitBtn");

    if (!token) {
        showAuthAlert("Password reset link is invalid or missing a token. Please request a new reset link.", "error");
        return;
    }

    if (!password || !confirmPassword) {
        showAuthAlert("Please fill in both password fields.", "error");
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
            // Remove token from browser URL address bar
            if (window.history && window.history.replaceState) {
                const cleanUrl = window.location.pathname;
                window.history.replaceState({}, document.title, cleanUrl);
            }

            // Clear inputs
            if (tokenInput) tokenInput.value = "";
            if (newPasswordInput) newPasswordInput.value = "";
            if (confirmNewPasswordInput) confirmNewPasswordInput.value = "";

            // Direct user to existing login page
            switchAuthMode("login");
            showAuthAlert("Password reset successfully! Please log in with your new password.", "success");
        } else {
            // Display invalid, expired, or backend error message
            const errorMsg = data.message || "Invalid or expired password reset link. Please request a new one.";
            showAuthAlert(errorMsg, "error");
        }
    } catch (err) {
        showAuthAlert("Network error: Could not reach authentication server. Please try again.", "error");
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
        authSubtitle.textContent = "Enter your email address and we'll send a secure reset link to your inbox.";
    } else if (mode === "reset") {
        authTabs.style.display = "none";
        resetForm.style.display = "block";
        authTitle.textContent = "Create New Password";

        const tokenInput = document.getElementById("resetTokenInput");
        const resetTokenGroup = document.getElementById("resetTokenGroup");
        const hasToken = (tokenInput && tokenInput.value.trim()) || getResetTokenFromUrl();
        if (hasToken) {
            if (resetTokenGroup) resetTokenGroup.style.display = "none";
            authSubtitle.textContent = "Enter your new password below to restore access.";
        } else {
            if (resetTokenGroup) resetTokenGroup.style.display = "block";
            authSubtitle.textContent = "Enter your reset token and your new password to restore access.";
        }
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
    const route = getRouteFromLocation();
    navigateTo(route, false);
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
    refreshActiveView(currentRoute);
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
    refreshActiveView(currentRoute);
}

/**
 * Toggle Task Completion
 */
async function completeTask(id) {
    const task = tasks.find(t => t.id === id || t._id === id);
    if (!task) return;

    task.completed = !task.completed;
    saveTasksLocal();
    refreshActiveView(currentRoute);

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

    navigateTo("tasks");

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
    refreshActiveView(currentRoute);

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
 * Date calculation helper for task cards
 */
function getDueDateText(dueDate) {
    if (!dueDate) return "No date";
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

/**
 * Render markup for an individual task card
 */
function renderTaskCard(task, today) {
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
    const safeTaskId = typeof taskId === 'number' ? taskId : `'${taskId}'`;

    return `
        <div class="task ${task.completed ? "completed" : ""}">
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
                <button onclick="completeTask(${safeTaskId})">
                    ${task.completed ? "Mark Pending" : "Complete"}
                </button>
                <button onclick="editTask(${safeTaskId})">
                    Edit
                </button>
                <button onclick="deleteTask(${safeTaskId})">
                    Delete
                </button>
            </div>
        </div>
    `;
}

/**
 * Render filtered & sorted task list into a target container
 */
function renderTaskList(filter, searchInputId, sortSelectId, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const searchInput = document.getElementById(searchInputId);
    const sortSelect = document.getElementById(sortSelectId);
    const searchText = (searchInput?.value || "").toLowerCase().trim();
    const sortOption = sortSelect?.value || "default";

    const today = new Date().toISOString().split("T")[0];

    let list = tasks.filter(t => t.name.toLowerCase().includes(searchText));

    if (filter === "pending") {
        list = list.filter(t => !t.completed);
    } else if (filter === "completed") {
        list = list.filter(t => t.completed);
    } else if (filter === "overdue") {
        list = list.filter(t => !t.completed && t.dueDate < today);
    }

    if (sortOption === "priorityHigh") {
        list.sort((a, b) => b.priority - a.priority);
    } else if (sortOption === "priorityLow") {
        list.sort((a, b) => a.priority - b.priority);
    } else if (sortOption === "dueSoon") {
        list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    } else if (sortOption === "dueLate") {
        list.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    }

    if (list.length === 0) {
        let msg = "No tasks found.";
        if (filter === "pending") msg = "No pending tasks.";
        if (filter === "completed") msg = "No completed tasks.";
        if (filter === "overdue") msg = "No overdue tasks.";
        if (searchText !== "") msg = "No tasks match your search.";

        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📝</div>
                <h3>${msg}</h3>
                <p>Tasks will appear here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = list.map(t => renderTaskCard(t, today)).join("");
}

/**
 * Render recent tasks preview for Dashboard view
 */
function renderDashboardRecentTasks() {
    const container = document.getElementById("dashboardRecentList");
    if (!container) return;

    const today = new Date().toISOString().split("T")[0];

    const urgentOrRecent = [...tasks]
        .sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            return a.dueDate.localeCompare(b.dueDate);
        })
        .slice(0, 4);

    if (urgentOrRecent.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🎓</div>
                <h3>No tasks yet</h3>
                <p>Click "+ Add Task" to start organizing your academic workflow.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = urgentOrRecent.map(t => renderTaskCard(t, today)).join("");
}

/**
 * Update Dashboard summary cards and progress
 */
function updateDashboard() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const today = new Date().toISOString().split("T")[0];
    const overdue = tasks.filter(t => !t.completed && t.dueDate < today).length;

    const totalEl = document.getElementById("totalTasks");
    const completedEl = document.getElementById("completedTasks");
    const pendingEl = document.getElementById("pendingTasks");
    const overdueEl = document.getElementById("overdueTasks");

    if (totalEl) totalEl.textContent = total;
    if (completedEl) completedEl.textContent = completed;
    if (pendingEl) pendingEl.textContent = pending;
    if (overdueEl) overdueEl.textContent = overdue;

    let progress = 0;
    if (total > 0) {
        progress = Math.round((completed / total) * 100);
    }

    const progressText = document.getElementById("progressText");
    const progressFill = document.getElementById("progressFill");
    if (progressText) progressText.textContent = progress + "%";
    if (progressFill) progressFill.style.width = progress + "%";
}

/**
 * Update Statistics view figures and progress
 */
function updateStatistics() {
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const pending = tasks.filter(t => !t.completed).length;
    const today = new Date().toISOString().split("T")[0];
    const overdue = tasks.filter(t => !t.completed && t.dueDate < today).length;

    const statsTotal = document.getElementById("statsTotal");
    const statsCompleted = document.getElementById("statsCompleted");
    const statsPending = document.getElementById("statsPending");
    const statsOverdue = document.getElementById("statsOverdue");

    if (statsTotal) statsTotal.textContent = total;
    if (statsCompleted) statsCompleted.textContent = completed;
    if (statsPending) statsPending.textContent = pending;
    if (statsOverdue) statsOverdue.textContent = overdue;

    let progress = 0;
    if (total > 0) {
        progress = Math.round((completed / total) * 100);
    }

    const statsProgressText = document.getElementById("statsProgressText");
    const statsProgressFill = document.getElementById("statsProgressFill");
    if (statsProgressText) statsProgressText.textContent = progress + "%";
    if (statsProgressFill) statsProgressFill.style.width = progress + "%";
}

/**
 * Update Subject summary breakdown
 */
function updateSubjectSummary() {
    const subjectSummary = document.getElementById("subjectSummary");
    if (!subjectSummary) return;

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

/**
 * Update Category summary breakdown
 */
function updateCategorySummary() {
    const categorySummary = document.getElementById("categorySummary");
    if (!categorySummary) return;

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

/**
 * Backward compatibility alias for displayTasks
 */
function displayTasks(filter = "all") {
    refreshActiveView(currentRoute);
}

/**
 * Refresh current active view contents and statistics
 */
function refreshActiveView(route = currentRoute) {
    updateDashboard();
    updateStatistics();
    updateSubjectSummary();
    updateCategorySummary();

    if (route === "dashboard") {
        renderDashboardRecentTasks();
    } else if (route === "tasks") {
        renderTaskList("all", "searchInput", "sortSelect", "taskList");
    } else if (route === "pending") {
        renderTaskList("pending", "pendingSearchInput", "pendingSortSelect", "pendingTaskList");
    } else if (route === "completed") {
        renderTaskList("completed", "completedSearchInput", "completedSortSelect", "completedTaskList");
    } else if (route === "overdue") {
        renderTaskList("overdue", "overdueSearchInput", "overdueSortSelect", "overdueTaskList");
    }
}

/**
 * Parse current route from URL hash
 */
function getRouteFromLocation() {
    const hash = window.location.hash || "";
    const clean = hash.replace(/^#\/?/, "").toLowerCase().split("?")[0].trim();
    if (VALID_ROUTES.includes(clean)) {
        return clean;
    }
    return DEFAULT_ROUTE;
}

/**
 * Dedicated Page/View Navigator
 * Opens corresponding page at top and manages history
 */
function navigateTo(route, updateHistory = true) {
    if (!VALID_ROUTES.includes(route)) {
        route = DEFAULT_ROUTE;
    }

    currentRoute = route;

    // Close mobile drawer when view changes
    closeMobileSidebar();

    if (updateHistory) {
        if (window.location.hash !== "#/" + route) {
            window.location.hash = "#/" + route;
        }
    }

    // Ensure corresponding page opens at the top (not scrolling to section below)
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });

    // Highlight active link across desktop sidebar and mobile navigation
    setActiveButton(route);

    // Hide all view pages and show only the selected view page
    document.querySelectorAll(".view-page").forEach(page => {
        page.style.display = "none";
    });

    const activeView = document.getElementById(`view-${route}`);
    if (activeView) {
        activeView.style.display = "block";
    }

    // Update Topbar heading and subtitle
    updateTopbarForRoute(route);

    // Refresh view data
    refreshActiveView(route);
}

/**
 * Update topbar title and subtitle for current view
 */
function updateTopbarForRoute(route) {
    const titleEl = document.getElementById("topbarTitle");
    const subtitleEl = document.getElementById("topbarSubtitle");
    if (!titleEl || !subtitleEl) return;

    switch (route) {
        case "dashboard":
            titleEl.textContent = "Dashboard";
            subtitleEl.textContent = "Manage your academic tasks efficiently.";
            break;
        case "tasks":
            titleEl.textContent = "My Tasks";
            subtitleEl.textContent = "Manage and organize all your academic activities.";
            break;
        case "pending":
            titleEl.textContent = "Pending Tasks";
            subtitleEl.textContent = "Tasks and assignments waiting to be completed.";
            break;
        case "completed":
            titleEl.textContent = "Completed Tasks";
            subtitleEl.textContent = "Archive of your completed activities and achievements.";
            break;
        case "overdue":
            titleEl.textContent = "Overdue Tasks";
            subtitleEl.textContent = "Tasks that have passed their deadline.";
            break;
        case "statistics":
            titleEl.textContent = "Statistics";
            subtitleEl.textContent = "View your academic productivity summary.";
            break;
        default:
            titleEl.textContent = "Dashboard";
            subtitleEl.textContent = "Manage your academic tasks efficiently.";
    }
}

/**
 * Handle browser routing on popstate / hashchange
 */
function handleRouting() {
    if (!currentUser && !localStorage.getItem("studentflow_token")) {
        return;
    }

    const route = getRouteFromLocation();
    navigateTo(route, false);
}

window.addEventListener("hashchange", handleRouting);
window.addEventListener("popstate", handleRouting);

/**
 * Open Task Form in My Tasks view
 */
function openTaskForm() {
    if (currentRoute !== "tasks") {
        navigateTo("tasks");
    }
    const form = document.getElementById("taskForm");
    if (form) form.scrollIntoView({ behavior: "smooth" });
    const input = document.getElementById("taskInput");
    if (input) input.focus();
}

/**
 * Clear Task Creation Form
 */
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

/**
 * Clear search & sort controls for specific view
 */
function clearTaskView(viewName = currentRoute) {
    if (viewName === "tasks") {
        const s = document.getElementById("searchInput");
        const o = document.getElementById("sortSelect");
        if (s) s.value = "";
        if (o) o.value = "default";
        renderTaskList("all", "searchInput", "sortSelect", "taskList");
    } else if (viewName === "pending") {
        const s = document.getElementById("pendingSearchInput");
        const o = document.getElementById("pendingSortSelect");
        if (s) s.value = "";
        if (o) o.value = "default";
        renderTaskList("pending", "pendingSearchInput", "pendingSortSelect", "pendingTaskList");
    } else if (viewName === "completed") {
        const s = document.getElementById("completedSearchInput");
        const o = document.getElementById("completedSortSelect");
        if (s) s.value = "";
        if (o) o.value = "default";
        renderTaskList("completed", "completedSearchInput", "completedSortSelect", "completedTaskList");
    } else if (viewName === "overdue") {
        const s = document.getElementById("overdueSearchInput");
        const o = document.getElementById("overdueSortSelect");
        if (s) s.value = "";
        if (o) o.value = "default";
        renderTaskList("overdue", "overdueSearchInput", "overdueSortSelect", "overdueTaskList");
    }
}

/**
 * Set active navigation item highlight
 */
function setActiveButton(route) {
    document.querySelectorAll(".nav-item").forEach(btn => {
        const btnRoute = btn.dataset.route || btn.getAttribute("href")?.replace(/^#\/?/, "") || (btn.id === "myTasksBtn" ? "tasks" : btn.id.replace("Btn", ""));
        if (btnRoute === route) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
}

/**
 * Mobile Navigation Drawer Controls
 */
function openMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    const menuBtn = document.getElementById("mobileMenuBtn");

    if (sidebar) sidebar.classList.add("open");
    if (overlay) overlay.classList.add("active");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "true");
    document.body.classList.add("sidebar-open");
}

function closeMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    const menuBtn = document.getElementById("mobileMenuBtn");

    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    document.body.classList.remove("sidebar-open");
}

function toggleMobileSidebar() {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && sidebar.classList.contains("open")) {
        closeMobileSidebar();
    } else {
        openMobileSidebar();
    }
}

/**
 * Setup navigation click listeners for sidebar & mobile nav
 */
function setupNavigationListeners() {
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            const route = item.dataset.route || item.getAttribute("href")?.replace(/^#\/?/, "");
            if (route && VALID_ROUTES.includes(route)) {
                e.preventDefault();
                navigateTo(route, true);
            }
        });
    });

    // Close mobile drawer on Escape key
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeMobileSidebar();
        }
    });

    // Close mobile drawer if resized past 900px
    window.addEventListener("resize", () => {
        if (window.innerWidth > 900) {
            closeMobileSidebar();
        }
    });
}

/**
 * HTML Escaping utility for secure DOM injection
 */
function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
