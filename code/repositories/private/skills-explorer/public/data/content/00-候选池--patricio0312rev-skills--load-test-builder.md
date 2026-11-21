---
name: load-test-builder
description: Creates load and performance tests with k6, Artillery, or autocannon to validate system behavior under stress. Use when users request "load testing", "performance testing", "stress testing", "k6 setup", or "benchmark API".
---

# Load Test Builder

Validate system performance under realistic and stress conditions.

## Core Workflow

1. **Define scenarios**: User journeys and load patterns
2. **Set thresholds**: Performance requirements
3. **Configure load**: Ramp-up, peak, duration
4. **Run tests**: Execute load scenarios
5. **Analyze results**: Metrics and bottlenecks
6. **Integrate CI**: Automated performance gates

## k6 Load Testing

### Installation

```bash
# macOS
brew install k6

# Docker
docker pull grafana/k6
```

### Basic Load Test

```javascript
// load-tests/basic.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// Custom metrics
const errorRate = new Rate("errors");
const responseTime = new Trend("response_time");

// Test configuration
export const options = {
  stages: [
    { duration: "1m", target: 20 }, // Ramp up to 20 users
    { duration: "3m", target: 20 }, // Stay at 20 users
    { duration: "1m", target: 50 }, // Ramp up to 50 users
    { duration: "3m", target: 50 }, // Stay at 50 users
    { duration: "1m", target: 0 }, // Ramp down to 0
  ],
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  // Homepage
  const homeResponse = http.get(`${BASE_URL}/`);

  check(homeResponse, {
    "homepage status is 200": (r) => r.status === 200,
    "homepage loads fast": (r) => r.timings.duration < 500,
  });

  responseTime.add(homeResponse.timings.duration);
  errorRate.add(homeResponse.status !== 200);

  sleep(1);

  // API request
  const apiResponse = http.get(`${BASE_URL}/api/users`);

  check(apiResponse, {
    "api status is 200": (r) => r.status === 200,
    "api returns array": (r) => Array.isArray(JSON.parse(r.body)),
  });

  errorRate.add(apiResponse.status !== 200);

  sleep(Math.random() * 3 + 1); // Random think time 1-4 seconds
}
```

### User Journey Test

```javascript
// load-tests/user-journey.js
import http from "k6/http";
import { check, group, sleep } from "k6";
import { SharedArray } from "k6/data";

const users = new SharedArray("users", function () {
  return JSON.parse(open("./data/users.json"));
});

export const options = {
  scenarios: {
    browse_and_buy: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: "5m", target: 100 },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    "group_duration{group:::Login}": ["p(95)<2000"],
    "group_duration{group:::Browse Products}": ["p(95)<1000"],
    "group_duration{group:::Checkout}": ["p(95)<3000"],
    http_req_failed: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const user = users[Math.floor(Math.random() * users.length)];

  group("Login", function () {
    const loginRes = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({
        email: user.email,
        password: user.password,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    check(loginRes, {
      "login successful": (r) => r.status === 200,
      "has token": (r) => JSON.parse(r.body).token !== undefined,
    });

    if (loginRes.status !== 200) return;

    const token = JSON.parse(loginRes.body).token;

    group("Browse Products", function () {
      const productsRes = http.get(`${BASE_URL}/api/products`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      check(productsRes, {
        "products loaded": (r) => r.status === 200,
      });

      sleep(2);

      // View product detail
      const products = JSON.parse(productsRes.body);
      if (products.length > 0) {
        const productId = products[Math.floor(Math.random() * products.length)].id;
        const productRes = http.get(`${BASE_URL}/api/products/${productId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        check(productRes, {
          "product detail loaded": (r) => r.status === 200,
        });
      }
    });

    sleep(1);

    group("Checkout", function () {
      // Add to cart
      const cartRes = http.post(
        `${BASE_URL}/api/cart`,
        JSON.stringify({ productId: "1", quantity: 1 }),
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      check(cartRes, {
        "added to cart": (r) => r.status === 200 || r.status === 201,
      });

      // Checkout
      const checkoutRes = http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify({ paymentMethod: "card" }),
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      check(checkoutRes, {
        "checkout successful": (r) => r.status === 200 || r.status === 201,
      });
    });
  });

  sleep(Math.random() * 5 + 2);
}
```

### Stress Test

```javascript
// load-tests/stress.js
import http from "k6/http";
import { check } from "k6";

