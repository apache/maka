---
name: typescript-strict-migrator
description: Migrates TypeScript projects to strict mode incrementally with type guards, utility types, and best practices. Use when users request "TypeScript strict", "strict mode migration", "type safety", "strict TypeScript", or "ts-strict".
---

# TypeScript Strict Migrator

Incrementally migrate to TypeScript strict mode for maximum type safety.

## Core Workflow

1. **Audit current state**: Check existing type errors
2. **Enable incrementally**: One flag at a time
3. **Fix errors**: Systematic approach per flag
4. **Add type guards**: Runtime type checking
5. **Use utility types**: Proper type transformations
6. **Document patterns**: Team guidelines

## Strict Mode Flags

```json
// tsconfig.json - Full strict mode
{
  "compilerOptions": {
    // Master flag (enables all below)
    "strict": true,

    // Individual flags (enabled by strict)
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "useUnknownInCatchVariables": true,
    "alwaysStrict": true,

    // Additional strict-ish flags (not in strict)
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true
  }
}
```

## Incremental Migration Strategy

### Phase 1: Basic Strict Flags

```json
// tsconfig.json - Phase 1
{
  "compilerOptions": {
    "strict": false,
    "noImplicitAny": true,
    "alwaysStrict": true
  }
}
```

```typescript
// Before: implicit any
function processData(data) {
  return data.map((item) => item.value);
}

// After: explicit types
function processData(data: DataItem[]): number[] {
  return data.map((item) => item.value);
}

interface DataItem {
  value: number;
  label: string;
}
```

### Phase 2: Strict Null Checks

```json
// tsconfig.json - Phase 2
{
  "compilerOptions": {
    "noImplicitAny": true,
    "strictNullChecks": true
  }
}
```

```typescript
// Before: potential null errors
function getUserName(user: User) {
  return user.profile.name; // Error if profile is undefined
}

// After: proper null handling
function getUserName(user: User): string | undefined {
  return user.profile?.name;
}

// With non-null assertion (use sparingly)
function getUserNameOrThrow(user: User): string {
  if (!user.profile?.name) {
    throw new Error("User has no name");
  }
  return user.profile.name;
}
```

### Phase 3: Function Types

```json
// tsconfig.json - Phase 3
{
  "compilerOptions": {
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true
  }
}
```

```typescript
// Before: contravariance issues
type Handler = (event: Event) => void;
const mouseHandler: Handler = (event: MouseEvent) => {
  console.log(event.clientX); // Error with strictFunctionTypes
};

// After: proper variance
type Handler<T extends Event = Event> = (event: T) => void;
const mouseHandler: Handler<MouseEvent> = (event) => {
  console.log(event.clientX);
};
```

### Phase 4: Property Initialization

```json
// tsconfig.json - Phase 4
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

```typescript
// Before: uninitialized properties
class UserService {
  private apiClient: ApiClient; // Error: not initialized

  constructor() {}
}

// After: definite assignment
class UserService {
  private apiClient: ApiClient;

  constructor(apiClient: ApiClient) {
    this.apiClient = apiClient;
  }
}

// Or with definite assignment assertion
class UserService {
  private apiClient!: ApiClient; // Initialized in init()

  async init() {
    this.apiClient = await createApiClient();
  }
}
```

## Type Guards

### Basic Type Guards

```typescript
// Type guard functions
function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArray<T>(value: unknown, itemGuard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(itemGuard);
}

// Usage
function processInput(input: unknown) {
  if (isString(input)) {
    return input.toUpperCase(); // input is string
  }
  if (isNumber(input)) {
    return input.toFixed(2); // input is number
  }
  throw new Error("Invalid input type");
}
```

### Object Type Guards

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

interface ApiResponse<T> {
  data: T;
  success: boolean;
}

// Type guard for User
function isUser(value: unknown): value is User {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.email === "string" &&
    (value.role === "admin" || value.role === "user")
  );
}

// Type guard for API response
function isApiResponse<T>(
  value: unknown,
  dataGuard: (data: unknown) => data is T,
): value is ApiResponse<T> {
  return (
    isObject(value) &&
    typeof value.success === "boolean" &&
    "data" in value &&
    dataGuard(value.data)
  );
}

// Usage
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  const data: unknown = await response.json();

  if (!isApiResponse(data, isUser)) {
    throw new Error("Invalid API response");
  }

  return data.data;
}
```

### Discriminated Unions

```typescript
// Discriminated union pattern
type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

function createSuccess<T>(data: T): Result<T> {
  return { success: true, data };
}

function createError<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

// Type guard via discriminant
function isSuccess<T, E>(result: Result<T, E>): result is { success: true; data: T } {
  return result.success === true;
}

// Usage
async function processRequest(): Promise<Result<User>> {
  try {
    const user = await fetchUser("123");
    return createSuccess(user);
  } catch (error) {
    return createError(error instanceof Error ? error : new Error(String(error)));
  }
}

const result = await processRequest();
if (isSuccess(result)) {
  console.log(result.data.name); // TypeScript knows data exists
} else {
  console.error(result.error.message); // TypeScript knows error exists
}
```

