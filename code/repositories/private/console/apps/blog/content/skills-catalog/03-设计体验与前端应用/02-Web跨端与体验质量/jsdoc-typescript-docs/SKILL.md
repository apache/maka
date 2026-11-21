---
name: jsdoc-typescript-docs
description: Documents TypeScript code with JSDoc comments, generates API documentation, and creates type-safe documentation. Use when users request "JSDoc", "code documentation", "API docs", "TypeDoc", or "inline documentation".
---

# JSDoc TypeScript Documentation

Create comprehensive inline documentation for TypeScript codebases.

## Core Workflow

1. **Document functions**: Parameters, returns, examples
2. **Document types**: Interfaces, types, enums
3. **Add descriptions**: Purpose and usage
4. **Include examples**: Code samples
5. **Generate docs**: TypeDoc output
6. **Integrate CI**: Automated doc generation

## Function Documentation

### Basic Function

```typescript
/**
 * Calculates the total price including tax.
 *
 * @param price - The base price before tax
 * @param taxRate - The tax rate as a decimal (e.g., 0.08 for 8%)
 * @returns The total price including tax
 *
 * @example
 * ```typescript
 * const total = calculateTotal(100, 0.08);
 * console.log(total); // 108
 * ```
 */
export function calculateTotal(price: number, taxRate: number): number {
  return price * (1 + taxRate);
}
```

### Async Function

```typescript
/**
 * Fetches user data from the API.
 *
 * @param userId - The unique identifier of the user
 * @param options - Optional configuration for the request
 * @returns A promise that resolves to the user data
 *
 * @throws {NotFoundError} When the user doesn't exist
 * @throws {NetworkError} When the request fails
 *
 * @example
 * ```typescript
 * try {
 *   const user = await fetchUser('user-123');
 *   console.log(user.name);
 * } catch (error) {
 *   if (error instanceof NotFoundError) {
 *     console.log('User not found');
 *   }
 * }
 * ```
 */
export async function fetchUser(
  userId: string,
  options?: FetchOptions
): Promise<User> {
  const response = await fetch(`/api/users/${userId}`, options);

  if (response.status === 404) {
    throw new NotFoundError(`User ${userId} not found`);
  }

  if (!response.ok) {
    throw new NetworkError('Failed to fetch user');
  }

  return response.json();
}
```

### Generic Function

```typescript
/**
 * Filters an array based on a predicate function.
 *
 * @typeParam T - The type of elements in the array
 * @param array - The array to filter
 * @param predicate - A function that returns true for elements to keep
 * @returns A new array containing only elements that pass the predicate
 *
 * @example
 * ```typescript
 * const numbers = [1, 2, 3, 4, 5];
 * const evens = filterArray(numbers, n => n % 2 === 0);
 * // evens: [2, 4]
 * ```
 */
export function filterArray<T>(
  array: T[],
  predicate: (item: T, index: number) => boolean
): T[] {
  return array.filter(predicate);
}
```

### Overloaded Function

```typescript
/**
 * Formats a value for display.
 *
 * @param value - The value to format
 * @returns The formatted string
 */
export function format(value: number): string;
/**
 * Formats a value with a specific format string.
 *
 * @param value - The value to format
 * @param formatStr - The format string (e.g., 'currency', 'percent')
 * @returns The formatted string
 */
export function format(value: number, formatStr: string): string;
/**
 * @internal
 */
export function format(value: number, formatStr?: string): string {
  if (formatStr === 'currency') {
    return `$${value.toFixed(2)}`;
  }
  if (formatStr === 'percent') {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toString();
}
```

## Interface Documentation

