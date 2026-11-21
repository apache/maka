---
name: accessibility-auditor
description: Audits and implements web accessibility (a11y) following WCAG 2.1 guidelines with ARIA patterns, keyboard navigation, screen reader support, and contrast checking. Use when users request "accessibility audit", "a11y review", "WCAG compliance", "screen reader support", or "keyboard navigation".
---

# Accessibility Auditor

Build inclusive web experiences with WCAG 2.1 compliance and comprehensive a11y patterns.

## Core Workflow

1. **Audit existing code**: Identify accessibility issues
2. **Check WCAG compliance**: Verify against success criteria
3. **Fix semantic HTML**: Use proper elements and landmarks
4. **Add ARIA attributes**: Enhance assistive technology support
5. **Implement keyboard nav**: Ensure full keyboard accessibility
6. **Test with tools**: Automated and manual testing
7. **Verify with screen readers**: Real-world testing

## WCAG 2.1 Quick Reference

### Compliance Levels

| Level | Description            | Requirement       |
| ----- | ---------------------- | ----------------- |
| A     | Minimum accessibility  | Must have         |
| AA    | Standard compliance    | Industry standard |
| AAA   | Enhanced accessibility | Nice to have      |

### Four Principles (POUR)

1. **Perceivable**: Content must be presentable to all senses
2. **Operable**: Interface must be navigable by all users
3. **Understandable**: Content must be clear and predictable
4. **Robust**: Content must work with assistive technologies

## Semantic HTML

### Use Proper Elements

```html
<!-- Bad: Divs for everything -->
<div class="header">
  <div class="nav">
    <div onclick="navigate()">Home</div>
  </div>
</div>

<!-- Good: Semantic elements -->
<header>
  <nav aria-label="Main navigation">
    <a href="/">Home</a>
  </nav>
</header>
```

### Document Landmarks

```html
<body>
  <header>
    <nav aria-label="Main">...</nav>
  </header>

  <main id="main-content">
    <article>
      <h1>Page Title</h1>
      <section aria-labelledby="section-heading">
        <h2 id="section-heading">Section</h2>
      </section>
    </article>
    <aside aria-label="Related content">...</aside>
  </main>

  <footer>...</footer>
</body>
```

### Heading Hierarchy

```html
<!-- Correct heading order -->
<h1>Page Title</h1>
<h2>Section</h2>
<h3>Subsection</h3>
<h3>Subsection</h3>
<h2>Section</h2>
<h3>Subsection</h3>

<!-- Never skip levels -->
<!-- Bad: h1 → h3 (skipped h2) -->
```

## ARIA Patterns

### Buttons

```tsx
// Interactive element that looks like a button
<button type="button" onClick={handleClick}>
  Click me
</button>

// If you must use a div (avoid if possible)
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }}
>
  Click me
</div>
```

### Modals / Dialogs

```tsx
// components/Modal.tsx
import { useEffect, useRef } from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Store current focus
      previousActiveElement.current = document.activeElement;
      // Focus modal
      modalRef.current?.focus();
      // Prevent body scroll
      document.body.style.overflow = "hidden";
    } else {
      // Restore focus
      (previousActiveElement.current as HTMLElement)?.focus();
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="presentation">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="relative z-10 bg-white rounded-lg p-6 max-w-md w-full"
      >
        <h2 id="modal-title" className="text-xl font-bold">
          {title}
        </h2>

        <div className="mt-4">{children}</div>

        <button onClick={onClose} className="absolute top-4 right-4" aria-label="Close modal">
          ×
        </button>
      </div>
    </div>
  );
}
```

### Tabs

