---
name: zustand-state-builder
description: Implements lightweight state management using Zustand with TypeScript, persistence, devtools, and modular store patterns. Use when users request "zustand store", "state management", "global state", "zustand setup", or "jotai alternative".
---

# Zustand State Builder

Build lightweight, scalable state management with Zustand's minimal API.

## Core Workflow

1. **Identify state needs**: Determine what needs global state
2. **Create store**: Define state shape and actions
3. **Add TypeScript types**: Full type safety
4. **Enable middleware**: Devtools, persist, immer
5. **Split stores**: Modular slices for large apps
6. **Connect components**: Use hooks to access state

## Installation

```bash
npm install zustand

# Optional middleware
npm install immer  # For immutable updates
```

## Basic Store

### Simple Counter Store

```typescript
// stores/counter.ts
import { create } from 'zustand';

interface CounterState {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
  incrementBy: (amount: number) => void;
}

export const useCounterStore = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
  incrementBy: (amount) => set((state) => ({ count: state.count + amount })),
}));

// Usage in component
function Counter() {
  const { count, increment, decrement } = useCounterStore();

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
    </div>
  );
}
```

### Async Actions

```typescript
// stores/users.ts
import { create } from "zustand";

interface User {
  id: string;
  name: string;
  email: string;
}

interface UsersState {
  users: User[];
  isLoading: boolean;
  error: string | null;
  fetchUsers: () => Promise<void>;
  addUser: (user: Omit<User, "id">) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
}

export const useUsersStore = create<UsersState>((set, get) => ({
  users: [],
  isLoading: false,
  error: null,

  fetchUsers: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch("/api/users");
      const users = await response.json();
      set({ users, isLoading: false });
    } catch (error) {
      set({ error: "Failed to fetch users", isLoading: false });
    }
  },

  addUser: async (userData) => {
    set({ isLoading: true, error: null });
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        body: JSON.stringify(userData),
      });
      const newUser = await response.json();
      set((state) => ({
        users: [...state.users, newUser],
        isLoading: false,
      }));
    } catch (error) {
      set({ error: "Failed to add user", isLoading: false });
    }
  },

  deleteUser: async (id) => {
    const previousUsers = get().users;
    // Optimistic update
    set((state) => ({
      users: state.users.filter((u) => u.id !== id),
    }));
    try {
      await fetch(`/api/users/${id}`, { method: "DELETE" });
    } catch (error) {
      // Rollback on error
      set({ users: previousUsers, error: "Failed to delete user" });
    }
  },
}));
```

## Middleware

### DevTools Integration

```typescript
import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface StoreState {
  count: number;
  increment: () => void;
}

export const useStore = create<StoreState>()(
  devtools(
    (set) => ({
      count: 0,
      increment: () =>
        set(
          (state) => ({ count: state.count + 1 }),
          false,
          "increment", // Action name for devtools
        ),
    }),
    { name: "CounterStore" }, // Store name in devtools
  ),
);
```

### Persistence

```typescript
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SettingsState {
  theme: "light" | "dark";
  language: string;
  notifications: boolean;
  setTheme: (theme: "light" | "dark") => void;
  setLanguage: (language: string) => void;
  toggleNotifications: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "light",
      language: "en",
      notifications: true,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      toggleNotifications: () => set((state) => ({ notifications: !state.notifications })),
    }),
    {
      name: "settings-storage", // localStorage key
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist these fields
        theme: state.theme,
        language: state.language,
        notifications: state.notifications,
      }),
    },
  ),
);
```

### Immer Middleware

