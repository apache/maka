---
name: test-reporting-triage-skill
description: Automatically categorizes test failures, suggests responsible owners, and provides common fix checklists. Generates actionable test reports with failure analysis. Use for "test reporting", "failure triage", "test analysis", or "test automation".
---

# Test Reporting & Triage Skill

Automatically triage test failures and suggest next actions.

## Failure Categorization

```typescript
// types/test-failure.ts
export type FailureCategory =
  | "timeout"
  | "assertion"
  | "network"
  | "database"
  | "authentication"
  | "permission"
  | "configuration"
  | "flaky"
  | "infrastructure"
  | "unknown";

export interface TestFailure {
  testName: string;
  category: FailureCategory;
  errorMessage: string;
  stackTrace: string;
  suggestedOwner: string;
  suggestedFixes: string[];
  runId: string;
  timestamp: Date;
}
```

## Failure Analyzer

```typescript
// analyzers/failure-analyzer.ts
export class FailureAnalyzer {
  categorize(error: Error, testName: string): TestFailure {
    const errorMessage = error.message.toLowerCase();
    const stackTrace = error.stack || "";

    // Timeout detection
    if (errorMessage.includes("timeout") || errorMessage.includes("exceeded")) {
      return {
        testName,
        category: "timeout",
        errorMessage: error.message,
        stackTrace,
        suggestedOwner: "Performance Team",
        suggestedFixes: [
          "Check if API is slow",
          "Increase timeout value",
          "Optimize database query",
          "Check for network issues",
        ],
        runId: process.env.CI_RUN_ID || "local",
        timestamp: new Date(),
      };
    }

    // Network errors
    if (
      errorMessage.includes("econnrefused") ||
      errorMessage.includes("network") ||
      errorMessage.includes("fetch failed")
    ) {
      return {
        testName,
        category: "network",
        errorMessage: error.message,
        stackTrace,
        suggestedOwner: "DevOps Team",
        suggestedFixes: [
          "Check if service is running",
          "Verify network connectivity",
          "Check firewall rules",
          "Verify DNS resolution",
        ],
        runId: process.env.CI_RUN_ID || "local",
        timestamp: new Date(),
      };
    }

    // Database errors
    if (
      errorMessage.includes("database") ||
      errorMessage.includes("prisma") ||
      errorMessage.includes("unique constraint")
    ) {
      return {
        testName,
        category: "database",
        errorMessage: error.message,
        stackTrace,
        suggestedOwner: "Backend Team",
        suggestedFixes: [
          "Check database connection",
          "Verify test data cleanup",
          "Check for race conditions",
          "Review migration status",
        ],
        runId: process.env.CI_RUN_ID || "local",
        timestamp: new Date(),
      };
    }

    // Authentication errors
    if (
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("authentication") ||
      errorMessage.includes("401")
    ) {
      return {
        testName,
        category: "authentication",
        errorMessage: error.message,
        stackTrace,
        suggestedOwner: "Auth Team",
        suggestedFixes: [
          "Check auth token validity",
          "Verify test user credentials",
          "Check session expiration",
          "Review auth middleware",
        ],
        runId: process.env.CI_RUN_ID || "local",
        timestamp: new Date(),
      };
    }

    // Assertion failures
    if (errorMessage.includes("expected") && errorMessage.includes("received")) {
      return {
        testName,
        category: "assertion",
        errorMessage: error.message,
        stackTrace,
        suggestedOwner: this.determineOwnerFromPath(stackTrace),
        suggestedFixes: [
          "Review recent code changes",
          "Check if test expectations are correct",
          "Verify test data setup",
          "Check for breaking changes",
        ],
        runId: process.env.CI_RUN_ID || "local",
        timestamp: new Date(),
      };
    }

    // Default: unknown
    return {
      testName,
      category: "unknown",
      errorMessage: error.message,
      stackTrace,
      suggestedOwner: "On-Call Engineer",
      suggestedFixes: [
        "Review error message and stack trace",
        "Check recent commits",
        "Run test locally to reproduce",
        "Add more specific error handling",
      ],
      runId: process.env.CI_RUN_ID || "local",
      timestamp: new Date(),
    };
  }

  private determineOwnerFromPath(stackTrace: string): string {
    if (stackTrace.includes("/frontend/")) return "Frontend Team";
    if (stackTrace.includes("/backend/")) return "Backend Team";
    if (stackTrace.includes("/api/")) return "API Team";
    if (stackTrace.includes("/database/")) return "Database Team";
    return "Development Team";
  }
}
```

