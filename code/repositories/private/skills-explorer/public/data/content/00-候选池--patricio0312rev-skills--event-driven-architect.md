---
name: event-driven-architect
description: Designs event-driven architectures with event sourcing, CQRS, pub/sub patterns, and domain events for decoupled systems. Use when users request "event sourcing", "CQRS", "domain events", "pub/sub", or "event-driven".
---

# Event-Driven Architect

Build decoupled, scalable systems with event-driven patterns.

## Core Workflow

1. **Identify domain events**: Define what happened
2. **Design event schema**: Structure event payloads
3. **Implement event bus**: Publish and subscribe
4. **Add event handlers**: React to events
5. **Consider CQRS**: Separate reads and writes
6. **Enable event sourcing**: Store event history

## Event Fundamentals

### Event Structure

```typescript
// events/base.ts
export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  aggregateId: string;
  aggregateType: string;
  payload: T;
  metadata: {
    timestamp: Date;
    version: number;
    correlationId?: string;
    causationId?: string;
    userId?: string;
  };
}

// Type-safe event creator
export function createEvent<T>(
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: T,
  metadata?: Partial<DomainEvent["metadata"]>,
): DomainEvent<T> {
  return {
    id: crypto.randomUUID(),
    type,
    aggregateType,
    aggregateId,
    payload,
    metadata: {
      timestamp: new Date(),
      version: 1,
      ...metadata,
    },
  };
}
```

### Define Domain Events

```typescript
// events/order.events.ts
export interface OrderCreatedPayload {
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  shippingAddress: Address;
}

export interface OrderPaidPayload {
  paymentId: string;
  amount: number;
  method: "card" | "bank" | "wallet";
}

export interface OrderShippedPayload {
  trackingNumber: string;
  carrier: string;
  estimatedDelivery: string;
}

export interface OrderCancelledPayload {
  reason: string;
  cancelledBy: string;
  refundAmount?: number;
}

// Event types
export type OrderEvent =
  | (DomainEvent<OrderCreatedPayload> & { type: "OrderCreated" })
  | (DomainEvent<OrderPaidPayload> & { type: "OrderPaid" })
  | (DomainEvent<OrderShippedPayload> & { type: "OrderShipped" })
  | (DomainEvent<OrderCancelledPayload> & { type: "OrderCancelled" });

// Event creators
export const OrderEvents = {
  created: (orderId: string, payload: OrderCreatedPayload) =>
    createEvent("OrderCreated", "Order", orderId, payload),

  paid: (orderId: string, payload: OrderPaidPayload) =>
    createEvent("OrderPaid", "Order", orderId, payload),

  shipped: (orderId: string, payload: OrderShippedPayload) =>
    createEvent("OrderShipped", "Order", orderId, payload),

  cancelled: (orderId: string, payload: OrderCancelledPayload) =>
    createEvent("OrderCancelled", "Order", orderId, payload),
};
```

## Event Bus

### In-Memory Event Bus

```typescript
// events/event-bus.ts
import { EventEmitter } from "events";
import { DomainEvent } from "./base";

type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void>;

class EventBus {
  private emitter = new EventEmitter();
  private handlers = new Map<string, EventHandler[]>();

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    console.log(`Publishing event: ${event.type}`, event);

    // Store event (for event sourcing)
    await this.storeEvent(event);

    // Emit to handlers
    this.emitter.emit(event.type, event);
    this.emitter.emit("*", event); // Wildcard for all events
  }

  async publishAll(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  subscribe<T>(eventType: string, handler: EventHandler<T>): () => void {
    const wrappedHandler = async (event: DomainEvent<T>) => {
      try {
        await handler(event);
      } catch (error) {
        console.error(`Error handling ${eventType}:`, error);
        // Could emit to dead letter queue here
      }
    };

    this.emitter.on(eventType, wrappedHandler);

    // Return unsubscribe function
    return () => {
      this.emitter.off(eventType, wrappedHandler);
    };
  }

  subscribeAll(handler: EventHandler): () => void {
    return this.subscribe("*", handler);
  }

  private async storeEvent(event: DomainEvent): Promise<void> {
    await db.event.create({
      data: {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        payload: event.payload as any,
        metadata: event.metadata as any,
        createdAt: event.metadata.timestamp,
      },
    });
  }
}

export const eventBus = new EventBus();
```

