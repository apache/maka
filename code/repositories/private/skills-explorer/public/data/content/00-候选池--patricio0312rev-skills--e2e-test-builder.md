---
name: e2e-test-builder
description: Builds end-to-end browser tests for critical user flows using Playwright or Cypress. Includes selector strategies, test data management, page objects, and visual regression testing. Use for "E2E testing", "browser tests", "Playwright", or "Cypress tests".
---

# E2E Test Builder

Build reliable end-to-end tests for critical user flows.

## Playwright Test Setup

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
```

## Critical Flow Tests

```typescript
// e2e/checkout-flow.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Checkout Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to home page
    await page.goto("/");

    // Login
    await page.getByRole("button", { name: "Login" }).click();
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign In" }).click();

    // Wait for dashboard
    await expect(page).toHaveURL("/dashboard");
  });

  test("should complete checkout successfully", async ({ page }) => {
    // 1. Browse products
    await page.getByRole("link", { name: "Products" }).click();
    await expect(page).toHaveURL("/products");

    // 2. Add product to cart
    await page.getByRole("button", { name: "Add to Cart" }).first().click();
    await expect(page.getByText("Added to cart")).toBeVisible();

    // 3. Go to cart
    await page.getByRole("link", { name: "Cart" }).click();
    await expect(page).toHaveURL("/cart");
    await expect(page.getByRole("heading", { name: "Shopping Cart" })).toBeVisible();

    // 4. Proceed to checkout
    await page.getByRole("button", { name: "Checkout" }).click();
    await expect(page).toHaveURL("/checkout");

    // 5. Fill shipping information
    await page.getByLabel("Full Name").fill("John Doe");
    await page.getByLabel("Address").fill("123 Main St");
    await page.getByLabel("City").fill("New York");
    await page.getByLabel("ZIP Code").fill("10001");

    // 6. Fill payment information
    await page.getByLabel("Card Number").fill("4242424242424242");
    await page.getByLabel("Expiry Date").fill("12/25");
    await page.getByLabel("CVC").fill("123");

    // 7. Place order
    await page.getByRole("button", { name: "Place Order" }).click();

    // 8. Verify success
    await expect(page).toHaveURL(/\/order\/\d+/);
    await expect(page.getByText("Order confirmed!")).toBeVisible();
    await expect(page.getByText(/Order #\d+/)).toBeVisible();
  });

  test("should show validation errors for empty fields", async ({ page }) => {
    // Navigate to checkout
    await page.goto("/checkout");

    // Try to submit without filling fields
    await page.getByRole("button", { name: "Place Order" }).click();

    // Verify validation errors
    await expect(page.getByText("Name is required")).toBeVisible();
    await expect(page.getByText("Address is required")).toBeVisible();
    await expect(page.getByText("Card number is required")).toBeVisible();
  });

  test("should handle payment failure", async ({ page }) => {
    // Add product and go to checkout
    await page.goto("/products");
    await page.getByRole("button", { name: "Add to Cart" }).first().click();
    await page.goto("/checkout");

    // Fill with failing card number
    await page.getByLabel("Card Number").fill("4000000000000002");
    await page.getByLabel("Expiry Date").fill("12/25");
    await page.getByLabel("CVC").fill("123");

    // Submit
    await page.getByRole("button", { name: "Place Order" }).click();

    // Verify error message
    await expect(page.getByText("Payment failed")).toBeVisible();
    await expect(page.getByText("Please try a different card")).toBeVisible();
  });
});
```

## Page Object Pattern

```typescript
// e2e/pages/LoginPage.ts
export class LoginPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/login");
  }

  async login(email: string, password: string) {
    await this.page.getByLabel("Email").fill(email);
    await this.page.getByLabel("Password").fill(password);
    await this.page.getByRole("button", { name: "Sign In" }).click();
  }

  async expectLoginSuccess() {
    await expect(this.page).toHaveURL("/dashboard");
  }

  async expectLoginError(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}

// e2e/pages/ProductPage.ts
export class ProductPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto("/products");
  }

  async addToCart(productName: string) {
    const product = this.page.locator(`[data-product="${productName}"]`);
    await product.getByRole("button", { name: "Add to Cart" }).click();
  }

  async expectProductVisible(productName: string) {
    await expect(this.page.getByRole("heading", { name: productName })).toBeVisible();
  }
}

