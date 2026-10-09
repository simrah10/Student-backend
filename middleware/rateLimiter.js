/**
 * In-memory rate limiter for password reset requests
 * Limits requests per IP/email combination to prevent Resend quota abuse and inbox flooding.
 */
const resetAttempts = new Map();

// Periodic cleanup of expired rate limit entries every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [key, record] of resetAttempts.entries()) {
    if (now - record.firstAttempt > windowMs) {
      resetAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

/**
 * Rate limiter middleware for /api/auth/forgot-password
 * Allows up to 5 requests per 15-minute window per IP / email pair.
 */
const forgotPasswordRateLimiter = (req, res, next) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const email = (req.body?.email || "").toString().toLowerCase().trim();
  const key = `${ip}:${email}`;

  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;

  const record = resetAttempts.get(key);

  if (!record || now - record.firstAttempt > windowMs) {
    resetAttempts.set(key, { count: 1, firstAttempt: now });
    return next();
  }

  if (record.count >= maxAttempts) {
    return res.status(429).json({
      success: false,
      message: "Too many password reset requests. Please wait 15 minutes before trying again."
    });
  }

  record.count += 1;
  next();
};

const clearRateLimits = () => {
  resetAttempts.clear();
};

module.exports = {
  forgotPasswordRateLimiter,
  clearRateLimits
};
