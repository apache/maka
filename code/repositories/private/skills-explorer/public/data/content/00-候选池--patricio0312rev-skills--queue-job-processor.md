---
name: queue-job-processor
description: Implements background job processing with BullMQ/Redis including job queues, workers, scheduling, retries, and monitoring. Use when users request "background jobs", "queue processing", "async tasks", "BullMQ", or "job scheduler".
---

# Queue Job Processor

Build robust background job processing with BullMQ and Redis.

## Core Workflow

1. **Setup Redis**: Configure connection
2. **Create queues**: Define job queues
3. **Implement workers**: Process jobs
4. **Add job types**: Type-safe job definitions
5. **Configure retries**: Handle failures
6. **Add monitoring**: Dashboard and alerts

## Installation

```bash
npm install bullmq ioredis
npm install -D @types/ioredis
```

## Redis Connection

```typescript
// lib/redis.ts
import IORedis from "ioredis";

export const redis = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
});

export const redisSubscriber = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
```

## Queue Setup

### Define Job Types

```typescript
// jobs/types.ts
export interface EmailJobData {
  to: string;
  subject: string;
  template: string;
  variables: Record<string, string>;
}

export interface ImageProcessingJobData {
  imageId: string;
  userId: string;
  operations: Array<{
    type: "resize" | "crop" | "watermark";
    params: Record<string, any>;
  }>;
}

export interface ReportJobData {
  reportId: string;
  userId: string;
  type: "daily" | "weekly" | "monthly";
  dateRange: {
    start: string;
    end: string;
  };
}

export interface WebhookJobData {
  url: string;
  payload: Record<string, any>;
  headers?: Record<string, string>;
  retryCount?: number;
}

export type JobData =
  | { type: "email"; data: EmailJobData }
  | { type: "image-processing"; data: ImageProcessingJobData }
  | { type: "report"; data: ReportJobData }
  | { type: "webhook"; data: WebhookJobData };
```

### Create Queues

```typescript
// queues/index.ts
import { Queue, QueueOptions } from "bullmq";
import { redis } from "../lib/redis";
import { EmailJobData, ImageProcessingJobData, ReportJobData, WebhookJobData } from "./types";

const defaultOptions: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: {
      count: 1000, // Keep last 1000 completed jobs
      age: 24 * 3600, // Keep for 24 hours
    },
    removeOnFail: {
      count: 5000, // Keep last 5000 failed jobs
    },
  },
};

export const emailQueue = new Queue<EmailJobData>("email", defaultOptions);

export const imageQueue = new Queue<ImageProcessingJobData>("image-processing", {
  ...defaultOptions,
  defaultJobOptions: {
    ...defaultOptions.defaultJobOptions,
    attempts: 5,
    timeout: 5 * 60 * 1000, // 5 minutes
  },
});

export const reportQueue = new Queue<ReportJobData>("reports", {
  ...defaultOptions,
  defaultJobOptions: {
    ...defaultOptions.defaultJobOptions,
    timeout: 30 * 60 * 1000, // 30 minutes
  },
});

export const webhookQueue = new Queue<WebhookJobData>("webhooks", {
  ...defaultOptions,
  defaultJobOptions: {
    ...defaultOptions.defaultJobOptions,
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
  },
});
```

## Workers

### Email Worker

```typescript
// workers/email.worker.ts
import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { EmailJobData } from "../jobs/types";
import { sendEmail } from "../lib/email";

const emailWorker = new Worker<EmailJobData>(
  "email",
  async (job: Job<EmailJobData>) => {
    const { to, subject, template, variables } = job.data;

    console.log(`Processing email job ${job.id} to ${to}`);

    // Update progress
    await job.updateProgress(10);

    // Render template
    const html = await renderTemplate(template, variables);
    await job.updateProgress(50);

    // Send email
    const result = await sendEmail({
      to,
      subject,
      html,
    });

    await job.updateProgress(100);

    return { messageId: result.messageId, sentAt: new Date() };
  },
  {
    connection: redis,
    concurrency: 10, // Process 10 emails at a time
    limiter: {
      max: 100, // Max 100 jobs
      duration: 60000, // Per minute
    },
  },
);

// Event handlers
emailWorker.on("completed", (job, result) => {
  console.log(`Email job ${job.id} completed:`, result);
});

emailWorker.on("failed", (job, error) => {
  console.error(`Email job ${job?.id} failed:`, error);
});

emailWorker.on("progress", (job, progress) => {
  console.log(`Email job ${job.id} progress: ${progress}%`);
});

export { emailWorker };
```

