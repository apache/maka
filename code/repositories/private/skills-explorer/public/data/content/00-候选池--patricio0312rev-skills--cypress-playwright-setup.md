---
name: cypress-playwright-setup
description: Sets up end-to-end testing with Cypress or Playwright including page objects, fixtures, and CI integration. Use when users request "E2E testing", "Cypress setup", "Playwright setup", "browser testing", or "integration tests".
---

# Cypress & Playwright Setup

Configure comprehensive end-to-end testing for web applications.

## Core Workflow

1. **Choose tool**: Cypress or Playwright
2. **Configure project**: Browser and test settings
3. **Create page objects**: Reusable selectors
4. **Write tests**: User journey coverage
5. **Setup fixtures**: Test data
6. **Integrate CI**: Automated testing

## Playwright Setup

### Installation

```bash
npm init playwright@latest
```

### Configuration

```typescript
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html"],
    ["json", { outputFile: "test-results/results.json" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],

  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
    },
  ],

  webServer: {
    command: "npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
```

### Page Object Model

```typescript
// e2e/pages/BasePage.ts
import { Page, Locator } from "@playwright/test";

export abstract class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(path: string = "") {
    await this.page.goto(path);
  }

  async waitForLoad() {
    await this.page.waitForLoadState("networkidle");
  }

  getByTestId(testId: string): Locator {
    return this.page.getByTestId(testId);
  }
}
```

```typescript
// e2e/pages/LoginPage.ts
import { Page, Locator, expect } from "@playwright/test";
import { BasePage } from "./BasePage";

export class LoginPage extends BasePage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly forgotPasswordLink: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByLabel("Email");
    this.passwordInput = page.getByLabel("Password");
    this.submitButton = page.getByRole("button", { name: "Sign in" });
    this.errorMessage = page.getByTestId("error-message");
    this.forgotPasswordLink = page.getByRole("link", { name: "Forgot password?" });
  }

  async goto() {
    await super.goto("/login");
    await this.waitForLoad();
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async expectError(message: string) {
    await expect(this.errorMessage).toBeVisible();
    await expect(this.errorMessage).toContainText(message);
  }

  async expectLoginSuccess() {
    await expect(this.page).toHaveURL(/\/dashboard/);
  }
}
```

```typescript
// e2e/pages/DashboardPage.ts
import { Page, Locator, expect } from "@playwright/test";
import { BasePage } from "./BasePage";

export class DashboardPage extends BasePage {
  readonly welcomeMessage: Locator;
  readonly userMenu: Locator;
  readonly logoutButton: Locator;
  readonly sidebar: Locator;

  constructor(page: Page) {
    super(page);
    this.welcomeMessage = page.getByTestId("welcome-message");
    this.userMenu = page.getByTestId("user-menu");
    this.logoutButton = page.getByRole("button", { name: "Logout" });
    this.sidebar = page.getByTestId("sidebar");
  }

  async goto() {
    await super.goto("/dashboard");
    await this.waitForLoad();
  }

  async logout() {
    await this.userMenu.click();
    await this.logoutButton.click();
    await expect(this.page).toHaveURL("/login");
  }

  async expectWelcome(name: string) {
    await expect(this.welcomeMessage).toContainText(`Welcome, ${name}`);
  }
}
```

### Test Examples

```typescript
// e2e/auth.spec.ts
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";

test.describe("Authentication", () => {
  let loginPage: LoginPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    await loginPage.goto();
  });

  test("successful login", async ({ page }) => {
    await loginPage.login("test@example.com", "password123");
    await loginPage.expectLoginSuccess();

    const dashboard = new DashboardPage(page);
    await dashboard.expectWelcome("Test User");
  });

  test("invalid credentials", async () => {
    await loginPage.login("test@example.com", "wrongpassword");
    await loginPage.expectError("Invalid email or password");
  });

  test("empty fields validation", async () => {
    await loginPage.submitButton.click();
    await expect(loginPage.page.getByText("Email is required")).toBeVisible();
    await expect(loginPage.page.getByText("Password is required")).toBeVisible();
  });

  test("forgot password flow", async ({ page }) => {
    await loginPage.forgotPasswordLink.click();
    await expect(page).toHaveURL("/forgot-password");
  });
});
```

### Fixtures

```typescript
// e2e/fixtures/auth.fixture.ts
import { test as base, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";
import { DashboardPage } from "../pages/DashboardPage";

interface AuthFixtures {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  authenticatedPage: DashboardPage;
}

export const test = base.extend<AuthFixtures>({
  loginPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    await use(loginPage);
  },

  dashboardPage: async ({ page }, use) => {
    const dashboardPage = new DashboardPage(page);
    await use(dashboardPage);
  },

  authenticatedPage: async ({ page }, use) => {
    // Login before test
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("test@example.com", "password123");
    await loginPage.expectLoginSuccess();

    const dashboardPage = new DashboardPage(page);
    await use(dashboardPage);
  },
});

export { expect };
```

```typescript
// e2e/dashboard.spec.ts
import { test, expect } from "./fixtures/auth.fixture";

test.describe("Dashboard", () => {
  test("shows user data", async ({ authenticatedPage }) => {
    await authenticatedPage.expectWelcome("Test User");
  });

  test("logout redirects to login", async ({ authenticatedPage }) => {
    await authenticatedPage.logout();
  });
});
```

## Cypress Setup

### Installation

```bash
npm install -D cypress @testing-library/cypress
npx cypress open
```

### Configuration

