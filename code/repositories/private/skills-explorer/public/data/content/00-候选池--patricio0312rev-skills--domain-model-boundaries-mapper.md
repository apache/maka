---
name: domain-model-boundaries-mapper
description: Identifies domain modules, ownership boundaries, dependencies, and interfaces using Domain-Driven Design principles. Provides domain maps, bounded contexts, refactor recommendations. Use for "DDD", "domain modeling", "bounded contexts", or "service boundaries".
---

# Domain Model & Boundaries Mapper

Map domain boundaries and ownership using Domain-Driven Design.

## Domain Map Template

```markdown
# Domain Map: E-Commerce Platform

## Bounded Contexts

### 1. Customer Management

**Core Domain:** User accounts, profiles, preferences
**Owner:** Customer Team
**Ubiquitous Language:**

- Customer: Registered user with account
- Profile: Customer personal information
- Preferences: User settings and choices

**Entities:**

- Customer (id, email, name)
- Address (id, customer_id, street, city)
- PaymentMethod (id, customer_id, type, token)

**Bounded Context Diagram:**
```

┌─────────────────────────────┐
│ Customer Management │
│ ┌─────────┐ ┌──────────┐ │
│ │Customer │ │ Address │ │
│ └─────────┘ └──────────┘ │
│ ┌─────────────────────┐ │
│ │ Payment Method │ │
│ └─────────────────────┘ │
└─────────────────────────────┘

```

### 2. Order Management
**Core Domain:** Order processing, fulfillment
**Owner:** Orders Team
**Ubiquitous Language:**
- Order: Purchase request with line items
- LineItem: Product quantity in order
- Fulfillment: Physical delivery of order

**Entities:**
- Order (id, customer_id, status, total)
- LineItem (id, order_id, product_id, quantity)
- Shipment (id, order_id, tracking_number)

### 3. Product Catalog
**Core Domain:** Product information, inventory
**Owner:** Catalog Team
**Ubiquitous Language:**
- Product: Sellable item
- SKU: Stock keeping unit
- Inventory: Available stock

**Entities:**
- Product (id, name, price, description)
- Inventory (sku, quantity, warehouse_id)

## Context Relationships

```

Customer Management ──────▶ Order Management
(customer_id)

Product Catalog ──────▶ Order Management
(product_id)

Order Management ──────▶ Fulfillment
(order events)

````

## Anti-Corruption Layers

### Order Management → Customer Management
**Problem:** Orders need customer data but shouldn't depend on Customer domain model

**Solution:** Customer Adapter
```typescript
// Order domain's view of customer
interface CustomerForOrder {
  id: string;
  shippingAddress: Address;
  billingAddress: Address;
}

// Adapter translates Customer domain to Order domain
class CustomerAdapter {
  async getCustomerForOrder(customerId: string): Promise<CustomerForOrder> {
    const customer = await customerService.getCustomer(customerId);
    return {
      id: customer.id,
      shippingAddress: this.toOrderAddress(customer.defaultShippingAddress),
      billingAddress: this.toOrderAddress(customer.defaultBillingAddress),
    };
  }
}
````

## Dependency Map

```
┌──────────────┐
│   Customer   │
└──────┬───────┘
       │
       ▼
┌──────────────┐      ┌────────────┐
│    Orders    │─────▶│  Products  │
└──────┬───────┘      └────────────┘
       │
       ▼
┌──────────────┐
│ Fulfillment  │
└──────────────┘
```

**Dependency Rules:**

- Customer has no dependencies
- Orders depends on Customer (read) and Products (read)
- Fulfillment depends on Orders (events)

## Interface Contracts

### Customer Management → Orders

```typescript
// Public interface exposed by Customer domain
interface CustomerService {
  getCustomer(id: string): Promise<Customer>;
  getCustomerAddresses(id: string): Promise<Address[]>;
}

// Events published
interface CustomerUpdated {
  customerId: string;
  email: string;
  name: string;
}
```

### Product Catalog → Orders

```typescript
interface ProductService {
  getProduct(id: string): Promise<Product>;
  checkAvailability(sku: string, quantity: number): Promise<boolean>;
  reserveInventory(items: ReservationRequest[]): Promise<Reservation>;
}
```

## Refactor Recommendations

### Problem 1: Tight Coupling

**Current:** Orders directly queries Customer database
**Issue:** Breaks bounded context, creates coupling
**Recommendation:** Use Customer API instead

```typescript
// ❌ Before: Direct database access
const customer = await db.customers.findById(customerId);

// ✅ After: API call through adapter
const customer = await customerAdapter.getCustomerForOrder(customerId);
```

### Problem 2: Shared Models

**Current:** Same `User` model used across contexts
**Issue:** Changes in one context affect others
**Recommendation:** Separate models per context

```typescript
// Customer context
interface Customer {
  id: string;
  email: string;
  profile: CustomerProfile;
  preferences: CustomerPreferences;
}

// Order context (different model!)
interface OrderCustomer {
  id: string;
  shippingAddress: Address;
  billingAddress: Address;
}
```

### Problem 3: God Service

**Current:** `OrderService` handles orders, inventory, payments, shipping
**Issue:** Single service owns too much
**Recommendation:** Extract bounded contexts

- OrderService: Order lifecycle
- InventoryService: Stock management
- PaymentService: Payment processing
- FulfillmentService: Shipping

## Strategic Design Patterns

### Pattern 1: Shared Kernel

**When:** Two contexts must share some code
**Example:** Common value objects (Money, Address)

```typescript
// Shared kernel (minimal!)
class Money {
  constructor(
    public amount: number,
    public currency: string,
  ) {}
}
```

### Pattern 2: Customer/Supplier

**When:** One context depends on another
**Example:** Orders (customer) depends on Products (supplier)

- Supplier defines interface
- Customer adapts to their needs

### Pattern 3: Published Language

**When:** Many contexts need same data
**Example:** Product events

```typescript
interface ProductCreated {
  productId: string;
  name: string;
  price: Money;
  publishedAt: Date;
}
```

## Migration Strategy

### Phase 1: Identify Boundaries

- [ ] Map existing code to domains
- [ ] Identify coupling points
- [ ] Document dependencies

### Phase 2: Define Interfaces

- [ ] Design APIs between contexts
- [ ] Create adapter layers
- [ ] Define event contracts

### Phase 3: Decouple

- [ ] Replace direct DB access with APIs
- [ ] Introduce anti-corruption layers
- [ ] Separate models per context

### Phase 4: Extract Services (optional)

- [ ] Move contexts to separate services
- [ ] Implement API gateways
- [ ] Set up event bus

## Best Practices

1. **Ubiquitous language**: Same terms in code and domain
2. **Bounded contexts**: Clear boundaries, separate models
3. **Context maps**: Document relationships
4. **Anti-corruption layers**: Protect domain integrity
5. **Event-driven**: Loose coupling via events
6. **Separate databases**: Context owns its data

## Output Checklist

- [ ] Bounded contexts identified (3-7)
- [ ] Core domain vs supporting domains
- [ ] Ubiquitous language defined per context
- [ ] Entity/aggregate definitions
- [ ] Context relationship diagram
- [ ] Dependency map
- [ ] Interface contracts defined
- [ ] Anti-corruption layers designed
- [ ] Refactor recommendations
- [ ] Migration strategy
