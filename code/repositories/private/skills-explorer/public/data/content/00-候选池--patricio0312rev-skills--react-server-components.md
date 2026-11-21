---
name: react-server-components
description: Implements React Server Components (RSC) patterns with Next.js App Router including data fetching, streaming, selective hydration, and server/client composition. Use when users request "server components", "RSC", "Next.js app router", "server-side rendering", or "streaming".
---

# React Server Components

Build performant applications with React Server Components and Next.js App Router.

## Core Workflow

1. **Understand RSC model**: Server vs client components
2. **Design component tree**: Plan server/client boundaries
3. **Implement data fetching**: Fetch in server components
4. **Add interactivity**: Client components where needed
5. **Enable streaming**: Suspense for progressive loading
6. **Optimize**: Minimize client bundle size

## Server vs Client Components

### Key Differences

| Feature        | Server Components    | Client Components        |
| -------------- | -------------------- | ------------------------ |
| Rendering      | Server only          | Server + Client          |
| Bundle size    | Zero JS sent         | Adds to bundle           |
| Data fetching  | Direct DB/API access | useEffect/TanStack Query |
| State/Effects  | No hooks             | Full React hooks         |
| Event handlers | No                   | Yes                      |
| Browser APIs   | No                   | Yes                      |
| File directive | Default (none)       | `'use client'`           |

### When to Use Each

**Server Components (Default)**

- Static content
- Data fetching
- Backend resource access
- Large dependencies (markdown, syntax highlighting)
- Sensitive logic/tokens

**Client Components**

- Interactive UI (onClick, onChange)
- useState, useEffect, useReducer
- Browser APIs (localStorage, geolocation)
- Custom hooks with state
- Third-party client libraries

## Basic Patterns

### Server Component (Default)

```tsx
// app/users/page.tsx (Server Component - no directive needed)
import { db } from "@/lib/db";

async function getUsers() {
  return db.user.findMany({
    orderBy: { createdAt: "desc" },
  });
}

export default async function UsersPage() {
  const users = await getUsers();

  return (
    <div>
      <h1>Users</h1>
      <ul>
        {users.map((user) => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Client Component

```tsx
// components/Counter.tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```

### Composition Pattern

```tsx
// app/dashboard/page.tsx (Server Component)
import { db } from "@/lib/db";
import { DashboardClient } from "./DashboardClient";
import { StatsCard } from "@/components/StatsCard";

async function getStats() {
  const [users, orders, revenue] = await Promise.all([
    db.user.count(),
    db.order.count(),
    db.order.aggregate({ _sum: { total: true } }),
  ]);
  return { users, orders, revenue: revenue._sum.total };
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div>
      {/* Server-rendered static content */}
      <h1>Dashboard</h1>

      {/* Server components with data */}
      <div className="grid grid-cols-3 gap-4">
        <StatsCard title="Users" value={stats.users} />
        <StatsCard title="Orders" value={stats.orders} />
        <StatsCard title="Revenue" value={`$${stats.revenue}`} />
      </div>

      {/* Client component for interactivity */}
      <DashboardClient initialData={stats} />
    </div>
  );
}
```

```tsx
// app/dashboard/DashboardClient.tsx
"use client";

import { useState } from "react";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Chart } from "@/components/Chart";

interface DashboardClientProps {
  initialData: Stats;
}

export function DashboardClient({ initialData }: DashboardClientProps) {
  const [dateRange, setDateRange] = useState({ from: null, to: null });

  return (
    <div>
      <DateRangePicker value={dateRange} onChange={setDateRange} />
      <Chart data={initialData} />
    </div>
  );
}
```

## Data Fetching Patterns

### Parallel Data Fetching