### Redis-Based Event Bus

```typescript
// events/redis-event-bus.ts
import { Redis } from "ioredis";
import { DomainEvent } from "./base";

const publisher = new Redis(process.env.REDIS_URL!);
const subscriber = new Redis(process.env.REDIS_URL!);

class RedisEventBus {
  private handlers = new Map<string, Set<(event: DomainEvent) => Promise<void>>>();

  constructor() {
    subscriber.on("message", async (channel, message) => {
      const event = JSON.parse(message) as DomainEvent;
      const handlers = this.handlers.get(channel) || new Set();

      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`Error handling ${event.type}:`, error);
        }
      }
    });
  }

  async publish(event: DomainEvent): Promise<void> {
    const channel = `events:${event.type}`;
    await publisher.publish(channel, JSON.stringify(event));

    // Also store in stream for replay
    await publisher.xadd(`stream:${event.aggregateType}`, "*", "event", JSON.stringify(event));
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => Promise<void>): () => void {
    const channel = `events:${eventType}`;

    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      subscriber.subscribe(channel);
    }

    this.handlers.get(channel)!.add(handler);

    return () => {
      this.handlers.get(channel)?.delete(handler);
    };
  }
}

export const eventBus = new RedisEventBus();
```

## Event Handlers

### Handler Registration

```typescript
// handlers/order.handlers.ts
import { eventBus } from "../events/event-bus";
import { OrderEvent } from "../events/order.events";

// Email notification on order created
eventBus.subscribe<OrderCreatedPayload>("OrderCreated", async (event) => {
  await emailService.send({
    to: await getUserEmail(event.payload.customerId),
    template: "order-confirmation",
    data: {
      orderId: event.aggregateId,
      items: event.payload.items,
      total: event.payload.totalAmount,
    },
  });
});

// Update inventory on order created
eventBus.subscribe<OrderCreatedPayload>("OrderCreated", async (event) => {
  for (const item of event.payload.items) {
    await inventoryService.reserve(item.productId, item.quantity);
  }
});

// Analytics tracking
eventBus.subscribe<OrderPaidPayload>("OrderPaid", async (event) => {
  await analytics.track("order_completed", {
    orderId: event.aggregateId,
    amount: event.payload.amount,
    paymentMethod: event.payload.method,
  });
});

// Notify shipping on order paid
eventBus.subscribe<OrderPaidPayload>("OrderPaid", async (event) => {
  await shippingService.createShipment(event.aggregateId);
});

// Handle cancellation
eventBus.subscribe<OrderCancelledPayload>("OrderCancelled", async (event) => {
  // Release inventory
  const order = await orderRepository.findById(event.aggregateId);
  for (const item of order.items) {
    await inventoryService.release(item.productId, item.quantity);
  }

  // Process refund
  if (event.payload.refundAmount) {
    await paymentService.refund(event.aggregateId, event.payload.refundAmount);
  }

  // Send cancellation email
  await emailService.send({
    to: await getUserEmail(order.customerId),
    template: "order-cancelled",
    data: {
      orderId: event.aggregateId,
      reason: event.payload.reason,
    },
  });
});
```

## Event Sourcing

### Aggregate with Events

