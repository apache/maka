---
name: api-security-hardener
description: Hardens API security with rate limiting, input validation, authentication, and protection against common attacks. Use when users request "API security", "secure API", "rate limiting", "input validation", or "API protection".
---

# API Security Hardener

Implement comprehensive security measures for production APIs.

## Core Workflow

1. **Input validation**: Sanitize and validate all input
2. **Authentication**: Secure identity verification
3. **Authorization**: Role-based access control
4. **Rate limiting**: Prevent abuse
5. **Security headers**: HTTP header protection
6. **Logging & monitoring**: Detect threats

## Input Validation

### Zod Schema Validation

```typescript
// validation/schemas.ts
import { z } from "zod";

// Common schemas
export const emailSchema = z.string().email().toLowerCase().trim();

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password too long")
  .regex(/[A-Z]/, "Password must contain uppercase letter")
  .regex(/[a-z]/, "Password must contain lowercase letter")
  .regex(/[0-9]/, "Password must contain number")
  .regex(/[^A-Za-z0-9]/, "Password must contain special character");

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// User schemas
export const createUserSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(2).max(100).trim(),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

// Sanitize HTML content
export const sanitizedStringSchema = z.string().transform((val) => {
  return val
    .replace(/[<>]/g, "") // Remove < and >
    .replace(/javascript:/gi, "") // Remove javascript: protocol
    .replace(/on\w+=/gi, "") // Remove event handlers
    .trim();
});
```

### Validation Middleware

```typescript
// middleware/validate.ts
import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationSchemas) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }
      if (schemas.query) {
        req.query = await schemas.query.parseAsync(req.query);
      }
      if (schemas.params) {
        req.params = await schemas.params.parseAsync(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Validation Error",
          details: error.errors.map((e) => ({
            field: e.path.join("."),
            message: e.message,
          })),
        });
      }
      next(error);
    }
  };
}

// Usage
router.post("/users", validate({ body: createUserSchema }), createUserHandler);
```

## Rate Limiting

```typescript
// middleware/rate-limit.ts
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);

// General API rate limit
export const apiLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: {
    error: "Too Many Requests",
    message: "Please try again later",
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise IP
    return req.user?.id || req.ip;
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === "/health";
  },
});

// Stricter limit for authentication endpoints
export const authLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: {
    error: "Too Many Attempts",
    message: "Account temporarily locked. Try again in 15 minutes.",
  },
  keyGenerator: (req) => `auth:${req.ip}:${req.body?.email}`,
});

// Cost-based rate limiting for expensive operations
export const costLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // points per hour
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: "Rate Limit Exceeded",
      message: "Hourly quota exceeded",
    });
  },
});

// Usage with cost assignment
router.post(
  "/expensive-operation",
  (req, res, next) => {
    req.rateLimit = { ...req.rateLimit, current: req.rateLimit.current + 10 };
    next();
  },
  costLimiter,
  handler,
);
```

## Authentication Middleware

```typescript
// middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface JWTPayload {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid authorization header",
    });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

    // Check token expiration with buffer
    if (payload.exp * 1000 < Date.now()) {
      return res.status(401).json({
        error: "Token Expired",
        message: "Please re-authenticate",
      });
    }

    req.user = payload;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: "Token Expired",
        message: "Please re-authenticate",
      });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: "Invalid Token",
        message: "Token validation failed",
      });
    }
    next(error);
  }
}

// Optional authentication
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice(7);

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
  } catch {
    // Ignore invalid tokens for optional auth
  }

  next();
}
```

## Authorization Middleware

