import { COOLDOWN_MS, BACKOFF_CONFIG, HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 0: 1s, Level 1: 2s, Level 2: 4s... → max 2 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, backoffLevel);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  // Check error message FIRST - specific patterns take priority over status codes
  if (errorText) {
    const errorStr = typeof errorText === "string" ? errorText : JSON.stringify(errorText);
    const lowerError = errorStr.toLowerCase();

    if (lowerError.includes("no credentials")) {
      return { shouldFallback: true, cooldownMs: COOLDOWN_MS.notFound };
    }

    if (lowerError.includes("request not allowed")) {
      return { shouldFallback: true, cooldownMs: COOLDOWN_MS.requestNotAllowed };
    }

    // Kiro: "improperly formed request" = model not available on this account tier
    // Treat as paymentRequired (long cooldown) so the model is locked and fallback occurs
    if (lowerError.includes("improperly formed request")) {
      return { shouldFallback: true, cooldownMs: COOLDOWN_MS.paymentRequired };
    }

    // Rate limit keywords - exponential backoff
    if (
      lowerError.includes("rate limit") ||
      lowerError.includes("too many requests") ||
      lowerError.includes("quota exceeded") ||
      lowerError.includes("capacity") ||
      lowerError.includes("overloaded")
    ) {
      const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
      return {
        shouldFallback: true,
        cooldownMs: getQuotaCooldown(backoffLevel),
        newBackoffLevel: newLevel
      };
    }
  }

  if (status === HTTP_STATUS.UNAUTHORIZED) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.unauthorized };
  }

  if (status === HTTP_STATUS.PAYMENT_REQUIRED || status === HTTP_STATUS.FORBIDDEN) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.paymentRequired };
  }

  if (status === HTTP_STATUS.NOT_FOUND) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.notFound };
  }

  // 429 - Rate limit with exponential backoff
  if (status === HTTP_STATUS.RATE_LIMITED) {
    const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return {
      shouldFallback: true,
      cooldownMs: getQuotaCooldown(backoffLevel),
      newBackoffLevel: newLevel
    };
  }

  // Transient errors
  const transientStatuses = [
    HTTP_STATUS.NOT_ACCEPTABLE, HTTP_STATUS.REQUEST_TIMEOUT,
    HTTP_STATUS.SERVER_ERROR, HTTP_STATUS.BAD_GATEWAY,
    HTTP_STATUS.SERVICE_UNAVAILABLE, HTTP_STATUS.GATEWAY_TIMEOUT
  ];
  if (transientStatuses.includes(status)) {
    return { shouldFallback: true, cooldownMs: COOLDOWN_MS.transient };
  }

  // All other errors - fallback with transient cooldown
  return { shouldFallback: true, cooldownMs: COOLDOWN_MS.transient };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 * @param {string|null} model - Model name (null = account-level lock)
 * @param {number} cooldownMs - Fallback cooldown duration in ms (used when retryAfterMs is absent)
 * @param {number|null} [retryAfterMs] - Provider-specified ms until reset (e.g. from Retry-After header).
 *   When provided and greater than the computed cooldown, this value is used as-is so the lock
 *   persists until the actual quota/rate-limit window expires.
 */
export function buildModelLockUpdate(model, cooldownMs, retryAfterMs = null) {
  const key = getModelLockKey(model);
  // Use provider-specified reset time when available and longer than the computed backoff.
  // This prevents wasting retries before the actual quota window expires.
  const lockMs = (retryAfterMs != null && retryAfterMs > cooldownMs) ? retryAfterMs : cooldownMs;
  return { [key]: new Date(Date.now() + lockMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Providers where each model has an independent quota pool.
 *
 * A 429 or 404 on one model must NOT affect the connection's global backoff
 * level or testStatus — only the specific model should be locked so that
 * other models on the same account remain selectable.
 *
 * - antigravity: each model routes to a different backend (Gemini/Claude/OpenAI)
 * - gemini:      Google AI Studio enforces per-model RPM and RPD quotas
 * - openrouter:  500+ models with independent per-model rate limits
 *
 * Ref: OmniRoute hasPerModelQuota (gemini + passthrough providers)
 */
export const PER_MODEL_QUOTA_PROVIDERS = new Set([
  "antigravity",
  "gemini",
  "openrouter",
]);

/**
 * Returns true if the provider uses per-model independent quotas.
 * For these providers, a 429/404 on one model should only lock that model,
 * not the whole connection (testStatus/backoffLevel stay untouched).
 * @param {string|null} provider
 * @returns {boolean}
 */
export function hasPerModelQuota(provider) {
  if (!provider) return false;
  return PER_MODEL_QUOTA_PROVIDERS.has(provider);
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
