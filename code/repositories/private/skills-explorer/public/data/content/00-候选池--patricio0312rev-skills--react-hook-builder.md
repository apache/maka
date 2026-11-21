---
name: react-hook-builder
description: Creates custom React hooks for common patterns including data fetching, forms, authentication, local storage, debounce, and more. Use when users request "create custom hook", "React hook for", "useX hook", or "reusable hook".
---

# React Hook Builder

Build production-ready custom React hooks following best practices and TypeScript patterns.

## Core Workflow

1. **Identify the pattern**: Determine what logic to encapsulate
2. **Design the API**: Define inputs, outputs, and options
3. **Add TypeScript types**: Full type safety with generics
4. **Handle edge cases**: Loading, errors, cleanup
5. **Optimize performance**: Memoization where needed
6. **Write tests**: Cover all states and scenarios

## Hook Naming Conventions

```typescript
// Always prefix with "use"
useLocalStorage; // ✓
useDebounce; // ✓
useFetch; // ✓
localStorageHook; // ✗
fetchData; // ✗
```

## Data Fetching Hooks

### useFetch

```typescript
// hooks/useFetch.ts
import { useState, useEffect, useCallback, useRef } from 'react';

interface UseFetchOptions<T> {
  immediate?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
}

interface UseFetchResult<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => Promise<void>;
}

export function useFetch<T>(
  url: string | null,
  options: UseFetchOptions<T> = {}
): UseFetchResult<T> {
  const { immediate = true, onSuccess, onError } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (!url) return;

    // Cancel previous request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(url, {
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      setData(result);
      onSuccess?.(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return; // Ignore abort errors
      }
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      onError?.(error);
    } finally {
      setIsLoading(false);
    }
  }, [url, onSuccess, onError]);

  useEffect(() => {
    if (immediate) {
      fetchData();
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [fetchData, immediate]);

  return {
    data,
    error,
    isLoading,
    isError: !!error,
    isSuccess: !!data && !error,
    refetch: fetchData,
  };
}

// Usage
function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading, error } = useFetch<User>(
    `/api/users/${userId}`
  );

  if (isLoading) return <Spinner />;
  if (error) return <Error message={error.message} />;
  return <Profile user={user!} />;
}
```

### useMutation

```typescript
// hooks/useMutation.ts
import { useState, useCallback } from 'react';

interface UseMutationOptions<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
}

interface UseMutationResult<TData, TVariables> {
  data: TData | null;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  mutate: (variables: TVariables) => Promise<TData | undefined>;
  reset: () => void;
}

export function useMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseMutationOptions<TData, TVariables> = {}
): UseMutationResult<TData, TVariables> {
  const { onSuccess, onError, onSettled } = options;

  const [data, setData] = useState<TData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const mutate = useCallback(
    async (variables: TVariables) => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await mutationFn(variables);
        setData(result);
        onSuccess?.(result, variables);
        onSettled?.(result, null, variables);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error');
        setError(error);
        onError?.(error, variables);
        onSettled?.(undefined, error, variables);
        return undefined;
      } finally {
        setIsLoading(false);
      }
    },
    [mutationFn, onSuccess, onError, onSettled]
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return {
    data,
    error,
    isLoading,
    isError: !!error,
    isSuccess: !!data && !error,
    mutate,
    reset,
  };
}

// Usage
function CreateUser() {
  const { mutate, isLoading } = useMutation(
    async (data: CreateUserDto) => {
      const res = await fetch('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return res.json();
    },
    {
      onSuccess: () => toast.success('User created!'),
    }
  );

  return (
    <button onClick={() => mutate({ name: 'John' })} disabled={isLoading}>
      Create User
    </button>
  );
}
```

## Form Hooks

### useForm

