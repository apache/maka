---
name: snapshot-test-refactorer
description: Refactors brittle snapshot tests into resilient, focused assertions. Provides strategies for reducing snapshot size, extracting meaningful assertions, and maintaining snapshots. Use for "snapshot testing", "snapshot refactoring", "brittle tests", or "assertion improvement".
---

# Snapshot Test Refactorer

Replace brittle snapshots with meaningful, maintainable assertions.

## Problems with Snapshot Tests

```typescript
// ❌ Bad: Full component snapshot
test("renders UserProfile", () => {
  const { container } = render(<UserProfile user={mockUser} />);
  expect(container).toMatchSnapshot();
});

// Problems:
// 1. Fails on any change (even whitespace)
// 2. No clear intent
// 3. Hard to review diffs
// 4. Doesn't test behavior
// 5. Implementation coupled
```

## Refactoring Strategy

```typescript
// ✅ Good: Specific assertions
test("renders UserProfile with user data", () => {
  render(<UserProfile user={mockUser} />);

  // Test what matters
  expect(screen.getByText(mockUser.name)).toBeInTheDocument();
  expect(screen.getByText(mockUser.email)).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("src", mockUser.avatar);
});

test("shows edit button for own profile", () => {
  render(<UserProfile user={mockUser} isOwnProfile={true} />);

  expect(
    screen.getByRole("button", { name: "Edit Profile" })
  ).toBeInTheDocument();
});

test("hides edit button for other profiles", () => {
  render(<UserProfile user={mockUser} isOwnProfile={false} />);

  expect(
    screen.queryByRole("button", { name: "Edit Profile" })
  ).not.toBeInTheDocument();
});
```

## Inline Snapshots for Data

```typescript
// ❌ Bad: External snapshot file
test("formats user data", () => {
  const result = formatUser(mockUser);
  expect(result).toMatchSnapshot();
});

// ✅ Good: Inline snapshot (visible in code)
test("formats user data", () => {
  const result = formatUser(mockUser);
  expect(result).toMatchInlineSnapshot(`
    {
      "displayName": "John Doe",
      "initials": "JD",
      "memberSince": "2020-01-01",
    }
  `);
});
```

## Partial Snapshots

```typescript
// ❌ Bad: Snapshot entire API response
test("fetches user", async () => {
  const response = await api.getUser("123");
  expect(response).toMatchSnapshot();
});

// ✅ Good: Test important parts
test("fetches user with required fields", async () => {
  const response = await api.getUser("123");

  expect(response).toMatchObject({
    id: "123",
    email: expect.stringContaining("@"),
    role: expect.any(String),
  });

  // Snapshot only stable, important data
  expect({
    name: response.name,
    role: response.role,
  }).toMatchInlineSnapshot(`
    {
      "name": "John Doe",
      "role": "USER",
    }
  `);
});
```

## Serializer for Unstable Data

```typescript
// Remove unstable fields before snapshot
expect.addSnapshotSerializer({
  test: (val) => val && typeof val === "object" && "createdAt" in val,
  serialize: (val) => {
    const { createdAt, updatedAt, ...rest } = val;
    return JSON.stringify(rest, null, 2);
  },
});

// Now timestamps won't break tests
test("creates user", async () => {
  const user = await createUser({ name: "Test" });

  expect(user).toMatchInlineSnapshot(`
    {
      "id": "123",
      "name": "Test",
      "role": "USER"
    }
  `);
  // createdAt automatically removed
});
```

## Snapshot Trimming Strategy

```typescript
// Before: 500 line snapshot
expect(component).toMatchSnapshot();

// After: Focus on critical parts
const criticalElements = {
  header: screen.getByRole("banner").textContent,
  mainAction: screen.getByRole("button", { name: /submit/i }).textContent,
  errorMessage: screen.queryByRole("alert")?.textContent,
};

expect(criticalElements).toMatchInlineSnapshot(`
  {
    "errorMessage": null,
    "header": "Welcome",
    "mainAction": "Submit",
  }
`);
```

## Visual Regression Alternative

```typescript
// Instead of DOM snapshot, use visual regression
test("Profile component appearance", async ({ page }) => {
  await page.goto("/profile");

  // Visual snapshot (Playwright)
  await expect(page).toHaveScreenshot("profile.png", {
    maxDiffPixels: 100,
  });
});
```

## When Snapshots Are Acceptable

