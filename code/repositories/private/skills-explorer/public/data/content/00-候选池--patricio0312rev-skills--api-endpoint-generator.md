---
name: api-contract-normalizer
description: Unifies API response patterns across endpoints including pagination format, error structure, status codes, response envelopes, and versioning strategy. Provides contract documentation, shared TypeScript types, middleware utilities, and migration plan. Use when standardizing "API contracts", "response formats", "API conventions", or "API consistency".
---

# API Contract Normalizer

Standardize API contracts across all endpoints for consistency and developer experience.

## Core Workflow

1. **Audit existing APIs**: Document current inconsistencies
2. **Define standards**: Response format, pagination, errors, status codes
3. **Create shared types**: TypeScript interfaces for all contracts
4. **Build middleware**: Normalize responses automatically
5. **Document contract**: OpenAPI spec with examples
6. **Migration plan**: Phased rollout strategy
7. **Versioning**: API version strategy

## Standard Response Envelope

```typescript
// types/api-contract.ts
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ResponseMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[] | string>;
  trace_id?: string;
}

export interface ResponseMeta {
  timestamp: string;
  request_id: string;
  version: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  meta: ResponseMeta & PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
}
```

## Pagination Standards

```typescript
// Standard pagination query params
interface PaginationQuery {
  page: number;      // 1-indexed, default: 1
  limit: number;     // default: 10, max: 100
  sort_by?: string;  // field name
  sort_order?: 'asc' | 'desc'; // default: 'desc'
}

// Standard pagination response
{
  "success": true,
  "data": [...],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 156,
    "total_pages": 16,
    "has_next": true,
    "has_prev": false
  }
}

// Cursor-based pagination (for large datasets)
interface CursorPaginationQuery {
  cursor?: string;
  limit: number;
}

interface CursorPaginationMeta {
  next_cursor?: string;
  prev_cursor?: string;
  has_more: boolean;
}
```

## Error Standards

```typescript
// Error taxonomy
export enum ErrorCode {
  // Client errors (4xx)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Server errors (5xx)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',
}

// Error to HTTP status mapping
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504,
};

// Standard error responses
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "email": ["Invalid email format"],
      "age": ["Must be at least 18"]
    },
    "trace_id": "abc123"
  }
}
```

## Response Normalization Middleware

```typescript
// middleware/normalize-response.ts
import { Request, Response, NextFunction } from "express";

export function normalizeResponse() {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = function (data: any) {
      // Already normalized
      if (data.success !== undefined) {
        return originalJson(data);
      }

      // Normalize success response
      const normalized: ApiResponse = {
        success: true,
        data,
        meta: {
          timestamp: new Date().toISOString(),
          request_id: req.id,
          version: "v1",
        },
      };

      return originalJson(normalized);
    };

    next();
  };
}

// Error normalization middleware
export function normalizeError() {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    const error: ApiError = {
      code: err.name || "INTERNAL_ERROR",
      message: err.message || "An unexpected error occurred",
      trace_id: req.id,
    };

    if (err instanceof ValidationError) {
      error.details = err.details;
    }

    const statusCode = ERROR_STATUS_MAP[error.code] || 500;

    res.status(statusCode).json({
      success: false,
      error,
      meta: {
        timestamp: new Date().toISOString(),
        request_id: req.id,
        version: "v1",
      },
    });
  };
}
```

## Status Code Standards

```typescript
// Standard status codes by operation
const STATUS_CODES = {
  // Success
  OK: 200, // GET, PUT, PATCH success
  CREATED: 201, // POST success
  NO_CONTENT: 204, // DELETE success

  // Client errors
  BAD_REQUEST: 400, // Validation errors
  UNAUTHORIZED: 401, // Missing/invalid auth
  FORBIDDEN: 403, // Insufficient permissions
  NOT_FOUND: 404, // Resource not found
  CONFLICT: 409, // Duplicate/conflict
  UNPROCESSABLE: 422, // Semantic errors
  TOO_MANY_REQUESTS: 429, // Rate limit

  // Server errors
  INTERNAL_ERROR: 500, // Unexpected errors
  SERVICE_UNAVAILABLE: 503, // Temporarily down
  GATEWAY_TIMEOUT: 504, // Upstream timeout
};
```