```typescript
// hooks/useForm.ts
import { useState, useCallback, ChangeEvent, FormEvent } from 'react';

type ValidationRules<T> = {
  [K in keyof T]?: (value: T[K], values: T) => string | undefined;
};

interface UseFormOptions<T> {
  initialValues: T;
  validate?: ValidationRules<T>;
  onSubmit: (values: T) => void | Promise<void>;
}

interface UseFormResult<T> {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  touched: Partial<Record<keyof T, boolean>>;
  isSubmitting: boolean;
  isValid: boolean;
  handleChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  handleBlur: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  handleSubmit: (e: FormEvent) => void;
  setFieldValue: <K extends keyof T>(field: K, value: T[K]) => void;
  setFieldError: (field: keyof T, error: string) => void;
  reset: () => void;
}

export function useForm<T extends Record<string, any>>({
  initialValues,
  validate = {},
  onSubmit,
}: UseFormOptions<T>): UseFormResult<T> {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateField = useCallback(
    (name: keyof T, value: T[keyof T]) => {
      const validator = validate[name];
      if (validator) {
        return validator(value, values);
      }
      return undefined;
    },
    [validate, values]
  );

  const validateAll = useCallback(() => {
    const newErrors: Partial<Record<keyof T, string>> = {};
    let isValid = true;

    (Object.keys(values) as Array<keyof T>).forEach((key) => {
      const error = validateField(key, values[key]);
      if (error) {
        newErrors[key] = error;
        isValid = false;
      }
    });

    setErrors(newErrors);
    return isValid;
  }, [values, validateField]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const { name, value, type } = e.target;
      const newValue = type === 'checkbox' ? (e.target as HTMLInputElement).checked : value;

      setValues((prev) => ({ ...prev, [name]: newValue }));

      // Clear error on change
      if (errors[name as keyof T]) {
        setErrors((prev) => ({ ...prev, [name]: undefined }));
      }
    },
    [errors]
  );

  const handleBlur = useCallback(
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const { name, value } = e.target;

      setTouched((prev) => ({ ...prev, [name]: true }));

      const error = validateField(name as keyof T, value as T[keyof T]);
      if (error) {
        setErrors((prev) => ({ ...prev, [name]: error }));
      }
    },
    [validateField]
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();

      // Mark all fields as touched
      const allTouched = Object.keys(values).reduce(
        (acc, key) => ({ ...acc, [key]: true }),
        {}
      );
      setTouched(allTouched);

      if (!validateAll()) {
        return;
      }

      setIsSubmitting(true);
      try {
        await onSubmit(values);
      } finally {
        setIsSubmitting(false);
      }
    },
    [values, validateAll, onSubmit]
  );

  const setFieldValue = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  }, []);

  const setFieldError = useCallback((field: keyof T, error: string) => {
    setErrors((prev) => ({ ...prev, [field]: error }));
  }, []);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
    setTouched({});
    setIsSubmitting(false);
  }, [initialValues]);

  const isValid = Object.keys(errors).length === 0;

  return {
    values,
    errors,
    touched,
    isSubmitting,
    isValid,
    handleChange,
    handleBlur,
    handleSubmit,
    setFieldValue,
    setFieldError,
    reset,
  };
}

// Usage
function LoginForm() {
  const { values, errors, touched, isSubmitting, handleChange, handleBlur, handleSubmit } =
    useForm({
      initialValues: { email: '', password: '' },
      validate: {
        email: (value) => (!value.includes('@') ? 'Invalid email' : undefined),
        password: (value) => (value.length < 8 ? 'Min 8 characters' : undefined),
      },
      onSubmit: async (values) => {
        await login(values);
      },
    });

  return (
    <form onSubmit={handleSubmit}>
      <input
        name="email"
        value={values.email}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      {touched.email && errors.email && <span>{errors.email}</span>}

      <input
        name="password"
        type="password"
        value={values.password}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      {touched.password && errors.password && <span>{errors.password}</span>}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Loading...' : 'Login'}
      </button>
    </form>
  );
}
```

## Storage Hooks

### useLocalStorage

```typescript
// hooks/useLocalStorage.ts
import { useState, useEffect, useCallback } from 'react';

export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // Get initial value from localStorage or use provided initial value
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Update localStorage when value changes
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        const valueToStore = value instanceof Function ? value(storedValue) : value;
        setStoredValue(valueToStore);
        window.localStorage.setItem(key, JSON.stringify(valueToStore));

        // Dispatch event for other tabs/windows
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            newValue: JSON.stringify(valueToStore),
          })
        );
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, storedValue]
  );

  // Remove from localStorage
  const removeValue = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
      setStoredValue(initialValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, initialValue]);

  // Sync with other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        setStoredValue(JSON.parse(e.newValue));
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [key]);

  return [storedValue, setValue, removeValue];
}

// Usage
function Settings() {
  const [theme, setTheme] = useLocalStorage('theme', 'light');

  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value)}>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
```

### useSessionStorage

```typescript
// hooks/useSessionStorage.ts
// Same pattern as useLocalStorage but with sessionStorage
export function useSessionStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = (value: T | ((prev: T) => T)) => {
    const valueToStore = value instanceof Function ? value(storedValue) : value;
    setStoredValue(valueToStore);
    window.sessionStorage.setItem(key, JSON.stringify(valueToStore));
  };

  return [storedValue, setValue];
}
```

## Utility Hooks

### useDebounce

```typescript
// hooks/useDebounce.ts
import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Usage
function Search() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);

  const { data } = useFetch(
    debouncedQuery ? `/api/search?q=${debouncedQuery}` : null
  );

  return <input value={query} onChange={(e) => setQuery(e.target.value)} />;
}
```

### useDebouncedCallback

```typescript
// hooks/useDebouncedCallback.ts
import { useCallback, useRef, useEffect } from "react";

export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
): T {
  const timeoutRef = useRef<NodeJS.Timeout>();
  const callbackRef = useRef(callback);

  // Update callback ref on every render
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return useCallback(
    ((...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    }) as T,
    [delay],
  );
}
```

