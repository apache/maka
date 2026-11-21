---
name: coverage-strategist
description: Defines ROI-based coverage targets with critical path identification, layer-specific targets, and explicit "don't test this" guidelines. Use for "test coverage", "coverage strategy", "test priorities", or "coverage targets".
---

# Coverage Strategist

Define pragmatic, ROI-focused test coverage strategies.

## Coverage Philosophy

**Goal**: Maximum confidence with minimum tests

**Principle**: 100% coverage is not the goal. Test what matters.

## Critical Path Identification

```typescript
// Critical paths that MUST be tested
const criticalPaths = {
  authentication: {
    priority: "P0",
    coverage: "100%",
    paths: [
      "User login flow",
      "User registration",
      "Password reset",
      "Token refresh",
      "Session management",
    ],
    reasoning: "Security critical, impacts all users",
  },

  checkout: {
    priority: "P0",
    coverage: "100%",
    paths: ["Add to cart", "Update cart", "Apply coupon", "Process payment", "Order confirmation"],
    reasoning: "Revenue critical, business essential",
  },

  dataIntegrity: {
    priority: "P0",
    coverage: "100%",
    paths: ["User data CRUD", "Order creation", "Inventory updates", "Database transactions"],
    reasoning: "Data corruption would be catastrophic",
  },
};

// Important but not critical
const importantPaths = {
  userProfile: {
    priority: "P1",
    coverage: "80%",
    paths: ["Profile updates", "Avatar upload", "Preferences"],
    reasoning: "Important UX, but not business critical",
  },

  search: {
    priority: "P1",
    coverage: "70%",
    paths: ["Product search", "Filters", "Sorting"],
    reasoning: "Enhances experience, not essential",
  },
};
```

## Layer-Specific Targets

```markdown
# Coverage Targets by Layer

## Business Logic / Core Functions: 90-100%

**Why**: High ROI - complex logic, many edge cases
**What to test**:

- Calculations
- Validations
- State machines
- Algorithms
- Data transformations

## API Endpoints: 80-90%

**Why**: Critical integration points
**What to test**:

- Happy paths
- Error cases
- Validation
- Authentication
- Authorization

## Database Layer: 70-80%

**Why**: Data integrity matters
**What to test**:

- CRUD operations
- Transactions
- Constraints
- Migrations

## UI Components: 50-70%

**Why**: Lower ROI - visual changes, less critical
**What to test**:

- User interactions
- State changes
- Error states
- Critical flows only

## Utils/Helpers: 80-90%

**Why**: Reused everywhere, high impact
**What to test**:

- All public functions
- Edge cases
- Error handling
```

## "Don't Test This" List

```typescript
// Explicit list of what NOT to test

const dontTestThese = {
  externalLibraries: {
    examples: ["React internals", "Next.js router", "Lodash functions"],
    reasoning: "Already tested by library authors",
  },

  trivialCode: {
    examples: ["Simple getters/setters", "Constants", "Type definitions", "Pass-through functions"],
    reasoning: "No logic to test, waste of time",
  },

  presentationalComponents: {
    examples: ["Simple buttons", "Icons", "Layout wrappers"],
    reasoning: "Visual regression testing more appropriate",
  },

  configurationFiles: {
    examples: ["webpack.config.js", "next.config.js"],
    reasoning: "Configuration, not logic",
  },

  mockData: {
    examples: ["Fixtures", "Test data", "Storybook stories"],
    reasoning: "Not production code",
  },
};

// Example: Don't test trivial code
// ❌ Don't test this
class User {
  constructor(private name: string) {}
  getName() {
    return this.name;
  } // Trivial getter
}

// ✅ But DO test this
class User {
  constructor(private name: string) {}

  getDisplayName() {
    // Business logic
    return this.name
      .split(" ")
      .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
      .join(" ");
  }
}
```

## Test Priority Matrix

```typescript
interface TestPriority {
  feature: string;
  businessImpact: "high" | "medium" | "low";
  complexity: "high" | "medium" | "low";
  changeFrequency: "high" | "medium" | "low";
  priority: "P0" | "P1" | "P2" | "P3";
  targetCoverage: string;
}

const testPriorities: TestPriority[] = [
  {
    feature: "Payment processing",
    businessImpact: "high",
    complexity: "high",
    changeFrequency: "low",
    priority: "P0",
    targetCoverage: "100%",
  },
  {
    feature: "User authentication",
    businessImpact: "high",
    complexity: "medium",
    changeFrequency: "low",
    priority: "P0",
    targetCoverage: "100%",
  },
  {
    feature: "Product search",
    businessImpact: "medium",
    complexity: "medium",
    changeFrequency: "medium",
    priority: "P1",
    targetCoverage: "80%",
  },
  {
    feature: "UI themes",
    businessImpact: "low",
    complexity: "low",
    changeFrequency: "high",
    priority: "P3",
    targetCoverage: "30%",
  },
];

// Priority calculation
function calculatePriority(
  businessImpact: number, // 1-10
  complexity: number, // 1-10
  changeFrequency: number, // 1-10
): number {
  return businessImpact * 0.5 + complexity * 0.3 + changeFrequency * 0.2;
}
```