## Test Report Generator

```typescript
// reporters/test-report.ts
import { FailureAnalyzer } from "../analyzers/failure-analyzer";

export class TestReporter {
  private analyzer = new FailureAnalyzer();
  private failures: TestFailure[] = [];

  recordFailure(error: Error, testName: string) {
    const failure = this.analyzer.categorize(error, testName);
    this.failures.push(failure);
  }

  generateReport(): string {
    const grouped = this.groupByCategory();
    const report: string[] = [];

    report.push("# Test Failure Report\n");
    report.push(`Generated: ${new Date().toISOString()}\n`);
    report.push(`Total Failures: ${this.failures.length}\n\n`);

    // Summary by category
    report.push("## Summary by Category\n");
    Object.entries(grouped).forEach(([category, failures]) => {
      report.push(`- ${category}: ${failures.length} failures`);
    });
    report.push("\n");

    // Detailed failures
    report.push("## Detailed Failures\n\n");
    Object.entries(grouped).forEach(([category, failures]) => {
      report.push(`### ${category.toUpperCase()} (${failures.length})\n\n`);

      failures.forEach((failure, i) => {
        report.push(`#### ${i + 1}. ${failure.testName}\n`);
        report.push(`**Owner:** ${failure.suggestedOwner}\n\n`);
        report.push(`**Error:**\n\`\`\`\n${failure.errorMessage}\n\`\`\`\n\n`);
        report.push(`**Suggested Fixes:**\n`);
        failure.suggestedFixes.forEach((fix) => {
          report.push(`- ${fix}\n`);
        });
        report.push("\n");
      });
    });

    return report.join("");
  }

  generateSlackMessage(): string {
    const grouped = this.groupByCategory();
    const messages: string[] = [];

    messages.push("🔴 *Test Failures Detected*\n");
    messages.push(`Total: ${this.failures.length} failures\n`);

    Object.entries(grouped).forEach(([category, failures]) => {
      const icon = this.getCategoryIcon(category);
      messages.push(`${icon} ${category}: ${failures.length}`);
    });

    // Top 3 failures
    messages.push("\n*Top Failures:*");
    this.failures.slice(0, 3).forEach((failure, i) => {
      messages.push(`\n${i + 1}. \`${failure.testName}\``);
      messages.push(`   Owner: @${failure.suggestedOwner}`);
    });

    return messages.join("\n");
  }

  private groupByCategory(): Record<string, TestFailure[]> {
    return this.failures.reduce(
      (acc, failure) => {
        if (!acc[failure.category]) {
          acc[failure.category] = [];
        }
        acc[failure.category].push(failure);
        return acc;
      },
      {} as Record<string, TestFailure[]>,
    );
  }

  private getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      timeout: "⏱️",
      network: "🌐",
      database: "💾",
      authentication: "🔐",
      assertion: "❌",
      flaky: "🔄",
      infrastructure: "🏗️",
      unknown: "❓",
    };
    return icons[category] || "❓";
  }
}
```

## Common Fix Checklists

```typescript
// checklists/fix-checklists.ts
export const fixChecklists = {
  timeout: {
    title: "Timeout Failure Checklist",
    steps: [
      "☐ Check if the timeout is too short",
      "☐ Verify API response time in logs",
      "☐ Check database query performance",
      "☐ Look for network latency issues",
      "☐ Verify no infinite loops or deadlocks",
      "☐ Check if external services are slow",
      "☐ Consider increasing timeout temporarily",
      "☐ Optimize slow code path if confirmed slow",
    ],
  },

  flaky: {
    title: "Flaky Test Checklist",
    steps: [
      "☐ Run test 10 times locally",
      "☐ Check for race conditions",
      "☐ Verify proper test cleanup",
      "☐ Look for timing dependencies",
      "☐ Check for shared state between tests",
      "☐ Verify no randomness in test data",
      "☐ Check for network/external dependencies",
      "☐ Add explicit waits where needed",
    ],
  },

  database: {
    title: "Database Error Checklist",
    steps: [
      "☐ Verify database is running",
      "☐ Check connection string",
      "☐ Verify test database cleanup",
      "☐ Check for constraint violations",
      "☐ Look for migration issues",
      "☐ Verify proper transaction handling",
      "☐ Check for concurrent access issues",
      "☐ Review recent schema changes",
    ],
  },

  assertion: {
    title: "Assertion Failure Checklist",
    steps: [
      "☐ Review what changed in recent commits",
      "☐ Verify test expectations are still valid",
      "☐ Check if feature requirements changed",
      "☐ Run test locally to reproduce",
      "☐ Check test data setup",
      "☐ Verify mocks are up to date",
      "☐ Review API contract changes",
      "☐ Update test if behavior change is intentional",
    ],
  },
};
```

## CI Integration

```yaml
# .github/workflows/test-report.yml
name: Test Report

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  report:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}

    steps:
      - uses: actions/checkout@v4

      - name: Download test results
        uses: actions/download-artifact@v4
        with:
          name: test-results

      - name: Generate report
        run: npm run analyze-failures

      - name: Post to Slack
        uses: slackapi/slack-github-action@v1
        with:
          channel-id: "test-failures"
          payload: ${{ steps.analyze.outputs.slack_message }}
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

      - name: Create GitHub Issue
        uses: actions/github-script@v7
        with:
          script: |
            const report = require('./test-report.json');
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `Test Failures - ${new Date().toISOString()}`,
              body: report.markdown,
              labels: ['test-failure', 'automated'],
            });