### useThrottle

```typescript
// hooks/useThrottle.ts
import { useState, useEffect, useRef } from "react";

export function useThrottle<T>(value: T, interval: number): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastExecuted = useRef<number>(Date.now());

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastExecuted.current;

    if (elapsed >= interval) {
      lastExecuted.current = now;
      setThrottledValue(value);
    } else {
      const timer = setTimeout(() => {
        lastExecuted.current = Date.now();
        setThrottledValue(value);
      }, interval - elapsed);

      return () => clearTimeout(timer);
    }
  }, [value, interval]);

  return throttledValue;
}
```

### useClickOutside

```typescript
// hooks/useClickOutside.ts
import { useEffect, useRef, RefObject } from 'react';

export function useClickOutside<T extends HTMLElement>(
  handler: () => void
): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const handleClick = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        handler();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [handler]);

  return ref;
}

// Usage
function Dropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setIsOpen(false));

  return (
    <div ref={ref}>
      <button onClick={() => setIsOpen(true)}>Open</button>
      {isOpen && <div>Dropdown content</div>}
    </div>
  );
}
```

### useMediaQuery

```typescript
// hooks/useMediaQuery.ts
import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);

    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    // Set initial value
    setMatches(mediaQuery.matches);

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

// Convenience hooks
export function useIsMobile() {
  return useMediaQuery("(max-width: 768px)");
}

export function usePrefersDarkMode() {
  return useMediaQuery("(prefers-color-scheme: dark)");
}

export function usePrefersReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
```

### usePrevious

```typescript
// hooks/usePrevious.ts
import { useRef, useEffect } from 'react';

export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>();

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref.current;
}

// Usage
function Counter() {
  const [count, setCount] = useState(0);
  const prevCount = usePrevious(count);

  return (
    <div>
      <p>Current: {count}, Previous: {prevCount}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}
```

### useToggle

```typescript
// hooks/useToggle.ts
import { useState, useCallback } from 'react';

export function useToggle(
  initialValue = false
): [boolean, () => void, (value: boolean) => void] {
  const [value, setValue] = useState(initialValue);

  const toggle = useCallback(() => setValue((v) => !v), []);
  const set = useCallback((v: boolean) => setValue(v), []);

  return [value, toggle, set];
}

// Usage
function Modal() {
  const [isOpen, toggle, setIsOpen] = useToggle();

  return (
    <>
      <button onClick={toggle}>Toggle Modal</button>
      {isOpen && <div>Modal Content</div>}
    </>
  );
}
```

### useCopyToClipboard

```typescript
// hooks/useCopyToClipboard.ts
import { useState, useCallback } from "react";

interface UseCopyToClipboardResult {
  copiedText: string | null;
  copy: (text: string) => Promise<boolean>;
}

export function useCopyToClipboard(): UseCopyToClipboardResult {
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const copy = useCallback(async (text: string) => {
    if (!navigator?.clipboard) {
      console.warn("Clipboard not supported");
      return false;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
      return true;
    } catch (error) {
      console.error("Failed to copy:", error);
      setCopiedText(null);
      return false;
    }
  }, []);

  return { copiedText, copy };
}
```

## Testing Custom Hooks

```typescript
// hooks/__tests__/useDebounce.test.ts
import { renderHook, act } from "@testing-library/react";
import { useDebounce } from "../useDebounce";

describe("useDebounce", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebounce("initial", 500));
    expect(result.current).toBe("initial");
  });

  it("debounces value changes", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: "initial" },
    });

    rerender({ value: "updated" });
    expect(result.current).toBe("initial");

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(result.current).toBe("updated");
  });

  it("cancels pending updates on rapid changes", () => {
    const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    act(() => jest.advanceTimersByTime(200));

    rerender({ value: "c" });
    act(() => jest.advanceTimersByTime(200));

    rerender({ value: "d" });
    act(() => jest.advanceTimersByTime(500));

    expect(result.current).toBe("d");
  });
});
```

## Best Practices

1. **Start with `use`**: All hooks must start with `use`
2. **Single responsibility**: Each hook does one thing well
3. **Return consistent types**: Always return same shape
4. **Handle cleanup**: Use `useEffect` cleanup for subscriptions
5. **Memoize callbacks**: Use `useCallback` for stable references
6. **Type everything**: Full TypeScript types with generics
7. **Document API**: JSDoc comments for parameters
8. **Test all states**: Loading, error, success, edge cases

## Output Checklist

Every custom hook should include:

- [ ] Hook name starts with `use`
- [ ] Full TypeScript types for inputs and outputs
- [ ] Proper cleanup in useEffect
- [ ] Stable callback references with useCallback
- [ ] Error handling for edge cases
- [ ] SSR safety (check for `window`)
- [ ] Unit tests covering all states
- [ ] JSDoc documentation
- [ ] Usage example in comments
