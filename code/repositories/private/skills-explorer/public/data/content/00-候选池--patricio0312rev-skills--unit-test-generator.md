---
name: unit-test-generator
description: Generates comprehensive unit tests with AAA pattern (Arrange-Act-Assert), edge cases, error scenarios, and coverage analysis. Creates test files matching source structure with complete test suites. Use for "unit testing", "test generation", "Jest tests", or "test coverage".
---

# Unit Test Generator

Generate comprehensive unit tests with edge cases and AAA pattern.

## AAA Pattern Template

```typescript
// tests/utils/validator.test.ts
import { describe, it, expect } from "vitest";
import { validateEmail } from "@/utils/validator";

describe("validateEmail", () => {
  it("should return true for valid email", () => {
    // Arrange
    const email = "user@example.com";

    // Act
    const result = validateEmail(email);

    // Assert
    expect(result).toBe(true);
  });

  it("should return false for invalid email - missing @", () => {
    // Arrange
    const email = "userexample.com";

    // Act
    const result = validateEmail(email);

    // Assert
    expect(result).toBe(false);
  });

  it("should return false for invalid email - missing domain", () => {
    // Arrange
    const email = "user@";

    // Act
    const result = validateEmail(email);

    // Assert
    expect(result).toBe(false);
  });
});
```

## Comprehensive Test Cases

```typescript
// src/utils/calculator.ts
export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  return a / b;
}

// tests/utils/calculator.test.ts
describe("divide", () => {
  describe("happy path", () => {
    it("should divide positive numbers", () => {
      expect(divide(10, 2)).toBe(5);
    });

    it("should divide negative numbers", () => {
      expect(divide(-10, 2)).toBe(-5);
      expect(divide(10, -2)).toBe(-5);
      expect(divide(-10, -2)).toBe(5);
    });

    it("should handle decimal results", () => {
      expect(divide(10, 3)).toBeCloseTo(3.333, 3);
    });
  });

  describe("edge cases", () => {
    it("should handle zero dividend", () => {
      expect(divide(0, 5)).toBe(0);
    });

    it("should handle very large numbers", () => {
      expect(divide(Number.MAX_SAFE_INTEGER, 2)).toBe(Number.MAX_SAFE_INTEGER / 2);
    });

    it("should handle very small numbers", () => {
      expect(divide(0.0001, 0.0001)).toBe(1);
    });
  });

  describe("error cases", () => {
    it("should throw error when dividing by zero", () => {
      expect(() => divide(10, 0)).toThrow("Division by zero");
    });

    it("should throw error when dividing by negative zero", () => {
      expect(() => divide(10, -0)).toThrow("Division by zero");
    });
  });
});
```

## Async Function Testing

```typescript
// src/services/userService.ts
export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);

  if (!response.ok) {
    throw new Error(`User not found: ${id}`);
  }

  return response.json();
}

// tests/services/userService.test.ts
describe("fetchUser", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should fetch user successfully", async () => {
    // Arrange
    const mockUser = { id: "123", name: "John" };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockUser,
    });

    // Act
    const user = await fetchUser("123");

    // Assert
    expect(user).toEqual(mockUser);
    expect(global.fetch).toHaveBeenCalledWith("/api/users/123");
  });

  it("should throw error when user not found", async () => {
    // Arrange
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
    });

    // Act & Assert
    await expect(fetchUser("999")).rejects.toThrow("User not found: 999");
  });

  it("should handle network error", async () => {
    // Arrange
    (global.fetch as any).mockRejectedValueOnce(new Error("Network error"));

    // Act & Assert
    await expect(fetchUser("123")).rejects.toThrow("Network error");
  });
});
```

## Testing Classes

```typescript
// src/models/ShoppingCart.ts
export class ShoppingCart {
  private items: CartItem[] = [];

  add(item: CartItem): void {
    this.items.push(item);
  }

  remove(itemId: string): void {
    this.items = this.items.filter((i) => i.id !== itemId);
  }

  getTotal(): number {
    return this.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  clear(): void {
    this.items = [];
  }
}

// tests/models/ShoppingCart.test.ts
describe("ShoppingCart", () => {
  let cart: ShoppingCart;

  beforeEach(() => {
    cart = new ShoppingCart();
  });

  describe("add", () => {
    it("should add item to cart", () => {
      // Arrange
      const item = { id: "1", name: "Product", price: 10, quantity: 1 };

      // Act
      cart.add(item);

      // Assert
      expect(cart.getTotal()).toBe(10);
    });

    it("should add multiple items", () => {
      // Arrange
      const item1 = { id: "1", name: "Product 1", price: 10, quantity: 1 };
      const item2 = { id: "2", name: "Product 2", price: 20, quantity: 2 };

      // Act
      cart.add(item1);
      cart.add(item2);

      // Assert
      expect(cart.getTotal()).toBe(50); // 10 + (20 * 2)
    });
  });

  describe("remove", () => {
    it("should remove item from cart", () => {
      // Arrange
      const item = { id: "1", name: "Product", price: 10, quantity: 1 };
      cart.add(item);

      // Act
      cart.remove("1");

      // Assert
      expect(cart.getTotal()).toBe(0);
    });

    it("should not throw when removing non-existent item", () => {
      // Act & Assert
      expect(() => cart.remove("999")).not.toThrow();
    });
  });

  describe("getTotal", () => {
    it("should return 0 for empty cart", () => {
      expect(cart.getTotal()).toBe(0);
    });

    it("should calculate total with quantities", () => {
      // Arrange
      cart.add({ id: "1", name: "Product", price: 10, quantity: 3 });

      // Assert
      expect(cart.getTotal()).toBe(30);
    });
  });

  describe("clear", () => {
    it("should remove all items", () => {
      // Arrange
      cart.add({ id: "1", name: "Product 1", price: 10, quantity: 1 });
      cart.add({ id: "2", name: "Product 2", price: 20, quantity: 1 });

      // Act
      cart.clear();

      // Assert
      expect(cart.getTotal()).toBe(0);
    });
  });
});
```

