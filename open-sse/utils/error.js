import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/runtimeConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse Antigravity error message to extract retry time
 * Example: "You have exhausted your capacity on this model. Your quota will reset after 2h7m23s."
 * @param {string} message - Error message
 * @returns {number|null} Retry time in milliseconds, or null if not found
 */
export function parseAntigravityRetryTime(message) {
  if (typeof message !== "string") return null;
  
  // Match patterns like: 2h7m23s, 5m30s, 45s, 1h20m, etc.
  const match = message.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
  if (!match) return null;
  
  let totalMs = 0;
  
  // Extract hours
  if (match[1]) {
    const hours = parseInt(match[1]);
    totalMs += hours * 60 * 60 * 1000;
  }
  
  // Extract minutes
  if (match[2]) {
    const minutes = parseInt(match[2]);
    totalMs += minutes * 60 * 1000;
  }
  
  // Extract seconds
  if (match[3]) {
    const seconds = parseInt(match[3]);
    totalMs += seconds * 1000;
  }
  
  return totalMs > 0 ? totalMs : null;
}

/**
 * Calculate milliseconds until next midnight UTC.
 * Used when a daily quota error says "resets tomorrow" or "resets at midnight UTC"
 * with no explicit timestamp.
 * @returns {number} Milliseconds until next UTC midnight
 */
export function msUntilNextMidnightUTC() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, // next day
    0, 0, 0, 0
  ));
  return nextMidnight.getTime() - Date.now();
}

/**
 * Parse Codex (chatgpt.com) and OpenAI-style quota error body/message to extract reset time.
 *
 * Handles:
 *   - Structured JSON fields: reset_at, quota_resets_at, resets_at, retry_after (ISO or Unix)
 *   - ISO-8601 timestamp anywhere in error message text
 *   - "resets on YYYY-MM-DD" date patterns
 *   - error code "session_limit_exceeded" / "five_hour" / "5h" → 5 hours from now
 *   - error code "weekly_limit_exceeded" / "7d" → 7 days
 *   - "midnight UTC" / "tomorrow" phrases → next midnight UTC (for other providers with daily limits)
 *   - "weekly limit" keyword → 7 days
 *   NOTE: Codex has a 5h session window and a 7d weekly window — NOT a daily limit.
 *
 * @param {object|null} json - Parsed JSON body (may be null if body wasn't JSON)
 * @param {string} message - Error message string
 * @returns {number|null} Milliseconds until reset, or null if not determinable
 */
export function parseCodexQuotaResetMs(json, message) {
  // 1. Structured JSON reset fields — most reliable
  const resetFields = [
    json?.error?.reset_at,
    json?.error?.quota_resets_at,
    json?.error?.resets_at,
    json?.reset_at,
    json?.quota_resets_at,
    json?.resets_at,
  ];
  for (const field of resetFields) {
    if (!field) continue;
    // ISO string or Unix timestamp
    if (typeof field === "string") {
      const t = new Date(field).getTime();
      if (!isNaN(t)) {
        const diff = t - Date.now();
        if (diff > 0) return diff;
      }
    } else if (typeof field === "number") {
      // Could be Unix seconds or ms
      const t = field < 1e12 ? field * 1000 : field;
      const diff = t - Date.now();
      if (diff > 0) return diff;
    }
  }

  // 2. retry_after field in JSON body (numeric seconds)
  const retryAfterField = json?.error?.retry_after ?? json?.retry_after;
  if (typeof retryAfterField === "number" && retryAfterField > 0) {
    return retryAfterField * 1000;
  }

  const msg = typeof message === "string" ? message : "";
  const errorCode = json?.error?.code || json?.code || "";

  // 3. Codex session (5h) limit error codes
  if (
    /session[_\s]limit[_\s]exceeded/i.test(errorCode) ||
    /five[_\s]hour/i.test(errorCode) ||
    errorCode === "5h_limit_exceeded"
  ) {
    return 5 * 60 * 60 * 1000;
  }

  // 4. Weekly (7d) limit error codes
  if (
    errorCode === "weekly_limit_exceeded" ||
    /weekly[_ ]limit[_ ]exceeded/i.test(errorCode) ||
    /seven[_\s]day/i.test(errorCode) ||
    errorCode === "7d_limit_exceeded"
  ) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (!msg) return null;

  // 5. ISO-8601 timestamp in the message text
  const isoMatch = msg.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  if (isoMatch) {
    const t = new Date(isoMatch[0]).getTime();
    if (!isNaN(t)) {
      const diff = t - Date.now();
      if (diff > 0) return diff;
    }
  }

  // 6. "resets on YYYY-MM-DD" or "resets at YYYY-MM-DD" date in message
  const dateMatch = msg.match(/resets?\s+(?:on|at)\s+(\d{4}-\d{2}-\d{2})/i);
  if (dateMatch) {
    const t = new Date(dateMatch[1] + "T00:00:00Z").getTime();
    if (!isNaN(t)) {
      const diff = t - Date.now();
      if (diff > 0) return diff;
    }
  }

  // 7. "session" / "5h" / "5-hour" limit keyword in message → 5h from now (Codex)
  if (/\b5[\s-]?h(?:our)?\b|\bsession\s+(?:quota|limit)\b|\bfive[\s-]hour\b/i.test(msg)) {
    return 5 * 60 * 60 * 1000;
  }

  // 8. "midnight UTC" or "tomorrow" phrasing → next midnight UTC (other providers with daily limits)
  if (/midnight\s+UTC/i.test(msg) || /\btomorrow\b/i.test(msg)) {
    return msUntilNextMidnightUTC();
  }

  // 9. "weekly limit" keyword in message → 7 days
  if (/\bweekly\b.*\blimit\b|\blimit\b.*\bweekly\b/i.test(msg)) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  return null;
}

