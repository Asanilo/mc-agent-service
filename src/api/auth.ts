/**
 * Authentication middleware for mc-agent-service.
 *
 * Supports three modes:
 *  - none: pass through (default)
 *  - bearer: check Authorization: Bearer <token> header, token from env var
 *  - api-key: check custom header (config.header) with key from env var (config.keyEnv)
 *
 * Applied to REST routes, WebSocket connections, and MCP requests.
 */

import type { Request, Response, NextFunction } from "express";
import type { AuthConfig } from "../types/config.js";

// ─── Error Response Helper ──────────────────────────────────────────────────

function sendAuthError(res: Response, code: string, message: string): void {
  res.status(401).json({
    error: {
      code,
      message,
    },
  });
}

// ─── REST Auth Middleware ────────────────────────────────────────────────────

/**
 * Express middleware that enforces authentication based on AuthConfig.
 * Attach to the router before any protected routes.
 */
export function createAuthMiddleware(authConfig: AuthConfig) {
  if (authConfig.mode === "none") {
    // No-op middleware
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  if (authConfig.mode === "bearer") {
    const expectedToken = process.env[authConfig.tokenEnv];
    if (!expectedToken) {
      // If the env var is missing, log a warning but still enforce auth (deny all)
      console.warn(
        `Auth configured in bearer mode but env var "${authConfig.tokenEnv}" is not set. ` +
        `All authenticated requests will be rejected.`,
      );
    }

    return (req: Request, res: Response, next: NextFunction): void => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        sendAuthError(res, "AUTH_REQUIRED", "Authentication required. Provide an Authorization header.");
        return;
      }

      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
        sendAuthError(res, "AUTH_INVALID", "Invalid Authorization header format. Expected: Bearer <token>");
        return;
      }

      if (!expectedToken || parts[1] !== expectedToken) {
        sendAuthError(res, "AUTH_INVALID", "Invalid authentication token.");
        return;
      }

      next();
    };
  }

  // api-key mode
  const headerName = authConfig.header;
  const expectedKey = process.env[authConfig.keyEnv];
  if (!expectedKey) {
    console.warn(
      `Auth configured in api-key mode but env var "${authConfig.keyEnv}" is not set. ` +
      `All authenticated requests will be rejected.`,
    );
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const providedKey = req.headers[headerName.toLowerCase()];
    if (!providedKey) {
      sendAuthError(
        res,
        "AUTH_REQUIRED",
        `Authentication required. Provide the "${headerName}" header.`,
      );
      return;
    }

    if (typeof providedKey !== "string" || providedKey !== expectedKey) {
      sendAuthError(res, "AUTH_INVALID", "Invalid API key.");
      return;
    }

    next();
  };
}

// ─── WebSocket Auth Check ───────────────────────────────────────────────────

/**
 * Validate a WebSocket upgrade request against auth config.
 * Returns null on success, or an error object { code, message } on failure.
 *
 * For WebSocket, the API key can be supplied via:
 *  - The configured header (e.g. X-API-Key)
 *  - Query parameter ?apiKey=...
 *
 * Bearer token can be supplied via:
 *  - Authorization header
 *  - Query parameter ?token=...
 */
export function checkWsAuth(
  authConfig: AuthConfig,
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams,
): { code: string; message: string } | null {
  if (authConfig.mode === "none") return null;

  if (authConfig.mode === "bearer") {
    const expectedToken = process.env[authConfig.tokenEnv];
    if (!expectedToken) {
      return { code: "AUTH_REQUIRED", message: "Authentication not configured on server." };
    }

    // Check Authorization header first, then ?token= query param
    const authHeader = headers["authorization"];
    const headerToken =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;
    const queryToken = query.get("token") ?? undefined;
    const token = headerToken ?? queryToken;

    if (!token) {
      return { code: "AUTH_REQUIRED", message: "Authentication required. Provide Authorization header or ?token= parameter." };
    }
    if (token !== expectedToken) {
      return { code: "AUTH_INVALID", message: "Invalid authentication token." };
    }
    return null;
  }

  // api-key mode
  const headerName = authConfig.header.toLowerCase();
  const expectedKey = process.env[authConfig.keyEnv];
  if (!expectedKey) {
    return { code: "AUTH_REQUIRED", message: "Authentication not configured on server." };
  }

  // Check header first, then ?apiKey= query param
  const headerValue = headers[headerName];
  const keyFromHeader = typeof headerValue === "string" ? headerValue : undefined;
  const keyFromQuery = query.get("apiKey") ?? undefined;
  const providedKey = keyFromHeader ?? keyFromQuery;

  if (!providedKey) {
    return {
      code: "AUTH_REQUIRED",
      message: `Authentication required. Provide the "${authConfig.header}" header or ?apiKey= parameter.`,
    };
  }
  if (providedKey !== expectedKey) {
    return { code: "AUTH_INVALID", message: "Invalid API key." };
  }
  return null;
}

// ─── MCP Auth Check ─────────────────────────────────────────────────────────

/**
 * Validate MCP request headers against auth config.
 * Returns null on success, or an error object on failure.
 *
 * MCP HTTP transport passes raw headers from the HTTP request.
 */
export function checkMcpAuth(
  authConfig: AuthConfig,
  headers: Record<string, string | string[] | undefined>,
): { code: string; message: string } | null {
  // MCP uses the same logic as WS but without query param fallback
  if (authConfig.mode === "none") return null;

  if (authConfig.mode === "bearer") {
    const expectedToken = process.env[authConfig.tokenEnv];
    if (!expectedToken) {
      return { code: "AUTH_REQUIRED", message: "Authentication not configured on server." };
    }

    const authHeader = headers["authorization"];
    const token =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : undefined;

    if (!token) {
      return { code: "AUTH_REQUIRED", message: "Authentication required. Provide an Authorization header." };
    }
    if (token !== expectedToken) {
      return { code: "AUTH_INVALID", message: "Invalid authentication token." };
    }
    return null;
  }

  // api-key mode
  const headerName = authConfig.header.toLowerCase();
  const expectedKey = process.env[authConfig.keyEnv];
  if (!expectedKey) {
    return { code: "AUTH_REQUIRED", message: "Authentication not configured on server." };
  }

  const headerValue = headers[headerName];
  const providedKey = typeof headerValue === "string" ? headerValue : undefined;

  if (!providedKey) {
    return {
      code: "AUTH_REQUIRED",
      message: `Authentication required. Provide the "${authConfig.header}" header.`,
    };
  }
  if (providedKey !== expectedKey) {
    return { code: "AUTH_INVALID", message: "Invalid API key." };
  }
  return null;
}