## Testing React Components

```typescript
// src/components/Counter.tsx
export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      <button onClick={() => setCount(0)}>Reset</button>
    </div>
  );
}

// tests/components/Counter.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";

describe("Counter", () => {
  it("should render with initial count of 0", () => {
    // Arrange & Act
    render(<Counter />);

    // Assert
    expect(screen.getByText("Count: 0")).toBeInTheDocument();
  });

  it("should increment count when button clicked", () => {
    // Arrange
    render(<Counter />);
    const button = screen.getByText("Increment");

    // Act
    fireEvent.click(button);

    // Assert
    expect(screen.getByText("Count: 1")).toBeInTheDocument();
  });

  it("should increment multiple times", () => {
    // Arrange
    render(<Counter />);
    const button = screen.getByText("Increment");

    // Act
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // Assert
    expect(screen.getByText("Count: 3")).toBeInTheDocument();
  });

  it("should reset count to 0", () => {
    // Arrange
    render(<Counter />);
    fireEvent.click(screen.getByText("Increment"));

    // Act
    fireEvent.click(screen.getByText("Reset"));

    // Assert
    expect(screen.getByText("Count: 0")).toBeInTheDocument();
  });
});
```

## Edge Case Categories

```typescript
// Test case generation template
interface TestCase {
  category: "happy-path" | "edge-case" | "error-case";
  description: string;
  input: any;
  expectedOutput: any;
}

const testCases: TestCase[] = [
  // Happy path
  {
    category: "happy-path",
    description: "typical valid input",
    input: "user@example.com",
    expectedOutput: true,
  },

  // Edge cases
  {
    category: "edge-case",
    description: "empty string",
    input: "",
    expectedOutput: false,
  },
  {
    category: "edge-case",
    description: "null input",
    input: null,
    expectedOutput: false,
  },
  {
    category: "edge-case",
    description: "undefined input",
    input: undefined,
    expectedOutput: false,
  },
  {
    category: "edge-case",
    description: "whitespace only",
    input: "   ",
    expectedOutput: false,
  },
  {
    category: "edge-case",
    description: "very long email",
    input: "a".repeat(1000) + "@example.com",
    expectedOutput: false,
  },

  // Error cases
  {
    category: "error-case",
    description: "invalid format - no @",
    input: "userexample.com",
    expectedOutput: false,
  },
  {
    category: "error-case",
    description: "invalid format - multiple @",
    input: "user@@example.com",
    expectedOutput: false,
  },
];
```

## Coverage Notes

```typescript
/**
 * Coverage targets for this module:
 *
 * - Line coverage: 100% (all lines executed)
 * - Branch coverage: 100% (all if/else paths tested)
 * - Function coverage: 100% (all functions called)
 * - Statement coverage: 100% (all statements executed)
 *
 * Untested scenarios (intentionally):
 * - None - module is fully covered
 *
 * High-risk areas requiring extra attention:
 * - Division by zero handling
 * - Null/undefined input handling
 * - Type coercion edge cases
 */
```

## Test File Structure

```
src/
  utils/
    validator.ts
    calculator.ts
  services/
    userService.ts
  models/
    ShoppingCart.ts
  components/
    Counter.tsx

tests/
  utils/
    validator.test.ts
    calculator.test.ts
  services/
    userService.test.ts
  models/
    ShoppingCart.test.ts
  components/
    Counter.test.tsx
```

## Test Generation Script

```typescript
// scripts/generate-tests.ts
import * as fs from "fs";
import * as path from "path";

function generateTestTemplate(filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  const className = fileName.charAt(0).toUpperCase() + fileName.slice(1);

  return `
import { describe, it, expect } from 'vitest';
import { ${className} } from '@/${filePath}';

describe('${className}', () => {
  describe('happy path', () => {
    it('should handle typical case', () => {
      // Arrange
      const input = /* TODO */;

      // Act
      const result = ${className}(input);

      // Assert
      expect(result).toBe(/* TODO */);
    });
  });

  describe('edge cases', () => {
    it('should handle null input', () => {
      // Arrange
      const input = null;

      // Act & Assert
      expect(() => ${className}(input)).toThrow();
    });

    it('should handle empty input', () => {
      // Arrange
      const input = '';

      // Act
      const result = ${className}(input);

      // Assert
      expect(result).toBe(/* TODO */);
    });
  });

  describe('error cases', () => {
    it('should throw error for invalid input', () => {
      // Arrange
      const input = /* TODO */;

      // Act & Assert
      expect(() => ${className}(input)).toThrow('Invalid input');
    });
  });
});
  `.trim();
}
```

## Best Practices

1. **AAA pattern**: Arrange-Act-Assert structure
2. **One assertion per test**: Keep tests focused
3. **Descriptive names**: "should [expected behavior] when [condition]"
4. **Test edge cases**: null, undefined, empty, max values
5. **Test errors**: Verify error handling
6. **Isolated tests**: No shared state between tests
7. **Fast tests**: Unit tests should run in milliseconds

## Output Checklist

- [ ] Test file created matching source structure
- [ ] AAA pattern used consistently
- [ ] Happy path cases covered
- [ ] Edge cases identified and tested
- [ ] Error cases tested
- [ ] Async functions tested with proper awaits
- [ ] Mocks used for dependencies
- [ ] Coverage notes documented
- [ ] Descriptive test names
- [ ] Setup/teardown hooks used appropriately
