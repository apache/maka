---
name: "stripe"
displayName: "Stripe Payments"
description: "Build payment integrations with Stripe - accept payments, manage subscriptions, handle billing, and process refunds"
keywords: ["stripe","payments","checkout","subscriptions","billing","invoices","refunds","payment-intents"]
author: "Stripe"
---

# Stripe Payments Power

## Overview

Build payment integrations with Stripe's comprehensive payment platform. Accept one-time payments and subscriptions, manage customer billing, process refunds, and handle complex payment flows. This power provides access to Stripe's APIs through an MCP server, enabling you to build production-ready payment systems.

Use Stripe Checkout for hosted payment pages, Payment Intents for custom payment flows, or Billing APIs for subscription management. The platform handles PCI compliance, fraud detection, and supports 135+ currencies and payment methods worldwide.

**Key capabilities:**

- **Checkout Sessions**: Hosted payment pages for one-time payments and subscriptions
- **Payment Intents**: Custom payment flows with full control over the checkout experience
- **Subscriptions**: Recurring billing with flexible pricing models
- **Customers**: Manage customer data and saved payment methods
- **Invoices**: Generate and send invoices with automatic payment collection
- **Refunds**: Process full or partial refunds
- **Payment Methods**: Save and reuse payment methods for future charges

**Authentication**: Requires Stripe secret API key for server-side operations. Never expose in client code. Requires Stripe publishable key (only for client-side operations like Elements or Checkout); safe to include in browser code.

## Available MCP Servers

### stripe

**Connection:** HTTPS API endpoint at `https://mcp.stripe.com`
**Authorization:** Use OAuth to connect to the Stripe MCP server

## Best Practices

### Integration Approach

**Always prefer Checkout Sessions** for standard payment flows:

- One-time payments
- Subscription sign-ups
- Hosted (preferred) or embedded checkout forms

**Use Payment Intents** only when:

- Building custom checkout UI
- Handling off-session payments
- Need full control over payment state

**Never use the deprecated Charges API** - migrate to Checkout Sessions or Payment Intents.
**Use Payment Links** when:

- User wants a _No code_ Stripe integration
- Quickly create shareable payment pages
- Selling products or collecting donations with minimal setup

### Payment Methods

**Enable dynamic payment methods** in Dashboard settings instead of hardcoding `payment_method_types`. Stripe automatically shows optimal payment methods based on:

- Customer location
- Available wallets
- User preferences
- Transaction context

### Subscriptions

**For recurring revenue models**, use Billing APIs:

- Follow [Subscription Use Cases](https://docs.stripe.com/billing/subscriptions/use-cases)
- Use [SaaS integration patterns](https://docs.stripe.com/saas)
- Combine with Checkout for frontend
- [Plan your integration](https://docs.stripe.com/billing/subscriptions/designing-integration)
- [Usage-based billing to charge customers based on their usage of your product or service](https://docs.stripe.com/billing/subscriptions/usage-based)

### Stripe Connect

**For platforms managing fund flows**:

- Use **direct charges** if platform accepts risk (Stripe handles liability)
- Use **destination charges** if platform manages risk (platform handles negative balances)
- Use `on_behalf_of` parameter to control merchant of record
- Never mix charge types
- Refer to [controller properties](https://docs.stripe.com/connect/migrate-to-controller-properties.md) not legacy Standard/Express/Custom terms
- Follow [integration recommendations](https://docs.stripe.com/connect/integration-recommendations.md)

### Saving Payment Methods

**Use Setup Intents API** to save payment methods for future use:

- Never use deprecated Sources API
- For pre-authorization before payment, use Confirmation Tokens
- Don't call `createPaymentMethod` or `createToken` directly

### PCI Compliance

**For server-side raw PAN data**:

- Requires PCI compliance proof
- Use `payment_method_data` parameter
- For migrations, follow [PAN import process](https://docs.stripe.com/get-started/data-migrations/pan-import)

### Before Going Live

Review the [Go Live Checklist](https://docs.stripe.com/get-started/checklist/go-live):

- Test with sandbox keys
- Handle webhooks for async events
- Implement error handling
- Set up proper logging
- Configure tax and compliance settings

## Common Workflows

### Workflow 1: Accept One-Time Payment

```javascript
// Step 1: Create Checkout Session
const session = createCheckoutSession({
  mode: "payment",
  line_items: [
    {
      price_data: {
        currency: "usd",
        product_data: { name: "Premium Plan" },
        unit_amount: 2999,
      },
      quantity: 1,
    },
  ],
  success_url: "https://example.com/success",
  cancel_url: "https://example.com/cancel",
});

// Step 2: Redirect customer to session.url
// Step 3: Handle webhook for payment_intent.succeeded
```

### Workflow 2: Create Subscription

```javascript
// Step 1: Create or retrieve customer
const customer = createCustomer({
  email: "customer@example.com",
  name: "Jane Doe",
});

// Step 2: Create Checkout Session for subscription
const session = createCheckoutSession({
  mode: "subscription",
  customer: customer.id,
  line_items: [
    {
      price: "price_monthly_premium",
      quantity: 1,
    },
  ],
  success_url: "https://example.com/success",
  cancel_url: "https://example.com/cancel",
});

// Step 3: Handle webhook for customer.subscription.created
```

### Workflow 3: Process Refund

```javascript
// Step 1: Retrieve payment intent or charge
const paymentIntent = retrievePaymentIntent("pi_xxx");

// Step 2: Create refund
const refund = createRefund({
  payment_intent: paymentIntent.id,
  amount: 1000, // Partial refund in cents, omit for full refund
});

// Step 3: Handle webhook for charge.refunded
```

### Workflow 4: Save Payment Method for Future Use

```javascript
// Step 1: Create Setup Intent
const setupIntent = createSetupIntent({
  customer: "cus_xxx",
  payment_method_types: ["card"],
});

// Step 2: Collect payment method on frontend with Setup Intent
// Step 3: Handle webhook for setup_intent.succeeded
// Step 4: Use saved payment method for future charges
const paymentIntent = createPaymentIntent({
  amount: 2999,
  currency: "usd",
  customer: "cus_xxx",
  payment_method: "pm_xxx",
  off_session: true,
  confirm: true,
});
```

## Best Practices Summary

### ✅ Do:

- **Use Checkout Sessions** for standard payment flows
- **Enable dynamic payment methods** in Dashboard settings
- **Use Billing APIs** for subscription models
- **Use Setup Intents** to save payment methods
- **Handle webhooks** for all async events
- **Test thoroughly** in sandbox before going live
- **Follow the Go Live Checklist** before production
- **Do not include API version** in code snippets. Read https://docs.stripe.com/api/versioning.md for more information on versions
- **Implement idempotency keys** for safe retries
- **Log all API interactions** for debugging

### ❌ Don't:

- **Use Charges API** - it's deprecated, migrate to Payment Intents
- **Use Sources API** - deprecated for saving cards
- **Use Card Element** - migrate to Payment Element
- **Hardcode payment_method_types** - use dynamic payment methods
- **Mix Connect charge types** - choose one approach
- **Skip webhook handling** - critical for payment confirmation
- **Use production keys in development** - always use test keys
- **Ignore errors** - implement proper error handling
- **Skip PCI compliance** - required for handling card data
- **Forget to test edge cases** - declined cards, network failures, etc.
- **Expose API secret keys** - never include secret keys in client-side code, mobile apps, or public repositories

## Configuration

**Authentication Required**: Stripe secret key

**Setup Steps:**

1. Create Stripe account at https://stripe.com
2. Navigate to Developers → API keys
3. Copy your secret key (starts with `sk_test_` for [sandboxes](https://docs.stripe.com/sandboxes/dashboard/manage))
4. (Optional) Copy your publishable key (starts with `pk_test_` for sandboxes). Only needed for Stripe client-side code.
5. For production, use live mode key (starts with `sk_live_` and `pk_live_`)
6. Configure key in Kiro Powers UI when installing this power

**Permissions**: Secret key has full API access - keep secure and never expose client-side. Publishable keys (pk\_...) are intended and acceptable to embed in client-side code.

**MCP Configuration:**

```json
{
  "mcpServers": {
    "stripe": {
      "url": "https://mcp.stripe.com"
    }
  }
}
```

## Troubleshooting

### Error: "Invalid API key"

**Cause:** Incorrect or missing API key
**Solution:**

1. Verify key starts with `sk_test_` or `sk_live_`
2. Check key hasn't been deleted in Dashboard
3. Ensure using secret key, not publishable key
4. Regenerate key if compromised

### Error: "Payment method not available"

**Cause:** Payment method not enabled or not supported in region
**Solution:**

1. Enable payment methods in Dashboard → Settings → Payment methods
2. Check customer location supports the payment method
3. Use dynamic payment methods instead of hardcoding types
4. Verify currency is supported by payment method

### Error: "Customer not found"

**Cause:** Invalid customer ID or customer deleted
**Solution:**

1. Verify customer ID format (starts with `cus_`)
2. Check customer exists in Dashboard
3. Ensure using correct API mode (test vs live)
4. Create customer if doesn't exist

### Error: "Subscription creation failed"

**Cause:** Missing required parameters or invalid price ID
**Solution:**

1. Verify price ID exists (starts with `price_`)
2. Ensure price is active in Dashboard
3. Check customer has valid payment method
4. Review subscription parameters match price configuration

### Webhook not received

**Cause:** Webhook endpoint not configured or failing
**Solution:**

1. Configure webhook endpoint in Dashboard → Developers → Webhooks
2. Verify endpoint is publicly accessible
3. Check endpoint returns 200 status
4. Review webhook logs in Dashboard
5. Test with Stripe CLI: `stripe listen --forward-to localhost:3000/webhook`

### Payment declined

**Cause:** Card declined by issuer or failed fraud check
**Solution:**

1. Use test cards from [Stripe testing docs](https://docs.stripe.com/testing)
2. Check decline code in error response
3. Implement proper error messaging for customer
4. For production, customer should contact their bank
5. Review Radar rules if fraud detection triggered

## Tips

1. **Start with Checkout** - Fastest way to accept payments with minimal code
2. **Use sandbox extensively** - Test all scenarios before going live
3. **Implement webhooks early** - Critical for handling async events
4. **Use Stripe CLI** - Test webhooks locally during development
5. **Follow integration guides** - Use [API Tour](https://docs.stripe.com/payments-api/tour) and [Integration Options](https://docs.stripe.com/payments/payment-methods/integration-options)
6. **Monitor Dashboard** - Review payments, disputes, and logs regularly
7. **Handle errors gracefully** - Show clear messages to customers
8. **Use idempotency keys** - Prevent duplicate charges on retries
9. **Keep keys secure** - Never commit to version control
10. **Stay updated** - Review API changelog for new features and deprecations

## Resources

- [Integration Options](https://docs.stripe.com/payments/payment-methods/integration-options)
- [API Tour](https://docs.stripe.com/payments-api/tour)
- [Go Live Checklist](https://docs.stripe.com/get-started/checklist/go-live)
- [Checkout Sessions](https://docs.stripe.com/api/checkout/sessions)
- [Payment Intents](https://docs.stripe.com/payments/paymentintents/lifecycle)
- [Subscription Use Cases](https://docs.stripe.com/billing/subscriptions/use-cases)
- [Connect Integration](https://docs.stripe.com/connect/design-an-integration)
- [Testing](https://docs.stripe.com/testing)

---

**License:** Proprietary