export const options = {
  stages: [
    { duration: "2m", target: 100 }, // Normal load
    { duration: "5m", target: 100 },
    { duration: "2m", target: 200 }, // High load
    { duration: "5m", target: 200 },
    { duration: "2m", target: 300 }, // Stress
    { duration: "5m", target: 300 },
    { duration: "2m", target: 400 }, // Breaking point
    { duration: "5m", target: 400 },
    { duration: "10m", target: 0 }, // Recovery
  ],
  thresholds: {
    http_req_duration: ["p(99)<1500"],
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  const response = http.get(`${__ENV.BASE_URL}/api/health`);

  check(response, {
    "status is 200": (r) => r.status === 200,
  });
}
```

### Spike Test

```javascript
// load-tests/spike.js
export const options = {
  stages: [
    { duration: "10s", target: 100 }, // Quick ramp
    { duration: "1m", target: 100 }, // Normal
    { duration: "10s", target: 1000 }, // Spike!
    { duration: "3m", target: 1000 }, // Stay at spike
    { duration: "10s", target: 100 }, // Scale down
    { duration: "3m", target: 100 }, // Recovery
    { duration: "10s", target: 0 }, // Ramp down
  ],
};
```

### Soak Test

```javascript
// load-tests/soak.js
export const options = {
  stages: [
    { duration: "5m", target: 100 }, // Ramp up
    { duration: "8h", target: 100 }, // Sustained load for 8 hours
    { duration: "5m", target: 0 }, // Ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};
```

## Artillery

### Installation

```bash
npm install -D artillery
```

### Configuration

```yaml
# artillery/load-test.yml
config:
  target: "http://localhost:3000"
  phases:
    - duration: 60
      arrivalRate: 5
      name: "Warm up"
    - duration: 120
      arrivalRate: 10
      name: "Normal load"
    - duration: 60
      arrivalRate: 50
      name: "Spike"
    - duration: 60
      arrivalRate: 10
      name: "Cool down"

  defaults:
    headers:
      Content-Type: "application/json"

  plugins:
    expect: {}

  ensure:
    p99: 500
    maxErrorRate: 1

scenarios:
  - name: "User Journey"
    flow:
      - get:
          url: "/"
          expect:
            - statusCode: 200
            - contentType: text/html

      - think: 2

      - get:
          url: "/api/products"
          expect:
            - statusCode: 200
          capture:
            - json: "$[0].id"
              as: "productId"

      - think: 1

      - get:
          url: "/api/products/{{ productId }}"
          expect:
            - statusCode: 200

      - post:
          url: "/api/cart"
          json:
            productId: "{{ productId }}"
            quantity: 1
          expect:
            - statusCode: 201
```

### With Custom Functions

```javascript
// artillery/processor.js
module.exports = {
  generateUser,
  logResponse,
  validateCheckout,
};

function generateUser(context, events, done) {
  context.vars.email = `user${Date.now()}@example.com`;
  context.vars.password = "testpassword123";
  return done();
}

function logResponse(requestParams, response, context, events, done) {
  console.log(`Response: ${response.statusCode} - ${response.body}`);
  return done();
}

function validateCheckout(requestParams, response, context, events, done) {
  const body = JSON.parse(response.body);
  if (!body.orderId) {
    return done(new Error("Missing orderId in response"));
  }
  context.vars.orderId = body.orderId;
  return done();
}
```

```yaml
# artillery/with-processor.yml
config:
  target: "http://localhost:3000"
  processor: "./processor.js"
  phases:
    - duration: 60
      arrivalRate: 10

scenarios:
  - name: "Checkout flow"
    flow:
      - function: "generateUser"
      - post:
          url: "/api/auth/register"
          json:
            email: "{{ email }}"
            password: "{{ password }}"
      - post:
          url: "/api/checkout"
          afterResponse: "validateCheckout"
```

## Autocannon (Node.js)

```typescript
// load-tests/autocannon.ts
import autocannon from "autocannon";

async function runLoadTest() {
  const result = await autocannon({
    url: "http://localhost:3000/api/users",
    connections: 100,
    duration: 30,
    pipelining: 10,
    headers: {
      "Content-Type": "application/json",
    },
    requests: [
      {
        method: "GET",
        path: "/api/users",
      },
      {
        method: "POST",
        path: "/api/users",
        body: JSON.stringify({ name: "Test", email: "test@example.com" }),
      },
    ],
  });

  console.log(autocannon.printResult(result));

  // Validate results
  if (result.latency.p99 > 500) {
    console.error("P99 latency exceeded 500ms");
    process.exit(1);
  }

  if (result.errors > 0) {
    console.error(`Errors detected: ${result.errors}`);
    process.exit(1);
  }
}

runLoadTest();
```

## CI Integration

```yaml
# .github/workflows/load-tests.yml
name: Load Tests

on:
  schedule:
    - cron: "0 2 * * *" # Daily at 2 AM
  workflow_dispatch:

jobs:
  load-test:
    runs-on: ubuntu-latest

    services:
      app:
        image: myapp:latest
        ports:
          - 3000:3000
        env:
          DATABASE_URL: postgresql://test@localhost/test

    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6

      - name: Wait for app
        run: |
          timeout 60 bash -c 'until curl -s http://localhost:3000/health; do sleep 1; done'

      - name: Run load tests
        run: k6 run --out json=results.json load-tests/basic.js
        env:
          BASE_URL: http://localhost:3000

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: load-test-results
          path: results.json

      - name: Comment on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('results.json', 'utf8'));
            // Parse and format results for PR comment
```

## Results Analysis

```javascript
// scripts/analyze-results.js
import fs from "fs";

const results = JSON.parse(fs.readFileSync("results.json", "utf8"));

const summary = {
  totalRequests: results.metrics.http_reqs.count,
  avgDuration: results.metrics.http_req_duration.avg,
  p95Duration: results.metrics.http_req_duration["p(95)"],
  p99Duration: results.metrics.http_req_duration["p(99)"],
  errorRate: results.metrics.http_req_failed.rate,
  throughput: results.metrics.http_reqs.rate,
};

console.table(summary);

// Check thresholds
const passed = summary.p95Duration < 500 && summary.p99Duration < 1000 && summary.errorRate < 0.01;

process.exit(passed ? 0 : 1);
```

## Best Practices

1. **Start small**: Gradually increase load
2. **Use realistic data**: Production-like scenarios
3. **Monitor everything**: Backend metrics too
4. **Set thresholds**: Define pass/fail criteria
5. **Test regularly**: Catch regressions early
6. **Isolate environment**: Dedicated test environment
7. **Document findings**: Track improvements
8. **Include think time**: Simulate real users

## Output Checklist

Every load test setup should include:

- [ ] k6/Artillery configuration
- [ ] Realistic user scenarios
- [ ] Multiple load patterns (normal, stress, spike)
- [ ] Performance thresholds
- [ ] Custom metrics
- [ ] CI integration
- [ ] Results analysis
- [ ] Soak test for memory leaks
- [ ] Documentation
- [ ] Baseline benchmarks
