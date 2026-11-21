---
name: page-layout-builder
description: Generates complete page layouts and shells for common patterns (dashboard, authentication, settings, CRUD pages) with consistent navigation, layout components, routing structure, and state management placeholders. Use when building "new page", "dashboard layout", "auth pages", or "admin panel structure".
---

# Page Layout Builder

Generate production-ready page layouts with routing, navigation, and state patterns.

## Core Workflow

1. **Choose page type**: Dashboard, auth, settings, CRUD, landing, etc.
2. **Setup routing**: Create route files with proper structure
3. **Build layout**: Header, sidebar, main content, footer
4. **Add navigation**: Nav menus, breadcrumbs, tabs
5. **State placeholders**: Data fetching, forms, modals
6. **Responsive design**: Mobile-first with breakpoints
7. **Loading states**: Skeletons and suspense boundaries

## Common Page Patterns

### Dashboard Layout

```typescript
// app/dashboard/layout.tsx
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar - Hidden on mobile, shown on desktop */}
      <Sidebar className="hidden lg:flex lg:w-64 lg:flex-col" />

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
```

```typescript
// app/dashboard/page.tsx
import { StatsCard } from "@/components/dashboard/StatsCard";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { Chart } from "@/components/dashboard/Chart";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-gray-600">Welcome back! Here's your overview.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatsCard title="Total Users" value="2,543" change="+12%" trend="up" />
        <StatsCard title="Revenue" value="$45,231" change="+8%" trend="up" />
        <StatsCard
          title="Active Sessions"
          value="431"
          change="-3%"
          trend="down"
        />
        <StatsCard
          title="Conversion Rate"
          value="3.2%"
          change="+0.5%"
          trend="up"
        />
      </div>

      {/* Charts and Activity */}
      <div className="grid gap-6 md:grid-cols-2">
        <Chart title="Revenue Over Time" />
        <RecentActivity title="Recent Activity" />
      </div>
    </div>
  );
}
```

### Authentication Pages

```typescript
// app/(auth)/layout.tsx
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      {/* Left side - Branding (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 lg:flex-col lg:justify-center lg:bg-primary-500 lg:p-12">
        <div className="text-white">
          <h1 className="text-4xl font-bold">Welcome to AppName</h1>
          <p className="mt-4 text-lg text-primary-100">
            The best platform for managing your workflow
          </p>
        </div>
      </div>

      {/* Right side - Auth form */}
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6 lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
```

```typescript
// app/(auth)/login/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);

    // TODO: Implement authentication logic
    try {
      // await signIn(formData);
      router.push("/dashboard");
    } catch (error) {
      console.error("Login failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-bold">Sign In</h1>
        <p className="text-gray-600">
          Enter your credentials to access your account
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            required
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-sm text-primary-600 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            required
          />
        </div>

        <Button type="submit" className="w-full" isLoading={isLoading}>
          Sign In
        </Button>
      </form>

      <div className="text-center text-sm">
        Don't have an account?{" "}
        <Link href="/register" className="text-primary-600 hover:underline">
          Sign up
        </Link>
      </div>
    </div>
  );
}
```

### Settings/Profile Page

```typescript
// app/settings/layout.tsx
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-gray-600">
          Manage your account settings and preferences
        </p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <SettingsSidebar className="lg:w-64" />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}
```

```typescript
// app/settings/profile/page.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";

export default function ProfileSettingsPage() {
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    // TODO: Save profile changes

    setIsSaving(false);
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Profile Information</h2>
            <p className="text-sm text-gray-600">
              Update your account's profile information and email address
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" placeholder="Your name" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="you@example.com" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bio">Bio</Label>
              <textarea
                id="bio"
                rows={4}
                className="w-full rounded-md border border-gray-300 p-3"
                placeholder="Tell us about yourself"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" isLoading={isSaving}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
```

### CRUD Page (List/Create/Edit/Delete)

```typescript
// app/users/page.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table } from "@/components/ui/table";
import { CreateUserModal } from "@/components/users/CreateUserModal";
import { DeleteConfirmDialog } from "@/components/ui/DeleteConfirmDialog";

export default function UsersPage() {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Users</h1>
          <p className="text-gray-600">Manage your team members</p>
        </div>
        <Button onClick={() => setIsCreateModalOpen(true)}>Add User</Button>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <Input
          placeholder="Search users..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        {/* TODO: Implement table with data */}
      </div>

      {/* Modals */}
      <CreateUserModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
    </div>
  );
}
```

## Navigation Components

### Sidebar Navigation

