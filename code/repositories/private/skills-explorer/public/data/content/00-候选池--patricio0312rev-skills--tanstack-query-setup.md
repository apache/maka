---
name: tanstack-query-setup
description: Implements TanStack Query (React Query) for server state management with caching, mutations, optimistic updates, and infinite queries. Use when users request "react query", "tanstack query", "data fetching", "cache management", or "server state".
---

# TanStack Query Setup

Manage server state with powerful caching, background updates, and optimistic UI.

## Core Workflow

1. **Install and configure**: Set up QueryClient
2. **Create queries**: Define data fetching hooks
3. **Add mutations**: Handle data modifications
4. **Enable caching**: Configure stale times
5. **Implement optimistic updates**: Instant UI feedback
6. **Add infinite queries**: Pagination and infinite scroll

## Installation

```bash
npm install @tanstack/react-query @tanstack/react-query-devtools
```

## Provider Setup

### Next.js App Router

```tsx
// app/providers.tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            gcTime: 5 * 60 * 1000, // 5 minutes (formerly cacheTime)
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
```

```tsx
// app/layout.tsx
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

## Basic Queries

### Simple Query

```tsx
// hooks/useUsers.ts
import { useQuery } from "@tanstack/react-query";

interface User {
  id: string;
  name: string;
  email: string;
}

async function fetchUsers(): Promise<User[]> {
  const response = await fetch("/api/users");
  if (!response.ok) {
    throw new Error("Failed to fetch users");
  }
  return response.json();
}

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: fetchUsers,
  });
}

// Usage
function UsersList() {
  const { data: users, isLoading, error } = useUsers();

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;

  return (
    <ul>
      {users?.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

### Query with Parameters

```tsx
// hooks/useUser.ts
import { useQuery } from "@tanstack/react-query";

async function fetchUser(userId: string): Promise<User> {
  const response = await fetch(`/api/users/${userId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch user");
  }
  return response.json();
}

export function useUser(userId: string) {
  return useQuery({
    queryKey: ["users", userId],
    queryFn: () => fetchUser(userId),
    enabled: !!userId, // Only fetch when userId exists
  });
}

// Usage
function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading } = useUser(userId);

  if (isLoading) return <Skeleton />;

  return <div>{user?.name}</div>;
}
```

### Query with Filters

```tsx
// hooks/useProducts.ts
interface ProductFilters {
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
}

async function fetchProducts(filters: ProductFilters): Promise<Product[]> {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.minPrice) params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice) params.set("maxPrice", String(filters.maxPrice));
  if (filters.search) params.set("search", filters.search);

  const response = await fetch(`/api/products?${params}`);
  return response.json();
}

export function useProducts(filters: ProductFilters) {
  return useQuery({
    queryKey: ["products", filters],
    queryFn: () => fetchProducts(filters),
    placeholderData: (previousData) => previousData, // Keep previous data while fetching
  });
}
```

## Mutations

### Basic Mutation

```tsx
// hooks/useCreateUser.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface CreateUserDto {
  name: string;
  email: string;
}

async function createUser(data: CreateUserDto): Promise<User> {
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error("Failed to create user");
  }

  return response.json();
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createUser,
    onSuccess: (newUser) => {
      // Invalidate and refetch users list
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      console.error("Failed to create user:", error);
    },
  });
}