```typescript
// aggregates/order.aggregate.ts
import { DomainEvent } from "../events/base";
import { OrderEvents, OrderCreatedPayload, OrderPaidPayload } from "../events/order.events";

interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

type OrderStatus = "pending" | "paid" | "shipped" | "delivered" | "cancelled";

export class OrderAggregate {
  private _id: string;
  private _status: OrderStatus = "pending";
  private _items: OrderItem[] = [];
  private _totalAmount: number = 0;
  private _customerId: string = "";
  private _version: number = 0;

  private uncommittedEvents: DomainEvent[] = [];

  get id() {
    return this._id;
  }
  get status() {
    return this._status;
  }
  get items() {
    return [...this._items];
  }
  get version() {
    return this._version;
  }

  constructor(id?: string) {
    this._id = id || crypto.randomUUID();
  }

  // Command: Create order
  static create(customerId: string, items: OrderItem[], shippingAddress: Address): OrderAggregate {
    const order = new OrderAggregate();
    const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    order.apply(
      OrderEvents.created(order._id, {
        customerId,
        items,
        totalAmount,
        shippingAddress,
      }),
    );

    return order;
  }

  // Command: Pay order
  pay(paymentId: string, amount: number, method: "card" | "bank" | "wallet"): void {
    if (this._status !== "pending") {
      throw new Error("Order cannot be paid in current status");
    }

    if (amount !== this._totalAmount) {
      throw new Error("Payment amount does not match order total");
    }

    this.apply(OrderEvents.paid(this._id, { paymentId, amount, method }));
  }

  // Command: Cancel order
  cancel(reason: string, cancelledBy: string): void {
    if (["shipped", "delivered", "cancelled"].includes(this._status)) {
      throw new Error("Order cannot be cancelled in current status");
    }

    const refundAmount = this._status === "paid" ? this._totalAmount : undefined;

    this.apply(OrderEvents.cancelled(this._id, { reason, cancelledBy, refundAmount }));
  }

  // Apply event and track for persistence
  private apply(event: DomainEvent): void {
    this.applyEvent(event);
    this.uncommittedEvents.push(event);
  }

  // Apply event to state (used for replay too)
  private applyEvent(event: DomainEvent): void {
    switch (event.type) {
      case "OrderCreated":
        const created = event.payload as OrderCreatedPayload;
        this._customerId = created.customerId;
        this._items = created.items;
        this._totalAmount = created.totalAmount;
        this._status = "pending";
        break;

      case "OrderPaid":
        this._status = "paid";
        break;

      case "OrderShipped":
        this._status = "shipped";
        break;

      case "OrderCancelled":
        this._status = "cancelled";
        break;
    }

    this._version++;
  }

  // Get and clear uncommitted events
  getUncommittedEvents(): DomainEvent[] {
    const events = [...this.uncommittedEvents];
    this.uncommittedEvents = [];
    return events;
  }

  // Rebuild from events
  static fromEvents(events: DomainEvent[]): OrderAggregate {
    if (events.length === 0) {
      throw new Error("Cannot rebuild aggregate from empty events");
    }

    const order = new OrderAggregate(events[0].aggregateId);

    for (const event of events) {
      order.applyEvent(event);
    }

    return order;
  }
}
```

### Event Store Repository

```typescript
// repositories/event-store.repository.ts
import { db } from "../lib/db";
import { DomainEvent } from "../events/base";
import { eventBus } from "../events/event-bus";

export class EventStoreRepository<T extends { id: string; getUncommittedEvents(): DomainEvent[] }> {
  constructor(
    private aggregateType: string,
    private reconstruct: (events: DomainEvent[]) => T,
  ) {}

  async save(aggregate: T): Promise<void> {
    const events = aggregate.getUncommittedEvents();

    if (events.length === 0) return;

    // Store events
    await db.event.createMany({
      data: events.map((event) => ({
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        payload: event.payload as any,
        metadata: event.metadata as any,
        createdAt: event.metadata.timestamp,
      })),
    });

    // Publish events
    await eventBus.publishAll(events);
  }

  async findById(id: string): Promise<T | null> {
    const events = await db.event.findMany({
      where: {
        aggregateId: id,
        aggregateType: this.aggregateType,
      },
      orderBy: { createdAt: "asc" },
    });

    if (events.length === 0) return null;

    return this.reconstruct(
      events.map((e) => ({
        id: e.id,
        type: e.type,
        aggregateId: e.aggregateId,
        aggregateType: e.aggregateType,
        payload: e.payload,
        metadata: e.metadata as any,
      })),
    );
  }

  async getEvents(aggregateId: string, fromVersion?: number): Promise<DomainEvent[]> {
    const events = await db.event.findMany({
      where: {
        aggregateId,
        aggregateType: this.aggregateType,
        ...(fromVersion && {
          metadata: { path: ["version"], gte: fromVersion },
        }),
      },
      orderBy: { createdAt: "asc" },
    });

    return events.map((e) => ({
      id: e.id,
      type: e.type,
      aggregateId: e.aggregateId,
      aggregateType: e.aggregateType,
      payload: e.payload,
      metadata: e.metadata as any,
    }));
  }
}

// Usage
export const orderRepository = new EventStoreRepository("Order", OrderAggregate.fromEvents);
```

