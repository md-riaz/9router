import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { getCodexModelScope } from "open-sse/executors/codex.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// ─── Codex scope-level lock helpers ──────────────────────────────────────────
// Codex has two independent quota pools: "codex" and "spark".
// Scope locks are stored in providerSpecificData.codexScopeRateLimitedUntil
// so that exhausting one pool does not block the other.

/**
 * Get the scope-level rate-limit expiry for a specific Codex model.
 * @param {object} providerSpecificData
 * @param {string|null} model
 * @returns {string|null} ISO expiry, or null
 */
function getCodexScopeRateLimitedUntil(providerSpecificData, model) {
  if (!model || !providerSpecificData) return null;
  const scope = getCodexModelScope(model);
  const scopeMap = providerSpecificData.codexScopeRateLimitedUntil;
  if (!scopeMap || typeof scopeMap !== "object") return null;
  return scopeMap[scope] || null;
}

/**
 * Returns true if this connection's Codex quota scope is still locked for the given model.
 * @param {object} connection - raw connection record (has providerSpecificData)
 * @param {string|null} model
 * @returns {boolean}
 */
function isCodexScopeUnavailable(connection, model) {
  const until = getCodexScopeRateLimitedUntil(connection.providerSpecificData, model);
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

/**
 * Earliest active Codex scope expiry across a set of connections for a given model.
 * @param {Array} connections
 * @param {string|null} model
 * @returns {string|null} ISO expiry, or null
 */
function getEarliestCodexScopeRateLimitedUntil(connections, model) {
  let earliest = null;
  const now = Date.now();
  for (const conn of connections) {
    const until = getCodexScopeRateLimitedUntil(conn.providerSpecificData, model);
    if (!until) continue;
    const ms = new Date(until).getTime();
    if (ms <= now) continue;
    if (!earliest || ms < new Date(earliest).getTime()) earliest = until;
  }
  return earliest;
}
// ─────────────────────────────────────────────────────────────────────────────

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      return { id: "noauth", connectionName: "Public", isActive: true, accessToken: "public" };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // For Codex: also skip connections whose scope quota pool is exhausted
      if (provider === "codex" && isCodexScopeUnavailable(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      const scopeLocked = provider === "codex" && isCodexScopeUnavailable(c, model);
      if (excluded || locked || scopeLocked) {
        const lockUntil = getEarliestModelLockUntil(c) ||
          (scopeLocked ? getCodexScopeRateLimitedUntil(c.providerSpecificData, model) : null);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""} ${scopeLocked ? `codexScopeLocked(${getCodexModelScope(model)}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing.
      // For Codex: also consider scope-level quota lock expiry.
      const lockedConns = connections.filter(c => isModelLockActive(c, model) || (provider === "codex" && isCodexScopeUnavailable(c, model)));
      const expiries = lockedConns.map(c => {
        const modelExpiry = getEarliestModelLockUntil(c);
        const scopeExpiry = provider === "codex" ? getCodexScopeRateLimitedUntil(c.providerSpecificData, model) : null;
        // Return the earlier of the two (shortest wait)
        if (modelExpiry && scopeExpiry) return modelExpiry < scopeExpiry ? modelExpiry : scopeExpiry;
        return modelExpiry || scopeExpiry;
      }).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @param {number|null} [retryAfterMs] - Provider-specified ms until reset (from Retry-After header etc.)
 *   When provided and exceeds the computed backoff, the lock is set to this exact duration so the
 *   account+model is not retried before the provider's actual quota window expires.
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, retryAfterMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  const { shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const effectiveLockMs = (retryAfterMs != null && retryAfterMs > cooldownMs) ? retryAfterMs : cooldownMs;

  // T09: Codex per-scope lockout (5h session + weekly quota pools are independent).
  // When a Codex account hits a 429, we lock the ENTIRE quota scope (all models that
  // share the same 5h/weekly pool) rather than just the single model variant.
  // This prevents combo packs from wastefully cycling through gpt-5.3-codex-high,
  // gpt-5.3-codex-low, gpt-5.1-codex, etc. when the shared pool is exhausted.
  if (provider === "codex" && status === 429 && model && conn) {
    const scope = getCodexModelScope(model);
    const existingScopeMap = (conn.providerSpecificData?.codexScopeRateLimitedUntil) || {};
    const newExpiry = new Date(Date.now() + effectiveLockMs).toISOString();
    const existingExpiry = existingScopeMap[scope];

    // Only update if the new expiry is further out (preserve longer locks)
    if (!existingExpiry || new Date(newExpiry) > new Date(existingExpiry)) {
      const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
      await updateProviderConnection(connectionId, {
        testStatus: "unavailable",
        lastError: reason,
        errorCode: status,
        lastErrorAt: new Date().toISOString(),
        backoffLevel: newBackoffLevel ?? backoffLevel,
        providerSpecificData: {
          ...(conn.providerSpecificData || {}),
          codexScopeRateLimitedUntil: {
            ...existingScopeMap,
            [scope]: newExpiry,
          },
        },
      });
      log.warn("AUTH", `${connName} Codex scope [${scope}] locked until ${newExpiry} (${Math.round(effectiveLockMs / 1000)}s) [${status}]${retryAfterMs && retryAfterMs > cooldownMs ? " (provider reset time)" : ""}`);
    }

    if (provider && status && reason) {
      console.error(`❌ ${provider} [${status}] (${scope}): ${reason}`);
    }

    return { shouldFallback: true, cooldownMs: effectiveLockMs };
  }

  const lockUpdate = buildModelLockUpdate(model, cooldownMs, retryAfterMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(effectiveLockMs / 1000)}s [${status}]${retryAfterMs && retryAfterMs > cooldownMs ? " (provider reset time)" : ""}`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.info("AUTH", `Account ${connName} cleared lock for model=${model || "__all"}`);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