```

## Dashboard Metrics

```typescript
// dashboard/test-metrics.ts
export interface TestMetrics {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failureRate: number;

  failuresByCategory: Record<FailureCategory, number>;
  failuresByOwner: Record<string, number>;
  flakyTests: string[];
  slowTests: Array<{ name: string; duration: number }>;
}

export function generateMetrics(results: TestResult[]): TestMetrics {
  const failures = results.filter((r) => r.status === "failed");
  const analyzer = new FailureAnalyzer();

  const categorized = failures.map((f) => analyzer.categorize(f.error, f.testName));

  return {
    totalTests: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: failures.length,
    skipped: results.filter((r) => r.status === "skipped").length,
    duration: results.reduce((sum, r) => sum + r.duration, 0),
    failureRate: (failures.length / results.length) * 100,

    failuresByCategory: categorized.reduce(
      (acc, f) => {
        acc[f.category] = (acc[f.category] || 0) + 1;
        return acc;
      },
      {} as Record<FailureCategory, number>,
    ),

    failuresByOwner: categorized.reduce(
      (acc, f) => {
        acc[f.suggestedOwner] = (acc[f.suggestedOwner] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),

    flakyTests: identifyFlakyTests(results),
    slowTests: results
      .filter((r) => r.duration > 5000)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10),
  };
}
```

## Best Practices

1. **Auto-categorize**: Classify failures automatically
2. **Suggest owners**: Route to right team
3. **Actionable fixes**: Provide clear next steps
4. **Track trends**: Monitor failure patterns
5. **Notify quickly**: Slack/email on failures
6. **Create issues**: Auto-file for persistent failures
7. **Dashboard**: Visual metrics for team

## Output Checklist

- [ ] Failure categorization logic
- [ ] Owner assignment rules
- [ ] Fix checklists per category
- [ ] Report generation (Markdown/Slack)
- [ ] CI integration
- [ ] GitHub issue creation
- [ ] Slack notifications
- [ ] Dashboard metrics
- [ ] Trend analysis
- [ ] Flaky test detection
