---
name: load-test-scenario-builder
description: Creates comprehensive load test plans with realistic scenarios, traffic models, k6 scripts, and success criteria. Use for "load testing", "performance testing", "capacity validation", or "stress testing".
---

# Load Test Scenario Builder

Validate system capacity with realistic load tests.

## Load Test Scenarios

```typescript
interface LoadTestScenario {
  name: string;
  description: string;
  virtualUsers: number;
  duration: string;
  rampUp: string;
  successCriteria: {
    p95Latency: number;
    errorRate: number;
    throughput: number;
  };
}

const scenarios: LoadTestScenario[] = [
  {
    name: "Baseline Load",
    description: "Normal traffic pattern",
    virtualUsers: 100,
    duration: "10m",
    rampUp: "2m",
    successCriteria: {
      p95Latency: 500, // ms
      errorRate: 0.01, // 1%
      throughput: 1000, // req/s
    },
  },
  {
    name: "Peak Load",
    description: "Black Friday traffic",
    virtualUsers: 1000,
    duration: "30m",
    rampUp: "5m",
    successCriteria: {
      p95Latency: 2000,
      errorRate: 0.05,
      throughput: 5000,
    },
  },
  {
    name: "Stress Test",
    description: "Find breaking point",
    virtualUsers: 5000,
    duration: "20m",
    rampUp: "10m",
    successCriteria: {
      p95Latency: 5000,
      errorRate: 0.1,
      throughput: 10000,
    },
  },
];
```

## K6 Load Test Script

```javascript
// load-tests/checkout-flow.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export let options = {
  stages: [
    { duration: "2m", target: 100 }, // Ramp up
    { duration: "10m", target: 100 }, // Stay at 100
    { duration: "2m", target: 0 }, // Ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"], // 95% under 500ms
    errors: ["rate<0.01"], // Error rate <1%
  },
};

export default function () {
  // 1. Browse products
  let browseRes = http.get("https://api.example.com/products");
  check(browseRes, {
    "browse status 200": (r) => r.status === 200,
  }) || errorRate.add(1);
  sleep(1);

  // 2. Add to cart
  let addCartRes = http.post(
    "https://api.example.com/cart",
    JSON.stringify({
      productId: "123",
      quantity: 1,
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
  check(addCartRes, {
    "add cart status 201": (r) => r.status === 201,
  }) || errorRate.add(1);
  sleep(2);

  // 3. Checkout
  let checkoutRes = http.post(
    "https://api.example.com/checkout",
    JSON.stringify({
      paymentMethod: "card",
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
  check(checkoutRes, {
    "checkout status 200": (r) => r.status === 200,
    "checkout success": (r) => r.json("status") === "success",
  }) || errorRate.add(1);
  sleep(3);
}
```

## Traffic Models

```javascript
// Realistic traffic patterns
export const trafficModels = {
  // Steady state
  steadyState: {
    stages: [{ duration: "30m", target: 500 }],
  },

  // Gradual ramp
  gradualRamp: {
    stages: [
      { duration: "5m", target: 100 },
      { duration: "5m", target: 300 },
      { duration: "5m", target: 500 },
      { duration: "10m", target: 500 },
      { duration: "5m", target: 0 },
    ],
  },

  // Spike test
  spikeTest: {
    stages: [
      { duration: "2m", target: 100 },
      { duration: "1m", target: 2000 }, // Sudden spike
      { duration: "2m", target: 100 },
    ],
  },

  // Soak test (endurance)
  soakTest: {
    stages: [
      { duration: "5m", target: 500 },
      { duration: "4h", target: 500 }, // Long duration
      { duration: "5m", target: 0 },
    ],
  },
};
```

## Success Thresholds

```javascript
export const thresholds = {
  // Latency
  http_req_duration: [
    "p(50)<200", // 50% under 200ms
    "p(95)<500", // 95% under 500ms
    "p(99)<1000", // 99% under 1s
  ],

  // Error rate
  http_req_failed: ["rate<0.01"], // <1% errors

  // Throughput
  http_reqs: ["rate>1000"], // >1000 req/s

  // Custom metrics
  checkout_duration: ["p(95)<2000"],
  checkout_success_rate: ["rate>0.95"],
};
```

## Running Load Tests

```bash
#!/bin/bash
# scripts/run-load-tests.sh

echo "Running load tests..."

# Baseline test
k6 run --vus 100 --duration 10m load-tests/checkout-flow.js

# Peak load test
k6 run --vus 1000 --duration 30m load-tests/checkout-flow.js

# Stress test (find breaking point)
k6 run --vus 5000 --duration 20m load-tests/stress-test.js

# Generate report
k6 run --out json=results.json load-tests/checkout-flow.js
k6 run --out influxdb=http://localhost:8086 load-tests/checkout-flow.js
```

## Result Analysis

```typescript
interface LoadTestResult {
  scenario: string;
  timestamp: Date;
  metrics: {
    p50Latency: number;
    p95Latency: number;
    p99Latency: number;
    errorRate: number;
    throughput: number;
    maxVUs: number;
  };
  passed: boolean;
  notes: string[];
}

function analyzeResults(results: LoadTestResult) {
  console.log(\`Load Test: \${results.scenario}\`);
  console.log(\`Status: \${results.passed ? '✅ PASS' : '❌ FAIL'}\`);
  console.log(\`p95 Latency: \${results.metrics.p95Latency}ms\`);
  console.log(\`Error Rate: \${(results.metrics.errorRate * 100).toFixed(2)}%\`);
  console.log(\`Throughput: \${results.metrics.throughput} req/s\`);

  if (!results.passed) {
    console.log('Failed criteria:');
    results.notes.forEach(note => console.log(\`  - \${note}\`));
  }
}
```

## Output Checklist

- [ ] Scenarios defined
- [ ] k6 scripts created
- [ ] Traffic models configured
- [ ] Success criteria set
- [ ] CI integration
- [ ] Results analysis
      ENDFILE