## Utility Types for Migration

```typescript
// Making properties required
type RequiredUser = Required<User>;

// Making properties optional
type PartialUser = Partial<User>;

// Pick specific properties
type UserCredentials = Pick<User, "email" | "id">;

// Omit specific properties
type PublicUser = Omit<User, "password" | "internalId">;

// Make properties readonly
type ReadonlyUser = Readonly<User>;

// Deep readonly
type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

// NonNullable
type DefiniteString = NonNullable<string | null | undefined>; // string

// Extract and Exclude
type AdminRole = Extract<User["role"], "admin">; // 'admin'
type NonAdminRole = Exclude<User["role"], "admin">; // 'user'

// Record type
type UserById = Record<string, User>;

// Parameters and ReturnType
type FetchParams = Parameters<typeof fetch>; // [input: RequestInfo, init?: RequestInit]
type FetchReturn = ReturnType<typeof fetch>; // Promise<Response>
```

## Common Migration Patterns

### Handling Optional Chaining

```typescript
// Before: unsafe access
const userName = user.profile.settings.displayName;

// After: safe access with optional chaining
const userName = user?.profile?.settings?.displayName;

// With nullish coalescing
const userName = user?.profile?.settings?.displayName ?? "Anonymous";

// With type narrowing
function getDisplayName(user: User | null): string {
  if (!user?.profile?.settings?.displayName) {
    return "Anonymous";
  }
  return user.profile.settings.displayName;
}
```

### Assertion Functions

```typescript
// Assertion function
function assertIsDefined<T>(value: T): asserts value is NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error("Value is not defined");
  }
}

function assertIsUser(value: unknown): asserts value is User {
  if (!isUser(value)) {
    throw new Error("Value is not a User");
  }
}

// Usage
function processUser(maybeUser: unknown) {
  assertIsUser(maybeUser);
  // maybeUser is now User
  console.log(maybeUser.name);
}
```

### Error Handling

```typescript
// Before: any in catch
try {
  await riskyOperation();
} catch (error) {
  console.error(error.message); // Error with useUnknownInCatchVariables
}

// After: proper error handling
try {
  await riskyOperation();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error:", String(error));
  }
}

// Helper function
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error occurred";
}
```

### Index Signatures

```typescript
// Before: unsafe index access
const users: Record<string, User> = {};
const user = users["unknown-id"];
console.log(user.name); // Error with noUncheckedIndexedAccess

// After: proper null check
const user = users["unknown-id"];
if (user) {
  console.log(user.name);
}

// Or with assertion
const user = users["known-id"]!; // Only if you're certain

// Better: use Map
const usersMap = new Map<string, User>();
const user = usersMap.get("some-id"); // User | undefined by design
```

## Migration Script

```typescript
// scripts/analyze-strict.ts
import * as ts from "typescript";
import * as path from "path";

interface StrictAnalysis {
  noImplicitAny: number;
  strictNullChecks: number;
  strictFunctionTypes: number;
  strictPropertyInitialization: number;
  total: number;
}

function analyzeProject(configPath: string): StrictAnalysis {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );

  // Enable strict flags one by one
  const strictOptions = {
    noImplicitAny: true,
    strictNullChecks: true,
    strictFunctionTypes: true,
    strictPropertyInitialization: true,
  };

  const analysis: StrictAnalysis = {
    noImplicitAny: 0,
    strictNullChecks: 0,
    strictFunctionTypes: 0,
    strictPropertyInitialization: 0,
    total: 0,
  };

  for (const [flag, _] of Object.entries(strictOptions)) {
    const options = {
      ...parsedConfig.options,
      [flag]: true,
    };

    const program = ts.createProgram(parsedConfig.fileNames, options);
    const diagnostics = ts.getPreEmitDiagnostics(program);

    analysis[flag as keyof StrictAnalysis] = diagnostics.length;
    analysis.total += diagnostics.length;
  }

  return analysis;
}

// Usage
const analysis = analyzeProject("./tsconfig.json");
console.log("Strict mode analysis:", analysis);
```

## Best Practices

1. **Incremental adoption**: One flag at a time
2. **Start with noImplicitAny**: Easiest to fix
3. **Add type guards**: Runtime safety
4. **Use assertion functions**: Fail fast
5. **Avoid non-null assertions**: Use sparingly
6. **Document patterns**: Team consistency
7. **CI enforcement**: Prevent regression
8. **Use unknown over any**: Better type safety

## Output Checklist

Every strict migration should include:

- [ ] Baseline error count per flag
- [ ] Migration plan with phases
- [ ] Type guard utilities
- [ ] Assertion functions
- [ ] Error handling patterns
- [ ] Index access handling
- [ ] Optional chaining usage
- [ ] Updated tsconfig.json
- [ ] Team documentation
- [ ] CI strict checking