```typescript
// cypress.config.ts
import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    viewportWidth: 1280,
    viewportHeight: 720,
    video: true,
    screenshotOnRunFailure: true,
    retries: {
      runMode: 2,
      openMode: 0,
    },
    experimentalStudio: true,
    setupNodeEvents(on, config) {
      // Tasks and plugins
    },
  },

  component: {
    devServer: {
      framework: "react",
      bundler: "vite",
    },
  },
});
```

### Support Commands

```typescript
// cypress/support/commands.ts
import "@testing-library/cypress/add-commands";

declare global {
  namespace Cypress {
    interface Chainable {
      login(email: string, password: string): Chainable<void>;
      getByTestId(testId: string): Chainable<JQuery<HTMLElement>>;
      mockApi(fixture: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add("login", (email: string, password: string) => {
  cy.session([email, password], () => {
    cy.visit("/login");
    cy.get('[data-testid="email-input"]').type(email);
    cy.get('[data-testid="password-input"]').type(password);
    cy.get('[data-testid="submit-button"]').click();
    cy.url().should("include", "/dashboard");
  });
});

Cypress.Commands.add("getByTestId", (testId: string) => {
  return cy.get(`[data-testid="${testId}"]`);
});

Cypress.Commands.add("mockApi", (fixture: string) => {
  cy.intercept("GET", "/api/**", { fixture }).as("apiCall");
});
```

### Cypress Tests

```typescript
// cypress/e2e/auth.cy.ts
describe("Authentication", () => {
  beforeEach(() => {
    cy.visit("/login");
  });

  it("logs in successfully", () => {
    cy.get('[data-testid="email-input"]').type("test@example.com");
    cy.get('[data-testid="password-input"]').type("password123");
    cy.get('[data-testid="submit-button"]').click();

    cy.url().should("include", "/dashboard");
    cy.getByTestId("welcome-message").should("contain", "Welcome");
  });

  it("shows error for invalid credentials", () => {
    cy.get('[data-testid="email-input"]').type("test@example.com");
    cy.get('[data-testid="password-input"]').type("wrongpassword");
    cy.get('[data-testid="submit-button"]').click();

    cy.getByTestId("error-message").should("be.visible");
    cy.url().should("include", "/login");
  });

  it("validates required fields", () => {
    cy.get('[data-testid="submit-button"]').click();
    cy.contains("Email is required").should("be.visible");
    cy.contains("Password is required").should("be.visible");
  });
});
```

### API Mocking in Cypress

```typescript
// cypress/e2e/products.cy.ts
describe("Products", () => {
  beforeEach(() => {
    cy.login("test@example.com", "password123");
  });

  it("displays products from API", () => {
    cy.intercept("GET", "/api/products", {
      fixture: "products.json",
    }).as("getProducts");

    cy.visit("/products");
    cy.wait("@getProducts");

    cy.getByTestId("product-card").should("have.length", 3);
  });

  it("handles API error gracefully", () => {
    cy.intercept("GET", "/api/products", {
      statusCode: 500,
      body: { error: "Server Error" },
    }).as("getProductsError");

    cy.visit("/products");
    cy.wait("@getProductsError");

    cy.getByTestId("error-message").should("contain", "Failed to load products");
  });

  it("filters products", () => {
    cy.intercept("GET", "/api/products?category=electronics", {
      fixture: "products-electronics.json",
    }).as("getElectronics");

    cy.visit("/products");
    cy.getByTestId("category-filter").select("electronics");

    cy.wait("@getElectronics");
    cy.getByTestId("product-card").should("have.length", 2);
  });
});
```

## CI Integration

### GitHub Actions

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  playwright:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"

      - run: npm ci

      - name: Install Playwright Browsers
        run: npx playwright install --with-deps

      - name: Build
        run: npm run build

      - name: Run Playwright tests
        run: npx playwright test
        env:
          CI: true

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30

  cypress:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "npm"

      - run: npm ci

      - name: Cypress run
        uses: cypress-io/github-action@v6
        with:
          build: npm run build
          start: npm start
          wait-on: "http://localhost:3000"
          browser: chrome
          record: true
        env:
          CYPRESS_RECORD_KEY: ${{ secrets.CYPRESS_RECORD_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: cypress-screenshots
          path: cypress/screenshots
```

## Accessibility Testing

```typescript
// e2e/accessibility.spec.ts (Playwright)
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Accessibility", () => {
  test("homepage has no accessibility violations", async ({ page }) => {
    await page.goto("/");

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test("login page has no accessibility violations", async ({ page }) => {
    await page.goto("/login");

    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
```

```typescript
// cypress/e2e/accessibility.cy.ts
import "cypress-axe";

describe("Accessibility", () => {
  beforeEach(() => {
    cy.injectAxe();
  });

  it("homepage has no accessibility violations", () => {
    cy.visit("/");
    cy.checkA11y();
  });

  it("login form is accessible", () => {
    cy.visit("/login");
    cy.checkA11y('[data-testid="login-form"]');
  });
});
```

## Best Practices

1. **Use page objects**: Maintainable selectors
2. **Use test IDs**: Stable element selection
3. **Avoid sleep**: Use proper waits
4. **Isolate tests**: No dependencies between tests
5. **Mock external APIs**: Reliable, fast tests
6. **Test accessibility**: Include a11y checks
7. **Parallel execution**: Faster CI
8. **Meaningful assertions**: Clear expectations

## Output Checklist

Every E2E setup should include:

- [ ] Playwright/Cypress configuration
- [ ] Page object model
- [ ] Custom commands/fixtures
- [ ] API mocking setup
- [ ] Authentication handling
- [ ] Multi-browser testing
- [ ] Accessibility tests
- [ ] CI integration
- [ ] Reporting configuration
- [ ] Screenshot/video on failure