```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

interface TodosState {
  todos: Todo[];
  addTodo: (text: string) => void;
  toggleTodo: (id: string) => void;
  updateTodo: (id: string, text: string) => void;
  deleteTodo: (id: string) => void;
}

export const useTodosStore = create<TodosState>()(
  immer((set) => ({
    todos: [],

    addTodo: (text) =>
      set((state) => {
        state.todos.push({
          id: crypto.randomUUID(),
          text,
          completed: false,
        });
      }),

    toggleTodo: (id) =>
      set((state) => {
        const todo = state.todos.find((t) => t.id === id);
        if (todo) {
          todo.completed = !todo.completed;
        }
      }),

    updateTodo: (id, text) =>
      set((state) => {
        const todo = state.todos.find((t) => t.id === id);
        if (todo) {
          todo.text = text;
        }
      }),

    deleteTodo: (id) =>
      set((state) => {
        const index = state.todos.findIndex((t) => t.id === id);
        if (index !== -1) {
          state.todos.splice(index, 1);
        }
      }),
  })),
);
```

### Combined Middleware

```typescript
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

export const useStore = create<StoreState>()(
  devtools(
    persist(
      immer((set) => ({
        // ... state and actions
      })),
      { name: "store" },
    ),
    { name: "MyStore" },
  ),
);
```

## Slices Pattern

### Modular Store Architecture

```typescript
// stores/slices/authSlice.ts
import { StateCreator } from "zustand";

export interface AuthSlice {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

export const createAuthSlice: StateCreator<
  AuthSlice & CartSlice, // Combined state type
  [],
  [],
  AuthSlice
> = (set) => ({
  user: null,
  isAuthenticated: false,

  login: async (email, password) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const user = await response.json();
    set({ user, isAuthenticated: true });
  },

  logout: () => set({ user: null, isAuthenticated: false }),
});
```

```typescript
// stores/slices/cartSlice.ts
import { StateCreator } from "zustand";

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CartSlice {
  items: CartItem[];
  addItem: (item: Omit<CartItem, "quantity">) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  clearCart: () => void;
  totalItems: () => number;
  totalPrice: () => number;
}

export const createCartSlice: StateCreator<AuthSlice & CartSlice, [], [], CartSlice> = (
  set,
  get,
) => ({
  items: [],

  addItem: (item) =>
    set((state) => {
      const existing = state.items.find((i) => i.id === item.id);
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i,
          ),
        };
      }
      return { items: [...state.items, { ...item, quantity: 1 }] };
    }),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((i) => i.id !== id),
    })),

  updateQuantity: (id, quantity) =>
    set((state) => ({
      items:
        quantity <= 0
          ? state.items.filter((i) => i.id !== id)
          : state.items.map((i) => (i.id === id ? { ...i, quantity } : i)),
    })),

  clearCart: () => set({ items: [] }),

  totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),

  totalPrice: () => get().items.reduce((sum, i) => sum + i.price * i.quantity, 0),
});
```

```typescript
// stores/index.ts
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { createAuthSlice, AuthSlice } from "./slices/authSlice";
import { createCartSlice, CartSlice } from "./slices/cartSlice";

type StoreState = AuthSlice & CartSlice;

export const useStore = create<StoreState>()(
  devtools(
    persist(
      (...args) => ({
        ...createAuthSlice(...args),
        ...createCartSlice(...args),
      }),
      {
        name: "app-store",
        partialize: (state) => ({
          items: state.items, // Persist cart
          // Don't persist auth (handle with tokens)
        }),
      },
    ),
    { name: "AppStore" },
  ),
);
```

## Selectors

### Optimized Selectors

```typescript
// Avoid re-renders with selectors
function UserName() {
  // Only re-renders when user.name changes
  const userName = useStore((state) => state.user?.name);
  return <span>{userName}</span>;
}

// Multiple values with shallow comparison
import { shallow } from 'zustand/shallow';

function UserInfo() {
  const { name, email } = useStore(
    (state) => ({ name: state.user?.name, email: state.user?.email }),
    shallow
  );
  return (
    <div>
      <p>{name}</p>
      <p>{email}</p>
    </div>
  );
}

// Computed values
function CartSummary() {
  const totalItems = useStore((state) =>
    state.items.reduce((sum, i) => sum + i.quantity, 0)
  );
  const totalPrice = useStore((state) =>
    state.items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  );

  return (
    <div>
      <p>Items: {totalItems}</p>
      <p>Total: ${totalPrice.toFixed(2)}</p>
    </div>
  );
}
```

