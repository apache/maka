---
name: webhook-receiver-hardener
description: Secures webhook receivers with signature verification, retry handling, deduplication, idempotency keys, and error responses. Provides verification code, dedupe storage strategy, runbook for incidents. Use when implementing "webhooks", "webhook security", "event receivers", or "third-party integrations".
---

# Webhook Receiver Hardener

Build secure, reliable webhook endpoints that handle failures gracefully.

## Core Security

**Signature Verification**: HMAC validation before processing
**Deduplication**: Track processed webhook IDs
**Idempotency**: Safe to process same webhook multiple times
**Retries**: Handle provider retry attempts
**Rate Limiting**: Prevent abuse

## Signature Verification

```typescript
import crypto from "crypto";

export const verifyWebhookSignature = (
  payload: string,
  signature: string,
  secret: string,
): boolean => {
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac));
};

// Stripe example
router.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    await processStripeEvent(event);
    res.json({ received: true });
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});
```

## Deduplication

```typescript
// Redis-based dedupe
const WEBHOOK_TTL = 60 * 60 * 24; // 24 hours

export const isDuplicate = async (webhookId: string): Promise<boolean> => {
  const key = `webhook:${webhookId}`;
  const exists = await redis.exists(key);

  if (exists) return true;

  await redis.setex(key, WEBHOOK_TTL, "1");
  return false;
};

// Usage
if (await isDuplicate(webhook.id)) {
  return res.status(200).json({ received: true }); // Already processed
}
```

## Idempotent Processing

```typescript
export const processWebhook = async (webhook: Webhook) => {
  // Use database transaction with unique constraint
  try {
    await db.transaction(async (trx) => {
      // Insert webhook record (unique constraint on webhook_id)
      await trx("processed_webhooks").insert({
        webhook_id: webhook.id,
        processed_at: new Date(),
      });

      // Do actual processing
      await performWebhookAction(webhook, trx);
    });
  } catch (err) {
    if (err.code === "23505") {
      // Unique violation
      console.log("Webhook already processed");
      return; // Idempotent - already processed
    }
    throw err;
  }
};
```

## Retry Handling

```typescript
// Acknowledge immediately, process async
router.post("/webhooks/provider", async (req, res) => {
  // Verify signature
  if (!verifySignature(req.body, req.headers["signature"])) {
    return res.status(401).send("Invalid signature");
  }

  // Return 200 immediately
  res.status(200).json({ received: true });

  // Process async
  processWebhookAsync(req.body).catch((err) => {
    console.error("Webhook processing failed:", err);
    // Will be retried by provider
  });
});

// Exponential backoff for provider retries
// Attempt 1: immediate
// Attempt 2: +5 minutes
// Attempt 3: +15 minutes
// Attempt 4: +1 hour
// Attempt 5: +6 hours
```

## Error Responses

```typescript
// Return appropriate status codes
const webhookHandler = async (req, res) => {
  // 400: Malformed payload (won't retry)
  if (!isValidPayload(req.body)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // 401: Invalid signature (won't retry)
  if (!verifySignature(req.body, req.headers["signature"])) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // 200: Already processed (idempotent)
  if (await isDuplicate(req.body.id)) {
    return res.status(200).json({ received: true });
  }

  // 500: Processing error (will retry)
  try {
    await processWebhook(req.body);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Processing error:", err);
    return res.status(500).json({ error: "Processing failed" });
  }
};
```

## Monitoring & Runbook

```markdown
## Webhook Incidents

### High Error Rate

1. Check provider status page
2. Review recent code deploys
3. Check signature secret rotation
4. Verify database connectivity

### Missing Webhooks

1. Check provider sending (their dashboard)
2. Verify endpoint is accessible
3. Check rate limiting rules
4. Review dedupe cache TTL

### Duplicate Processing

1. Check dedupe cache connectivity
2. Verify unique constraints
3. Review idempotency logic
```

## Best Practices

- Verify signature BEFORE any processing
- Return 200 quickly, process async
- Dedupe with Redis + database constraints
- Log all webhook attempts
- Monitor processing latency
- Set up alerts for failures
- Document expected payload schemas

## Output Checklist

- [ ] Signature verification
- [ ] Deduplication mechanism
- [ ] Idempotent processing
- [ ] Async processing pattern
- [ ] Proper status codes
- [ ] Error logging
- [ ] Monitoring/alerts
- [ ] Incident runbook