```typescript
/**
 * Represents a user in the system.
 *
 * @example
 * ```typescript
 * const user: User = {
 *   id: 'user-123',
 *   email: 'john@example.com',
 *   name: 'John Doe',
 *   role: 'admin',
 *   createdAt: new Date(),
 * };
 * ```
 */
export interface User {
  /**
   * The unique identifier for the user.
   * @example 'user-123'
   */
  id: string;

  /**
   * The user's email address.
   * @example 'john@example.com'
   */
  email: string;

  /**
   * The user's display name.
   * @example 'John Doe'
   */
  name: string;

  /**
   * The user's role in the system.
   * @default 'user'
   */
  role: 'admin' | 'user' | 'guest';

  /**
   * When the user account was created.
   */
  createdAt: Date;

  /**
   * When the user account was last updated.
   * @optional
   */
  updatedAt?: Date;

  /**
   * The user's profile settings.
   * @see {@link UserProfile}
   */
  profile?: UserProfile;
}

/**
 * User profile configuration.
 */
export interface UserProfile {
  /** URL to the user's avatar image */
  avatarUrl?: string;

  /** User's preferred language code (e.g., 'en', 'es') */
  language: string;

  /** User's timezone (e.g., 'America/New_York') */
  timezone: string;

  /** User notification preferences */
  notifications: NotificationSettings;
}
```

## Type Documentation

```typescript
/**
 * HTTP methods supported by the API.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Configuration options for API requests.
 *
 * @typeParam TBody - The type of the request body
 */
export type RequestConfig<TBody = unknown> = {
  /** HTTP method to use */
  method: HttpMethod;

  /** Request headers */
  headers?: Record<string, string>;

  /** Request body (for POST, PUT, PATCH) */
  body?: TBody;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Number of retry attempts on failure */
  retries?: number;
};

/**
 * Result type for operations that can fail.
 *
 * @typeParam T - The type of the success value
 * @typeParam E - The type of the error value
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return { success: false, error: 'Division by zero' };
 *   }
 *   return { success: true, data: a / b };
 * }
 * ```
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };
```

## Class Documentation

```typescript
/**
 * A client for interacting with the API.
 *
 * @remarks
 * This client handles authentication, retries, and error handling
 * automatically. Use the {@link ApiClient.create} factory method
 * to create an instance.
 *
 * @example
 * ```typescript
 * const client = ApiClient.create({
 *   baseUrl: 'https://api.example.com',
 *   apiKey: process.env.API_KEY,
 * });
 *
 * const users = await client.get<User[]>('/users');
 * ```
 */
export class ApiClient {
  /**
   * The base URL for all API requests.
   * @readonly
   */
  readonly baseUrl: string;

  /**
   * Creates a new ApiClient instance.
   *
   * @param config - The client configuration
   * @returns A new ApiClient instance
   *
   * @example
   * ```typescript
   * const client = ApiClient.create({ baseUrl: 'https://api.example.com' });
   * ```
   */
  static create(config: ApiClientConfig): ApiClient {
    return new ApiClient(config);
  }

  /**
   * @internal
   */
  private constructor(private config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
  }

  /**
   * Performs a GET request.
   *
   * @typeParam T - The expected response type
   * @param endpoint - The API endpoint (relative to baseUrl)
   * @param options - Optional request configuration
   * @returns A promise that resolves to the response data
   *
   * @throws {ApiError} When the request fails
   *
   * @example
   * ```typescript
   * interface User { id: string; name: string; }
   * const users = await client.get<User[]>('/users');
   * ```
   */
  async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', endpoint, options);
  }

  /**
   * Performs a POST request.
   *
   * @typeParam T - The expected response type
   * @typeParam TBody - The request body type
   * @param endpoint - The API endpoint
   * @param body - The request body
   * @param options - Optional request configuration
   * @returns A promise that resolves to the response data
   */
  async post<T, TBody = unknown>(
    endpoint: string,
    body: TBody,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>('POST', endpoint, { ...options, body });
  }

  /**
   * @internal
   */
  private async request<T>(
    method: HttpMethod,
    endpoint: string,
    options?: RequestOptions
  ): Promise<T> {
    // Implementation
  }
}
```

## Enum Documentation

```typescript
/**
 * Status codes for order processing.
 *
 * @remarks
 * Orders progress through these statuses in sequence,
 * though they may skip directly to `Cancelled` from any state.
 */
export enum OrderStatus {
  /** Order has been created but not yet processed */
  Pending = 'pending',

  /** Payment has been received and order is being prepared */
  Processing = 'processing',

  /** Order has been shipped to the customer */
  Shipped = 'shipped',

  /** Order has been delivered to the customer */
  Delivered = 'delivered',

