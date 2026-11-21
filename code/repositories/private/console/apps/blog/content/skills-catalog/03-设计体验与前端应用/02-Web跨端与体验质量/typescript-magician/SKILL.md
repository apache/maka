---
name: typescript-magician
description: Designs complex generic types, refactors `any` types to strict alternatives, creates type guards and utility types, and resolves TypeScript compiler errors. Use when the user asks about TypeScript (TS) types, generics, type inference, type guards, removing `any` types, strict typing, type errors, `infer`, `extends`, conditional types, mapped types, template literal types, branded/opaque types, or utility types like `Partial`, `Record`, `ReturnType`, and `Awaited`.
metadata:
  tags: typescript, types, generics, type-safety, advanced-typescript
---

## When to use

Use this skill for:
- TypeScript errors and type challenges
- Eliminating `any` types from codebases
- Complex generics and type inference issues
- When strict typing is needed

## Instructions

When invoked:
1. Run `tsc --noEmit` to capture the full error output before making changes
2. Identify the root cause of type issues (unsound inference, missing constraints, implicit `any`, etc.)
3. Craft precise, type-safe solutions using advanced TypeScript features
4. Eliminate all `any` types with proper typing — validate each replacement still satisfies call sites
5. Confirm the fix compiles cleanly with a second `tsc --noEmit` pass

Capabilities include:
- Advanced generics and conditional types
- Template literal types and mapped types
- Utility types and type manipulation
- Brand types and nominal typing
- Complex inference patterns
- Variance and distribution rules
- Module augmentation and declaration merging

For every TypeScript challenge:
- Explain the type theory behind the problem
- Provide multiple solution approaches when applicable
- Show before/after type representations
- Include comprehensive type tests
- Ensure full IntelliSense support

## Quick Examples

### Eliminating `any` with generics

**Before**
```ts
function getProperty(obj: any, key: string): any {
  return obj[key];
}
```

**After**
```ts
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
// getProperty({ name: "Alice" }, "name") → inferred as string ✓
```

### Narrowing an unknown API response

**Before**
```ts
async function fetchUser(): Promise<any> {
  const res = await fetch("/api/user");
  return res.json();
}
```

**After**
```ts
interface User { id: number; name: string }

function isUser(value: unknown): value is User {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value
  );
}

async function fetchUser(): Promise<User> {
  const res = await fetch("/api/user");
  const data: unknown = await res.json();
  if (!isUser(data)) throw new Error("Invalid user shape");
  return data;
}
```

## Reference

Read individual rule files for detailed explanations and code examples:

### Core Patterns
- [rules/as-const-typeof.md](rules/as-const-typeof.md) - Deriving types from runtime values using `as const` and `typeof`
- [rules/array-index-access.md](rules/array-index-access.md) - Accessing array element types using `[number]` indexing
- [rules/utility-types.md](rules/utility-types.md) - Built-in utility types: Parameters, ReturnType, Awaited, Omit, Partial, Record

### Advanced Generics
- [rules/generics-basics.md](rules/generics-basics.md) - Fundamentals of generic types, constraints, and inference
- [rules/builder-pattern.md](rules/builder-pattern.md) - Type-safe builder pattern with chainable methods
- [rules/deep-inference.md](rules/deep-inference.md) - Achieving deep type inference with F.Narrow and const type parameters

### Type-Level Programming
- [rules/conditional-types.md](rules/conditional-types.md) - Conditional types for type-level if/else logic
- [rules/infer-keyword.md](rules/infer-keyword.md) - Using `infer` to extract types within conditional types
- [rules/template-literal-types.md](rules/template-literal-types.md) - String manipulation at the type level
- [rules/mapped-types.md](rules/mapped-types.md) - Creating new types by transforming existing type properties

### Type Safety Patterns
- [rules/opaque-types.md](rules/opaque-types.md) - Brand types and opaque types for type-safe identifiers
- [rules/type-narrowing.md](rules/type-narrowing.md) - Narrowing types through control flow analysis
- [rules/function-overloads.md](rules/function-overloads.md) - Using function overloads for complex function signatures

### Debugging
- [rules/error-diagnosis.md](rules/error-diagnosis.md) - Strategies for diagnosing and understanding TypeScript type errors
