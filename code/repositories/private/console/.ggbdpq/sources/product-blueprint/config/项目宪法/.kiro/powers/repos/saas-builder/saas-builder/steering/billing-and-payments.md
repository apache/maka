---
inclusion: always
---

# Billing and Payments

## Money Handling Rules

### Never Use Floats for Money
- Use integers for all monetary amounts (cents, not dollars)
- Store: `amount_cents: 1999` (represents $19.99)
- Display: Convert to decimal only in UI layer
- Calculate: All math in cents, round at the end
- Currency: Always store currency code with amount (`USD`, `EUR`, etc.)

### Data Types
- Backend: Integer type for cents (int64/bigint for large amounts)
- Database: Integer column, never DECIMAL or FLOAT
- API: Send as integer cents in JSON: `{"amount": 1999, "currency": "USD"}`
- Frontend: Convert to display format: `(1999 / 100).toFixed(2)` → "$19.99"

## Payment Integration

### Use Payment Service Providers
- Never store credit card numbers (PCI compliance nightmare)
- Use Stripe, Paddle, or similar for payment processing
- Store only: customer ID, subscription ID, payment method ID (tokens)
- Let provider handle: card storage, PCI compliance, fraud detection

### Idempotency
- All payment operations MUST be idempotent
- Use idempotency keys for charge/refund operations
- Store operation results to prevent duplicate charges
- Handle webhook retries gracefully (same event may arrive multiple times)

### Webhook Security
- Verify webhook signatures (Stripe signature, etc.)
- Use HTTPS endpoints only
- Process webhooks asynchronously (return 200 immediately, process in background)
- Store raw webhook payload for debugging
- Implement retry logic for failed webhook processing

## Subscription Management

### Subscription States
Track subscription lifecycle per tenant:
- `trial` - Free trial period
- `active` - Paid and current
- `past_due` - Payment failed, grace period
- `canceled` - User canceled, end of billing period
- `expired` - Subscription ended

### Grace Periods
- Don't immediately disable on payment failure
- Provide grace period (3-7 days) with notifications
- Degrade gracefully: read-only mode before full lockout
- Allow reactivation without data loss

### Proration
- Calculate prorated amounts when changing plans mid-cycle
- Use provider's proration logic (Stripe handles this)
- Show preview of charges before plan changes
- Document proration policy clearly to users

## Usage-Based Billing

### Metering Pattern
```
1. Track usage events in real-time
2. Aggregate usage per tenant per billing period
3. Calculate charges based on usage tiers
4. Generate invoice at end of billing period
5. Charge payment method on file
```

### Usage Tracking
- Publish usage events to EventBridge immediately
- Store aggregated usage in DynamoDB (tenant + period)
- Include metadata: tenant ID, user ID, resource type, quantity, timestamp
- Make usage data queryable for customer dashboards

### Quota Enforcement
- Check quota before expensive operations
- Return 429 with clear message when quota exceeded
- Offer upgrade path in error response
- Track quota usage in real-time (cache in Lambda memory)

## Invoicing

### Invoice Generation
- Generate invoices automatically at billing cycle end
- Include: line items, usage details, taxes, discounts
- Store invoices in S3 (PDF) and metadata in DynamoDB
- Send invoice email with PDF attachment
- Provide invoice history in customer portal

### Tax Handling
- Use tax calculation service (Stripe Tax, TaxJar)
- Never calculate tax manually (complex, jurisdiction-specific)
- Store tax rate and amount with each transaction
- Support tax-exempt customers (store exemption certificate)

## Financial Reporting

### Audit Trail
- Log all financial operations: charges, refunds, credits
- Include: timestamp, tenant ID, amount, reason, operator
- Immutable logs (append-only)
- Retain for 7+ years (compliance requirement)

### Revenue Recognition
- Track MRR (Monthly Recurring Revenue) per tenant
- Calculate churn rate and LTV (Lifetime Value)
- Store subscription start/end dates for cohort analysis
- Separate one-time charges from recurring revenue

## Security & Compliance

### PCI Compliance
- Never log credit card numbers (even partial)
- Use tokenization for stored payment methods
- Encrypt sensitive financial data at rest
- Limit access to financial data (RBAC)

### Fraud Prevention
- Monitor for unusual patterns: rapid plan changes, high-value transactions
- Implement velocity limits (max charges per hour)
- Require additional verification for large amounts
- Use provider's fraud detection (Stripe Radar)

### Refund Policy
- Implement clear refund policy
- Track refund reasons for analysis
- Partial refunds for prorated cancellations
- Automate refunds where possible, manual review for large amounts

## Multi-Currency Support

### Currency Handling
- Store prices in multiple currencies if needed
- Use exchange rates from reliable source (provider or ECB)
- Lock exchange rate at time of charge
- Display prices in customer's currency
- Bill in customer's currency to avoid FX fees

### Localization
- Format currency according to locale: `$1,999.99` (US) vs `1.999,99 €` (EU)
- Use Intl.NumberFormat in frontend for formatting
- Store locale preference per tenant

## Testing

### Test Mode
- Use payment provider's test mode for development
- Test cards: successful charges, declined cards, 3D Secure
- Test webhooks with provider's CLI tools
- Never use real payment methods in development

### Edge Cases to Test
- Payment failure during subscription renewal
- Plan upgrade/downgrade mid-cycle
- Refund after partial usage
- Subscription cancellation with immediate vs end-of-period
- Webhook delivery failures and retries
- Currency conversion edge cases
