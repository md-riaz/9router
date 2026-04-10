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

  try {
    const text = await response.text();

    // Try parse as JSON
    try {
      const json = JSON.parse(text);
      message = json.error?.message || json.message || json.error || text;
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

    // 4. Provider-specific error message parsing (e.g. Antigravity "reset after Xh Ym Zs")
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
  
  // Add retryAfterMs if available (for Antigravity quota errors)
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