  /** Order has been cancelled */
  Cancelled = 'cancelled',

  /** Order has been returned by the customer */
  Returned = 'returned',
}
```

## React Component Documentation

```typescript
/**
 * A customizable button component.
 *
 * @remarks
 * This button supports multiple variants, sizes, and states.
 * It is fully accessible and supports keyboard navigation.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <Button onClick={handleClick}>Click me</Button>
 *
 * // With variant and size
 * <Button variant="secondary" size="lg">
 *   Large Secondary Button
 * </Button>
 *
 * // Loading state
 * <Button loading>Submitting...</Button>
 * ```
 */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The visual style variant.
   * @default 'primary'
   */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';

  /**
   * The size of the button.
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';

  /**
   * Whether the button is in a loading state.
   * When true, the button is disabled and shows a spinner.
   * @default false
   */
  loading?: boolean;

  /**
   * Icon to display before the button text.
   */
  leftIcon?: React.ReactNode;

  /**
   * Icon to display after the button text.
   */
  rightIcon?: React.ReactNode;
}

/**
 * A customizable button component.
 *
 * @param props - The component props
 * @returns The rendered button element
 *
 * @see {@link ButtonProps} for available props
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, children, ...props }, ref) => {
    // Implementation
  }
);

Button.displayName = 'Button';
```

## TypeDoc Configuration

```json
// typedoc.json
{
  "entryPoints": ["./src/index.ts"],
  "out": "./docs",
  "name": "My Library",
  "readme": "./README.md",
  "plugin": [
    "typedoc-plugin-markdown",
    "typedoc-plugin-mdn-links"
  ],
  "excludePrivate": true,
  "excludeProtected": true,
  "excludeInternal": true,
  "includeVersion": true,
  "categorizeByGroup": true,
  "categoryOrder": ["Core", "Utilities", "Types", "*"],
  "navigationLinks": {
    "GitHub": "https://github.com/user/repo",
    "npm": "https://www.npmjs.com/package/my-package"
  },
  "validation": {
    "notExported": true,
    "invalidLink": true,
    "notDocumented": false
  }
}
```

```json
// package.json
{
  "scripts": {
    "docs": "typedoc",
    "docs:watch": "typedoc --watch"
  },
  "devDependencies": {
    "typedoc": "^0.25.0",
    "typedoc-plugin-markdown": "^3.17.0",
    "typedoc-plugin-mdn-links": "^3.1.0"
  }
}
```

## JSDoc Tags Reference

```typescript
/**
 * Summary description.
 *
 * @remarks
 * Additional details and implementation notes.
 *
 * @param name - Parameter description
 * @typeParam T - Type parameter description
 * @returns Return value description
 *
 * @throws {ErrorType} When error condition
 *
 * @example
 * ```typescript
 * // Example code
 * ```
 *
 * @see {@link RelatedItem} for related documentation
 * @see https://example.com External link
 *
 * @deprecated Use `newFunction` instead
 * @since 1.0.0
 * @version 2.0.0
 *
 * @alpha - Early preview
 * @beta - Feature complete but may change
 * @public - Stable API
 * @internal - Not for public use
 * @readonly - Cannot be modified
 * @virtual - Can be overridden
 * @override - Overrides parent
 * @sealed - Cannot be extended
 *
 * @defaultValue default value
 * @eventProperty - For event properties
 */
```

## Best Practices

1. **Document public API**: All exports need docs
2. **Use examples**: Show real usage
3. **Describe parameters**: Clear, concise descriptions
4. **Document errors**: What can be thrown
5. **Link related items**: Use @see tags
6. **Keep updated**: Sync docs with code
7. **Generate HTML**: TypeDoc for browsable docs
8. **Validate in CI**: Check for missing docs

## Output Checklist

Every documented codebase should include:

- [ ] All public functions documented
- [ ] All interfaces and types documented
- [ ] All parameters described
- [ ] Return values documented
- [ ] Examples for complex functions
- [ ] Thrown errors documented
- [ ] TypeDoc configuration
- [ ] Generated documentation
- [ ] Documentation in CI pipeline
- [ ] README with API overview
