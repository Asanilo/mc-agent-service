/**
 * In-memory rate limiting middleware for mc-agent-service.
 *
 * Uses a sliding window counter algorithm.
 * Configurable per scope: rest.read, rest.mutate, jobs.create, chat.messages.
 * Returns 429 with Retry-After header on limit exceeded.
 * Skips if rateLimit config not present or enabled=false.
 */

import type { Request, Response, NextFunction } from "express";
import type { RateLimitConfig } from "../types/config.js";

// ─── Sliding Window Counter ──────────────────────────────────────────────────

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Sliding window rate limiter.
 * Tracks request counts per key in a rolling time window.
 */
export class SlidingWindowLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly windowMs: number = 60_000) {
    // Periodic cleanup of stale entries every 2 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 120_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Check if a request is allowed under the rate limit.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  check(key: string, maxRequests: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const prevWindowStart = windowStart - this.windowMs;

    const entry = this.windows.get(key);

    if (!entry || entry.windowStart < prevWindowStart) {
      // No data or stale — allow and start fresh
      this.windows.set(key, { count: 1, windowStart });
      return { allowed: true };
    }

    if (entry.windowStart === windowStart) {
      // Current window
      const prevEntry = this.windows.get(`${key}:prev`);
      const prevCount = prevEntry?.windowStart === prevWindowStart ? prevEntry.count : 0;

      // Weighted count: full previous window + current window
      const elapsed = now - windowStart;
      const weight = 1 - elapsed / this.windowMs;
      const effectiveCount = prevCount * weight + entry.count;

      if (effectiveCount >= maxRequests) {
        const retryAfterMs = this.windowMs - elapsed;
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 100) };
      }

      entry.count++;
      return { allowed: true };
    }

    // New window — rotate current to prev
    if (entry.windowStart === prevWindowStart) {
      this.windows.set(`${key}:prev`, entry);
    }
    this.windows.set(key, { count: 1, windowStart });
    return { allowed: true };
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [key, entry] of this.windows) {
      if (entry.windowStart < cutoff) {
        this.windows.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

// ─── Rate Limit Scopes ──────────────────────────────────────────────────────

export type RateLimitScope = "rest.read" | "rest.mutate" | "jobs.create" | "chat.messages";

// ─── REST Rate Limit Middleware ──────────────────────────────────────────────

/**
 * Create rate limiting middleware for REST routes.
 * Determines the scope based on HTTP method and path.
 */
export function createRestRateLimitMiddleware(config: RateLimitConfig) {
  if (!config.enabled) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const limiter = new SlidingWindowLimiter();

  // Scope limiters with different keys to avoid collision
  const readLimiter = new SlidingWindowLimiter();
  const mutateLimiter = new SlidingWindowLimiter();
  const jobLimiter = new SlidingWindowLimiter();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = extractClientKey(req);
    const scope = classifyRequest(req);

    let result: { allowed: true } | { allowed: false; retryAfterMs: number };

    switch (scope) {
      case "rest.read":
        result = readLimiter.check(`read:${key}`, config.rest.readPerMinute);
        break;
      case "rest.mutate":
        result = mutateLimiter.check(`mutate:${key}`, config.rest.mutatePerMinute);
        break;
      case "jobs.create":
        result = jobLimiter.check(`job:${key}`, config.jobs.createPerMinute);
        break;
      default:
        result = readLimiter.check(`read:${key}`, config.rest.readPerMinute);
    }

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Rate limit exceeded.",
          details: {
            retryAfterMs: result.retryAfterMs,
            scope,
          },
        },
      });
      return;
    }

    next();
  };
}

// ─── Chat Rate Limit Middleware ──────────────────────────────────────────────

/**
 * Create rate limiting middleware specifically for chat endpoints.
 * Keyed by botId to enforce per-bot limits.
 */
export function createChatRateLimitMiddleware(config: RateLimitConfig) {
  if (!config.enabled) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  const limiter = new SlidingWindowLimiter();

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientKey = extractClientKey(req);
    const botId = req.params?.["botId"] ?? "unknown";
    const key = `chat:${clientKey}:${botId}`;

    const result = limiter.check(key, config.chat.messagesPerMinutePerBot);

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: {
          code: "CHAT_RATE_LIMITED",
          message: "Chat rate limit exceeded for this bot.",
          details: {
            retryAfterMs: result.retryAfterMs,
            scope: "chat.messages",
          },
        },
      });
      return;
    }

    next();
  };
}

// ─── MCP Rate Limit Check ───────────────────────────────────────────────────

/**
 * Rate limit check for MCP tool calls.
 * Returns null if allowed, or an error object if limited.
 */
export function checkMcpRateLimit(
  config: RateLimitConfig,
  limiter: SlidingWindowLimiter,
  key: string,
  mutating: boolean,
): { retryAfterMs: number } | null {
  if (!config.enabled) return null;

  const scope = mutating ? config.mcp?.mutatingToolCallsPerMinute : config.mcp?.toolCallsPerMinute;
  const limit = scope ?? (mutating ? 60 : 120);

  const result = limiter.check(key, limit);
  if (!result.allowed) {
    return { retryAfterMs: result.retryAfterMs };
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a client identifier for rate limiting.
 * Uses API key / auth identity when available, falls back to IP.
 */
function extractClientKey(req: Request): string {
  // If auth middleware set a user identity, prefer that
  const authHeader = req.headers.authorization;
  if (authHeader) {
    // Use a hash of the token as key (don't store the actual token)
    return `auth:${authHeader.slice(0, 16)}`;
  }

  // Check for API key header
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") {
    return `apikey:${apiKey.slice(0, 16)}`;
  }

  // Fall back to IP
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  return `ip:${ip}`;
}

/**
 * Classify a REST request into a rate limit scope.
 */
function classifyRequest(req: Request): RateLimitScope {
  const method = req.method;
  const path = req.path;

  // Job creation: POST /bots/:botId/actions/:skillName
  if (method === "POST" && /\/bots\/[^/]+\/actions\//.test(path)) {
    return "jobs.create";
  }

  // Mutating methods
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    return "rest.mutate";
  }

  // Everything else is a read
  return "rest.read";
}
