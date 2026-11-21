---
name: background-jobs-designer
description: Designs background job processing systems with queue integration (BullMQ/Celery), job definitions, retry policies, exponential backoff, idempotent execution, and monitoring hooks. Use when implementing "background jobs", "task queues", "async processing", or "job workers".
---

# Background Jobs Designer

Design reliable background job processing with retries and monitoring.

## Queue Integration

**BullMQ (Node.js)**:

```typescript
import { Queue, Worker } from "bullmq";

const emailQueue = new Queue("email", {
  connection: { host: "localhost", port: 6379 },
});

// Add job
await emailQueue.add(
  "send-welcome",
  {
    userId: "123",
    email: "user@example.com",
  },
  {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
);
```

**Celery (Python)**:

```python
from celery import Celery

app = Celery('tasks', broker='redis://localhost:6379')

@app.task(bind=True, max_retries=3)
def send_email(self, user_id, email):
    try:
        # Send email
        pass
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)
```

## Job Definitions

```typescript
export interface Job {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  processedAt?: Date;
  failedAt?: Date;
  error?: string;
}

export const JOB_TYPES = {
  SEND_EMAIL: "send-email",
  PROCESS_PAYMENT: "process-payment",
  GENERATE_REPORT: "generate-report",
  SYNC_DATA: "sync-data",
} as const;
```

## Retry Strategy

```typescript
// Exponential backoff
const RETRY_CONFIG = {
  maxAttempts: 5,
  delays: [
    1000, // 1 second
    5000, // 5 seconds
    30000, // 30 seconds
    300000, // 5 minutes
    1800000, // 30 minutes
  ],
};

// Worker with retry
const worker = new Worker("email", async (job) => {
  try {
    await sendEmail(job.data);
  } catch (error) {
    if (job.attemptsMade < RETRY_CONFIG.maxAttempts) {
      throw error; // Will retry
    }
    await handleFailedJob(job, error);
  }
});
```

## Idempotent Jobs

```typescript
// Track processed jobs
export const processJob = async (job: Job) => {
  // Check if already processed
  const processed = await db.query("SELECT 1 FROM processed_jobs WHERE job_id = $1", [job.id]);

  if (processed.rows.length > 0) {
    console.log("Job already processed");
    return; // Idempotent
  }

  await db.transaction(async (trx) => {
    // Mark as processed
    await trx("processed_jobs").insert({ job_id: job.id });

    // Do work
    await performWork(job, trx);
  });
};
```

## Monitoring

```typescript
// Job events
worker.on("completed", (job) => {
  metrics.increment("jobs.completed", { type: job.name });
});

worker.on("failed", (job, err) => {
  metrics.increment("jobs.failed", { type: job.name });
  logger.error("Job failed", { jobId: job.id, error: err });
});

worker.on("stalled", (jobId) => {
  metrics.increment("jobs.stalled");
  logger.warn("Job stalled", { jobId });
});
```

## Best Practices

- Jobs should be idempotent
- Use exponential backoff for retries
- Set reasonable timeouts
- Monitor queue depth
- Dead letter queue for failed jobs
- Log job start/completion
- Graceful shutdown handling

## Output Checklist

- [ ] Queue setup (Redis/RabbitMQ)
- [ ] Job type definitions
- [ ] Retry policy with backoff
- [ ] Idempotency tracking
- [ ] Error handling
- [ ] Monitoring/metrics
- [ ] Dead letter queue
- [ ] Graceful shutdown