```typescript
// middleware/authorize.ts
import { Request, Response, NextFunction } from "express";

type Role = "admin" | "user" | "guest";

interface Permission {
  resource: string;
  actions: string[];
}

const rolePermissions: Record<Role, Permission[]> = {
  admin: [{ resource: "*", actions: ["*"] }],
  user: [
    { resource: "posts", actions: ["read", "create", "update:own", "delete:own"] },
    { resource: "comments", actions: ["read", "create", "update:own", "delete:own"] },
    { resource: "profile", actions: ["read", "update"] },
  ],
  guest: [
    { resource: "posts", actions: ["read"] },
    { resource: "comments", actions: ["read"] },
  ],
};

export function authorize(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
    }

    const userRole = req.user.role as Role;

    if (!roles.includes(userRole)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Insufficient permissions",
      });
    }

    next();
  };
}

export function hasPermission(resource: string, action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userRole = req.user.role as Role;
    const permissions = rolePermissions[userRole];

    const hasAccess = permissions.some((perm) => {
      const resourceMatch = perm.resource === "*" || perm.resource === resource;
      const actionMatch = perm.actions.includes("*") || perm.actions.includes(action);
      return resourceMatch && actionMatch;
    });

    if (!hasAccess) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Cannot ${action} ${resource}`,
      });
    }

    next();
  };
}

// Usage
router.delete("/posts/:id", authenticate, hasPermission("posts", "delete"), deletePost);
router.get("/admin/users", authenticate, authorize("admin"), listUsers);
```

## Security Headers

```typescript
// middleware/security-headers.ts
import helmet from "helmet";
import { Express } from "express";

export function configureSecurityHeaders(app: Express) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://api.example.com"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // Additional security headers
  app.use((req, res, next) => {
    // Prevent caching of sensitive data
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }

    // Permissions Policy
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );

    next();
  });
}
```

## SQL Injection Prevention

```typescript
// db/queries.ts - Using parameterized queries
import { Pool } from "pg";

const pool = new Pool();

// GOOD: Parameterized query
export async function getUserById(id: string) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

// GOOD: Using query builder (Prisma)
export async function searchUsers(term: string) {
  return prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    },
  });
}

// BAD: String interpolation (vulnerable)
// const result = await pool.query(`SELECT * FROM users WHERE id = '${id}'`);
```

## XSS Prevention

```typescript
// utils/sanitize.ts
import DOMPurify from "isomorphic-dompurify";

// Sanitize HTML content
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "p", "br"],
    ALLOWED_ATTR: ["href", "target"],
  });
}

// Escape for plain text display
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

// JSON response escaping (Express)
app.set("json escape", true);
```

## Request Logging

```typescript
// middleware/logging.ts
import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers["x-request-id"] as string) || uuidv4();
  const startTime = Date.now();

  // Add request ID to response
  res.setHeader("X-Request-ID", requestId);
  req.requestId = requestId;

  // Log request
  console.log(
    JSON.stringify({
      type: "request",
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      userId: req.user?.sub,
      timestamp: new Date().toISOString(),
    }),
  );

  // Log response
  res.on("finish", () => {
    const duration = Date.now() - startTime;

    console.log(
      JSON.stringify({
        type: "response",
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        userId: req.user?.sub,
        timestamp: new Date().toISOString(),
      }),
    );

    // Alert on suspicious activity
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.warn(
        JSON.stringify({
          type: "security_event",
          event: "access_denied",
          requestId,
          ip: req.ip,
          path: req.path,
          statusCode: res.statusCode,
        }),
      );
    }
  });

  next();
}
```

## Error Handling

```typescript
// middleware/error-handler.ts
import { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error({
    type: "error",
    requestId: req.requestId,
    error: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
      code: err.code,
    });
  }

  // Don't leak internal errors to clients
  res.status(500).json({
    error: "Internal Server Error",
    message: "An unexpected error occurred",
    requestId: req.requestId,
  });
}
```

## Best Practices

1. **Validate everything**: Never trust client input
2. **Use parameterized queries**: Prevent SQL injection
3. **Sanitize output**: Prevent XSS
4. **Rate limit**: Protect against abuse
5. **Log everything**: Enable audit trails
6. **Use HTTPS**: Always encrypt in transit
7. **Minimal responses**: Don't leak information
8. **Update dependencies**: Patch vulnerabilities

## Output Checklist

Every API security implementation should include:

- [ ] Input validation with schemas
- [ ] Authentication middleware
- [ ] Authorization (RBAC/ABAC)
- [ ] Rate limiting
- [ ] Security headers (Helmet)
- [ ] CORS configuration
- [ ] SQL injection prevention
- [ ] XSS prevention
- [ ] Request logging
- [ ] Error handling (no leaks)