```tsx
// components/Tabs.tsx
import { useState, useRef, KeyboardEvent } from "react";

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({ tabs }: { tabs: Tab[] }) {
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (e: KeyboardEvent, index: number) => {
    let newIndex = index;

    switch (e.key) {
      case "ArrowLeft":
        newIndex = index === 0 ? tabs.length - 1 : index - 1;
        break;
      case "ArrowRight":
        newIndex = index === tabs.length - 1 ? 0 : index + 1;
        break;
      case "Home":
        newIndex = 0;
        break;
      case "End":
        newIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    setActiveTab(tabs[newIndex].id);
    tabRefs.current[newIndex]?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label="Content tabs" className="flex border-b">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => (tabRefs.current[index] = el)}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`px-4 py-2 ${
              activeTab === tab.id ? "border-b-2 border-blue-500" : "text-gray-500"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          hidden={activeTab !== tab.id}
          tabIndex={0}
          className="p-4"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
```

### Dropdown Menu

```tsx
// components/Dropdown.tsx
import { useState, useRef, useEffect, KeyboardEvent } from "react";

interface MenuItem {
  id: string;
  label: string;
  onClick: () => void;
}

export function Dropdown({ label, items }: { label: string; items: MenuItem[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setActiveIndex(0);
        } else {
          setActiveIndex((prev) => (prev + 1) % items.length);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (isOpen && activeIndex >= 0) {
          items[activeIndex].onClick();
          setIsOpen(false);
          buttonRef.current?.focus();
        } else {
          setIsOpen(true);
        }
        break;
      case "Escape":
        setIsOpen(false);
        buttonRef.current?.focus();
        break;
    }
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls="dropdown-menu"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className="px-4 py-2 bg-gray-100 rounded"
      >
        {label}
      </button>

      {isOpen && (
        <ul
          ref={menuRef}
          id="dropdown-menu"
          role="menu"
          aria-labelledby="dropdown-button"
          onKeyDown={handleKeyDown}
          className="absolute mt-1 bg-white border rounded shadow-lg"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                item.onClick();
                setIsOpen(false);
              }}
              className={`px-4 py-2 cursor-pointer ${index === activeIndex ? "bg-blue-100" : ""}`}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

## Focus Management

### Skip Links

```html
<!-- First element in body -->
<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:absolute focus:p-4 focus:bg-white focus:z-50"
>
  Skip to main content
</a>

<!-- Main content target -->
<main id="main-content" tabindex="-1">...</main>
```

### Focus Trap for Modals

```tsx
// hooks/useFocusTrap.ts
import { useEffect, useRef } from "react";

export function useFocusTrap<T extends HTMLElement>(isActive: boolean) {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    container.addEventListener("keydown", handleTab);
    firstElement?.focus();

    return () => container.removeEventListener("keydown", handleTab);
  }, [isActive]);

  return containerRef;
}
```

### Focus Visible Styles

```css
/* Only show focus ring for keyboard users */
:focus {
  outline: none;
}

:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}

/* Tailwind equivalent */
.focus-visible:focus-visible {
  @apply outline-none ring-2 ring-blue-500 ring-offset-2;
}
```

## Color Contrast

### WCAG Contrast Requirements

| Level | Normal Text | Large Text |
| ----- | ----------- | ---------- |
| AA    | 4.5:1       | 3:1        |
| AAA   | 7:1         | 4.5:1      |

Large text = 18pt+ (24px) or 14pt+ bold (18.5px)

### Accessible Color Pairs

```css
/* High contrast pairs */
:root {
  /* Text on white background */
  --text-primary: #1f2937; /* gray-800, 12.6:1 contrast */
  --text-secondary: #4b5563; /* gray-600, 7.0:1 contrast */
  --text-tertiary: #6b7280; /* gray-500, 4.6:1 contrast (AA only) */

  /* Links */
  --link-color: #1d4ed8; /* blue-700, 7.3:1 contrast */

  /* Errors */
  --error-text: #dc2626; /* red-600, 4.5:1 contrast */
}
```

### Testing Contrast

```tsx
// Utility to check contrast ratio
function getContrastRatio(color1: string, color2: string): number {
  const getLuminance = (hex: string): number => {
    const rgb = parseInt(hex.slice(1), 16);
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = (rgb >> 0) & 0xff;

    const [rs, gs, bs] = [r, g, b].map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  };

  const l1 = getLuminance(color1);
  const l2 = getLuminance(color2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

// Usage
const ratio = getContrastRatio("#1f2937", "#ffffff"); // 12.6
const passesAA = ratio >= 4.5;
const passesAAA = ratio >= 7;
```

## Forms

### Accessible Form Fields

```tsx
// components/FormField.tsx
interface FormFieldProps {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  description?: string;
  children: React.ReactNode;
}

export function FormField({ id, label, error, required, description, children }: FormFieldProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-medium">
        {label}
        {required && (
          <span className="text-red-500 ml-1" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only">(required)</span>}
      </label>

      {description && (
        <p id={descriptionId} className="text-sm text-gray-500">
          {description}
        </p>
      )}

      {/* Clone child and add aria attributes */}
      {React.cloneElement(children as React.ReactElement, {
        id,
        "aria-required": required,
        "aria-invalid": !!error,
        "aria-describedby": [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
      })}

      {error && (
        <p id={errorId} className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
```

### Error Announcements

```tsx
// components/LiveRegion.tsx
export function LiveRegion({ message }: { message: string }) {
  return (
    <div role="alert" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

// Usage: Announce form submission result
const [announcement, setAnnouncement] = useState("");

const handleSubmit = async () => {
  try {
    await submitForm();
    setAnnouncement("Form submitted successfully");
  } catch {
    setAnnouncement("Error submitting form. Please try again.");
  }
};
```

## Images and Media

### Image Alt Text

```html
<!-- Informative image -->
<img src="chart.png" alt="Sales increased 25% from Q1 to Q2 2024" />

<!-- Decorative image -->
<img src="decoration.svg" alt="" role="presentation" />

<!-- Complex image with long description -->
<figure>
  <img src="infographic.png" alt="Company growth infographic" aria-describedby="infographic-desc" />
  <figcaption id="infographic-desc">Detailed description of the infographic...</figcaption>
</figure>
```

### Video Accessibility

```html
<video controls>
  <source src="video.mp4" type="video/mp4" />
  <track kind="captions" src="captions-en.vtt" srclang="en" label="English" default />
  <track kind="descriptions" src="descriptions.vtt" srclang="en" label="Audio descriptions" />
</video>
```

## Screen Reader Utilities

### Tailwind SR-Only Classes

```css
/* Already in Tailwind */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

.not-sr-only {
  position: static;
  width: auto;
  height: auto;
  padding: 0;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
}
```

### Screen Reader Only Text

```tsx
// components/VisuallyHidden.tsx
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

// Usage
<button>
  <TrashIcon aria-hidden="true" />
  <VisuallyHidden>Delete item</VisuallyHidden>
</button>;
```

## Testing Tools

### Automated Testing

```typescript
// jest-axe for unit tests
import { axe, toHaveNoViolations } from 'jest-axe';
import { render } from '@testing-library/react';

expect.extend(toHaveNoViolations);

test('component has no accessibility violations', async () => {
  const { container } = render(<MyComponent />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### Playwright a11y Testing

```typescript
// tests/a11y.spec.ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("homepage has no accessibility violations", async ({ page }) => {
  await page.goto("/");

  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});

test("keyboard navigation works", async ({ page }) => {
  await page.goto("/");

  // Tab through interactive elements
  await page.keyboard.press("Tab");
  const firstFocused = await page.evaluate(() => document.activeElement?.tagName);
  expect(["A", "BUTTON", "INPUT"]).toContain(firstFocused);

  // Test skip link
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});
```

### Manual Testing Checklist

- [ ] Navigate entire page with keyboard only
- [ ] Test with screen reader (VoiceOver, NVDA)
- [ ] Zoom to 200% - layout still usable
- [ ] Check color contrast with browser tools
- [ ] Verify focus indicators are visible
- [ ] Test with reduced motion preference
- [ ] Verify form error announcements

## Best Practices

1. **Semantic HTML first**: Use native elements before ARIA
2. **Focus management**: Never remove focus outlines without replacement
3. **Announce changes**: Use live regions for dynamic content
4. **Test with users**: Include disabled users in testing
5. **Progressive enhancement**: Core functionality without JavaScript
6. **Color independence**: Don't rely on color alone for meaning
7. **Touch targets**: Minimum 44x44px for mobile
8. **Animation**: Respect `prefers-reduced-motion`

## Output Checklist

Every accessibility audit should verify:

- [ ] Semantic HTML used throughout
- [ ] Proper heading hierarchy (h1 → h2 → h3)
- [ ] All interactive elements keyboard accessible
- [ ] Focus visible on all focusable elements
- [ ] Images have appropriate alt text
- [ ] Form fields have associated labels
- [ ] Error messages linked with aria-describedby
- [ ] Color contrast meets WCAG AA (4.5:1)
- [ ] Skip link to main content
- [ ] ARIA attributes used correctly
- [ ] Modal focus trap implemented
- [ ] Dynamic content announced to screen readers
- [ ] Tested with axe-core or similar
- [ ] Manual screen reader testing completed