### Image Processing Worker

```typescript
// workers/image.worker.ts
import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { ImageProcessingJobData } from "../jobs/types";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });

const imageWorker = new Worker<ImageProcessingJobData>(
  "image-processing",
  async (job: Job<ImageProcessingJobData>) => {
    const { imageId, userId, operations } = job.data;

    console.log(`Processing image ${imageId} for user ${userId}`);

    // Download original image
    const originalBuffer = await downloadImage(imageId);
    let image = sharp(originalBuffer);

    // Apply operations
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      switch (op.type) {
        case "resize":
          image = image.resize(op.params.width, op.params.height, {
            fit: op.params.fit || "cover",
          });
          break;
        case "crop":
          image = image.extract({
            left: op.params.left,
            top: op.params.top,
            width: op.params.width,
            height: op.params.height,
          });
          break;
        case "watermark":
          image = image.composite([{ input: op.params.watermarkPath, gravity: "southeast" }]);
          break;
      }

      await job.updateProgress(((i + 1) / operations.length) * 80);
    }

    // Convert and upload
    const processedBuffer = await image.webp({ quality: 85 }).toBuffer();

    const key = `processed/${userId}/${imageId}.webp`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: processedBuffer,
        ContentType: "image/webp",
      }),
    );

    await job.updateProgress(100);

    return {
      url: `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${key}`,
      size: processedBuffer.length,
    };
  },
  {
    connection: redis,
    concurrency: 5,
  },
);

imageWorker.on("failed", async (job, error) => {
  // Notify user of failure
  if (job) {
    await notifyUser(job.data.userId, {
      type: "image-processing-failed",
      imageId: job.data.imageId,
      error: error.message,
    });
  }
});

export { imageWorker };
```

### Webhook Worker with Retries

```typescript
// workers/webhook.worker.ts
import { Worker, Job } from "bullmq";
import { redis } from "../lib/redis";
import { WebhookJobData } from "../jobs/types";

const webhookWorker = new Worker<WebhookJobData>(
  "webhooks",
  async (job: Job<WebhookJobData>) => {
    const { url, payload, headers = {} } = job.data;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": generateSignature(payload),
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!response.ok) {
      // Retry for server errors
      if (response.status >= 500) {
        throw new Error(`Webhook failed: ${response.status}`);
      }
      // Don't retry for client errors
      return {
        success: false,
        status: response.status,
        message: "Client error, not retrying",
      };
    }

    return {
      success: true,
      status: response.status,
    };
  },
  {
    connection: redis,
    concurrency: 20,
  },
);

export { webhookWorker };
```

## Adding Jobs

### Service Layer

```typescript
// services/jobs.service.ts
import { emailQueue, imageQueue, reportQueue, webhookQueue } from "../queues";
import { JobsOptions } from "bullmq";

export class JobService {
  // Send email
  static async sendEmail(data: EmailJobData, options?: JobsOptions) {
    return emailQueue.add("send-email", data, {
      ...options,
      priority: data.template === "password-reset" ? 1 : 10,
    });
  }

  // Bulk emails
  static async sendBulkEmails(emails: EmailJobData[]) {
    const jobs = emails.map((data, index) => ({
      name: "send-email",
      data,
      opts: {
        delay: index * 100, // Stagger by 100ms
      },
    }));

    return emailQueue.addBulk(jobs);
  }

  // Process image
  static async processImage(data: ImageProcessingJobData) {
    return imageQueue.add("process", data, {
      jobId: `image-${data.imageId}`, // Prevent duplicates
    });
  }

  // Schedule report
  static async scheduleReport(data: ReportJobData, runAt: Date) {
    return reportQueue.add("generate", data, {
      delay: runAt.getTime() - Date.now(),
    });
  }

  // Send webhook
  static async sendWebhook(data: WebhookJobData) {
    return webhookQueue.add("deliver", data);
  }
}
```

### API Usage

```typescript
// app/api/users/route.ts
import { JobService } from "@/services/jobs.service";

export async function POST(req: Request) {
  const data = await req.json();

  // Create user
  const user = await db.user.create({ data });

  // Queue welcome email
  await JobService.sendEmail({
    to: user.email,
    subject: "Welcome!",
    template: "welcome",
    variables: { name: user.name },
  });

  return Response.json(user);
}
```

## Scheduled Jobs (Cron)

