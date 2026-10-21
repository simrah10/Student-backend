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

    // 3. Local development environment (localhost, 127.0.0.1, or file://)
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1" || window.location.protocol === "file:";
    if (isLocalHost) {
        if (window.location.port === "5000") {
            return "/api";
        }
        return "http://localhost:5000/api";
    }

    // 4. HTML meta tag configuration
    const metaTag = document.querySelector('meta[name="api-base-url"]');
    const metaUrl = metaTag ? metaTag.getAttribute("content") : null;
    if (metaUrl && metaUrl.trim()) {
        return metaUrl.trim().replace(/\/+$/, "");
    }

    // 5. Backend same-origin serving on Render
    if (window.location.origin === "https://student-backend-wdxq.onrender.com") {
        return "/api";
    }

    // 6. Default to production API
    return PRODUCTION_API_URL;
}

const API_BASE_URL = getApiBaseUrl();

/**
 * Returns currently stored JWT auth token or null
 */
function getAuthToken() {
    return localStorage.getItem("studentflow_token");
}

/**
 * Returns Authorization header with JWT token
 */
function getAuthHeaders() {
    const token = getAuthToken();
    const headers = { "Content-Type": "application/json" };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * Centralized API Request Helper
 * - Attaches base URL safely
 * - Adds Authorization and Content-Type headers
 * - Handles JSON and non-JSON responses safely
 * - Provides request timeout
 * - Automatically handles 401 unauthorized sessions
 * - Distinguishes 403 unverified accounts
 */
async function apiRequest(endpoint, options = {}) {
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = endpoint.startsWith("http://") || endpoint.startsWith("https://")
        ? endpoint
        : `${API_BASE_URL}${cleanEndpoint}`;

    const headers = { ...(options.headers || {}) };

    // Format body: auto stringify object unless it is already a string or FormData
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof FormData)) {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        body = JSON.stringify(body);
    }

    // Inject Bearer token if not explicitly skipped
    if (!options.skipAuth) {
        const token = localStorage.getItem("studentflow_token");
        if (token && !headers["Authorization"]) {
            headers["Authorization"] = `Bearer ${token}`;
        }
    }

    // 15-second request timeout controller
    const timeoutMs = options.timeout || 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            ...options,
            headers,
            body,
            signal: options.signal || controller.signal
        });
        clearTimeout(timeoutId);

        // Safe body parsing (handles empty responses and non-JSON errors gracefully)
        let data = null;
        const text = await res.text();
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = { message: text };
            }
        } else {
            data = {};
        }

        // Automatic 401 handling for protected endpoints
        const isAuthRoute = cleanEndpoint.startsWith("/auth/login") ||
                            cleanEndpoint.startsWith("/auth/register") ||
                            cleanEndpoint.startsWith("/auth/verify-email") ||
                            cleanEndpoint.startsWith("/auth/forgot-password") ||
                            cleanEndpoint.startsWith("/auth/reset-password");

        if (res.status === 401 && !isAuthRoute) {
            if (localStorage.getItem("studentflow_token")) {
                console.warn("Session expired or token invalid. Returning to login.");
                handleLogout(false);
                showAuthAlert("Your session has expired. Please log in again.", "error");
            }
        }

        return {
            ok: res.ok,
            status: res.status,
            data: data,
            error: !res.ok ? (data?.message || `Request failed with status ${res.status}`) : null
        };
    } catch (err) {
        clearTimeout(timeoutId);
        const isTimeout = err.name === "AbortError";
        const errorMsg = isTimeout
            ? "Request timed out. Please check your network connection and try again."
            : "Network error: Unable to reach the server. Please check your connection.";

        return {
            ok: false,
            status: 0,
            data: null,
            error: errorMsg,
            isNetworkError: true
        };
    }
}

// Application State
let tasks = [];
let currentUser = null;
let currentAuthMode = "login"; // "login" | "signup" | "forgot" | "reset" | "verify"
let editingTaskId = null;

// OTP Verification State
let pendingVerificationEmail = "";
let otpExpiryInterval = null;
let otpExpirySeconds = 300; // 5 minutes
let resendCooldownInterval = null;
let resendCooldownSeconds = 0;

// Routing State
const VALID_ROUTES = ["dashboard", "tasks", "pending", "completed", "overdue", "statistics", "profile"];
const DEFAULT_ROUTE = "dashboard";
let currentRoute = "dashboard";

// ============================================================
// LIGHT / DARK MODE THEME MANAGEMENT
// ============================================================

const THEME_STORAGE_KEY = "studentflow_theme";

/**
 * Retrieve current saved theme from localStorage, default to "light"
 */
function getStoredTheme() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        return (stored === "dark" || stored === "light") ? stored : "light";
    } catch (e) {
        return "light";
    }
}

/**
 * Apply selected theme across document and update switcher buttons
 */
function applyTheme(theme, save = false) {
    const validTheme = theme === "dark" ? "dark" : "light";

    // Set attributes on html document element and body
    document.documentElement.setAttribute("data-theme", validTheme);
    if (document.body) {
        document.body.setAttribute("data-theme", validTheme);
    }

    if (save) {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, validTheme);
        } catch (e) {
            console.warn("Could not save theme to localStorage:", e);
        }
    }

    syncThemeUI(validTheme);

    // If statistics charts are active, re-render them with appropriate theme colors
    const statsView = document.getElementById("view-statistics");
    const isStatsVisible = statsView && statsView.style.display !== "none";
    if (isStatsVisible && typeof updateStatistics === "function") {
        updateStatistics();
    }
}

/**
 * Sync UI indicator and buttons on Profile page
 */
function syncThemeUI(theme) {
    const current = theme || getStoredTheme();
    const lightBtn = document.getElementById("themeLightBtn");
    const darkBtn = document.getElementById("themeDarkBtn");
    const indicatorText = document.getElementById("themeIndicatorNote");

    if (lightBtn && darkBtn) {
        if (current === "dark") {
            darkBtn.classList.add("active");
            darkBtn.setAttribute("aria-checked", "true");
            lightBtn.classList.remove("active");
            lightBtn.setAttribute("aria-checked", "false");
        } else {
            lightBtn.classList.add("active");
            lightBtn.setAttribute("aria-checked", "true");
            darkBtn.classList.remove("active");
            darkBtn.setAttribute("aria-checked", "false");
        }
    }

    if (indicatorText) {
        indicatorText.textContent = current === "dark"
            ? "Currently using Dark Mode"
            : "Currently using Light Mode";
    }
}

/**
 * User-triggered theme change from Profile page
 */
function setAppTheme(theme) {
    applyTheme(theme, true);
}

/**
 * Initialize theme on page load
 */
function initAppTheme() {
    const theme = getStoredTheme();
    applyTheme(theme, false);
}

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
    // 0. Initialize visual theme and OTP input listeners immediately
    initAppTheme();
    initOtpInputListeners();

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
        const pendingEmail = (function() {
            try { return sessionStorage.getItem("studentflow_pending_verify_email") || ""; } catch (_) { return ""; }
        })();
        if (pendingEmail) {
            showAuthScreen("verify", pendingEmail);
        } else {
            showAuthScreen("login");
        }
    }

    // 3. Bind navigation buttons
    setupNavigationListeners();
});

/**
 * Verify session token against backend /api/auth/me
 */
