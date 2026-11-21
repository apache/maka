---
name: performance-budget-setter
description: Defines measurable performance budgets for bundle size, API latency, database queries, and render times. Provides enforcement strategies and monitoring plans. Use for "performance budgets", "performance monitoring", "web vitals", or "optimization targets".
---

# Performance Budget Setter

Set and enforce performance budgets to maintain fast user experiences.

## Performance Budget Template

```markdown
# Performance Budget: E-Commerce Website

## Bundle Size Budget

| Asset Type             | Budget     | Current    | Status |
| ---------------------- | ---------- | ---------- | ------ |
| Initial JS             | 200 KB     | 185 KB     | ✅     |
| Initial CSS            | 50 KB      | 48 KB      | ✅     |
| Vendor JS              | 150 KB     | 145 KB     | ✅     |
| Fonts                  | 100 KB     | 95 KB      | ✅     |
| Images (above fold)    | 300 KB     | 320 KB     | ❌     |
| **Total Initial Load** | **800 KB** | **793 KB** | ✅     |

## API Latency Budget

| Endpoint       | p50    | p95    | p99     |
| -------------- | ------ | ------ | ------- |
| GET /products  | <100ms | <300ms | <500ms  |
| POST /checkout | <200ms | <500ms | <1000ms |
| GET /search    | <150ms | <400ms | <800ms  |

## Database Query Budget

| Query Type       | Budget | Current |
| ---------------- | ------ | ------- |
| Simple reads     | <50ms  | 42ms    |
| Complex joins    | <200ms | 185ms   |
| Aggregations     | <500ms | 450ms   |
| Queries per page | <20    | 18      |

## Core Web Vitals

| Metric                         | Good   | Poor   | Target |
| ------------------------------ | ------ | ------ | ------ |
| LCP (Largest Contentful Paint) | <2.5s  | >4.0s  | <2.0s  |
| FID (First Input Delay)        | <100ms | >300ms | <50ms  |
| CLS (Cumulative Layout Shift)  | <0.1   | >0.25  | <0.05  |

## Page-Specific Budgets

### Homepage

- Time to Interactive: <3s
- Total Blocking Time: <300ms
- Speed Index: <3s

### Product Page

- Time to Interactive: <4s
- Images loaded: <2s
- Reviews section: <1s

### Checkout

- Time to Interactive: <3s
- Payment processing: <2s
- Zero layout shifts

## Third-Party Scripts

| Service     | Budget     | Purpose          |
| ----------- | ---------- | ---------------- |
| Analytics   | 30 KB      | Google Analytics |
| Chat Widget | 50 KB      | Customer support |
| Payment     | 100 KB     | Stripe           |
| **Total**   | **180 KB** |                  |
```

## Enforcement Strategy

### 1. CI/CD Integration

```yaml
# .github/workflows/performance-budget.yml
name: Performance Budget Check

on: [pull_request]

jobs:
  budget-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Build production bundle
        run: npm run build

      - name: Check bundle size
        run: |
          npx bundlesize

      - name: Lighthouse CI
        run: |
          npm install -g @lhci/cli
          lhci autorun
```

### 2. Webpack Bundle Analyzer

```javascript
// webpack.config.js
const BundleAnalyzerPlugin = require("webpack-bundle-analyzer").BundleAnalyzerPlugin;

module.exports = {
  plugins: [
    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE ? "server" : "disabled",
    }),
  ],
  performance: {
    hints: "error",
    maxAssetSize: 200000, // 200 KB
    maxEntrypointSize: 400000, // 400 KB
  },
};
```

### 3. package.json Configuration

```json
{
  "bundlesize": [
    {
      "path": "./dist/js/main.*.js",
      "maxSize": "200 KB"
    },
    {
      "path": "./dist/css/main.*.css",
      "maxSize": "50 KB"
    },
    {
      "path": "./dist/js/vendor.*.js",
      "maxSize": "150 KB"
    }
  ]
}
```

## Monitoring Plan

### Real User Monitoring (RUM)

```typescript
// Track Core Web Vitals
import { getCLS, getFID, getFCP, getLCP, getTTFB } from "web-vitals";

function sendToAnalytics(metric) {
  const body = JSON.stringify(metric);

  if (navigator.sendBeacon) {
    navigator.sendBeacon("/analytics", body);
  } else {
    fetch("/analytics", { body, method: "POST", keepalive: true });
  }
}

getCLS(sendToAnalytics);
getFID(sendToAnalytics);
getLCP(sendToAnalytics);
```

### Synthetic Monitoring

```bash
# Lighthouse CI
lhci autorun --config=.lighthouserc.json

# WebPageTest API
curl "https://www.webpagetest.org/runtest.php?url=https://example.com&k=API_KEY"
```

### Performance Dashboard

```markdown
**Daily Metrics:**

- Bundle size trend
- API latency percentiles
- Core Web Vitals scores
- Page load times

**Alerts:**

- Bundle size exceeds budget by 10%
- LCP >2.5s for >5% of users
- API p95 >500ms
- Any metric exceeds budget
```

## Optimization Strategies

### Reduce Bundle Size

```typescript
// Code splitting
const ProductPage = lazy(() => import("./ProductPage"));

// Tree shaking
import { specific } from "library"; // ✅
import * as library from "library"; // ❌

// Dynamic imports
if (featureFlag) {
  const module = await import("./feature");
}
```

### Optimize API Calls

```typescript
// Parallel requests
const [user, orders] = await Promise.all([fetchUser(id), fetchOrders(id)]);

// Caching
const cachedData = await redis.get(key);
if (cachedData) return cachedData;

// Pagination
const products = await db.products
  .find()
  .limit(20)
  .skip((page - 1) * 20);
```

### Optimize Database Queries

```sql
-- Add indexes
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);

-- Limit columns
SELECT id, name FROM products; -- ✅
SELECT * FROM products;        -- ❌

-- Use EXPLAIN
EXPLAIN ANALYZE SELECT ...;
```

## Budget Violation Response

### When Budget Exceeded

1. **Immediate:**

   - Block PR from merging
   - Notify team in Slack
   - Create ticket

2. **Within 24 hours:**

   - Investigate cause
   - Identify optimization opportunities
   - Propose fix or budget increase

3. **Decision:**
   - Fix code (preferred)
   - Increase budget (requires justification)

### Budget Increase Request Template

```markdown
## Budget Increase Request

**Component:** Main JS bundle
**Current Budget:** 200 KB
**Requested Budget:** 250 KB
**Reason:** Added critical feature X

**Impact Analysis:**

- Load time increase: +0.5s
- User impact: Medium
- Revenue impact: Unknown

**Alternatives Considered:**

1. Code splitting: Reduces to 210 KB (preferred)
2. Remove feature Y: Reduces to 195 KB (rejected)
3. Lazy loading: Complex, 3 weeks effort

**Recommendation:** Implement code splitting
```

## Best Practices

1. **Set realistic budgets**: Based on user data
2. **Enforce in CI**: Automated checks
3. **Monitor continuously**: RUM + synthetic
4. **Review quarterly**: Adjust as needed
5. **Prioritize UX**: User-centric metrics
6. **Document exceptions**: Why budget increased
7. **Celebrate wins**: When under budget

## Output Checklist

- [ ] Bundle size budgets defined
- [ ] API latency targets set
- [ ] Database query budgets
- [ ] Core Web Vitals targets
- [ ] Page-specific budgets
- [ ] CI/CD enforcement configured
- [ ] Monitoring dashboard
- [ ] Alert thresholds set
- [ ] Violation response process
- [ ] Regular review schedule
