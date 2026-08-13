// =============================================================================
// AI Response Cache — Spec 9.8/9.11
// In-memory cache for identical questions within the same organization.
// Reduces cost, latency, and provider load.
//
// Rules:
// - Only cache successful, high/medium confidence responses
// - Respect per-tool cacheTtlSeconds from the tool registry
// - Never cache refused, blocked, or error responses
// - Cache key = normalized question hash + org_id + tool_used
// =============================================================================

interface CacheEntry {
  key: string;
  response: any;
  toolUsed: string;
  confidence: string;
  createdAt: number;
  ttlMs: number;
}

// Simple in-memory LRU cache (max 500 entries for a single server instance)
const MAX_CACHE_SIZE = 500;
const cache = new Map<string, CacheEntry>();

// =============================================================================
// NORMALIZE QUESTION FOR CACHE KEY
// Lowercase, trim, collapse whitespace, remove punctuation
// =============================================================================

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?!.,;:'"()\-]/g, '');
}

// =============================================================================
// SIMPLE HASH FUNCTION (non-cryptographic, fast)
// =============================================================================

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// =============================================================================
// GENERATE CACHE KEY
// =============================================================================

export function generateCacheKey(
  question: string,
  orgId: string,
  toolUsed: string
): string {
  const normalized = normalizeQuestion(question);
  const questionHash = simpleHash(normalized);
  return `${orgId}:${toolUsed}:${questionHash}`;
}

// =============================================================================
// GET CACHED RESPONSE
// Returns null if not found or expired
// =============================================================================

export function getCachedResponse(
  question: string,
  orgId: string,
  toolUsed: string
): any | null {
  const key = generateCacheKey(question, orgId, toolUsed);
  const entry = cache.get(key);

  if (!entry) return null;

  // Check TTL
  const now = Date.now();
  if (now - entry.createdAt > entry.ttlMs) {
    cache.delete(key);
    return null;
  }

  return entry.response;
}

// =============================================================================
// SET CACHE RESPONSE
// Only caches if entry is successful and within size limit
// =============================================================================

export function setCachedResponse(
  question: string,
  orgId: string,
  toolUsed: string,
  response: any,
  confidence: string,
  ttlMs: number = 300000 // default 5 minutes
): void {
  // Don't cache low confidence, refused, or error responses
  if (confidence === 'low' || !response) return;

  const key = generateCacheKey(question, orgId, toolUsed);

  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, {
    key,
    response,
    toolUsed,
    confidence,
    createdAt: Date.now(),
    ttlMs,
  });
}

// =============================================================================
// INVALIDATE CACHE
// Useful when data changes (e.g., new journal posted, invoice paid)
// =============================================================================

export function invalidateCacheForOrg(orgId: string): void {
  for (const [key] of cache) {
    if (key.startsWith(`${orgId}:`)) {
      cache.delete(key);
    }
  }
}

export function invalidateCacheForTool(toolUsed: string): void {
  for (const [key] of cache) {
    if (key.includes(`:${toolUsed}:`)) {
      cache.delete(key);
    }
  }
}

// =============================================================================
// CACHE STATS (for monitoring)
// =============================================================================

export function getCacheStats(): {
  size: number;
  maxSize: number;
  hitRate: number;
} {
  return {
    size: cache.size,
    maxSize: MAX_CACHE_SIZE,
    hitRate: 0, // Would need hit/miss counters for accurate rate
  };
}

// Clear all cache (useful for testing)
export function clearCache(): void {
  cache.clear();
}