### Reusable Selector Hooks

```typescript
// stores/selectors.ts
import { useStore } from "./index";
import { shallow } from "zustand/shallow";

// Auth selectors
export const useAuth = () =>
  useStore(
    (state) => ({
      user: state.user,
      isAuthenticated: state.isAuthenticated,
      login: state.login,
      logout: state.logout,
    }),
    shallow,
  );

export const useUser = () => useStore((state) => state.user);
export const useIsAuthenticated = () => useStore((state) => state.isAuthenticated);

// Cart selectors
export const useCart = () =>
  useStore(
    (state) => ({
      items: state.items,
      addItem: state.addItem,
      removeItem: state.removeItem,
      updateQuantity: state.updateQuantity,
      clearCart: state.clearCart,
    }),
    shallow,
  );

export const useCartTotal = () =>
  useStore(
    (state) => ({
      items: state.items.reduce((sum, i) => sum + i.quantity, 0),
      price: state.items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    }),
    shallow,
  );
```

## Outside React Usage

```typescript
// Access store outside React components
const { getState, setState, subscribe } = useStore;

// Get current state
const currentUser = useStore.getState().user;

// Update state
useStore.setState({ user: newUser });

// Subscribe to changes
const unsubscribe = useStore.subscribe((state) => {
  console.log("State changed:", state);
});

// Subscribe to specific slice
const unsubscribeCart = useStore.subscribe(
  (state) => state.items,
  (items, previousItems) => {
    console.log("Cart changed:", items);
  },
);
```

## Server State Integration

### With TanStack Query

```typescript
// stores/ui.ts - Client state only
import { create } from "zustand";

interface UIState {
  sidebarOpen: boolean;
  modalOpen: boolean;
  toggleSidebar: () => void;
  openModal: () => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  modalOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
}));

// hooks/useUsers.ts - Server state with TanStack Query
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => fetch("/api/users").then((r) => r.json()),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (user: CreateUserDto) =>
      fetch("/api/users", {
        method: "POST",
        body: JSON.stringify(user),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
}
```

## Testing

```typescript
// stores/__tests__/counter.test.ts
import { act, renderHook } from "@testing-library/react";
import { useCounterStore } from "../counter";

describe("Counter Store", () => {
  beforeEach(() => {
    // Reset store before each test
    useCounterStore.setState({ count: 0 });
  });

  it("increments count", () => {
    const { result } = renderHook(() => useCounterStore());

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });

  it("decrements count", () => {
    useCounterStore.setState({ count: 5 });
    const { result } = renderHook(() => useCounterStore());

    act(() => {
      result.current.decrement();
    });

    expect(result.current.count).toBe(4);
  });

  it("resets count", () => {
    useCounterStore.setState({ count: 10 });
    const { result } = renderHook(() => useCounterStore());

    act(() => {
      result.current.reset();
    });

    expect(result.current.count).toBe(0);
  });
});
```

## Best Practices

1. **Keep stores small**: One store per domain
2. **Use selectors**: Prevent unnecessary re-renders
3. **Separate client/server state**: Use TanStack Query for server state
4. **Enable devtools**: Essential for debugging
5. **Type everything**: Full TypeScript coverage
6. **Use immer for nested state**: Cleaner immutable updates
7. **Persist sparingly**: Only persist what's needed
8. **Test stores**: Unit test actions and state changes

## Output Checklist

Every Zustand store should include:

- [ ] TypeScript interfaces for state and actions
- [ ] Devtools middleware enabled
- [ ] Persistence where needed
- [ ] Selectors for optimized re-renders
- [ ] Slices pattern for large stores
- [ ] Async action error handling
- [ ] Outside React access method
- [ ] Unit tests for actions
- [ ] Integration with server state library