```typescript
// schedulers/index.ts
import { Queue, QueueScheduler } from "bullmq";
import { redis } from "../lib/redis";

// Daily report scheduler
export async function setupSchedulers() {
  // Clean up old jobs daily
  await reportQueue.add(
    "cleanup",
    {},
    {
      repeat: {
        pattern: "0 0 * * *", // Every day at midnight
      },
    },
  );

  // Hourly metrics aggregation
  await metricsQueue.add(
    "aggregate",
    {},
    {
      repeat: {
        pattern: "0 * * * *", // Every hour
      },
    },
  );

  // Weekly digest
  await emailQueue.add(
    "weekly-digest",
    { template: "weekly-digest" },
    {
      repeat: {
        pattern: "0 9 * * 1", // Every Monday at 9 AM
      },
    },
  );
}
```

## Job Events & Monitoring

### Event Listeners

```typescript
// monitoring/events.ts
import { QueueEvents } from "bullmq";
import { redis } from "../lib/redis";

const emailQueueEvents = new QueueEvents("email", { connection: redis });

emailQueueEvents.on("completed", ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed with:`, returnvalue);
  metrics.increment("email.completed");
});

emailQueueEvents.on("failed", ({ jobId, failedReason }) => {
  console.error(`Job ${jobId} failed:`, failedReason);
  metrics.increment("email.failed");

  // Alert on repeated failures
  alertOnFailure(jobId, failedReason);
});

emailQueueEvents.on("delayed", ({ jobId, delay }) => {
  console.log(`Job ${jobId} delayed by ${delay}ms`);
});

emailQueueEvents.on("progress", ({ jobId, data }) => {
  console.log(`Job ${jobId} progress:`, data);
});

emailQueueEvents.on("stalled", ({ jobId }) => {
  console.warn(`Job ${jobId} stalled`);
  metrics.increment("email.stalled");
});
```

### Bull Board Dashboard

```typescript
// app/api/admin/queues/route.ts
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue, imageQueue, reportQueue, webhookQueue } from "@/queues";

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/api/admin/queues");

createBullBoard({
  queues: [
    new BullMQAdapter(emailQueue),
    new BullMQAdapter(imageQueue),
    new BullMQAdapter(reportQueue),
    new BullMQAdapter(webhookQueue),
  ],
  serverAdapter,
});

export const GET = serverAdapter.getRouter();
export const POST = serverAdapter.getRouter();
```

## Error Handling

```typescript
// workers/base.worker.ts
import { Worker, Job, UnrecoverableError } from "bullmq";

// Custom error for non-retryable failures
export class NonRetryableError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// Worker with error handling
const worker = new Worker(
  "queue-name",
  async (job: Job) => {
    try {
      // Validate input
      if (!job.data.requiredField) {
        throw new NonRetryableError("Missing required field");
      }

      // Process job
      return await processJob(job.data);
    } catch (error) {
      if (error instanceof NonRetryableError) {
        throw error; // Won't retry
      }

      // Log and rethrow for retry
      console.error(`Job ${job.id} error:`, error);
      throw error;
    }
  },
  {
    connection: redis,
  },
);

// Handle worker errors
worker.on("error", (error) => {
  console.error("Worker error:", error);
});
```

## Graceful Shutdown

```typescript
// server.ts
import { emailWorker, imageWorker, reportWorker } from "./workers";

const workers = [emailWorker, imageWorker, reportWorker];

async function gracefulShutdown() {
  console.log("Shutting down workers...");

  // Close workers gracefully
  await Promise.all(
    workers.map((worker) =>
      worker.close().catch((err) => {
        console.error("Error closing worker:", err);
      }),
    ),
  );

  // Close Redis connections
  await redis.quit();
  await redisSubscriber.quit();

  console.log("Workers shut down");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
```

## Best Practices

1. **Idempotent jobs**: Jobs should be safe to retry
2. **Unique job IDs**: Prevent duplicate processing
3. **Set timeouts**: Prevent stuck jobs
4. **Use progress updates**: For long-running jobs
5. **Handle failures gracefully**: Alert and log
6. **Clean up old jobs**: Remove completed/failed jobs
7. **Graceful shutdown**: Wait for jobs to complete
8. **Monitor queues**: Use Bull Board or similar

## Output Checklist

Every queue implementation should include:

- [ ] Redis connection with proper config
- [ ] Typed job data interfaces
- [ ] Queue with default options
- [ ] Worker with concurrency limits
- [ ] Retry and backoff configuration
- [ ] Event handlers for monitoring
- [ ] Error handling (retryable vs non-retryable)
- [ ] Graceful shutdown handling
- [ ] Bull Board or monitoring dashboard
- [ ] Scheduled/recurring jobs (if needed)