## Versioning Strategy

```typescript
// URL versioning (recommended)
/api/v1/users
/api/v2/users

// Header versioning
Accept: application/vnd.api.v1+json

// Query param versioning (not recommended)
/api/users?version=1

// Version middleware
export function apiVersion(version: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    req.apiVersion = version;
    res.setHeader('X-API-Version', version);
    next();
  };
}

// Route versioning
app.use('/api/v1', apiVersion('v1'), v1Router);
app.use('/api/v2', apiVersion('v2'), v2Router);
```

## Migration Strategy

```markdown
# API Contract Migration Plan

## Phase 1: Add Normalization (Week 1-2)

- [ ] Deploy normalization middleware
- [ ] Run alongside existing responses
- [ ] Monitor for issues
- [ ] No breaking changes yet

## Phase 2: Deprecation Notice (Week 3-4)

- [ ] Add deprecation headers
- [ ] Update documentation
- [ ] Notify API consumers
- [ ] Provide migration guide

## Phase 3: Dual Format Support (Week 5-8)

- [ ] Support both old and new formats
- [ ] Add ?format=v2 query param
- [ ] Track adoption metrics
- [ ] Help consumers migrate

## Phase 4: Switch Default (Week 9-10)

- [ ] New format becomes default
- [ ] Old format requires ?format=v1
- [ ] Final migration reminders
- [ ] Extended support period

## Phase 5: Remove Old Format (Week 12+)

- [ ] Remove old format support
- [ ] Clean up legacy code
- [ ] Update all documentation
- [ ] Celebrate consistency! 🎉
```

## Contract Documentation

```yaml
# openapi.yaml
openapi: 3.0.0
info:
  title: Standardized API
  version: 1.0.0
  description: All endpoints follow this contract

components:
  schemas:
    ApiResponse:
      type: object
      required: [success]
      properties:
        success:
          type: boolean
        data:
          type: object
        error:
          $ref: "#/components/schemas/ApiError"
        meta:
          $ref: "#/components/schemas/ResponseMeta"

    ApiError:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          enum: [VALIDATION_ERROR, UNAUTHORIZED, ...]
        message:
          type: string
        details:
          type: object
          additionalProperties: true
        trace_id:
          type: string

    PaginationMeta:
      type: object
      required: [page, limit, total, total_pages]
      properties:
        page: { type: integer }
        limit: { type: integer }
        total: { type: integer }
        total_pages: { type: integer }
        has_next: { type: boolean }
        has_prev: { type: boolean }
```

## Shared Utilities

```typescript
// utils/api-response.ts
export class ApiResponseBuilder {
  static success<T>(data: T, meta?: Partial<ResponseMeta>): ApiResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta,
      },
    };
  }

  static paginated<T>(data: T[], pagination: PaginationMeta): PaginatedResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...pagination,
      },
    };
  }

  static error(code: ErrorCode, message: string, details?: any): ApiResponse {
    return {
      success: false,
      error: { code, message, details },
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
```

## Best Practices

1. **Consistent envelope**: All responses use same structure
2. **Type safety**: Shared types across frontend/backend
3. **Clear errors**: Descriptive codes and messages
4. **Standard pagination**: Same format for all lists
5. **Versioning**: Plan for API evolution
6. **Documentation**: OpenAPI spec as source of truth
7. **Gradual migration**: Don't break existing clients
8. **Monitoring**: Track adoption and errors

## Output Checklist

- [ ] Standard response envelope defined
- [ ] Error taxonomy documented
- [ ] Pagination format standardized
- [ ] Status code mapping
- [ ] Normalization middleware
- [ ] Shared TypeScript types
- [ ] Versioning strategy
- [ ] OpenAPI specification
- [ ] Migration plan with phases
- [ ] Consumer communication plan