```typescript
// components/Sidebar.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  HomeIcon,
  UsersIcon,
  SettingsIcon,
  ChartBarIcon,
} from "@/components/icons";

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: HomeIcon },
  { name: "Users", href: "/users", icon: UsersIcon },
  { name: "Analytics", href: "/analytics", icon: ChartBarIcon },
  { name: "Settings", href: "/settings", icon: SettingsIcon },
];

export function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <aside className={cn("border-r bg-white", className)}>
      <div className="flex h-16 items-center px-6">
        <span className="text-xl font-bold">AppName</span>
      </div>

      <nav className="space-y-1 px-3">
        {navigation.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary-50 text-primary-600"
                  : "text-gray-700 hover:bg-gray-100"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

### Header with User Menu

```typescript
// components/Header.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { BellIcon, MenuIcon } from "@/components/icons";

export function Header() {
  return (
    <header className="flex h-16 items-center justify-between border-b bg-white px-4 md:px-6">
      {/* Mobile menu button */}
      <Button variant="ghost" size="icon" className="lg:hidden">
        <MenuIcon className="h-6 w-6" />
      </Button>

      {/* Search (optional) */}
      <div className="flex-1 px-4">{/* Search component */}</div>

      {/* Right side actions */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon">
          <BellIcon className="h-5 w-5" />
        </Button>

        <DropdownMenu>
          <Avatar src="/avatar.jpg" alt="User" />
        </DropdownMenu>
      </div>
    </header>
  );
}
```

## Routing Structure

### Next.js App Router

```
app/
├── (auth)/                 # Auth group (no dashboard layout)
│   ├── layout.tsx
│   ├── login/
│   │   └── page.tsx
│   ├── register/
│   │   └── page.tsx
│   └── forgot-password/
│       └── page.tsx
├── dashboard/             # Dashboard section
│   ├── layout.tsx
│   └── page.tsx
├── users/                 # CRUD section
│   ├── page.tsx           # List
│   ├── [id]/
│   │   ├── page.tsx       # Detail/Edit
│   │   └── loading.tsx
│   └── new/
│       └── page.tsx       # Create
├── settings/              # Settings section
│   ├── layout.tsx
│   ├── profile/
│   │   └── page.tsx
│   ├── security/
│   │   └── page.tsx
│   └── notifications/
│       └── page.tsx
└── layout.tsx             # Root layout
```

## State Management Patterns

### Data Fetching Pattern

```typescript
// app/users/page.tsx
import { Suspense } from "react";
import { UsersTable } from "@/components/users/UsersTable";
import { UsersTableSkeleton } from "@/components/users/UsersTableSkeleton";

async function getUsers() {
  // Server-side data fetching
  const res = await fetch("https://api.example.com/users", {
    cache: "no-store",
  });
  return res.json();
}

export default async function UsersPage() {
  const users = await getUsers();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Users</h1>

      <Suspense fallback={<UsersTableSkeleton />}>
        <UsersTable data={users} />
      </Suspense>
    </div>
  );
}
```

### Client-Side State

```typescript
"use client";

import { useState, useEffect } from "react";
import { useUsers } from "@/hooks/useUsers";

export default function UsersPage() {
  const { users, isLoading, error } = useUsers();
  const [selectedUser, setSelectedUser] = useState(null);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return <div>{/* Page content */}</div>;
}
```

## Loading States

### Skeleton Screens

```typescript
// components/dashboard/DashboardSkeleton.tsx
export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-48 bg-gray-200 rounded" />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-200 rounded-lg" />
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="h-64 bg-gray-200 rounded-lg" />
        <div className="h-64 bg-gray-200 rounded-lg" />
      </div>
    </div>
  );
}
```

### Loading Component

```typescript
// app/dashboard/loading.tsx
import { DashboardSkeleton } from "@/components/dashboard/DashboardSkeleton";

export default function Loading() {
  return <DashboardSkeleton />;
}
```

## Responsive Patterns

### Mobile Navigation

```typescript
"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/sheet";

export function MobileNav() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button onClick={() => setIsOpen(true)} className="lg:hidden">
        <MenuIcon />
      </button>

      <Sheet isOpen={isOpen} onClose={() => setIsOpen(false)}>
        <nav className="space-y-2 p-4">{/* Navigation items */}</nav>
      </Sheet>
    </>
  );
}
```

## Best Practices

1. **Consistent layouts**: Use layout files for shared structure
2. **Route groups**: Organize related pages with (groupName)
3. **Loading states**: Add loading.tsx for automatic suspense
4. **Error boundaries**: Add error.tsx for error handling
5. **Mobile-first**: Design for mobile, enhance for desktop
6. **Accessibility**: Semantic HTML, ARIA labels, keyboard nav
7. **SEO**: Use metadata, proper heading hierarchy
8. **Performance**: Code splitting, lazy loading, optimized images

## Output Checklist

Every page layout should include:

- [ ] Proper route structure with layout files
- [ ] Responsive navigation (sidebar + mobile menu)
- [ ] Header with actions
- [ ] Main content area with proper spacing
- [ ] Loading states (skeletons)
- [ ] Empty states
- [ ] Error boundaries
- [ ] State management placeholders
- [ ] Breadcrumbs or page headers
- [ ] Mobile-responsive breakpoints