async function verifyAndRestoreSession(token) {
    const res = await apiRequest("/auth/me");

    if (res.ok && res.data?.user) {
        currentUser = res.data.user;
        localStorage.setItem("studentflow_user", JSON.stringify(currentUser));
        showDashboardScreen();
        await loadUserTasks();
        await loadUserProfile(false);
        await loadTaskStats();
    } else if (res.status === 401) {
        // Token expired or invalid
        handleLogout(false);
    } else {
        console.warn("Could not reach auth server, checking local session cache:", res.error);
        const cachedUser = localStorage.getItem("studentflow_user");
        if (cachedUser) {
            try {
                currentUser = JSON.parse(cachedUser);
                showDashboardScreen();
                await loadUserTasks();
            } catch (_) {
                handleLogout(false);
            }
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
        const res = await apiRequest("/auth/login", {
            method: "POST",
            body: { email, password },
            skipAuth: true
        });

        const data = res.data || {};

        // 1. Unverified Email Check (HTTP 403 or requiresVerification flag)
        if (res.status === 403 || data.requiresVerification) {
            const targetEmail = data.email || email;
            pendingVerificationEmail = targetEmail;

            const noticeHtml = `
                <div class="auth-unverified-notice">
                    <span><strong>Email Not Verified:</strong> ${escapeHtml(data.message || "Please verify your email address before logging in.")}</span>
                    <button type="button" class="verify-now-btn" onclick="openVerificationScreen('${escapeHtml(targetEmail)}')">
                        Verify Email Now →
                    </button>
                </div>
            `;
            showAuthAlert(noticeHtml, "error", true);
            return;
        }

        // 2. Verified Login Success
        if (res.ok && data.success) {
            localStorage.setItem("studentflow_token", data.token);
            localStorage.setItem("studentflow_user", JSON.stringify(data.user));
            currentUser = data.user;

            showAuthAlert("Login successful! Redirecting...", "success");
            setTimeout(async () => {
                showDashboardScreen();
                await loadUserTasks();
                await loadUserProfile(false);
                await loadTaskStats();
            }, 400);
        } else {
            showAuthAlert(res.error || data.message || "Invalid email or password", "error");
        }
    } catch (err) {
        showAuthAlert(`Network error: Could not connect to authentication server`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Log In");
    }
}

/**
 * Handle Sign Up Submission (Transitions to OTP Verification)
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

    if (password.length < 8) {
        showAuthAlert("Password must be at least 8 characters long.", "error");
        return;
    }

    if (password !== confirmPassword) {
        showAuthAlert("Passwords do not match.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Creating Account...");
    clearAuthAlert();

    try {
        const res = await apiRequest("/auth/register", {
            method: "POST",
            body: { name, email, password, confirmPassword },
            skipAuth: true
        });

        const data = res.data || {};

        if (res.ok && data.success) {
            // Backend OTP Verification Flow (no JWT issued on signup alone)
            if (data.requiresVerification) {
                pendingVerificationEmail = email;
                switchAuthMode("verify", email);
                showAuthAlert(
                    data.message || "Account created! A 6-digit verification code has been sent to your email.",
                    "success"
                );
            } else if (data.token) {
                // Fallback for direct token responses
                localStorage.setItem("studentflow_token", data.token);
                localStorage.setItem("studentflow_user", JSON.stringify(data.user));
                currentUser = data.user;

                showAuthAlert("Account created successfully! Loading your dashboard...", "success");
                setTimeout(async () => {
                    showDashboardScreen();
                    await loadUserTasks();
                    await loadUserProfile(false);
                    await loadTaskStats();
                }, 400);
            }
        } else {
            showAuthAlert(res.error || data.message || "Registration failed", "error");
        }
    } catch (err) {
        showAuthAlert(`Network error: Could not reach backend server`, "error");
    } finally {
        setBtnLoading(submitBtn, false, "Create Account");
    }
}

/**
 * Handle 6-Digit Email OTP Verification
 */
async function handleVerifyEmail(event) {
    event.preventDefault();

    const otp = getOtpCode();
    const submitBtn = document.getElementById("verifyOtpSubmitBtn");

    if (!pendingVerificationEmail) {
        showAuthAlert("Email address is missing. Please return to log in or sign up.", "error");
        return;
    }

    if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
        showAuthAlert("Please enter all 6 digits of your verification code.", "error");
        for (let i = 1; i <= 6; i++) {
            const input = document.getElementById(`otpDigit${i}`);
            if (input && !input.value) {
                input.focus();
                break;
            }
        }
        return;
    }

    setBtnLoading(submitBtn, true, "Verifying...");
    clearAuthAlert();

    try {
        const res = await apiRequest("/auth/verify-email", {
            method: "POST",
            body: {
                email: pendingVerificationEmail,
                otp: otp
            },
            skipAuth: true
        });

        const data = res.data || {};

        if (res.ok && data.success) {
            // Stop timers
            if (otpExpiryInterval) {
                clearInterval(otpExpiryInterval);
                otpExpiryInterval = null;
            }
            if (resendCooldownInterval) {
                clearInterval(resendCooldownInterval);
                resendCooldownInterval = null;
            }

            try { sessionStorage.removeItem("studentflow_pending_verify_email"); } catch (_) {}

            // Save authenticated session token & user details
            localStorage.setItem("studentflow_token", data.token);
            localStorage.setItem("studentflow_user", JSON.stringify(data.user));
            currentUser = data.user;

            showAuthAlert("Email verified successfully! Loading your dashboard...", "success");

            setTimeout(async () => {
                showDashboardScreen();
                await loadUserTasks();
                await loadUserProfile(false);
                await loadTaskStats();
            }, 400);
        } else {
            showAuthAlert(res.error || data.message || "Invalid or expired verification code. Please try again.", "error");
            clearOtpInputs();
        }
    } catch (err) {
        showAuthAlert("Network error: Could not connect to verification service. Please check your connection and try again.", "error");
    } finally {
        setBtnLoading(submitBtn, false, "Verify Email");
    }
}

/**
 * Handle Resend Verification OTP
 */
async function handleResendOtp() {
    if (resendCooldownSeconds > 0) return;

    if (!pendingVerificationEmail) {
        showAuthAlert("Email address is missing. Please return to log in and sign in again.", "error");
        return;
    }

    const resendBtn = document.getElementById("resendOtpBtn");
    const originalText = resendBtn ? resendBtn.innerHTML : "Resend Code";
    if (resendBtn) {
        resendBtn.disabled = true;
        resendBtn.innerHTML = `<span>Sending code...</span>`;
    }
    clearAuthAlert();

    try {
        const res = await apiRequest("/auth/resend-verification", {
            method: "POST",
            body: { email: pendingVerificationEmail },
            skipAuth: true
        });

        const data = res.data || {};

        if (res.status === 429) {
            const waitSec = data.retryAfter || 60;
            startResendCooldown(waitSec);
            showAuthAlert(data.message || `Please wait ${waitSec} seconds before requesting another code.`, "error");
        } else if (res.ok && data.success) {
            clearOtpInputs();
            startOtpExpiryTimer(300);
            startResendCooldown(60);
            showAuthAlert(data.message || "A new 6-digit verification code has been sent to your email.", "success");
        } else {
            showAuthAlert(res.error || data.message || "Unable to resend verification code. Please try again later.", "error");
            if (resendBtn) {
                resendBtn.disabled = false;
                resendBtn.innerHTML = originalText;
            }
        }
    } catch (err) {
        showAuthAlert("Network error: Could not reach authentication server to resend code.", "error");
        if (resendBtn) {
            resendBtn.disabled = false;
            resendBtn.innerHTML = originalText;
        }
    }
}

/**
 * Open verification screen with specific prefilled email
 */
function openVerificationScreen(email) {
    clearAuthAlert();
    switchAuthMode("verify", email);
}

/**
 * Safe HTML escaping helper
 */
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * 5-Minute OTP Expiry Display Timer
 */
function startOtpExpiryTimer(seconds = 300) {
    if (otpExpiryInterval) {
        clearInterval(otpExpiryInterval);
        otpExpiryInterval = null;
    }

    otpExpirySeconds = seconds;
    updateExpiryTimerUI();

    otpExpiryInterval = setInterval(() => {
        otpExpirySeconds--;
        if (otpExpirySeconds <= 0) {
            clearInterval(otpExpiryInterval);
            otpExpiryInterval = null;
            const timerEl = document.getElementById("otpExpiryTimer");
            if (timerEl) {
                timerEl.textContent = "Code expired! Please request a new code.";
                timerEl.style.color = "#dc2626";
            }
            showAuthAlert("Your 6-digit verification code has expired. Please click 'Resend Code' to receive a new code.", "error");
        } else {
            updateExpiryTimerUI();
        }
    }, 1000);
}

function updateExpiryTimerUI() {
    const timerEl = document.getElementById("otpExpiryTimer");
    if (!timerEl) return;
    const mins = Math.floor(otpExpirySeconds / 60);
    const secs = otpExpirySeconds % 60;
    const formatted = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    timerEl.textContent = `Code expires in ${formatted}`;
    timerEl.style.color = "";
}

/**
 * 60-Second Resend Cooldown Timer
 */
function startResendCooldown(seconds = 60) {
    if (resendCooldownInterval) {
        clearInterval(resendCooldownInterval);
        resendCooldownInterval = null;
    }

    resendCooldownSeconds = seconds;
    const resendBtn = document.getElementById("resendOtpBtn");

    if (resendCooldownSeconds > 0 && resendBtn) {
        resendBtn.disabled = true;
        resendBtn.innerHTML = `<span>Resend Code (${resendCooldownSeconds}s)</span>`;
    }

    resendCooldownInterval = setInterval(() => {
        resendCooldownSeconds--;
        if (resendCooldownSeconds <= 0) {
            clearInterval(resendCooldownInterval);
            resendCooldownInterval = null;
            if (resendBtn) {
                resendBtn.disabled = false;
                resendBtn.innerHTML = `<span>Resend Code</span>`;
            }
        } else if (resendBtn) {
            resendBtn.disabled = true;
            resendBtn.innerHTML = `<span>Resend Code (${resendCooldownSeconds}s)</span>`;
        }
    }, 1000);
}

/**
 * Collect digits from OTP boxes
 */
function getOtpCode() {
    let code = "";
    for (let i = 1; i <= 6; i++) {
        const input = document.getElementById(`otpDigit${i}`);
        if (input) code += input.value.trim();
    }
    return code;
}

/**
 * Reset all 6 OTP digit inputs
 */
function clearOtpInputs() {
    for (let i = 1; i <= 6; i++) {
        const input = document.getElementById(`otpDigit${i}`);
        if (input) {
            input.value = "";
            input.classList.remove("filled");
        }
    }
    const first = document.getElementById("otpDigit1");
    if (first) {
        setTimeout(() => first.focus(), 50);
    }
}

/**
 * Bind keyboard, input, and paste listeners to the 6 OTP input boxes
 */
function initOtpInputListeners() {
    for (let i = 1; i <= 6; i++) {
        const input = document.getElementById(`otpDigit${i}`);
        if (!input) continue;

        // Strip non-digits and advance focus
        input.addEventListener("input", (e) => {
            const val = e.target.value.replace(/\D/g, "");
            e.target.value = val.slice(0, 1);

            if (e.target.value) {
                e.target.classList.add("filled");
                if (i < 6) {
                    const next = document.getElementById(`otpDigit${i + 1}`);
                    if (next) next.focus();
                }
            } else {
                e.target.classList.remove("filled");
            }
        });

        // Key navigation (backspace and arrows)
        input.addEventListener("keydown", (e) => {
            if (e.key === "Backspace") {
                if (!e.target.value && i > 1) {
                    const prev = document.getElementById(`otpDigit${i - 1}`);
                    if (prev) {
                        prev.focus();
                        prev.value = "";
                        prev.classList.remove("filled");
                    }
                } else {
                    e.target.classList.remove("filled");
                }
            } else if (e.key === "ArrowLeft" && i > 1) {
                const prev = document.getElementById(`otpDigit${i - 1}`);
                if (prev) prev.focus();
            } else if (e.key === "ArrowRight" && i < 6) {
                const next = document.getElementById(`otpDigit${i + 1}`);
                if (next) next.focus();
            }
        });

        // 6-digit paste handler
        input.addEventListener("paste", (e) => {
            e.preventDefault();
            const clipboardData = (e.clipboardData || window.clipboardData).getData("text");
            if (!clipboardData) return;

            const digits = clipboardData.replace(/\D/g, "").slice(0, 6);
            if (!digits) return;

            for (let j = 0; j < 6; j++) {
                const digitInput = document.getElementById(`otpDigit${j + 1}`);
                if (digitInput) {
                    if (j < digits.length) {
                        digitInput.value = digits[j];
                        digitInput.classList.add("filled");
                    } else {
                        digitInput.value = "";
                        digitInput.classList.remove("filled");
                    }
                }
            }

            const focusIndex = Math.min(digits.length + 1, 6);
            const focusTarget = document.getElementById(`otpDigit${focusIndex}`);
            if (focusTarget) focusTarget.focus();
        });
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
        const res = await apiRequest("/auth/forgot-password", {
            method: "POST",
            body: { email },
            skipAuth: true
        });

        const data = res.data || {};

        if (res.ok && data.success) {
            // Display clear generic confirmation message
            showAuthAlert(
                data.message || "If an account with that email exists, password reset instructions have been sent to your email. Please check your inbox and spam folder.",
                "success"
            );
            if (emailInput) emailInput.value = "";
        } else {
            showAuthAlert(res.error || data.message || "Unable to process password reset request. Please try again later.", "error");
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

    if (password.length < 8) {
        showAuthAlert("New password must be at least 8 characters long.", "error");
        return;
    }

    if (password !== confirmPassword) {
        showAuthAlert("Passwords do not match.", "error");
        return;
    }

    setBtnLoading(submitBtn, true, "Setting New Password...");
    clearAuthAlert();

    try {
        const res = await apiRequest("/auth/reset-password", {
            method: "POST",
            body: { token, password, confirmPassword },
            skipAuth: true
        });

        const data = res.data || {};

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
            const errorMsg = res.error || data.message || "Invalid or expired password reset link. Please request a new one.";
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
            await apiRequest("/auth/logout", {
                method: "POST"
            });
        } catch {
            // Ignore offline logout error
        }
    }

    // Invalidate local session & clear memory
    localStorage.removeItem("studentflow_token");
    localStorage.removeItem("studentflow_user");
    try { sessionStorage.removeItem("studentflow_pending_verify_email"); } catch (_) {}
    pendingVerificationEmail = "";
    currentUser = null;
    tasks = [];

    // Stop active timers
    if (otpExpiryInterval) {
        clearInterval(otpExpiryInterval);
        otpExpiryInterval = null;
    }
    if (resendCooldownInterval) {
        clearInterval(resendCooldownInterval);
        resendCooldownInterval = null;
    }

    // Destroy chart instances
    destroyStatisticsCharts();

    // Reset task form & search inputs
    clearForm();
    clearTaskView();

    showAuthScreen("login");
}

// ============================================================
// UI NAVIGATION & FORM VIEW SWITCHING
// ============================================================

function switchAuthMode(mode, email = "") {
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
    const verifyEmailForm = document.getElementById("verifyEmailForm");

    const authTitle = document.getElementById("authTitle");
    const authSubtitle = document.getElementById("authSubtitle");

    // Hide all forms
    if (loginForm) loginForm.style.display = "none";
    if (signupForm) signupForm.style.display = "none";
    if (forgotForm) forgotForm.style.display = "none";
    if (resetForm) resetForm.style.display = "none";
    if (verifyEmailForm) verifyEmailForm.style.display = "none";

    // Clean up OTP timers if switching away from verification view
    if (mode !== "verify") {
        if (otpExpiryInterval) {
            clearInterval(otpExpiryInterval);
            otpExpiryInterval = null;
        }
        if (resendCooldownInterval) {
            clearInterval(resendCooldownInterval);
            resendCooldownInterval = null;
        }
        if (mode === "login" || mode === "signup") {
            try { sessionStorage.removeItem("studentflow_pending_verify_email"); } catch (_) {}
            pendingVerificationEmail = "";
        }
    }

    if (mode === "login") {
        if (authTabs) authTabs.style.display = "flex";
        if (loginTabBtn) loginTabBtn.classList.add("active");
        if (signupTabBtn) signupTabBtn.classList.remove("active");
        if (loginForm) loginForm.style.display = "block";
        if (authTitle) authTitle.textContent = "Welcome to StudentFlow";
        if (authSubtitle) authSubtitle.textContent = "Sign in to manage your tasks, schedules, and academic progress.";
    } else if (mode === "signup") {
        if (authTabs) authTabs.style.display = "flex";
        if (loginTabBtn) loginTabBtn.classList.remove("active");
        if (signupTabBtn) signupTabBtn.classList.add("active");
        if (signupForm) signupForm.style.display = "block";
        if (authTitle) authTitle.textContent = "Create an Account";
        if (authSubtitle) authSubtitle.textContent = "Join StudentFlow to start organizing your academic workflow.";
    } else if (mode === "forgot") {
        if (authTabs) authTabs.style.display = "none";
        if (forgotForm) forgotForm.style.display = "block";
        if (authTitle) authTitle.textContent = "Reset Password";
        if (authSubtitle) authSubtitle.textContent = "Enter your email address and we'll send a secure reset link to your inbox.";
    } else if (mode === "reset") {
        if (authTabs) authTabs.style.display = "none";
        if (resetForm) resetForm.style.display = "block";
        if (authTitle) authTitle.textContent = "Create New Password";

        const tokenInput = document.getElementById("resetTokenInput");
        const resetTokenGroup = document.getElementById("resetTokenGroup");
        const hasToken = (tokenInput && tokenInput.value.trim()) || getResetTokenFromUrl();
        if (hasToken) {
            if (resetTokenGroup) resetTokenGroup.style.display = "none";
            if (authSubtitle) authSubtitle.textContent = "Enter your new password below to restore access.";
        } else {
            if (resetTokenGroup) resetTokenGroup.style.display = "block";
            if (authSubtitle) authSubtitle.textContent = "Enter your reset token and your new password to restore access.";
        }
    } else if (mode === "verify") {
        if (authTabs) authTabs.style.display = "none";
        if (verifyEmailForm) verifyEmailForm.style.display = "block";
        if (authTitle) authTitle.textContent = "Verify Your Email";
        if (authSubtitle) authSubtitle.textContent = "Enter the 6-digit verification code sent to your email to activate your account.";

        const targetEmail = email || pendingVerificationEmail || (function() {
            try { return sessionStorage.getItem("studentflow_pending_verify_email") || ""; } catch (_) { return ""; }
        })();

        if (targetEmail) {
            pendingVerificationEmail = targetEmail;
            try { sessionStorage.setItem("studentflow_pending_verify_email", targetEmail); } catch (_) {}
            const emailEl = document.getElementById("verifyTargetEmail");
            if (emailEl) emailEl.textContent = targetEmail;
        }

        clearOtpInputs();

        if (!otpExpiryInterval) {
            startOtpExpiryTimer(300);
        }
        if (resendCooldownSeconds <= 0) {
            startResendCooldown(60);
        }
    }
}

function showAuthScreen(defaultMode = "login", email = "") {
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("mainApp").style.display = "none";
    switchAuthMode(defaultMode, email);
}

function showDashboardScreen() {
    if (!currentUser) {
        const cached = localStorage.getItem("studentflow_user");
        if (cached) {
            try { currentUser = JSON.parse(cached); } catch (_) {}
        }
    }
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

function showAuthAlert(message, type = "error", isHtml = false) {
    const alertBox = document.getElementById("authAlert");
    if (!alertBox) return;
    if (isHtml) {
        alertBox.innerHTML = message;
    } else {
        alertBox.textContent = message;
    }
    alertBox.className = `auth-alert ${type}`;
    alertBox.style.display = "block";
}

function clearAuthAlert() {
    const alertBox = document.getElementById("authAlert");
    if (!alertBox) return;
    alertBox.style.display = "none";
    alertBox.textContent = "";
}

function updateUserProfileUI() {
    if (!currentUser) return;

    const name = currentUser.name || "Student";
    const email = currentUser.email || "";
    const initial = (name[0] || "S").toUpperCase();
    const avatar = currentUser.avatar || "";

    // Sidebar Profile
    const sidebarName = document.getElementById("sidebarUserName");
    const sidebarEmail = document.getElementById("sidebarUserEmail");
    const sidebarInitials = document.getElementById("sidebarUserInitials");

    if (sidebarName) sidebarName.textContent = name;
    if (sidebarEmail) sidebarEmail.textContent = email;
    if (sidebarInitials) {
        if (avatar) {
            sidebarInitials.innerHTML = `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" class="user-avatar-badge-img">`;
        } else {
            sidebarInitials.textContent = initial;
        }
    }

    // Topbar Profile
    const topbarName = document.getElementById("topbarUserName");
    const topbarInitials = document.getElementById("topbarUserInitials");

    if (topbarName) topbarName.textContent = name;
    if (topbarInitials) {
        if (avatar) {
            topbarInitials.innerHTML = `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" class="user-avatar-badge-img">`;
        } else {
            topbarInitials.textContent = initial;
        }
    }

    // Populate profile view fields if elements exist
    populateProfileFields(currentUser);
}

// ============================================================
// TASK DATA & CRUD WITH REST BACKEND (USER ISOLATION)
// ============================================================

/**
 * Load tasks for the current user from backend
 */
async function loadUserTasks() {
    const listContainers = ["taskList", "pendingTaskList", "completedTaskList", "overdueTaskList", "dashboardRecentList"];
    if (tasks.length === 0) {
        listContainers.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = `
                    <div class="empty-state" style="padding: 28px; text-align: center;">
                        <div class="empty-icon">⏳</div>
                        <h3>Loading tasks...</h3>
                        <p>Connecting to your personal task database.</p>
                    </div>
                `;
            }
        });
    }

    try {
        const res = await apiRequest("/tasks");

        if (res.ok && res.data && Array.isArray(res.data.data)) {
            tasks = res.data.data;
            saveTasksLocal();
        } else if (res.status !== 401) {
            // Fallback to local storage cache for this user if network issue
            const cached = localStorage.getItem(`tasks_${currentUser?.id || "guest"}`);
            tasks = cached ? JSON.parse(cached) : [];
        }
    } catch (err) {
        console.warn("Could not load tasks from API, using cached data:", err.message);
        const cached = localStorage.getItem(`tasks_${currentUser?.id || "guest"}`);
        tasks = cached ? JSON.parse(cached) : [];
    }

    refreshActiveView(currentRoute);
    await loadTaskStats();
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
    const saveBtn = document.getElementById("saveTaskBtn");

    if (taskName === "" || subject === "" || dueDate === "") {
        alert("Please fill in the required fields: Task Name, Subject, and Due Date.");
        return;
    }

    if (saveBtn && saveBtn.disabled) return;
    setBtnLoading(saveBtn, true, editingTaskId ? "Updating..." : "Saving...");

    const taskPayload = {
        name: taskName,
        subject: subject,
        category: category,
        priority: priority,
        dueDate: dueDate,
        completed: false
    };

    try {
        if (editingTaskId) {
            // UPDATE Existing Task
            const res = await apiRequest(`/tasks/${editingTaskId}`, {
                method: "PUT",
                body: taskPayload
            });

            if (res.ok && res.data && res.data.data) {
                const index = tasks.findIndex(t => t.id === editingTaskId || t._id === editingTaskId);
                if (index !== -1) tasks[index] = res.data.data;
                saveTasksLocal();
                editingTaskId = null;
                document.getElementById("formHeading").textContent = "Add New Task";
                document.getElementById("saveTaskBtn").textContent = "Add Task";
                clearForm();
                refreshActiveView(currentRoute);
                await loadTaskStats();
            } else {
                alert(res.error || "Failed to update task. Please check your inputs and try again.");
            }
        } else {
            // CREATE New Task
            const res = await apiRequest("/tasks", {
                method: "POST",
                body: taskPayload
            });

            if (res.ok && res.data && res.data.data) {
                tasks.unshift(res.data.data);
                saveTasksLocal();
                clearForm();
                refreshActiveView(currentRoute);
                await loadTaskStats();
            } else {
                alert(res.error || "Failed to create task on the server. Please try again.");
            }
        }
    } catch (err) {
        alert("Network error: Could not reach the task service. Please check your connection.");
    } finally {
        setBtnLoading(saveBtn, false, editingTaskId ? "Update Task" : "Add Task");
    }
}