```tsx
// app/page.tsx
async function getUser(id: string) {
  const res = await fetch(`/api/users/${id}`);
  return res.json();
}

async function getPosts(userId: string) {
  const res = await fetch(`/api/users/${userId}/posts`);
  return res.json();
}

async function getComments(userId: string) {
  const res = await fetch(`/api/users/${userId}/comments`);
  return res.json();
}

export default async function ProfilePage({ params }: { params: { id: string } }) {
  // Parallel fetching - all requests start simultaneously
  const [user, posts, comments] = await Promise.all([
    getUser(params.id),
    getPosts(params.id),
    getComments(params.id),
  ]);

  return (
    <div>
      <UserHeader user={user} />
      <PostsList posts={posts} />
      <CommentsList comments={comments} />
    </div>
  );
}
```

### Sequential Data Fetching (When Dependent)

```tsx
export default async function OrderPage({ params }: { params: { id: string } }) {
  // Sequential - second fetch depends on first
  const order = await getOrder(params.id);
  const customer = await getCustomer(order.customerId);

  return (
    <div>
      <OrderDetails order={order} />
      <CustomerInfo customer={customer} />
    </div>
  );
}
```

### Caching and Revalidation

```tsx
// Static data (cached indefinitely)
async function getStaticData() {
  const res = await fetch("https://api.example.com/static", {
    cache: "force-cache", // Default
  });
  return res.json();
}

// Dynamic data (no cache)
async function getDynamicData() {
  const res = await fetch("https://api.example.com/dynamic", {
    cache: "no-store",
  });
  return res.json();
}

// Revalidate after time
async function getRevalidatedData() {
  const res = await fetch("https://api.example.com/data", {
    next: { revalidate: 3600 }, // Revalidate every hour
  });
  return res.json();
}

// Revalidate by tag
async function getTaggedData() {
  const res = await fetch("https://api.example.com/products", {
    next: { tags: ["products"] },
  });
  return res.json();
}

// Trigger revalidation
import { revalidateTag } from "next/cache";
revalidateTag("products");
```

## Streaming with Suspense

### Page-Level Streaming

```tsx
// app/dashboard/page.tsx
import { Suspense } from "react";
import { StatsCards, StatsCardsSkeleton } from "./StatsCards";
import { RecentOrders, RecentOrdersSkeleton } from "./RecentOrders";
import { TopProducts, TopProductsSkeleton } from "./TopProducts";

export default function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>

      {/* Each section streams independently */}
      <Suspense fallback={<StatsCardsSkeleton />}>
        <StatsCards />
      </Suspense>

      <div className="grid grid-cols-2 gap-4 mt-8">
        <Suspense fallback={<RecentOrdersSkeleton />}>
          <RecentOrders />
        </Suspense>

        <Suspense fallback={<TopProductsSkeleton />}>
          <TopProducts />
        </Suspense>
      </div>
    </div>
  );
}
```

### Component with Data

```tsx
// app/dashboard/StatsCards.tsx
import { db } from "@/lib/db";

async function getStats() {
  // Simulate slow query
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return db.stats.findFirst();
}

export async function StatsCards() {
  const stats = await getStats();

  return (
    <div className="grid grid-cols-4 gap-4">
      <Card title="Revenue" value={stats.revenue} />
      <Card title="Orders" value={stats.orders} />
      <Card title="Customers" value={stats.customers} />
      <Card title="Products" value={stats.products} />
    </div>
  );
}

export function StatsCardsSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="h-24 bg-gray-200 animate-pulse rounded" />
      ))}
    </div>
  );
}
```

### Loading States

```tsx
// app/products/loading.tsx
export default function ProductsLoading() {
  return (
    <div className="grid grid-cols-3 gap-4">
      {[...Array(9)].map((_, i) => (
        <div key={i} className="h-64 bg-gray-200 animate-pulse rounded" />
      ))}
    </div>
  );
}
```

## Server Actions

### Form Actions

```tsx
// app/contact/page.tsx
import { submitContact } from "./actions";

export default function ContactPage() {
  return (
    <form action={submitContact}>
      <input name="email" type="email" required />
      <textarea name="message" required />
      <button type="submit">Send</button>
    </form>
  );
}
```

