---
name: structured-logging-standardizer
description: Enforces consistent structured logging with request correlation IDs, standardized log schema, middleware integration, and best practices. Use for "structured logging", "log standardization", "request tracing", or "log correlation".
---

# Structured Logging Standardizer

Implement consistent, queryable, correlated logs.

## Log Schema

```typescript
interface LogEntry {
  timestamp: string; // ISO 8601
  level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  service: string;
  environment: string;

  // Request context
  requestId?: string;
  traceId?: string;
  userId?: string;

  // Additional context
  [key: string]: any;
}
```

## Request ID Middleware

```typescript
import { v4 as uuidv4 } from "uuid";

app.use((req, res, next) => {
  // Generate or use existing request ID
  req.id = req.headers["x-request-id"] || uuidv4();

  // Add to response headers
  res.setHeader("x-request-id", req.id);

  // Store in async local storage
  asyncLocalStorage.run(new Map(), () => {
    asyncLocalStorage.getStore()?.set("requestId", req.id);
    next();
  });
});

// Logger with request context
const logger = pino({
  mixin() {
    return {
      requestId: asyncLocalStorage.getStore()?.get("requestId"),
    };
  },
});
```

## Standardized Logger

```typescript
class StandardLogger {
  private logger = pino();

  info(message: string, context?: Record<string, any>) {
    this.logger.info(
      {
        ...this.getContext(),
        ...context,
      },
      message,
    );
  }

  error(message: string, error?: Error, context?: Record<string, any>) {
    this.logger.error(
      {
        ...this.getContext(),
        ...context,
        error: {
          message: error?.message,
          stack: error?.stack,
          name: error?.name,
        },
      },
      message,
    );
  }

  private getContext() {
    return {
      requestId: asyncLocalStorage.getStore()?.get("requestId"),
      userId: asyncLocalStorage.getStore()?.get("userId"),
    };
  }
}
```

## Best Practices

```typescript
// ✅ DO: Structured fields
logger.info({ userId: '123', action: 'purchase', amount: 99.99 }, 'Purchase completed');

// ❌ DON'T: String interpolation
logger.info(\`User 123 purchased for $99.99\`);

// ✅ DO: Consistent field names
logger.info({ duration_ms: 150 }, 'Request completed');

// ❌ DON'T: Inconsistent naming
logger.info({ durationMs: 150 }, 'Request done');
```

## Output Checklist

- [ ] Request ID middleware
- [ ] Structured log schema
- [ ] Correlation IDs
- [ ] Standardized logger
- [ ] Best practices documented
      ENDFILE
