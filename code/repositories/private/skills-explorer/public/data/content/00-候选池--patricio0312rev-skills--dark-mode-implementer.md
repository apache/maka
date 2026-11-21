---
name: dark-mode-implementer
description: Implements complete dark/light mode theming systems using CSS variables, Tailwind dark mode, React context, and system preference detection. Use when users request "add dark mode", "theme toggle", "dark theme", "light mode switch", or "color scheme".
---

# Dark Mode Implementer

Build robust dark/light mode theming with system preference detection and persistent storage.

## Core Workflow

1. **Choose strategy**: CSS-only, Tailwind, or React context
2. **Define color tokens**: Create semantic color variables
3. **Implement toggle**: Add theme switch component
4. **Detect system preference**: Respect `prefers-color-scheme`
5. **Persist choice**: Store preference in localStorage
6. **Prevent flash**: Handle initial load correctly

## Strategy Comparison

| Strategy           | Best For              | Complexity |
| ------------------ | --------------------- | ---------- |
| Tailwind `class`   | React/Vue/Svelte apps | Low        |
| CSS `media`        | Simple static sites   | Very Low   |
| CSS Variables + JS | Framework-agnostic    | Medium     |
| React Context      | Complex React apps    | Medium     |

## Tailwind CSS Dark Mode

### Enable Class Strategy

```javascript
// tailwind.config.js
module.exports = {
  darkMode: "class", // or 'media' for system-only
  theme: {
    extend: {
      colors: {
        // Semantic color tokens
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: "hsl(var(--primary))",
        muted: "hsl(var(--muted))",
      },
    },
  },
};
```

### CSS Variables Setup

```css
/* globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222 47% 11%;
    --primary: 221 83% 53%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96%;
    --secondary-foreground: 222 47% 11%;
    --muted: 210 40% 96%;
    --muted-foreground: 215 16% 47%;
    --accent: 210 40% 96%;
    --accent-foreground: 222 47% 11%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 210 40% 98%;
    --border: 214 32% 91%;
    --input: 214 32% 91%;
    --ring: 221 83% 53%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222 47% 11%;
    --foreground: 210 40% 98%;
    --primary: 217 91% 60%;
    --primary-foreground: 222 47% 11%;
    --secondary: 217 33% 17%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217 33% 17%;
    --muted-foreground: 215 20% 65%;
    --accent: 217 33% 17%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62% 30%;
    --destructive-foreground: 210 40% 98%;
    --border: 217 33% 17%;
    --input: 217 33% 17%;
    --ring: 224 76% 48%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

### Using Dark Mode Classes

```html
<!-- Component with dark mode variants -->
<div class="bg-white dark:bg-gray-900">
  <h1 class="text-gray-900 dark:text-white">Title</h1>
  <p class="text-gray-600 dark:text-gray-300">Description</p>
  <button class="bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700">
    Action
  </button>