/**
 * Parse standard Retry-After header value into milliseconds.
 * Supports both delay-seconds (integer) and HTTP-date formats per RFC 7231.
 * @param {string|null} headerValue - Raw Retry-After header value
 * @returns {number|null} Milliseconds until retry, or null if not parseable
 */
export function parseRetryAfterHeader(headerValue) {
  if (!headerValue) return null;

  // Try as delay-seconds (integer)
  const delaySeconds = parseInt(headerValue, 10);
  if (!isNaN(delaySeconds) && delaySeconds > 0) {
    return delaySeconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(headerValue);
  if (!isNaN(date.getTime())) {
    const diff = date.getTime() - Date.now();
    return diff > 0 ? diff : null;
  }

  return null;
}

/**
 * Parse x-ratelimit-reset header (Unix timestamp in seconds) into milliseconds from now.
 * @param {string|null} headerValue - Raw x-ratelimit-reset header value
 * @returns {number|null} Milliseconds until reset, or null if not parseable
 */
export function parseRateLimitResetHeader(headerValue) {
  if (!headerValue) return null;

  const resetUnix = parseInt(headerValue, 10);
  if (isNaN(resetUnix) || resetUnix <= 0) return null;

  // Determine if it's seconds or milliseconds (Unix epoch in seconds is ~10 digits)
  const resetMs = resetUnix < 1e12 ? resetUnix * 1000 : resetUnix;
  const diff = resetMs - Date.now();
  return diff > 0 ? diff : null;
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {string} provider - Provider name (for provider-specific parsing)
 * @returns {Promise<{statusCode: number, message: string, retryAfterMs: number|null}>}
 */
export async function parseUpstreamError(response, provider = null) {
  let message = "";
  let retryAfterMs = null;
  let parsedJson = null;

  try {
    const text = await response.text();

    // Try parse as JSON — keep the full object for structured reset-field extraction
    try {
      parsedJson = JSON.parse(text);
      message = parsedJson.error?.message || parsedJson.message || parsedJson.error || text;
    } catch {
      message = text;
    }
  } catch {
    message = `Upstream error: ${response.status}`;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Only attempt to extract reset time for errors that indicate rate limiting or quota exhaustion
  if (response.status === 429 || response.status === 403 || response.status === 402) {
    // 1. Standard Retry-After header (RFC 7231) — takes highest priority
    const retryAfterHeader = response.headers?.get?.("retry-after") ||
      response.headers?.get?.("Retry-After");
    retryAfterMs = parseRetryAfterHeader(retryAfterHeader);

    // 2. x-ratelimit-reset header (Unix timestamp in seconds, used by GitHub and others)
    if (!retryAfterMs) {
      const resetHeader = response.headers?.get?.("x-ratelimit-reset") ||
        response.headers?.get?.("x-ratelimit-reset-requests") ||
        response.headers?.get?.("ratelimit-reset");
      retryAfterMs = parseRateLimitResetHeader(resetHeader);
    }

    // 3. x-ratelimit-reset-after header (seconds, used by some providers)
    if (!retryAfterMs) {
      const resetAfterHeader = response.headers?.get?.("x-ratelimit-reset-after");
      if (resetAfterHeader) {
        const seconds = parseFloat(resetAfterHeader);
        if (!isNaN(seconds) && seconds > 0) {
          retryAfterMs = Math.ceil(seconds * 1000);
        }
      }
    }

    // 4. Codex-specific quota window headers (present on every Codex response).
    //    x-codex-7d-reset-at  — ISO timestamp of weekly window reset
    //    x-codex-5h-reset-at  — ISO timestamp of 5h session window reset
    //    Per OmniRoute T03: use the furthest-out reset time to avoid premature unblock.
    if (!retryAfterMs) {
      const reset7d = response.headers?.get?.("x-codex-7d-reset-at");
      const reset5h = response.headers?.get?.("x-codex-5h-reset-at");
      const candidates = [];
      for (const h of [reset7d, reset5h]) {
        if (!h) continue;
        const t = new Date(h).getTime();
        if (!isNaN(t) && t > Date.now()) candidates.push(t - Date.now());
      }
      if (candidates.length > 0) {
        // Use furthest-out reset so the lock is not released before the longer window expires
        retryAfterMs = Math.max(...candidates);
      }
    }

    // 5. Structured JSON body and quota message parsing
    //    Handles Codex 5h/weekly limits, ISO dates in error text, etc.
    if (!retryAfterMs) {
      retryAfterMs = parseCodexQuotaResetMs(parsedJson, finalMessage);
    }

    // 6. Antigravity "reset after Xh Ym Zs" text pattern (legacy fallback)
    if (!retryAfterMs) {
      retryAfterMs = parseAntigravityRetryTime(finalMessage);
    }
  }

  return {
    statusCode: response.status,
    message: finalMessage,
    retryAfterMs
  };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number|null} retryAfterMs - Optional retry-after time in milliseconds
 * @returns {{ success: false, status: number, error: string, response: Response, retryAfterMs?: number }}
 */
export function createErrorResult(statusCode, message, retryAfterMs = null) {
  const result = {
    success: false,
    status: statusCode,
    error: message,
    response: errorResponse(statusCode, message)
  };
  
  // Add retryAfterMs if available (for precise quota lock timing)
  if (retryAfterMs) {
    result.retryAfterMs = retryAfterMs;
  }
  
  return result;
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || 'FETCH_FAILED';
  const message = error.message || "Unknown error";
  return `[${code}]: ${message}`;
}