// Usage
function CreateUserForm() {
  const { mutate, isPending, isError, error } = useCreateUser();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    mutate({
      name: formData.get("name") as string,
      email: formData.get("email") as string,
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create User"}
      </button>
      {isError && <p className="text-red-500">{error.message}</p>}
    </form>
  );
}
```

### Update and Delete

```tsx
// hooks/useUpdateUser.ts
export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<User> }) => {
      const response = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return response.json();
    },
    onSuccess: (updatedUser) => {
      // Update the single user cache
      queryClient.setQueryData(["users", updatedUser.id], updatedUser);
      // Invalidate the list
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

// hooks/useDeleteUser.ts
export function useDeleteUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      await fetch(`/api/users/${userId}`, { method: "DELETE" });
      return userId;
    },
    onSuccess: (deletedId) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: ["users", deletedId] });
      // Invalidate list
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
```

## Optimistic Updates

### List Update

```tsx
// hooks/useToggleTodo.ts
export function useToggleTodo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, completed }: { id: string; completed: boolean }) => {
      const response = await fetch(`/api/todos/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed }),
      });
      return response.json();
    },

    // Optimistic update
    onMutate: async ({ id, completed }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["todos"] });

      // Snapshot previous value
      const previousTodos = queryClient.getQueryData<Todo[]>(["todos"]);

      // Optimistically update
      queryClient.setQueryData<Todo[]>(["todos"], (old) =>
        old?.map((todo) => (todo.id === id ? { ...todo, completed } : todo)),
      );

      // Return context for rollback
      return { previousTodos };
    },

    // Rollback on error
    onError: (err, variables, context) => {
      if (context?.previousTodos) {
        queryClient.setQueryData(["todos"], context.previousTodos);
      }
    },

    // Refetch after success or error
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}
```

### Create with Optimistic Add

```tsx
export function useCreateTodo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (text: string) => {
      const response = await fetch("/api/todos", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      return response.json();
    },

    onMutate: async (text) => {
      await queryClient.cancelQueries({ queryKey: ["todos"] });

      const previousTodos = queryClient.getQueryData<Todo[]>(["todos"]);

      // Add optimistic todo with temp id
      const optimisticTodo: Todo = {
        id: `temp-${Date.now()}`,
        text,
        completed: false,
      };

      queryClient.setQueryData<Todo[]>(["todos"], (old) => [...(old || []), optimisticTodo]);

      return { previousTodos, optimisticTodo };
    },

    onError: (err, text, context) => {
      if (context?.previousTodos) {
        queryClient.setQueryData(["todos"], context.previousTodos);
      }
    },

    onSuccess: (newTodo, text, context) => {
      // Replace optimistic todo with real one
      queryClient.setQueryData<Todo[]>(["todos"], (old) =>
        old?.map((todo) => (todo.id === context?.optimisticTodo.id ? newTodo : todo)),
      );
    },
  });
}
```

## Infinite Queries

### Cursor-Based Pagination

```tsx
// hooks/useInfinitePosts.ts
import { useInfiniteQuery } from "@tanstack/react-query";

interface PostsPage {
  posts: Post[];
  nextCursor?: string;
}

async function fetchPosts({ pageParam }: { pageParam?: string }): Promise<PostsPage> {
  const url = pageParam ? `/api/posts?cursor=${pageParam}` : "/api/posts";

  const response = await fetch(url);
  return response.json();
}

export function useInfinitePosts() {
  return useInfiniteQuery({
    queryKey: ["posts"],
    queryFn: fetchPosts,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

// Usage with intersection observer
function PostsFeed() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfinitePosts();

  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <div>
      {data?.pages.map((page, pageIndex) => (
        <Fragment key={pageIndex}>
          {page.posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </Fragment>
      ))}

      <div ref={loadMoreRef} className="h-10">
        {isFetchingNextPage && <Spinner />}
      </div>
    </div>
  );
}
```

### Offset-Based Pagination

```tsx
export function useInfiniteProducts() {
  return useInfiniteQuery({
    queryKey: ["products"],
    queryFn: async ({ pageParam = 0 }) => {
      const response = await fetch(`/api/products?offset=${pageParam}&limit=20`);
      return response.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      // Stop if less than limit returned
      if (lastPage.products.length < 20) return undefined;
      return allPages.length * 20;
    },
  });
}
```

## Query Factories

### Organized Query Keys

```tsx
// lib/queries/users.ts
import { queryOptions } from "@tanstack/react-query";

export const userQueries = {
  all: () =>
    queryOptions({
      queryKey: ["users"],
      queryFn: fetchUsers,
    }),

  detail: (id: string) =>
    queryOptions({
      queryKey: ["users", id],
      queryFn: () => fetchUser(id),
    }),

  list: (filters: UserFilters) =>
    queryOptions({
      queryKey: ["users", "list", filters],
      queryFn: () => fetchUsers(filters),
    }),

  posts: (userId: string) =>
    queryOptions({
      queryKey: ["users", userId, "posts"],
      queryFn: () => fetchUserPosts(userId),
    }),
};

// Usage
function UserProfile({ userId }: { userId: string }) {
  const userQuery = useQuery(userQueries.detail(userId));
  const postsQuery = useQuery(userQueries.posts(userId));
  // ...
}

// Invalidation
queryClient.invalidateQueries({ queryKey: ["users"] }); // All user queries
queryClient.invalidateQueries({ queryKey: ["users", userId] }); // Specific user
```

## Prefetching

### On Hover

```tsx
function UserLink({ userId, children }: { userId: string; children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const prefetch = () => {
    queryClient.prefetchQuery(userQueries.detail(userId));
  };

  return (
    <Link href={`/users/${userId}`} onMouseEnter={prefetch} onFocus={prefetch}>
      {children}
    </Link>
  );
}
```

### In Server Components

```tsx
// app/users/page.tsx
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { userQueries } from "@/lib/queries/users";
import { UsersList } from "./UsersList";

export default async function UsersPage() {
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery(userQueries.all());

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UsersList />
    </HydrationBoundary>
  );
}
```

## Dependent Queries

```tsx
function UserPosts({ userId }: { userId: string }) {
  // First query
  const userQuery = useQuery({
    queryKey: ["users", userId],
    queryFn: () => fetchUser(userId),
  });

  // Dependent query - only runs when user is loaded
  const postsQuery = useQuery({
    queryKey: ["users", userId, "posts"],
    queryFn: () => fetchUserPosts(userId),
    enabled: !!userQuery.data, // Wait for user
  });

  if (userQuery.isLoading) return <Spinner />;

  return (
    <div>
      <h2>{userQuery.data?.name}'s Posts</h2>
      {postsQuery.isLoading ? <Spinner /> : <PostsList posts={postsQuery.data} />}
    </div>
  );
}
```

## Parallel Queries

```tsx
import { useQueries } from "@tanstack/react-query";

function Dashboard({ userIds }: { userIds: string[] }) {
  const userQueries = useQueries({
    queries: userIds.map((id) => ({
      queryKey: ["users", id],
      queryFn: () => fetchUser(id),
    })),
  });

  const isLoading = userQueries.some((q) => q.isLoading);
  const users = userQueries.map((q) => q.data).filter(Boolean);

  if (isLoading) return <Spinner />;

  return (
    <div>
      {users.map((user) => (
        <UserCard key={user.id} user={user} />
      ))}
    </div>
  );
}
```

## Best Practices

1. **Use query factories**: Organized, reusable query options
2. **Set appropriate stale times**: Balance freshness vs performance
3. **Optimistic updates**: Instant UI feedback
4. **Prefetch on hover**: Anticipate user navigation
5. **Use placeholderData**: Show stale data while fetching
6. **Handle errors gracefully**: Error boundaries and retry
7. **SSR with HydrationBoundary**: Hydrate queries from server
8. **Separate queries and mutations**: Clear data flow

## Output Checklist

Every TanStack Query implementation should include:

- [ ] QueryClient with default options
- [ ] Provider with devtools
- [ ] Query factories for organization
- [ ] Proper query keys structure
- [ ] Mutations with invalidation
- [ ] Optimistic updates for UX
- [ ] Loading and error states
- [ ] Prefetching strategy
- [ ] SSR hydration (if using Next.js)
- [ ] Infinite queries for pagination