/**
 * Toggle Task Completion
 */
async function completeTask(id) {
    const task = tasks.find(t => t.id === id || t._id === id);
    if (!task) return;

    // Optimistically toggle
    const previousCompleted = task.completed;
    task.completed = !previousCompleted;
    saveTasksLocal();
    refreshActiveView(currentRoute);

    try {
        const res = await apiRequest(`/tasks/${id}/complete`, {
            method: "PATCH"
        });

        if (res.ok && res.data && res.data.data) {
            task.completed = res.data.data.completed;
            saveTasksLocal();
            await loadTaskStats();
        } else {
            // Rollback on server rejection
            task.completed = previousCompleted;
            saveTasksLocal();
            refreshActiveView(currentRoute);
            alert(res.error || "Could not update task status on the server.");
        }
    } catch (err) {
        // Rollback on network failure
        task.completed = previousCompleted;
        saveTasksLocal();
        refreshActiveView(currentRoute);
        alert("Network error: Could not sync task status with server.");
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

    const previousTasks = [...tasks];
    tasks = tasks.filter(t => t.id !== id && t._id !== id);
    saveTasksLocal();
    refreshActiveView(currentRoute);

    try {
        const res = await apiRequest(`/tasks/${id}`, {
            method: "DELETE"
        });

        if (res.ok) {
            await loadTaskStats();
        } else {
            // Rollback on failure
            tasks = previousTasks;
            saveTasksLocal();
            refreshActiveView(currentRoute);
            alert(res.error || "Failed to delete task from server.");
        }
    } catch (err) {
        tasks = previousTasks;
        saveTasksLocal();
        refreshActiveView(currentRoute);
        alert("Network error: Could not reach server to delete task.");
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
    if (String(task.priority) === "2") priorityText = "Medium";
    if (String(task.priority) === "3") priorityText = "High";

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

    let list = tasks.filter(t => (t.name || t.title || "").toLowerCase().includes(searchText));

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

let statusDoughnutChartInstance = null;
let statusBarChartInstance = null;

function destroyStatisticsCharts() {
    if (statusDoughnutChartInstance) {
        statusDoughnutChartInstance.destroy();
        statusDoughnutChartInstance = null;
    }
    if (statusBarChartInstance) {
        statusBarChartInstance.destroy();
        statusBarChartInstance = null;
    }
}

let latestServerStats = null;

/**
 * Fetch Authoritative Task Statistics from Backend GET /api/tasks/stats
 */
async function loadTaskStats() {
    const today = new Date().toISOString().split("T")[0];
    try {
        const res = await apiRequest(`/tasks/stats?today=${today}`);
        if (res.ok && res.data && (res.data.data || res.data.stats)) {
            const stats = res.data.data || res.data.stats;
            latestServerStats = stats;
            updateStatistics(stats);
            return stats;
        }
    } catch (err) {
        console.warn("Could not fetch server task stats:", err.message);
    }
    updateStatistics(null);
    return null;
}

/**
 * Update Statistics view figures, progress bar, and charts
 */
function updateStatistics(serverStats = latestServerStats) {
    const today = new Date().toISOString().split("T")[0];

    let total = 0;
    let completed = 0;
    let pending = 0;
    let overdue = 0;
    let progress = 0;

    if (serverStats && typeof serverStats.total === "number") {
        total = serverStats.total;
        completed = serverStats.completed || 0;
        pending = serverStats.pending || 0;
        overdue = serverStats.overdue || 0;
        progress = typeof serverStats.completionRate === "number"
            ? serverStats.completionRate
            : (total > 0 ? Math.round((completed / total) * 100) : 0);
    } else {
        total = tasks.length;
        completed = tasks.filter(t => t.completed).length;
        overdue = tasks.filter(t => !t.completed && t.dueDate && t.dueDate < today).length;
        pending = tasks.filter(t => !t.completed && (!t.dueDate || t.dueDate >= today)).length;
        if (total > 0) {
            progress = Math.round((completed / total) * 100);
        }
    }

    // Dashboard Cards Sync
    const totalEl = document.getElementById("totalTasks");
    const completedEl = document.getElementById("completedTasks");
    const pendingEl = document.getElementById("pendingTasks");
    const overdueEl = document.getElementById("overdueTasks");

    if (totalEl) totalEl.textContent = total;
    if (completedEl) completedEl.textContent = completed;
    if (pendingEl) pendingEl.textContent = pending;
    if (overdueEl) overdueEl.textContent = overdue;

    const progressText = document.getElementById("progressText");
    const progressFill = document.getElementById("progressFill");
    if (progressText) progressText.textContent = progress + "%";
    if (progressFill) progressFill.style.width = progress + "%";

    // Overall Progress Bar in Statistics
    const statsProgressText = document.getElementById("statsProgressText");
    const statsProgressFill = document.getElementById("statsProgressFill");
    if (statsProgressText) statsProgressText.textContent = progress + "%";
    if (statsProgressFill) statsProgressFill.style.width = progress + "%";

    // Chart Badges
    const chartTotalBadge = document.getElementById("chartTotalBadge");
    const chartRateBadge = document.getElementById("chartRateBadge");
    if (chartTotalBadge) chartTotalBadge.textContent = `${total} Task${total === 1 ? "" : "s"}`;
    if (chartRateBadge) chartRateBadge.textContent = `${progress}% Completed`;

    // Legend Counts and Percentages
    const completedPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const pendingPct = total > 0 ? Math.round((pending / total) * 100) : 0;
    const overduePct = total > 0 ? Math.round((overdue / total) * 100) : 0;

    const legendCompleted = document.getElementById("legendCompletedCount");
    const legendPending = document.getElementById("legendPendingCount");
    const legendOverdue = document.getElementById("legendOverdueCount");

    if (legendCompleted) legendCompleted.textContent = `${completed} (${completedPct}%)`;
    if (legendPending) legendPending.textContent = `${pending} (${pendingPct}%)`;
    if (legendOverdue) legendOverdue.textContent = `${overdue} (${overduePct}%)`;

    // Empty state vs Charts visibility
    const chartsGrid = document.getElementById("chartsGrid");
    const chartsEmptyState = document.getElementById("chartsEmptyState");
    const statsView = document.getElementById("view-statistics");
    const isStatsVisible = statsView && statsView.style.display !== "none";

    if (total === 0) {
        if (chartsGrid) chartsGrid.style.display = "none";
        if (chartsEmptyState) chartsEmptyState.style.display = "block";
        destroyStatisticsCharts();
        return;
    }

    if (chartsEmptyState) chartsEmptyState.style.display = "none";
    if (chartsGrid) {
        chartsGrid.style.display = isStatsVisible ? "grid" : "";
    }

    if (isStatsVisible) {
        renderStatisticsCharts(total, completed, pending, overdue);
    }
}

/**
 * Render Doughnut and Bar charts with Chart.js (with SVG fallback)
 */
function renderStatisticsCharts(total, completed, pending, overdue) {
    if (typeof Chart === "undefined") {
        renderFallbackSvgCharts(total, completed, pending, overdue);
        return;
    }

    destroyStatisticsCharts();

    // Theme-Aware Chart Styling
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const doughnutBorderColor = isDark ? "#172338" : "#ffffff";
    const totalBarBg = isDark ? "#A5B4FC" : "#18202f";
    const tooltipBg = isDark ? "#111C30" : "#18202f";
    const yTickColor = isDark ? "#A7B4C8" : "#7a8392";
    const xTickColor = isDark ? "#F1F5F9" : "#475569";
    const gridLineColor = isDark ? "#30415B" : "#f1f3f7";

    // 1. Doughnut Chart: Task Status Distribution
    const doughnutCanvas = document.getElementById("statusDoughnutChart");
    if (doughnutCanvas) {
        const ctx = doughnutCanvas.getContext("2d");
        statusDoughnutChartInstance = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: ["Completed", "Pending", "Overdue"],
                datasets: [{
                    data: [completed, pending, overdue],
                    backgroundColor: [
                        "#10b981", // Green
                        "#3b82f6", // Blue
                        "#ef4444"  // Red
                    ],
                    borderColor: doughnutBorderColor,
                    borderWidth: 2,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleFont: { size: 13, family: "Inter, -apple-system, sans-serif" },
                        bodyFont: { size: 12, family: "Inter, -apple-system, sans-serif" },
                        padding: 10,
                        cornerRadius: 8,
                        callbacks: {
                            label: function(context) {
                                const val = context.raw || 0;
                                const pct = total > 0 ? Math.round((val / total) * 100) : 0;
                                return ` ${context.label}: ${val} (${pct}%)`;
                            }
                        }
                    }
                },
                cutout: "66%"
            }
        });
    }

    // 2. Bar Chart: Task Status Breakdown
    const barCanvas = document.getElementById("statusBarChart");
    if (barCanvas) {
        const ctx = barCanvas.getContext("2d");
        statusBarChartInstance = new Chart(ctx, {
            type: "bar",
            data: {
                labels: ["Total Tasks", "Completed", "Pending", "Overdue"],
                datasets: [{
                    label: "Count",
                    data: [total, completed, pending, overdue],
                    backgroundColor: [
                        totalBarBg, // Brand Navy in Light Mode, Accent in Dark Mode
                        "#10b981",  // Green
                        "#3b82f6",  // Blue
                        "#ef4444"   // Red
                    ],
                    borderRadius: 6,
                    borderSkipped: false,
                    maxBarThickness: 44
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleFont: { size: 13, family: "Inter, -apple-system, sans-serif" },
                        bodyFont: { size: 12, family: "Inter, -apple-system, sans-serif" },
                        padding: 10,
                        cornerRadius: 8,
                        callbacks: {
                            label: function(context) {
                                return ` ${context.label}: ${context.raw} task(s)`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1,
                            precision: 0,
                            color: yTickColor,
                            font: { size: 11, family: "Inter, -apple-system, sans-serif" }
                        },
                        grid: {
                            color: gridLineColor
                        }
                    },
                    x: {
                        ticks: {
                            color: xTickColor,
                            font: { size: 12, family: "Inter, -apple-system, sans-serif", weight: 500 }
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });
    }
}

/**
 * Fallback SVG renderer if Chart.js is not loaded
 */
function renderFallbackSvgCharts(total, completed, pending, overdue) {
    const doughnutCanvas = document.getElementById("statusDoughnutChart");
    if (doughnutCanvas && doughnutCanvas.parentElement) {
        const cPct = total > 0 ? (completed / total) * 100 : 0;
        const pPct = total > 0 ? (pending / total) * 100 : 0;
        const oPct = total > 0 ? (overdue / total) * 100 : 0;
        doughnutCanvas.parentElement.innerHTML = `
            <svg viewBox="0 0 36 36" style="width: 100%; height: 100%; max-height: 220px; display: block; margin: auto;">
                <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#f1f3f7" stroke-width="4"></circle>
                <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#10b981" stroke-width="4" stroke-dasharray="${cPct} ${100 - cPct}" stroke-dashoffset="25"></circle>
                <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#3b82f6" stroke-width="4" stroke-dasharray="${pPct} ${100 - pPct}" stroke-dashoffset="${25 - cPct}"></circle>
                <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#ef4444" stroke-width="4" stroke-dasharray="${oPct} ${100 - oPct}" stroke-dashoffset="${25 - cPct - pPct}"></circle>
                <text x="18" y="20.5" font-size="5" text-anchor="middle" font-weight="bold" fill="#18202f">${total}</text>
            </svg>
        `;
    }
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
        if (getAuthToken()) {
            loadTaskStats();
        }
    } else if (route === "statistics") {
        if (getAuthToken()) {
            loadTaskStats();
        }
    } else if (route === "tasks") {
        renderTaskList("all", "searchInput", "sortSelect", "taskList");
    } else if (route === "pending") {
        renderTaskList("pending", "pendingSearchInput", "pendingSortSelect", "pendingTaskList");
    } else if (route === "completed") {
        renderTaskList("completed", "completedSearchInput", "completedSortSelect", "completedTaskList");
    } else if (route === "overdue") {
        renderTaskList("overdue", "overdueSearchInput", "overdueSortSelect", "overdueTaskList");
    } else if (route === "profile") {
        loadUserProfile();
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
        case "profile":
            titleEl.textContent = "User Profile";
            subtitleEl.textContent = "View and manage your personal and academic information.";
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

// ============================================================
// USER PROFILE MANAGEMENT
// ============================================================

let pendingProfileAvatar = null;
let isProfileEditing = false;

/**
 * Populate all profile fields from a user object
 */
function populateProfileFields(user) {
    if (!user) {
        if (!currentUser) {
            const cached = localStorage.getItem("studentflow_user");
            if (cached) {
                try { currentUser = JSON.parse(cached); } catch (_) {}
            }
        }
        user = currentUser;
    }
    if (!user) return;

    const name = user.name || "Student";
    const email = user.email || "";
    const initial = (name[0] || "S").toUpperCase();
    const avatar = pendingProfileAvatar !== null ? pendingProfileAvatar : (user.avatar || "");

    // Header Display
    const nameEl = document.getElementById("profileDisplayName");
    const emailEl = document.getElementById("profileDisplayEmail");
    const subEl = document.getElementById("profileDisplaySub");
    const initialsEl = document.getElementById("profileAvatarInitials");
    const imgEl = document.getElementById("profileAvatarImg");
    const removeBtn = document.getElementById("avatarRemoveBtn");

    if (nameEl) nameEl.textContent = name;
    if (emailEl) emailEl.textContent = email;
    if (subEl) {
        if (user.degree && user.institution) {
            subEl.textContent = `${user.degree} • ${user.institution}`;
        } else if (user.institution) {
            subEl.textContent = user.institution;
        } else if (user.degree) {
            subEl.textContent = user.degree;
        } else {
            subEl.textContent = "StudentFlow Productivity Account";
        }
    }

    if (initialsEl && imgEl) {
        if (avatar) {
            imgEl.src = avatar;
            imgEl.style.display = "block";
            initialsEl.style.display = "none";
        } else {
            imgEl.src = "";
            imgEl.style.display = "none";
            initialsEl.textContent = initial;
            initialsEl.style.display = "flex";
        }
    }

    if (removeBtn) {
        removeBtn.style.display = (isProfileEditing && avatar) ? "inline-flex" : "none";
    }

    // Form inputs (only fill if not currently dirty / typing in edit mode)
    const nameInput = document.getElementById("profileNameInput");
    const emailInput = document.getElementById("profileEmailInput");
    const genderInput = document.getElementById("profileGenderInput");
    const dobInput = document.getElementById("profileDobInput");
    const phoneInput = document.getElementById("profilePhoneInput");
    const instInput = document.getElementById("profileInstitutionInput");
    const degreeInput = document.getElementById("profileDegreeInput");
    const deptInput = document.getElementById("profileDepartmentInput");
    const yearInput = document.getElementById("profileYearInput");
    const semInput = document.getElementById("profileSemesterInput");
    const studentIdInput = document.getElementById("profileStudentIdInput");
    const gradYearInput = document.getElementById("profileGraduationYearInput");

    if (nameInput) nameInput.value = user.name || "";
    if (emailInput) {
        emailInput.value = user.email || "";
        emailInput.disabled = true;
    }
    if (genderInput) genderInput.value = user.gender || "";
    if (dobInput) dobInput.value = user.dateOfBirth || "";
    if (phoneInput) phoneInput.value = user.phone || "";
    if (instInput) instInput.value = user.institution || "";
    if (degreeInput) degreeInput.value = user.degree || "";
    if (deptInput) deptInput.value = user.department || "";
    if (yearInput) yearInput.value = user.yearOfStudy || "";
    if (semInput) semInput.value = user.semester || "";
    if (studentIdInput) studentIdInput.value = user.studentId || "";
    if (gradYearInput) gradYearInput.value = user.graduationYear || "";
}

/**
 * Load fresh user profile from backend GET /api/auth/profile
 */
async function loadUserProfile(forceFetch = true) {
    // Sync theme buttons and indicators on Profile view
    syncThemeUI(getStoredTheme());

    const token = localStorage.getItem("studentflow_token");
    if (!token) return;

    // First populate from in-memory currentUser if available
    if (currentUser) {
        populateProfileFields(currentUser);
    }

    if (!forceFetch) return;

    try {
        let res = await apiRequest("/auth/profile", { method: "GET" });

        // Fallback to /api/auth/me if backend does not yet have /api/auth/profile
        if (res.status === 404) {
            res = await apiRequest("/auth/me", { method: "GET" });
        }

        if (res.ok && res.data && res.data.user) {
            currentUser = res.data.user;
            localStorage.setItem("studentflow_user", JSON.stringify(currentUser));
            updateUserProfileUI();
            populateProfileFields(currentUser);
        } else if (res.status !== 401) {
            console.warn("Failed to fetch profile from server:", res.status, res.error);
        }
    } catch (err) {
        console.warn("Could not reach profile API, using cached data:", err.message);
    }
}

/**
 * Toggle Edit Mode on Profile
 */
function toggleProfileEditMode(isEditing) {
    isProfileEditing = isEditing;

    const editableFieldIds = [
        "profileNameInput",
        "profileGenderInput",
        "profileDobInput",
        "profilePhoneInput",
        "profileInstitutionInput",
        "profileDegreeInput",
        "profileDepartmentInput",
        "profileYearInput",
        "profileSemesterInput",
        "profileStudentIdInput",
        "profileGraduationYearInput"
    ];

    editableFieldIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !isEditing;
    });

    // profileEmailInput always remains disabled (read-only for security)
    const emailInput = document.getElementById("profileEmailInput");
    if (emailInput) emailInput.disabled = true;

    const editToggleBtn = document.getElementById("profileEditToggleBtn");
    const actionsContainer = document.getElementById("profileFormActions");
    const avatarUploadBtn = document.getElementById("avatarUploadBtn");
    const avatarRemoveBtn = document.getElementById("avatarRemoveBtn");

    if (editToggleBtn) editToggleBtn.style.display = isEditing ? "none" : "inline-flex";
    if (actionsContainer) actionsContainer.style.display = isEditing ? "flex" : "none";

    const hasAvatar = pendingProfileAvatar !== null ? Boolean(pendingProfileAvatar) : Boolean(currentUser?.avatar);
    if (avatarRemoveBtn) {
        avatarRemoveBtn.style.display = isEditing && hasAvatar ? "inline-flex" : "none";
    }
    if (avatarUploadBtn) {
        avatarUploadBtn.style.display = isEditing ? "inline-flex" : "none";
    }

    if (isEditing) {
        const nameInput = document.getElementById("profileNameInput");
        if (nameInput) nameInput.focus();
    }
}

/**
 * Cancel profile editing and restore saved values
 */
function cancelProfileEdit() {
    pendingProfileAvatar = null;
    hideProfileAlert();
    if (!currentUser) {
        const cached = localStorage.getItem("studentflow_user");
        if (cached) {
            try { currentUser = JSON.parse(cached); } catch (_) {}
        }
    }
    populateProfileFields(currentUser);
    toggleProfileEditMode(false);
}

/**
 * Handle avatar image file selection with validation and canvas compression
 */
function handleAvatarFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    // Validate mime type
    if (!file.type.startsWith("image/")) {
        showProfileAlert("Please select a valid image file (PNG, JPG, WebP, etc.).", "error");
        return;
    }

    // Validate size (max 5MB initial file)
    if (file.size > 5 * 1024 * 1024) {
        showProfileAlert("Avatar image is too large. Please select an image under 5MB.", "error");
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const rawDataUrl = e.target.result;
        // Compress and resize image using HTML5 Canvas to max 320x320 for optimal performance
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            const maxDim = 320;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxDim) {
                    height = Math.round((height * maxDim) / width);
                    width = maxDim;
                }
            } else {
                if (height > maxDim) {
                    width = Math.round((width * maxDim) / height);
                    height = maxDim;
                }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.85);
            pendingProfileAvatar = compressedDataUrl;

            // Update preview
            const previewImg = document.getElementById("profileAvatarImg");
            const initialsEl = document.getElementById("profileAvatarInitials");
            const removeBtn = document.getElementById("avatarRemoveBtn");

            if (previewImg && initialsEl) {
                previewImg.src = compressedDataUrl;
                previewImg.style.display = "block";
                initialsEl.style.display = "none";
            }
            if (removeBtn) removeBtn.style.display = "inline-flex";

            // If not currently in edit mode, switch to edit mode so user can save
            if (!isProfileEditing) {
                toggleProfileEditMode(true);
            }
            hideProfileAlert();
        };
        img.onerror = () => {
            showProfileAlert("Failed to load image. Please try a different photo.", "error");
        };
        img.src = rawDataUrl;
    };
    reader.onerror = () => {
        showProfileAlert("Error reading image file.", "error");
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected if needed
    event.target.value = "";
}

/**
 * Remove avatar photo
 */
function removeAvatarPhoto() {
    pendingProfileAvatar = "";

    const previewImg = document.getElementById("profileAvatarImg");
    const initialsEl = document.getElementById("profileAvatarInitials");
    const removeBtn = document.getElementById("avatarRemoveBtn");

    if (previewImg && initialsEl) {
        previewImg.src = "";
        previewImg.style.display = "none";
        const name = (document.getElementById("profileNameInput")?.value || currentUser?.name || "S").trim();
        initialsEl.textContent = (name[0] || "S").toUpperCase();
        initialsEl.style.display = "flex";
    }

    if (removeBtn) removeBtn.style.display = "none";

    if (!isProfileEditing) {
        toggleProfileEditMode(true);
    }
}

/**
 * Handle Profile Form Submission (Save Changes)
 */
async function handleProfileSubmit(event) {
    event.preventDefault();
    hideProfileAlert();

    const nameInput = document.getElementById("profileNameInput");
    const nameVal = nameInput ? nameInput.value.trim() : "";

    if (!nameVal) {
        showProfileAlert("Full name is required.", "error");
        if (nameInput) nameInput.focus();
        return;
    }

    const saveBtn = document.getElementById("profileSaveBtn");
    setBtnLoading(saveBtn, true, "Saving...");

    const payload = {
        name: nameVal,
        gender: document.getElementById("profileGenderInput")?.value || "",
        dateOfBirth: document.getElementById("profileDobInput")?.value || "",
        phone: document.getElementById("profilePhoneInput")?.value.trim() || "",
        institution: document.getElementById("profileInstitutionInput")?.value.trim() || "",
        degree: document.getElementById("profileDegreeInput")?.value.trim() || "",
        department: document.getElementById("profileDepartmentInput")?.value.trim() || "",
        yearOfStudy: document.getElementById("profileYearInput")?.value || "",
        semester: document.getElementById("profileSemesterInput")?.value || "",
        studentId: document.getElementById("profileStudentIdInput")?.value.trim() || "",
        graduationYear: document.getElementById("profileGraduationYearInput")?.value.trim() || ""
    };

    if (pendingProfileAvatar !== null) {
        payload.avatar = pendingProfileAvatar;
    }

    try {
        const res = await apiRequest("/auth/profile", {
            method: "PUT",
            body: payload
        });

        if (res.ok && res.data && res.data.success) {
            currentUser = res.data.user;
            localStorage.setItem("studentflow_user", JSON.stringify(currentUser));
            pendingProfileAvatar = null;

            updateUserProfileUI();
            populateProfileFields(currentUser);
            toggleProfileEditMode(false);
            showProfileAlert("✓ Profile updated successfully! All changes have been saved to your account.", "success");
        } else {
            const errorMsg = res.data?.message || res.error ||
                (res.status === 404
                    ? "Backend endpoint PUT /api/auth/profile is not available on this server yet."
                    : `Failed to update profile (Server error ${res.status}). Please try again.`);
            showProfileAlert(errorMsg, "error");
        }
    } catch (err) {
        console.error("Profile save error:", err);
        showProfileAlert("Network error: Could not reach the server. Please check your connection.", "error");
    } finally {
        setBtnLoading(saveBtn, false, "💾 Save Changes");
    }
}

/**
 * Display alert banner in profile view
 */
function showProfileAlert(message, type = "success") {
    const alertBox = document.getElementById("profileAlert");
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `profile-alert ${type}`;
    alertBox.style.display = "block";
    alertBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Hide alert banner in profile view
 */
function hideProfileAlert() {
    const alertBox = document.getElementById("profileAlert");
    if (!alertBox) return;
    alertBox.style.display = "none";
    alertBox.textContent = "";
}

// ============================================================
// SECURITY & CHANGE PASSWORD FUNCTIONALITY (PROFILE PAGE)
// ============================================================

/**
 * Toggle Change Password expandable form
 */
function toggleChangePasswordForm(show) {
    const container = document.getElementById("changePasswordContainer");
    const toggleBtn = document.getElementById("toggleChangePasswordBtn");
    if (!container) return;

    const isCurrentlyVisible = container.style.display !== "none";
    const shouldShow = typeof show === "boolean" ? show : !isCurrentlyVisible;

    if (shouldShow) {
        container.style.display = "block";
        if (toggleBtn) toggleBtn.innerHTML = "<span>Close Form</span>";
        hideChangePasswordAlert();
        const currentPassInput = document.getElementById("currentPasswordInput");
        if (currentPassInput) currentPassInput.focus();
    } else {
        container.style.display = "none";
        if (toggleBtn) toggleBtn.innerHTML = "<span>Change Password</span>";
        const form = document.getElementById("changePasswordForm");
        if (form) form.reset();
        hideChangePasswordAlert();
    }
}

/**
 * Display alert banner in change password section
 */
function showChangePasswordAlert(message, type) {
    const alertBox = document.getElementById("changePasswordAlert");
    if (!alertBox) return;
    const alertType = type || "error";
    alertBox.textContent = message;
    alertBox.className = "auth-alert " + alertType;
    alertBox.style.display = "block";
    alertBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * Hide alert banner in change password section
 */
function hideChangePasswordAlert() {
    const alertBox = document.getElementById("changePasswordAlert");
    if (!alertBox) return;
    alertBox.style.display = "none";
    alertBox.textContent = "";
}

/**
 * Handle Change Password Form Submission
 */
async function handleChangePasswordSubmit(event) {
    event.preventDefault();
    hideChangePasswordAlert();

    const currentPassInput = document.getElementById("currentPasswordInput");
    const newPassInput = document.getElementById("newPasswordInput");
    const confirmPassInput = document.getElementById("confirmNewPasswordInput");
    const submitBtn = document.getElementById("changePasswordSubmitBtn");

    const currentPassword = currentPassInput ? currentPassInput.value : "";
    const newPassword = newPassInput ? newPassInput.value : "";
    const confirmPassword = confirmPassInput ? confirmPassInput.value : "";

    // 1. Validation: Required fields
    if (!currentPassword || !newPassword || !confirmPassword) {
        showChangePasswordAlert("All fields are required.", "error");
        return;
    }

    // 2. Validation: Prevent identical current and new password
    if (newPassword === currentPassword) {
        showChangePasswordAlert("New password cannot be identical to your current password.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }

    // 3. Validation: Confirm password matching
    if (newPassword !== confirmPassword) {
        showChangePasswordAlert("New password and confirmation do not match.", "error");
        if (confirmPassInput) confirmPassInput.focus();
        return;
    }

    // 4. Validation: Password policy (8+ chars, uppercase, lowercase, digit, special character)
    if (newPassword.length < 8) {
        showChangePasswordAlert("Password must be at least 8 characters long.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }
    if (!/[A-Z]/.test(newPassword)) {
        showChangePasswordAlert("Password must contain at least one uppercase letter.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }
    if (!/[a-z]/.test(newPassword)) {
        showChangePasswordAlert("Password must contain at least one lowercase letter.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }
    if (!/[0-9]/.test(newPassword)) {
        showChangePasswordAlert("Password must contain at least one number.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }
    if (!/[^A-Za-z0-9]/.test(newPassword)) {
        showChangePasswordAlert("Password must contain at least one special character.", "error");
        if (newPassInput) newPassInput.focus();
        return;
    }

    // 5. Submit to backend API
    setBtnLoading(submitBtn, true, "Updating...");

    try {
        const res = await apiRequest("/auth/change-password", {
            method: "PUT",
            body: {
                currentPassword: currentPassword,
                newPassword: newPassword,
                confirmPassword: confirmPassword
            }
        });

        if (res.ok && res.data && res.data.success) {
            showChangePasswordAlert((res.data && res.data.message) || "Password updated successfully!", "success");
            // Clear inputs on success
            if (currentPassInput) currentPassInput.value = "";
            if (newPassInput) newPassInput.value = "";
            if (confirmPassInput) confirmPassInput.value = "";

            // Automatically close form after 2.5 seconds while keeping success notice visible
            setTimeout(function() {
                const container = document.getElementById("changePasswordContainer");
                const toggleBtn = document.getElementById("toggleChangePasswordBtn");
                if (container) container.style.display = "none";
                if (toggleBtn) toggleBtn.innerHTML = "<span>Change Password</span>";
            }, 2500);
        } else {
            // Keep fields intact on failure so user does not lose input
            const errorMsg = (res.data && res.data.message) || res.error ||
                (res.status === 401
                    ? "Your session has expired. Please log in again."
                    : res.status === 404
                    ? "Password change endpoint is not available on this server."
                    : "Failed to update password (Server error " + res.status + "). Please check your current password and try again.");
            showChangePasswordAlert(errorMsg, "error");
        }
    } catch (err) {
        console.error("Change password error:", err);
        showChangePasswordAlert("Network error: Could not reach the server. Please check your connection.", "error");
    } finally {
        setBtnLoading(submitBtn, false, "Update Password");
    }
}

// ============================================================
// PERMANENT ACCOUNT DELETION (PROFILE PAGE DANGER ZONE)
// ============================================================

let isDeletingAccount = false;

/**
 * Open Delete Account Confirmation Modal
 */
function openDeleteAccountModal() {
    isDeletingAccount = false;
    const modal = document.getElementById("deleteAccountModalOverlay");
    const input = document.getElementById("deleteConfirmInput");
    const confirmBtn = document.getElementById("confirmDeleteAccountBtn");
    const cancelBtn = document.getElementById("deleteAccountCancelBtn");
    const closeX = document.getElementById("deleteModalCloseX");

    if (input) {
        input.value = "";
        input.disabled = false;
    }
    if (confirmBtn) {
        confirmBtn.textContent = "Permanently Delete";
        confirmBtn.disabled = true;
    }
    if (cancelBtn) cancelBtn.disabled = false;
    if (closeX) closeX.disabled = false;

    hideDeleteAccountAlert();

    if (modal) {
        modal.style.display = "flex";
    }

    // Auto-focus confirmation input
    setTimeout(() => {
        if (input) input.focus();
    }, 100);
}

/**
 * Close Delete Account Confirmation Modal
 */
function closeDeleteAccountModal(force = false) {
    if (isDeletingAccount && !force) return;
    const modal = document.getElementById("deleteAccountModalOverlay");
    if (modal) {
        modal.style.display = "none";
    }
    const input = document.getElementById("deleteConfirmInput");
    if (input) input.value = "";
    hideDeleteAccountAlert();
}

/**
 * Handle backdrop click outside modal content
 */
function handleDeleteOverlayClick(event) {
    if (event.target && event.target.id === "deleteAccountModalOverlay") {
        closeDeleteAccountModal();
    }
}

/**
 * Enable/Disable Delete button based on exact "DELETE" input
 */
function handleDeleteConfirmInput(inputEl) {
    const confirmBtn = document.getElementById("confirmDeleteAccountBtn");
    if (!confirmBtn) return;
    const val = inputEl ? inputEl.value.trim() : "";
    confirmBtn.disabled = (val !== "DELETE");
}

/**
 * Show error alert inside Delete Account modal
 */
function showDeleteAccountAlert(message, type = "error") {
    const alertBox = document.getElementById("deleteAccountAlert");
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = "auth-alert " + type;
    alertBox.style.display = "block";
}

/**
 * Hide error alert inside Delete Account modal
 */
function hideDeleteAccountAlert() {
    const alertBox = document.getElementById("deleteAccountAlert");
    if (!alertBox) return;
    alertBox.style.display = "none";
    alertBox.textContent = "";
}

/**
 * Submit permanent account deletion request to backend DELETE /api/auth/account
 */
async function handleDeleteAccountSubmit() {
    if (isDeletingAccount) return;

    const input = document.getElementById("deleteConfirmInput");
    const confirmBtn = document.getElementById("confirmDeleteAccountBtn");
    const cancelBtn = document.getElementById("deleteAccountCancelBtn");
    const closeX = document.getElementById("deleteModalCloseX");

    if (!input || input.value.trim() !== "DELETE") {
        showDeleteAccountAlert("Please type DELETE in capital letters to confirm.", "error");
        if (input) input.focus();
        return;
    }

    isDeletingAccount = true;
    hideDeleteAccountAlert();

    if (input) input.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (closeX) closeX.disabled = true;
    setBtnLoading(confirmBtn, true, "Deleting Account...");

    try {
        const res = await apiRequest("/auth/account", {
            method: "DELETE"
        });

        if (res.ok && res.data && res.data.success) {
            // Close modal immediately
            closeDeleteAccountModal(true);

            // Thoroughly clear all authentication tokens and cached user data
            localStorage.removeItem("studentflow_token");
            localStorage.removeItem("studentflow_user");
            localStorage.removeItem("studentflow_tasks");
            sessionStorage.clear();

            tasks = [];
            currentUser = null;
            pendingProfileAvatar = null;
            editingTaskId = null;
            latestServerStats = null;

            destroyStatisticsCharts();
            updateUserProfileUI();

            // Clear intervals if running
            if (otpExpiryInterval) {
                clearInterval(otpExpiryInterval);
                otpExpiryInterval = null;
            }
            if (resendCooldownInterval) {
                clearInterval(resendCooldownInterval);
                resendCooldownInterval = null;
            }

            // Return user to login screen with clear confirmation notice
            switchAuthMode("login");
            showAuthAlert("✓ Your account and all associated data have been permanently deleted.", "success");
        } else {
            const errorMsg = res.data?.message || res.error || "Failed to delete account. Please try again.";
            showDeleteAccountAlert(errorMsg, "error");
            isDeletingAccount = false;
            if (input) input.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
            if (closeX) closeX.disabled = false;
            setBtnLoading(confirmBtn, false, "Permanently Delete");
        }
    } catch (err) {
        console.error("Account deletion error:", err);
        showDeleteAccountAlert("Network error: Could not reach the server. Please check your connection.", "error");
        isDeletingAccount = false;
        if (input) input.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (closeX) closeX.disabled = false;
        setBtnLoading(confirmBtn, false, "Permanently Delete");
    }
}

// Global ESC key listener to close Delete Account modal if open
window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        const modal = document.getElementById("deleteAccountModalOverlay");
        if (modal && modal.style.display !== "none" && !isDeletingAccount) {
            closeDeleteAccountModal();
        }
    }
});