// Usage in tests
test("should login and add product", async ({ page }) => {
  const loginPage = new LoginPage(page);
  const productPage = new ProductPage(page);

  await loginPage.goto();
  await loginPage.login("test@example.com", "password123");
  await loginPage.expectLoginSuccess();

  await productPage.goto();
  await productPage.addToCart("MacBook Pro");
});
```

## Selector Strategy

```typescript
// Preferred selector priority:
// 1. Role-based (most resilient)
await page.getByRole("button", { name: "Submit" });
await page.getByRole("link", { name: "Products" });
await page.getByRole("textbox", { name: "Email" });

// 2. Label-based (semantic)
await page.getByLabel("Email address");
await page.getByLabel("Password");

// 3. Test ID (for complex cases)
await page.getByTestId("user-menu");
await page.getByTestId("product-card-123");

// 4. Text content (for unique text)
await page.getByText("Welcome back!");
await page.getByText(/Order #\d+/);

// ❌ Avoid: CSS selectors (brittle)
// await page.locator('.btn.btn-primary');
// await page.locator('#submit-button');
```

## Test Data Management

```typescript
// e2e/fixtures/test-data.ts
export const testData = {
  users: {
    admin: {
      email: "admin@example.com",
      password: "admin123",
    },
    customer: {
      email: "customer@example.com",
      password: "customer123",
    },
  },
  products: {
    laptop: {
      name: "MacBook Pro",
      price: 2499.99,
    },
    phone: {
      name: "iPhone 15",
      price: 999.99,
    },
  },
  cards: {
    valid: "4242424242424242",
    declined: "4000000000000002",
    insufficientFunds: "4000000000009995",
  },
};

// e2e/setup/seed-test-data.ts
export async function seedTestData() {
  const prisma = new PrismaClient();

  // Create test users
  await prisma.user.upsert({
    where: { email: testData.users.customer.email },
    create: {
      email: testData.users.customer.email,
      password: await hash(testData.users.customer.password),
    },
    update: {},
  });

  // Create test products
  await prisma.product.upsert({
    where: { name: testData.products.laptop.name },
    create: testData.products.laptop,
    update: {},
  });

  await prisma.$disconnect();
}
```

## Visual Regression Testing

```typescript
// e2e/visual/homepage.spec.ts
test("homepage should match screenshot", async ({ page }) => {
  await page.goto("/");

  // Take full page screenshot
  await expect(page).toHaveScreenshot("homepage.png", {
    fullPage: true,
    maxDiffPixels: 100, // Allow minor differences
  });
});

test("product card should match screenshot", async ({ page }) => {
  await page.goto("/products");

  const productCard = page.locator('[data-testid="product-card"]').first();

  // Take element screenshot
  await expect(productCard).toHaveScreenshot("product-card.png");
});
```

## Mobile Testing

```typescript
// e2e/mobile/checkout-mobile.spec.ts
test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

test("should complete mobile checkout", async ({ page }) => {
  await page.goto("/");

  // Open mobile menu
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("link", { name: "Products" }).click();

  // Add to cart
  await page.getByRole("button", { name: "Add to Cart" }).first().click();

  // Continue with checkout
  // ...
});
```

## Network Mocking

```typescript
// e2e/mocked/payment-api.spec.ts
test("should handle payment API timeout", async ({ page }) => {
  // Mock slow payment API
  await page.route("**/api/payment", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ success: true }),
    });
  });

  // Proceed with checkout
  await page.goto("/checkout");
  // ... fill form ...
  await page.getByRole("button", { name: "Place Order" }).click();

  // Should show loading state
  await expect(page.getByText("Processing payment...")).toBeVisible();
});
```

## Best Practices

1. **Test user flows**: Not individual components
2. **Use role-based selectors**: More resilient
3. **Page objects**: Reusable and maintainable
4. **Wait for elements**: Don't use fixed sleeps
5. **Test critical paths**: Login, checkout, signup
6. **Manage test data**: Isolated per test
7. **Visual regression**: Key pages only

## Output Checklist

- [ ] Playwright/Cypress configured
- [ ] Critical flows identified
- [ ] Page objects created
- [ ] Selector strategy defined (role-based)
- [ ] Test data management
- [ ] Setup/teardown hooks
- [ ] Authentication flow tested
- [ ] Error states tested
- [ ] Mobile viewport tests
- [ ] CI integration configured
