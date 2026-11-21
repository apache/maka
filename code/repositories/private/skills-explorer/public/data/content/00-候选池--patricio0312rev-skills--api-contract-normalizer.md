---
name: api-endpoint-generator
description: Generates CRUD REST API endpoints with request validation, TypeScript types, consistent response formats, error handling, and documentation. Includes route handlers, validation schemas (Zod/Joi), typed responses, and usage examples. Use when building "REST API", "CRUD endpoints", "API routes", or "backend endpoints".
---

# API Endpoint Generator

Generate production-ready CRUD API endpoints with validation and type safety.

## Core Workflow

1. **Define resource**: Entity name and schema
2. **Generate routes**: POST, GET, PUT/PATCH, DELETE endpoints
3. **Add validation**: Request body/query validation with Zod/Joi
4. **Type responses**: TypeScript interfaces for all responses
5. **Error handling**: Consistent error responses
6. **Documentation**: OpenAPI/Swagger specs
7. **Examples**: Request/response samples

## Express + TypeScript Pattern

```typescript
// types/user.types.ts
export interface User {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserDto {
  email: string;
  name: string;
  password: string;
}

export interface UpdateUserDto {
  name?: string;
  email?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: PaginationMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}
```

## Validation Schemas (Zod)

```typescript
// schemas/user.schema.ts
import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(2, "Name must be at least 2 characters"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain uppercase letter")
    .regex(/[0-9]/, "Password must contain number"),
});

export const updateUserSchema = z
  .object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const getUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  sortBy: z.enum(["name", "email", "createdAt"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().optional(),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type GetUsersQuery = z.infer<typeof getUsersQuerySchema>;
```

## CRUD Route Handlers

```typescript
// routes/users.routes.ts
import { Router } from "express";
import { UserController } from "../controllers/user.controller";
import { validateRequest } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { createUserSchema, updateUserSchema, getUsersQuerySchema } from "../schemas/user.schema";

const router = Router();
const controller = new UserController();

// Create
router.post("/", authenticate, validateRequest({ body: createUserSchema }), controller.create);

// Read (list)
router.get("/", authenticate, validateRequest({ query: getUsersQuerySchema }), controller.list);

// Read (single)
router.get("/:id", authenticate, controller.getById);

// Update
router.patch("/:id", authenticate, validateRequest({ body: updateUserSchema }), controller.update);

// Delete
router.delete("/:id", authenticate, controller.delete);

export default router;
```

## Controller Implementation

```typescript
// controllers/user.controller.ts
import { Request, Response, NextFunction } from "express";
import { UserService } from "../services/user.service";
import { CreateUserDto, UpdateUserDto, GetUsersQuery } from "../types/user.types";
import { ApiResponse } from "../types/api.types";

export class UserController {
  private service = new UserService();

  create = async (
    req: Request<{}, {}, CreateUserDto>,
    res: Response<ApiResponse<User>>,
    next: NextFunction,
  ) => {
    try {
      const user = await this.service.create(req.body);
      res.status(201).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  list = async (
    req: Request<{}, {}, {}, GetUsersQuery>,
    res: Response<ApiResponse<User[]>>,
    next: NextFunction,
  ) => {
    try {
      const { page, limit, sortBy, sortOrder, search } = req.query;
      const result = await this.service.findAll({
        page,
        limit,
        sortBy,
        sortOrder,
        search,
      });

      res.json({
        success: true,
        data: result.users,
        meta: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  getById = async (
    req: Request<{ id: string }>,
    res: Response<ApiResponse<User>>,
    next: NextFunction,
  ) => {
    try {
      const user = await this.service.findById(req.params.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: {
            code: "USER_NOT_FOUND",
            message: "User not found",
          },
        });
      }
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  update = async (
    req: Request<{ id: string }, {}, UpdateUserDto>,
    res: Response<ApiResponse<User>>,
    next: NextFunction,
  ) => {
    try {
      const user = await this.service.update(req.params.id, req.body);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: {
            code: "USER_NOT_FOUND",
            message: "User not found",
          },
        });
      }
      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  delete = async (
    req: Request<{ id: string }>,
    res: Response<ApiResponse<void>>,
    next: NextFunction,
  ) => {
    try {
      const deleted = await this.service.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: {
            code: "USER_NOT_FOUND",
            message: "User not found",
          },
        });
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  };
}
```

## Validation Middleware

```typescript
// middleware/validate.ts
import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export const validateRequest = (schemas: ValidationSchemas) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request data",
            details: error.flatten().fieldErrors,
          },
        });
      }
      next(error);
    }
  };
};
```

## NestJS Pattern

```typescript
// users/users.controller.ts
import { Controller, Get, Post, Put, Delete, Body, Param, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CreateUserDto, UpdateUserDto, GetUsersQueryDto } from "./dto";

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: "Create user" })
  @ApiResponse({ status: 201, description: "User created" })
  @ApiResponse({ status: 400, description: "Validation error" })
  async create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List users" })
  async findAll(@Query() query: GetUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get user by ID" })
  async findOne(@Param("id") id: string) {
    return this.usersService.findOne(id);
  }

  @Put(":id")
  @ApiOperation({ summary: "Update user" })
  async update(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete user" })
  async remove(@Param("id") id: string) {
    return this.usersService.remove(id);
  }
}
```

## FastAPI Pattern (Python)

```python
# routers/users.py
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional
from pydantic import BaseModel, EmailStr, Field

router = APIRouter(prefix="/users", tags=["users"])

class CreateUserDto(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=2)
    password: str = Field(..., min_length=8)

class UserResponse(BaseModel):
    id: str
    email: str
    name: str
    role: str
    created_at: datetime

class PaginatedResponse(BaseModel):
    data: List[UserResponse]
    total: int
    page: int
    limit: int

@router.post("/", status_code=201, response_model=UserResponse)
async def create_user(dto: CreateUserDto, service: UserService = Depends()):
    return await service.create(dto)

@router.get("/", response_model=PaginatedResponse)
async def list_users(
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    search: Optional[str] = None,
    service: UserService = Depends()
):
    return await service.find_all(page, limit, search)
```

## Response Format Standards

```typescript
// Success Response
{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 50,
    "totalPages": 5
  }
}

// Error Response
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": {
      "email": ["Invalid email address"],
      "password": ["Password must contain uppercase letter"]
    }
  }
}
```

## Status Codes

- 200: Success (GET, PUT)
- 201: Created (POST)
- 204: No Content (DELETE)
- 400: Validation Error
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 409: Conflict
- 500: Server Error

## Best Practices

1. **Type everything**: Request, response, DTOs, errors
2. **Validate early**: Before hitting service layer
3. **Consistent responses**: Same structure everywhere
4. **HTTP semantics**: Use correct status codes
5. **Error details**: Include validation errors
6. **Pagination**: Always paginate lists
7. **Filtering/sorting**: Support common queries
8. **Documentation**: OpenAPI/Swagger specs

## Output Checklist

- [ ] Route definitions with HTTP methods
- [ ] Request validation schemas
- [ ] TypeScript types for all DTOs
- [ ] Controller handlers with error handling
- [ ] Consistent response format
- [ ] Pagination for list endpoints
- [ ] HTTP status codes correctly used
- [ ] Error response format
- [ ] OpenAPI/Swagger documentation
- [ ] Usage examples with curl/requests