```tsx
// app/contact/actions.ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";

const schema = z.object({
  email: z.string().email(),
  message: z.string().min(10),
});

export async function submitContact(formData: FormData) {
  const validatedFields = schema.safeParse({
    email: formData.get("email"),
    message: formData.get("message"),
  });

  if (!validatedFields.success) {
    return { error: validatedFields.error.flatten().fieldErrors };
  }

  await db.contact.create({
    data: validatedFields.data,
  });

  revalidatePath("/contacts");
  return { success: true };
}
```

### With useActionState

```tsx
// components/ContactForm.tsx
"use client";

import { useActionState } from "react";
import { submitContact } from "@/app/contact/actions";

export function ContactForm() {
  const [state, formAction, isPending] = useActionState(submitContact, null);

  return (
    <form action={formAction}>
      <input name="email" type="email" required />
      {state?.error?.email && <p className="text-red-500">{state.error.email}</p>}

      <textarea name="message" required />
      {state?.error?.message && <p className="text-red-500">{state.error.message}</p>}

      <button type="submit" disabled={isPending}>
        {isPending ? "Sending..." : "Send"}
      </button>

      {state?.success && <p className="text-green-500">Message sent!</p>}
    </form>
  );
}
```

## Optimistic Updates

```tsx
// components/LikeButton.tsx
"use client";

import { useOptimistic, useTransition } from "react";
import { likePost } from "@/app/actions";

interface LikeButtonProps {
  postId: string;
  initialLikes: number;
  isLiked: boolean;
}

export function LikeButton({ postId, initialLikes, isLiked }: LikeButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [optimisticState, addOptimistic] = useOptimistic(
    { likes: initialLikes, isLiked },
    (state, newIsLiked: boolean) => ({
      likes: newIsLiked ? state.likes + 1 : state.likes - 1,
      isLiked: newIsLiked,
    }),
  );

  const handleClick = () => {
    startTransition(async () => {
      addOptimistic(!optimisticState.isLiked);
      await likePost(postId);
    });
  };

  return (
    <button onClick={handleClick} disabled={isPending}>
      {optimisticState.isLiked ? "❤️" : "🤍"} {optimisticState.likes}
    </button>
  );
}
```

## Patterns for Common Use Cases

### Authentication Check

```tsx
// app/dashboard/layout.tsx
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <div>
      <nav>Welcome, {session.user.name}</nav>
      {children}
    </div>
  );
}
```

### Passing Server Data to Client

```tsx
// app/products/[id]/page.tsx
import { getProduct } from "@/lib/products";
import { ProductGallery } from "./ProductGallery";

export default async function ProductPage({ params }: { params: { id: string } }) {
  const product = await getProduct(params.id);

  return (
    <div>
      <h1>{product.name}</h1>
      <p>{product.description}</p>

      {/* Pass serializable data to client component */}
      <ProductGallery images={product.images} initialIndex={0} />
    </div>
  );
}
```

### Nested Client Components

```tsx
// components/Modal.tsx
"use client";

import { createContext, useContext, useState } from "react";

const ModalContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <ModalContext.Provider value={{ open, setOpen }}>{children}</ModalContext.Provider>;
}

export function useModal() {
  const context = useContext(ModalContext);
  if (!context) throw new Error("useModal must be used within ModalProvider");
  return context;
}
```

## Best Practices

1. **Start with Server Components**: Default to server, add 'use client' only when needed
2. **Push client boundaries down**: Keep interactivity in leaf components
3. **Parallel fetch data**: Use Promise.all for independent data
4. **Use Suspense for streaming**: Progressive loading for better UX
5. **Colocate data fetching**: Fetch where data is used
6. **Minimize client bundle**: Heavy libraries stay on server
7. **Cache appropriately**: Use revalidation strategies
8. **Handle errors**: Use error.tsx boundaries

## Output Checklist

Every RSC implementation should include:

- [ ] Server components for data fetching
- [ ] 'use client' only where needed
- [ ] Suspense boundaries for streaming
- [ ] Loading skeletons for each section
- [ ] Parallel data fetching with Promise.all
- [ ] Server actions for mutations
- [ ] Proper caching strategy
- [ ] Error boundaries (error.tsx)
- [ ] Authentication checks in layouts
- [ ] Minimal client JavaScript bundle
