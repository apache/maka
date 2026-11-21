---
name: flaky-test-detective
description: Diagnoses and fixes flaky tests by identifying root causes (timing issues, shared state, randomness, network dependencies) and provides stabilization strategies. Use for "flaky tests", "test stability", "intermittent failures", or "test debugging".
---

# Flaky Test Detective

Diagnose and eliminate flaky tests systematically.

## Common Flaky Test Patterns

### 1. Timing Issues

```typescript
// ❌ Flaky: Race condition
test("should load user data", async () => {
  render(<UserProfile userId="123" />);

  // Race condition - might pass or fail
  expect(screen.getByText("John Doe")).toBeInTheDocument();
});

// ✅ Fixed: Wait for element
test("should load user data", async () => {
  render(<UserProfile userId="123" />);

  await waitFor(() => {
    expect(screen.getByText("John Doe")).toBeInTheDocument();
  });
});

// ❌ Flaky: Fixed timeout
test("should complete animation", async () => {
  render(<AnimatedComponent />);
  await new Promise((resolve) => setTimeout(resolve, 500)); // Brittle!
  expect(element).toHaveClass("animated");
});

// ✅ Fixed: Wait for condition
test("should complete animation", async () => {
  render(<AnimatedComponent />);
  await waitFor(
    () => {
      expect(element).toHaveClass("animated");
    },
    { timeout: 2000 }
  );
});
```

### 2. Shared State

```typescript
// ❌ Flaky: Global state pollution
let userId = "123";

test("test A", () => {
  userId = "456"; // Modifies global
  // ...
});

test("test B", () => {
  expect(userId).toBe("123"); // Fails if test A runs first!
});

// ✅ Fixed: Isolated state
test("test A", () => {
  const userId = "456"; // Local variable
  // ...
});

test("test B", () => {
  const userId = "123";
  expect(userId).toBe("123");
});

// ❌ Flaky: Database not cleaned
test("should create user", async () => {
  await db.user.create({ email: "test@example.com" });
  // No cleanup!
});

test("should create another user", async () => {
  await db.user.create({ email: "test@example.com" }); // Fails! Duplicate
});

// ✅ Fixed: Proper cleanup
afterEach(async () => {
  await db.user.deleteMany();
});
```

### 3. Randomness

```typescript
// ❌ Flaky: Random data
test("should sort users", () => {
  const users = generateRandomUsers(10); // Different each time!
  const sorted = sortUsers(users);
  expect(sorted[0].name).toBe("Alice"); // Might not be Alice
});

// ✅ Fixed: Deterministic data
test("should sort users", () => {
  const users = [
    { name: "Charlie", age: 30 },
    { name: "Alice", age: 25 },
    { name: "Bob", age: 35 },
  ];
  const sorted = sortUsers(users);
  expect(sorted[0].name).toBe("Alice");
});

// ✅ Fixed: Seeded randomness
import { faker } from "@faker-js/faker";

beforeEach(() => {
  faker.seed(12345); // Same data every time
});
```

### 4. Network Dependencies

```typescript
// ❌ Flaky: Real API call
test("should fetch users", async () => {
  const users = await fetchUsers(); // External API!
  expect(users).toHaveLength(10); // Might fail if API down
});

// ✅ Fixed: Mocked API
test("should fetch users", async () => {
  server.use(
    http.get("/api/users", () => {
      return HttpResponse.json([
        { id: "1", name: "User 1" },
        { id: "2", name: "User 2" },
      ]);
    }),
  );

  const users = await fetchUsers();
  expect(users).toHaveLength(2);
});
```

## Flaky Test Detection Script

```typescript
// scripts/detect-flaky-tests.ts
import { execSync } from "child_process";

async function detectFlakyTests(iterations: number = 10) {
  const results = new Map<string, { passed: number; failed: number }>();

  for (let i = 0; i < iterations; i++) {
    console.log(`\nRun ${i + 1}/${iterations}`);

    try {
      const output = execSync("npm test -- --reporter=json", {
        encoding: "utf-8",
      });

      const testResults = JSON.parse(output);

      testResults.testResults.forEach((file: any) => {
        file.assertionResults.forEach((test: any) => {
          const key = `${file.name}::${test.fullName}`;
          const stats = results.get(key) || { passed: 0, failed: 0 };

          if (test.status === "passed") {
            stats.passed++;
          } else {
            stats.failed++;
          }

          results.set(key, stats);
        });
      });
    } catch (error) {
      console.error("Test run failed:", error);
    }
  }

  // Analyze results
  console.log("\n🔍 Flaky Test Report\n");

  const flakyTests: string[] = [];

  results.forEach((stats, testName) => {
    if (stats.failed > 0 && stats.passed > 0) {
      const failureRate = (stats.failed / iterations) * 100;
      console.log(`❌ FLAKY: ${testName}`);
      console.log(`   Passed: ${stats.passed}/${iterations}`);
      console.log(`   Failed: ${stats.failed}/${iterations}`);
      console.log(`   Failure rate: ${failureRate.toFixed(1)}%\n`);
      flakyTests.push(testName);
    }
  });

  if (flakyTests.length === 0) {
    console.log("✅ No flaky tests detected!");
  } else {
    console.log(`\n🚨 Found ${flakyTests.length} flaky tests`);
    process.exit(1);
  }
}

detectFlakyTests(20); // Run tests 20 times
```