## Coverage Configuration

```javascript
// jest.config.js
module.exports = {
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/*.stories.tsx", // Don't count stories
    "!src/mocks/**", // Don't count mocks
    "!src/**/__tests__/**", // Don't count tests
  ],

  coverageThresholds: {
    global: {
      statements: 70,
      branches: 65,
      functions: 70,
      lines: 70,
    },
    // Critical paths: 90%+
    "./src/services/payment/**/*.ts": {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
    "./src/services/auth/**/*.ts": {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
    // Utils: 80%+
    "./src/utils/**/*.ts": {
      statements: 80,
      branches: 75,
      functions: 80,
      lines: 80,
    },
    // UI components: 50%+ (lower bar)
    "./src/components/**/*.tsx": {
      statements: 50,
      branches: 45,
      functions: 50,
      lines: 50,
    },
  },
};
```

## Test Investment ROI

```typescript
// Calculate ROI of testing
interface TestROI {
  feature: string;
  testingCost: number; // hours
  bugPreventionValue: number; // estimated $ saved
  roi: number; // ratio
}

const testROI: TestROI[] = [
  {
    feature: "Payment processing",
    testingCost: 40, // hours
    bugPreventionValue: 50000, // Could lose $50k revenue
    roi: 1250, // $1,250 per hour invested
  },
  {
    feature: "Authentication",
    testingCost: 20,
    bugPreventionValue: 10000, // Security breach cost
    roi: 500,
  },
  {
    feature: "Theme switcher",
    testingCost: 5,
    bugPreventionValue: 100, // Minor UX issue
    roi: 20,
  },
];

// Focus on high ROI tests
const sortedByROI = testROI.sort((a, b) => b.roi - a.roi);
```

## Pragmatic Testing Strategy

```markdown
# Testing Strategy Document

## Principles

1. **Business value first**: Test what breaks the business
2. **Edge cases over happy path**: Happy path is obvious
3. **Integration over unit**: Test how pieces work together
4. **Critical flows end-to-end**: User journeys matter most

## Test Types Distribution

- 70% Unit tests (fast, isolated)
- 20% Integration tests (API + DB)
- 10% E2E tests (critical flows only)

## Coverage Goals

- Overall: 70% (pragmatic goal)
- Critical business logic: 90%+
- API endpoints: 80%+
- UI components: 50%+ (user interactions only)

## What NOT to Test

- Third-party libraries
- Trivial getters/setters
- Pure presentational components
- Configuration files
- Mock data and fixtures

## Review Criteria

Before writing a test, ask:

1. What bug would this test prevent?
2. How likely is that bug?
3. How costly would that bug be?
4. Is this already covered by integration tests?

If ROI is low, skip the test.
```

## Team Guidelines

```typescript
// Code review checklist for test coverage

const reviewChecklist = {
  criticalPath: {
    question: "Does this change affect a critical path?",
    ifYes: "MUST have comprehensive tests (90%+)",
  },

  businessLogic: {
    question: "Is this complex business logic?",
    ifYes: "MUST have unit tests with edge cases",
  },

  apiEndpoint: {
    question: "Is this a new API endpoint?",
    ifYes: "MUST have integration tests",
  },

  uiComponent: {
    question: "Is this a UI component?",
    ifYes: "Optional - test interactions only",
  },

  bugFix: {
    question: "Is this a bug fix?",
    ifYes: "MUST have regression test",
  },
};
```

## Best Practices

1. **Focus on risk**: Test what could go wrong
2. **Diminishing returns**: 100% coverage has low ROI
3. **Integration over unit**: Test behavior, not implementation
4. **Critical paths first**: Payment, auth, data integrity
5. **Explicit "don't test"**: Be intentional about skipping
6. **Review regularly**: Adjust targets quarterly
7. **Measure bugs**: Track if tests catch real issues

## Output Checklist

- [ ] Critical paths identified
- [ ] Layer-specific targets defined
- [ ] "Don't test this" list created
- [ ] Priority matrix established
- [ ] Coverage thresholds configured
- [ ] ROI analysis performed
- [ ] Testing strategy documented
- [ ] Team guidelines defined