</div>
```

## React Theme Provider

### Complete Theme Context

```tsx
// lib/theme-context.tsx
"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  // Get system preference
  const getSystemTheme = (): "light" | "dark" => {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  // Apply theme to document
  const applyTheme = (theme: Theme) => {
    const root = document.documentElement;
    const resolved = theme === "system" ? getSystemTheme() : theme;

    root.classList.remove("light", "dark");
    root.classList.add(resolved);
    setResolvedTheme(resolved);
  };

  // Set theme and persist
  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(STORAGE_KEY, newTheme);
    applyTheme(newTheme);
  };

  // Initialize theme on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initialTheme = stored || "system";
    setThemeState(initialTheme);
    applyTheme(initialTheme);
    setMounted(true);
  }, []);

  // Listen for system preference changes
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      if (theme === "system") {
        applyTheme("system");
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  // Prevent hydration mismatch
  if (!mounted) {
    return <>{children}</>;
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
```

### Prevent Flash of Wrong Theme

```tsx
// app/layout.tsx
import { ThemeProvider } from "@/lib/theme-context";

// Inline script to prevent flash
const themeScript = `
  (function() {
    const stored = localStorage.getItem('theme');
    const theme = stored || 'system';
    const resolved = theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : theme;
    document.documentElement.classList.add(resolved);
  })();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

## Theme Toggle Components

### Simple Toggle Button

```tsx
// components/ThemeToggle.tsx
"use client";

import { useTheme } from "@/lib/theme-context";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800"
      aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
    >
      {resolvedTheme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
```

### Three-Way Toggle (Light/Dark/System)

```tsx
// components/ThemeSelector.tsx
"use client";

import { useTheme } from "@/lib/theme-context";
import { Monitor, Moon, Sun } from "lucide-react";

const themes = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
] as const;

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
      {themes.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={`
            flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium
            transition-colors
            ${
              theme === value
                ? "bg-white text-gray-900 shadow dark:bg-gray-700 dark:text-white"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
            }
          `}
          aria-label={`Switch to ${label} theme`}
        >
          <Icon className="h-4 w-4" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
```

### Animated Toggle Switch

```tsx
// components/ThemeSwitch.tsx
"use client";

import { useTheme } from "@/lib/theme-context";
import { motion } from "framer-motion";

export function ThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative h-8 w-14 rounded-full bg-gray-200 p-1 dark:bg-gray-700"
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      <motion.div
        className="flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-md"
        animate={{ x: isDark ? 24 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      >
        <motion.span
          initial={false}
          animate={{ rotate: isDark ? 360 : 0 }}
          transition={{ duration: 0.5 }}
        >
          {isDark ? "🌙" : "☀️"}
        </motion.span>
      </motion.div>
    </button>
  );
}
```

## CSS-Only Dark Mode

### Using prefers-color-scheme

```css
/* For simple sites without JavaScript */
:root {
  --bg: #ffffff;
  --text: #1a1a1a;
  --primary: #3b82f6;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a;
    --text: #fafafa;
    --primary: #60a5fa;
  }
}

body {
  background-color: var(--bg);
  color: var(--text);
}
```

## Color Token System

### Semantic Color Naming

```css
:root {
  /* Background colors */
  --color-bg-primary: #ffffff;
  --color-bg-secondary: #f9fafb;
  --color-bg-tertiary: #f3f4f6;
  --color-bg-inverse: #111827;

  /* Text colors */
  --color-text-primary: #111827;
  --color-text-secondary: #4b5563;
  --color-text-tertiary: #9ca3af;
  --color-text-inverse: #ffffff;

  /* Border colors */
  --color-border-primary: #e5e7eb;
  --color-border-secondary: #d1d5db;

  /* Interactive colors */
  --color-interactive-primary: #3b82f6;
  --color-interactive-hover: #2563eb;
  --color-interactive-active: #1d4ed8;

  /* Status colors */
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;
  --color-info: #3b82f6;
}

.dark {
  --color-bg-primary: #0f172a;
  --color-bg-secondary: #1e293b;
  --color-bg-tertiary: #334155;
  --color-bg-inverse: #f8fafc;

  --color-text-primary: #f8fafc;
  --color-text-secondary: #cbd5e1;
  --color-text-tertiary: #64748b;
  --color-text-inverse: #0f172a;

  --color-border-primary: #334155;
  --color-border-secondary: #475569;

  --color-interactive-primary: #60a5fa;
  --color-interactive-hover: #3b82f6;
  --color-interactive-active: #2563eb;

  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-error: #f87171;
  --color-info: #60a5fa;
}
```

## Next.js with next-themes

### Installation and Setup

```bash
npm install next-themes
```

```tsx
// app/providers.tsx
"use client";

import { ThemeProvider } from "next-themes";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </ThemeProvider>
  );
}
```

```tsx
// app/layout.tsx
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

```tsx
// components/ThemeToggle.tsx
"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) return null;

  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
```

## Images and Media

### Theme-Aware Images

```tsx
// Swap images based on theme
<picture>
  <source srcSet="/dark-logo.svg" media="(prefers-color-scheme: dark)" />
  <img src="/light-logo.svg" alt="Logo" />
</picture>

// With Tailwind
<img src="/light-logo.svg" alt="Logo" class="dark:hidden" />
<img src="/dark-logo.svg" alt="Logo" class="hidden dark:block" />
```

### SVG Color Adaptation

```tsx
// SVG that adapts to theme
<svg className="text-gray-900 dark:text-white" fill="currentColor">
  {/* ... */}
</svg>
```

## Testing Dark Mode

### Playwright Test

```typescript
// tests/dark-mode.spec.ts
import { test, expect } from "@playwright/test";

test.describe("Dark Mode", () => {
  test("respects system preference", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
  });

  test("toggles theme correctly", async ({ page }) => {
    await page.goto("/");

    await page.click('[aria-label*="dark"]');
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.click('[aria-label*="light"]');
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("persists theme preference", async ({ page }) => {
    await page.goto("/");
    await page.click('[aria-label*="dark"]');

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});
```

## Best Practices

1. **Prevent flash**: Use inline script before React hydration
2. **Respect system preference**: Default to 'system' theme
3. **Persist choice**: Store in localStorage
4. **Use semantic tokens**: Don't hardcode colors
5. **Test both themes**: Ensure contrast and readability
6. **Handle images**: Provide dark-mode variants
7. **Consider transitions**: Add smooth color transitions
8. **Accessibility**: Maintain WCAG contrast ratios

## Output Checklist

Every dark mode implementation should include:

- [ ] Tailwind configured with `darkMode: 'class'`
- [ ] CSS variables for light and dark themes
- [ ] Theme provider with context
- [ ] System preference detection
- [ ] localStorage persistence
- [ ] Flash prevention script
- [ ] Theme toggle component
- [ ] Accessible labels on toggle
- [ ] Color tokens for all UI elements
- [ ] Dark variants for images/SVGs
- [ ] Smooth transition animations
- [ ] Playwright/Jest tests