## Root Cause Analysis

```typescript
// Framework for analyzing flaky tests
interface FlakyTestAnalysis {
  testName: string;
  failureRate: number;
  symptoms: string[];
  rootCause: "timing" | "state" | "randomness" | "network" | "unknown";
  recommendation: string;
}

function analyzeTest(testName: string, errorMessages: string[]): FlakyTestAnalysis {
  const analysis: FlakyTestAnalysis = {
    testName,
    failureRate: 0,
    symptoms: [],
    rootCause: "unknown",
    recommendation: "",
  };

  // Detect timing issues
  if (errorMessages.some((msg) => msg.includes("timeout") || msg.includes("not found"))) {
    analysis.symptoms.push("Timeout or element not found");
    analysis.rootCause = "timing";
    analysis.recommendation = "Add explicit waits using waitFor() or findBy* queries";
  }

  // Detect shared state
  if (
    errorMessages.some((msg) => msg.includes("already exists") || msg.includes("unique constraint"))
  ) {
    analysis.symptoms.push("Duplicate or existing data");
    analysis.rootCause = "state";
    analysis.recommendation = "Add beforeEach/afterEach cleanup or use unique test data";
  }

  // Detect randomness
  if (errorMessages.some((msg) => msg.includes("expected") && msg.includes("received"))) {
    analysis.symptoms.push("Inconsistent values");
    analysis.rootCause = "randomness";
    analysis.recommendation = "Use deterministic test data or seed random generators";
  }

  // Detect network issues
  if (errorMessages.some((msg) => msg.includes("network") || msg.includes("ECONNREFUSED"))) {
    analysis.symptoms.push("Network or connection errors");
    analysis.rootCause = "network";
    analysis.recommendation = "Mock all network requests using MSW or similar";
  }

  return analysis;
}
```

## Stabilization Guidelines

```typescript
// Test stability checklist
const stabilityChecklist = {
  timing: [
    "Use waitFor() instead of fixed timeouts",
    "Use findBy* queries (built-in waiting)",
    "Set appropriate timeout values",
    "Wait for loading states to disappear",
  ],
  state: [
    "Clear database before each test",
    "Reset mocks after each test",
    "Use test-specific data (unique IDs)",
    "Avoid global variables",
  ],
  randomness: [
    "Use fixed seed for random generators",
    "Use deterministic test data",
    "Avoid Date.now() - mock time instead",
    "Generate IDs deterministically",
  ],
  network: [
    "Mock all API calls",
    "Use MSW for HTTP mocking",
    "Avoid real external services",
    "Test network errors explicitly",
  ],
  parallelism: [
    "Use isolated databases per test worker",
    "Avoid port conflicts (random ports)",
    "Dont share file system state",
    "Use test.concurrent cautiously",
  ],
};
```

## Auto-Fix Patterns

```typescript
// Automated fixes for common issues

// Fix 1: Add waitFor to assertions
function addWaitFor(code: string): string {
  // Replace: expect(screen.getByText('...')).toBeInTheDocument()
  // With: await waitFor(() => expect(screen.getByText('...')).toBeInTheDocument())

  return code
    .replace(/expect\(screen\.getBy/g, "await waitFor(() => expect(screen.getBy")
    .replace(/\)\.toBeInTheDocument\(\)/g, ").toBeInTheDocument())");
}

// Fix 2: Replace getBy with findBy
function replaceGetByWithFindBy(code: string): string {
  return code.replace(/screen\.getBy/g, "await screen.findBy");
}

// Fix 3: Add cleanup
function addCleanup(code: string): string {
  if (!code.includes("afterEach")) {
    const insertPoint = code.indexOf("test(");
    return (
      code.slice(0, insertPoint) +
      "afterEach(async () => {\n  await cleanup();\n});\n\n" +
      code.slice(insertPoint)
    );
  }
  return code;
}
```

## Monitoring Flaky Tests in CI

```yaml
# .github/workflows/test-stability.yml
name: Test Stability

on:
  schedule:
    - cron: "0 2 * * *" # Run nightly

jobs:
  stability-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci

      - name: Run tests 20 times
        run: |
          for i in {1..20}; do
            echo "Run $i/20"
            npm test || echo "FAILED: Run $i"
          done

      - name: Analyze results
        run: npm run detect-flaky-tests
```

## Best Practices

1. **Explicit waits**: Never use sleep/timeout
2. **Clean state**: Reset between tests
3. **Deterministic data**: No randomness
4. **Mock external deps**: APIs, time, randomness
5. **Run tests multiple times**: Catch intermittent failures
6. **Isolate tests**: No shared state
7. **Monitor CI**: Track flaky test trends

## Output Checklist

- [ ] Common patterns identified
- [ ] Root cause analysis performed
- [ ] Timing issues fixed (waitFor)
- [ ] Shared state eliminated (cleanup)
- [ ] Randomness removed (fixed seeds)
- [ ] Network mocked (MSW)
- [ ] Detection script implemented
- [ ] Stabilization guidelines documented
- [ ] CI monitoring configured