```typescript
// ✅ OK: Error messages (rarely change)
test("validates email format", () => {
  const errors = validateEmail("invalid");
  expect(errors).toMatchInlineSnapshot(`
    [
      "Email must contain @",
      "Email must contain domain",
    ]
  `);
});

// ✅ OK: API response structure (stable contract)
test("user API response structure", async () => {
  const response = await api.getUser("123");

  expect(Object.keys(response).sort()).toMatchInlineSnapshot(`
    [
      "createdAt",
      "email",
      "id",
      "name",
      "role",
      "updatedAt",
    ]
  `);
});

// ✅ OK: Serialized data format
test("exports user to JSON", () => {
  const json = exportUserToJSON(user);
  expect(json).toMatchInlineSnapshot(`
    {
      "email": "john@example.com",
      "name": "John Doe",
      "version": "1.0",
    }
  `);
});
```

## Refactoring Process

```markdown
# Snapshot Refactoring Checklist

For each snapshot test, ask:

1. **What is being tested?**

   - If unclear → Replace with specific assertions

2. **Does it test behavior or implementation?**

   - Implementation → Refactor to behavior test

3. **How often does this change?**

   - Frequently → Use targeted assertions
   - Rarely → Snapshot OK

4. **Can I describe what should pass/fail?**

   - No → Snapshot is too broad

5. **Would a visual test be better?**
   - UI appearance → Use screenshot testing

## Refactoring Steps

1. Run snapshot test, let it fail
2. Look at the diff
3. Extract what actually matters
4. Write assertion for that specific thing
5. Delete snapshot
6. Repeat for next snapshot
```

## Example Refactoring

```typescript
// ❌ Before: Brittle 200-line snapshot
test("renders dashboard", () => {
  const { container } = render(<Dashboard user={user} />);
  expect(container).toMatchSnapshot();
});

// ✅ After: Multiple focused tests
describe("Dashboard", () => {
  test("displays welcome message with user name", () => {
    render(<Dashboard user={user} />);
    expect(screen.getByText(`Welcome back, ${user.name}!`)).toBeInTheDocument();
  });

  test("shows user stats", () => {
    render(<Dashboard user={user} stats={mockStats} />);

    expect(screen.getByText(`${mockStats.orders} orders`)).toBeInTheDocument();
    expect(screen.getByText(`$${mockStats.revenue}`)).toBeInTheDocument();
  });

  test("displays quick actions", () => {
    render(<Dashboard user={user} />);

    expect(
      screen.getByRole("button", { name: "New Order" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Reports" })
    ).toBeInTheDocument();
  });

  test("shows empty state when no recent activity", () => {
    render(<Dashboard user={user} recentActivity={[]} />);

    expect(screen.getByText("No recent activity")).toBeInTheDocument();
  });
});
```

## Automated Conversion Script

```typescript
// scripts/convert-snapshots.ts
import * as fs from "fs";
import * as path from "path";

function convertSnapshotToAssertions(testFile: string): string {
  let content = fs.readFileSync(testFile, "utf-8");

  // Replace toMatchSnapshot() with specific assertions
  content = content.replace(/expect\((.+?)\)\.toMatchSnapshot\(\)/g, (match, element) => {
    return `// TODO: Replace with specific assertions
// expect(${element}).to... `;
  });

  return content;
}
```

## Maintenance Strategy

```markdown
# Snapshot Maintenance Guidelines

## When to Update Snapshots

✅ **Update when:**

- Intentional design change
- New feature added
- Bug fix that changes output
- Refactoring that changes structure

❌ **Don't update when:**

- "Jest said to update"
- Test is failing
- Don't understand the change
- Too lazy to investigate

## Review Process

1. Run `jest -u` to update
2. Review EVERY changed snapshot
3. Verify change is intentional
4. If unsure, ask for review
5. Consider if assertion would be better

## Reduce Snapshot Size

- Use `.toMatchObject()` for partial matches
- Extract only relevant data
- Use serializers to remove noise
- Consider inline snapshots
```

## Best Practices

1. **Inline snapshots**: More visible and reviewable
2. **Small snapshots**: Snapshot only what matters
3. **Stable data**: Remove timestamps, IDs
4. **Clear intent**: Test name explains what's captured
5. **Visual regression**: For UI appearance
6. **Regular review**: Quarterly snapshot audit
7. **Specific assertions**: Prefer over snapshots

## Output Checklist

- [ ] Brittle snapshots identified
- [ ] Refactored to specific assertions
- [ ] Inline snapshots where appropriate
- [ ] Unstable data removed (serializers)
- [ ] Partial snapshots for data structures
- [ ] Visual regression for UI
- [ ] Maintenance guidelines documented
- [ ] Review process established