## CQRS Pattern

### Separate Command and Query

```typescript
// commands/create-order.command.ts
export interface CreateOrderCommand {
  customerId: string;
  items: Array<{ productId: string; quantity: number }>;
  shippingAddress: Address;
}

// Command handler
export async function handleCreateOrder(command: CreateOrderCommand): Promise<string> {
  // Validate
  const customer = await customerRepository.findById(command.customerId);
  if (!customer) throw new Error("Customer not found");

  // Get product prices
  const items = await Promise.all(
    command.items.map(async (item) => {
      const product = await productRepository.findById(item.productId);
      return {
        productId: item.productId,
        quantity: item.quantity,
        price: product.price,
      };
    }),
  );

  // Create aggregate and save
  const order = OrderAggregate.create(command.customerId, items, command.shippingAddress);

  await orderRepository.save(order);

  return order.id;
}
```

```typescript
// queries/order.queries.ts
// Read model - denormalized for fast queries
export interface OrderReadModel {
  id: string;
  status: string;
  customerName: string;
  customerEmail: string;
  items: Array<{
    productName: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  createdAt: Date;
  paidAt?: Date;
  shippedAt?: Date;
}

// Query handler
export async function getOrderById(orderId: string): Promise<OrderReadModel | null> {
  return db.orderReadModel.findUnique({
    where: { id: orderId },
  });
}

export async function getOrdersByCustomer(customerId: string): Promise<OrderReadModel[]> {
  return db.orderReadModel.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
  });
}
```

### Read Model Projector

```typescript
// projectors/order.projector.ts
import { eventBus } from "../events/event-bus";

// Project events to read model
eventBus.subscribe("OrderCreated", async (event) => {
  const { customerId, items, totalAmount } = event.payload;
  const customer = await db.customer.findUnique({ where: { id: customerId } });

  await db.orderReadModel.create({
    data: {
      id: event.aggregateId,
      status: "pending",
      customerId,
      customerName: customer.name,
      customerEmail: customer.email,
      items: await enrichItems(items),
      totalAmount,
      createdAt: event.metadata.timestamp,
    },
  });
});

eventBus.subscribe("OrderPaid", async (event) => {
  await db.orderReadModel.update({
    where: { id: event.aggregateId },
    data: {
      status: "paid",
      paidAt: event.metadata.timestamp,
    },
  });
});

eventBus.subscribe("OrderShipped", async (event) => {
  await db.orderReadModel.update({
    where: { id: event.aggregateId },
    data: {
      status: "shipped",
      shippedAt: event.metadata.timestamp,
      trackingNumber: event.payload.trackingNumber,
    },
  });
});
```

## Best Practices

1. **Immutable events**: Never modify stored events
2. **Descriptive event names**: Past tense (OrderCreated, not CreateOrder)
3. **Include all context**: Events should be self-contained
4. **Version events**: Handle schema evolution
5. **Idempotent handlers**: Handle duplicate events gracefully
6. **Separate concerns**: Commands mutate, queries read
7. **Event versioning**: Support backward compatibility
8. **Dead letter queue**: Handle failed events

## Output Checklist

Every event-driven system should include:

- [ ] Well-defined domain events
- [ ] Type-safe event payloads
- [ ] Event bus (in-memory or distributed)
- [ ] Event handlers with error handling
- [ ] Event store for persistence
- [ ] Aggregate with event sourcing (if needed)
- [ ] CQRS separation (if needed)
- [ ] Read model projectors
- [ ] Dead letter handling
- [ ] Event replay capability
