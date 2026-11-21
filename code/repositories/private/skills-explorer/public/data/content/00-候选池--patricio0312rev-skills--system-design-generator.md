---
name: system-design-generator
description: Produces comprehensive system architecture plans for features and products including component breakdown, data flow diagrams, system boundaries, API contracts, and scaling considerations. Use for "system design", "architecture planning", "feature design", or "technical specs".
---

# System Design Generator

Create comprehensive system architecture plans from requirements.

## System Design Document Template

```markdown
# System Design: [Feature/Product Name]

## Overview

Brief description of what we're building and why.

## Requirements

### Functional

- User can upload videos (max 1GB)
- System processes video within 5 minutes
- User receives notification when complete

### Non-Functional

- Handle 1000 uploads/day
- 99.9% uptime
- Process videos in <5 minutes (p95)
- Cost: <$0.50 per video

## High-Level Architecture
```

┌─────────┐ ┌──────────┐ ┌─────────────┐
│ Client │─────▶│ API │─────▶│ Upload │
│ │ │ Gateway │ │ Service │
└─────────┘ └──────────┘ └─────────────┘
│
▼
┌─────────────┐
│ Storage │
│ (S3) │
└─────────────┘
│
▼
┌─────────────┐
│ Processing │◀─┐
│ Queue │ │
└─────────────┘ │
│ │
▼ │
┌─────────────┐ │
│ Processor │─┘
│ Workers │
└─────────────┘
│
▼
┌─────────────┐
│Notification │
│ Service │
└─────────────┘

```

## Components

### 1. API Gateway
**Responsibilities:**
- Authentication
- Rate limiting
- Request routing

**Technology:** Kong/AWS API Gateway
**Scaling:** Auto-scale based on requests/sec

### 2. Upload Service
**Responsibilities:**
- Generate pre-signed S3 URLs
- Validate file metadata
- Enqueue processing jobs

**API:**
```

POST /uploads
Request: { filename, size, content_type }
Response: { upload_url, upload_id }

```

**Technology:** Node.js + Express
**Scaling:** Horizontal (stateless)

### 3. Storage (S3)
**Responsibilities:**
- Store raw videos
- Store processed outputs
- Serve content via CDN

**Structure:**
```

/uploads/{user_id}/{upload_id}/original.mp4
/processed/{user_id}/{upload_id}/output.mp4

````

### 4. Processing Queue
**Responsibilities:**
- Buffer processing jobs
- Ensure at-least-once delivery
- DLQ for failed jobs

**Technology:** AWS SQS
**Configuration:**
- Visibility timeout: 15 minutes
- DLQ after 3 retries

### 5. Processor Workers
**Responsibilities:**
- Transcode videos
- Generate thumbnails
- Update database

**Technology:** Python + FFmpeg
**Scaling:** Auto-scale on queue depth

## Data Flow

### Upload Flow
1. Client requests upload URL from Upload Service
2. Upload Service generates pre-signed S3 URL
3. Client uploads directly to S3
4. Client notifies Upload Service of completion
5. Upload Service enqueues processing job
6. Returns upload_id to client

### Processing Flow
1. Worker polls queue for jobs
2. Downloads video from S3
3. Processes video (transcode, thumbnail)
4. Uploads results to S3
5. Updates database status
6. Sends notification
7. Deletes message from queue

## Data Model

```typescript
interface Upload {
  id: string;
  user_id: string;
  filename: string;
  size: number;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  original_url: string;
  processed_url?: string;
  created_at: Date;
  processed_at?: Date;
}

interface ProcessingJob {
  upload_id: string;
  attempts: number;
  error?: string;
}
````

## API Contract

### Upload Endpoints

```
POST   /uploads           - Request upload URL
GET    /uploads/:id       - Get upload status
DELETE /uploads/:id       - Cancel upload
GET    /uploads           - List user uploads
```

### Webhooks

```
POST {webhook_url}
{
  "event": "upload.completed",
  "upload_id": "...",
  "status": "complete",
  "processed_url": "..."
}
```

## Scaling Considerations

### Current Capacity

- 1000 uploads/day = ~1 per minute
- Single worker can process 1 video every 5 minutes
- Need 5 workers for current load

### 10x Scale (10,000/day)

- ~10 uploads per minute
- Need 50 workers
- Use spot instances for cost savings
- Add Redis cache for status checks

### 100x Scale (100,000/day)

- ~100 uploads per minute
- Partition by region
- Use Kafka instead of SQS
- Database sharding by user_id

## Failure Modes

### S3 Unavailable

- Impact: Uploads fail
- Mitigation: Multi-region S3 replication

### Queue Backed Up

- Impact: Processing delays
- Mitigation: Auto-scale workers faster

### Worker Crash During Processing

- Impact: Job retried
- Mitigation: Idempotent processing

## Cost Estimate

**Monthly (1000 uploads/day):**

- S3 Storage: $50
- S3 Transfer: $100
- SQS: $10
- Workers (EC2): $300
- Database: $100
  **Total: ~$560/month**

## Security

- Pre-signed URLs expire in 1 hour
- Videos in private S3 buckets
- CloudFront signed URLs for delivery
- Rate limiting per user

## Monitoring

**Metrics:**

- Upload success rate
- Processing time (p50, p95, p99)
- Queue depth
- Worker CPU/memory
- Error rate by type

**Alerts:**

- Queue depth >1000
- Processing time p95 >10 minutes
- Error rate >5%

## Open Questions

- [ ] Video retention policy? (30 days? 1 year?)
- [ ] Maximum video duration? (affects processing time)
- [ ] Regional data residency requirements?

````

## Component Template

```markdown
### Component Name

**Responsibilities:**
- Primary responsibility
- Secondary responsibility

**Technology Stack:**
- Language: [Python/Node/Go]
- Framework: [Express/FastAPI/Gin]
- Database: [PostgreSQL/MongoDB]

**API/Interface:**
```typescript
interface ComponentAPI {
  method(params): ReturnType;
}
````

**Scaling Strategy:**

- Horizontal: Stateless, load balanced
- Vertical: Cache layer, connection pooling

**Dependencies:**

- Service A (for X)
- Database B (for persistence)

**Failure Handling:**

- Retry with exponential backoff
- Circuit breaker for downstream services
- Fallback to cached data

```

## Best Practices

1. **Start with requirements**: Functional + non-functional
2. **Draw diagrams first**: Visual clarity
3. **Define boundaries**: What's in scope vs out
4. **Document tradeoffs**: Every choice has costs
5. **Plan for failure**: What breaks and how to handle
6. **Consider scale**: Current, 10x, 100x
7. **Estimate costs**: Build vs buy decisions
8. **Leave open questions**: Don't pretend to know everything

## Output Checklist

- [ ] Requirements documented (functional + non-functional)
- [ ] High-level architecture diagram
- [ ] Component breakdown (3-7 components)
- [ ] Data flow documented
- [ ] Data model defined
- [ ] API contracts specified
- [ ] Scaling considerations (1x, 10x, 100x)
- [ ] Failure modes identified
- [ ] Cost estimate provided
- [ ] Security considerations
- [ ] Monitoring plan
```
