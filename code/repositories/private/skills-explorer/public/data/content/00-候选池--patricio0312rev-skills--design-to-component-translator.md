---
name: design-to-component-translator
description: Converts Figma/design specifications into production-ready UI components with accurate spacing, typography, color tokens, responsive rules, and interaction states (hover, focus, disabled, active). Generates Tailwind/shadcn code with design system tokens mapping. Use when translating "Figma to code", "design specs to components", or "implement design system".
---

# Design-to-Component Translator

Convert design specifications into pixel-perfect, production-ready React components.

## Core Workflow

1. **Analyze design specs**: Extract spacing, colors, typography, dimensions
2. **Map to tokens**: Convert design values to design system tokens
3. **Generate structure**: Create semantic HTML structure
4. **Apply styles**: Implement Tailwind/CSS with exact measurements
5. **Add states**: Include hover, focus, active, disabled states
6. **Handle responsive**: Implement breakpoint-specific rules
7. **Ensure accessibility**: Add ARIA labels, keyboard navigation
8. **Document variants**: List all visual states and props

## Design Spec Analysis

### Extract from Figma/Design

**Spacing & Layout:**

- Padding: `p-4` (16px), `px-6` (24px horizontal)
- Margin: `m-2` (8px), `mt-4` (16px top)
- Gap: `gap-3` (12px between flex items)
- Width/Height: `w-64` (256px), `h-10` (40px)

**Typography:**

- Font family: `font-sans`, `font-mono`
- Font size: `text-sm` (14px), `text-base` (16px), `text-lg` (18px)
- Font weight: `font-normal` (400), `font-medium` (500), `font-semibold` (600)
- Line height: `leading-tight`, `leading-normal`, `leading-relaxed`
- Letter spacing: `tracking-tight`, `tracking-normal`, `tracking-wide`

**Colors:**

- Background: `bg-blue-500`, `bg-gray-100`
- Text: `text-gray-900`, `text-white`
- Border: `border-gray-300`, `border-blue-600`
- Opacity: `bg-opacity-50`, `text-opacity-75`

**Borders & Radius:**

- Border width: `border`, `border-2`, `border-t-4`
- Border radius: `rounded` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-full`

**Shadows:**

- `shadow-sm`, `shadow`, `shadow-md`, `shadow-lg`, `shadow-xl`

## Design Token Mapping

### Create Token System

```typescript
// tokens.ts
export const tokens = {
  colors: {
    primary: {
      50: "#eff6ff",
      100: "#dbeafe",
      500: "#3b82f6",
      600: "#2563eb",
      700: "#1d4ed8",
    },
    gray: {
      100: "#f3f4f6",
      300: "#d1d5db",
      500: "#6b7280",
      700: "#374151",
      900: "#111827",
    },
  },
  spacing: {
    xs: "0.25rem", // 4px
    sm: "0.5rem", // 8px
    md: "1rem", // 16px
    lg: "1.5rem", // 24px
    xl: "2rem", // 32px
  },
  fontSize: {
    xs: ["0.75rem", { lineHeight: "1rem" }],
    sm: ["0.875rem", { lineHeight: "1.25rem" }],
    base: ["1rem", { lineHeight: "1.5rem" }],
    lg: ["1.125rem", { lineHeight: "1.75rem" }],
    xl: ["1.25rem", { lineHeight: "1.75rem" }],
  },
  borderRadius: {
    sm: "0.25rem", // 4px
    md: "0.375rem", // 6px
    lg: "0.5rem", // 8px
    full: "9999px",
  },
  shadows: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
  },
};
```

### Tailwind Config

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
      spacing: {
        18: "4.5rem",
        88: "22rem",
      },
      fontSize: {
        "2xs": "0.625rem",
      },
    },
  },
};
```

## Component Translation Examples

### Button from Figma Spec

**Figma Specs:**

- Height: 40px
- Padding: 12px 24px
- Border radius: 6px
- Font: Inter Medium 14px
- Background: #3B82F6
- Text: #FFFFFF
- Hover: #2563EB
- Shadow: 0 1px 3px rgba(0,0,0,0.1)

**Translated Component:**

```typescript
import { cn } from "@/lib/utils";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
  size?: "sm" | "md" | "lg";
}

export const Button = ({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) => {
  return (
    <button
      className={cn(
        // Base styles
        "inline-flex items-center justify-center rounded-md font-medium",
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        // Variant: Primary (matches Figma)
        variant === "primary" && [
          "bg-primary-500 text-white shadow-sm",
          "hover:bg-primary-600",
          "active:bg-primary-700",
        ],
        // Size: Medium (40px height, 12px 24px padding)
        size === "md" && "h-10 px-6 text-sm",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};
```

### Card from Design Spec

**Figma Specs:**

- Padding: 24px
- Border radius: 12px
- Background: #FFFFFF
- Border: 1px solid #E5E7EB
- Shadow: 0 1px 3px rgba(0,0,0,0.1)
- Max width: 400px

**Translated Component:**

```typescript
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
}

export const Card = ({
  elevated = false,
  className,
  children,
  ...props
}: CardProps) => {
  return (
    <div
      className={cn(
        // Base from Figma
        "max-w-sm rounded-xl bg-white p-6",
        "border border-gray-200",
        // Conditional shadow
        elevated ? "shadow-lg" : "shadow-sm",
        // Hover state (not in Figma, but good UX)
        "transition-shadow duration-200 hover:shadow-md",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};
```

## Interaction States

### Hover States

```typescript
// Figma: Background changes from #3B82F6 to #2563EB on hover
className={cn(
  'bg-primary-500',
  'hover:bg-primary-600',
  'transition-colors duration-200'
)}
```

### Focus States

```typescript
// Accessible focus ring
className={cn(
  'focus:outline-none',
  'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2'
)}
```

### Active/Pressed States

```typescript
// Figma: Slightly darker on click
className={cn(
  'active:bg-primary-700',
  'active:scale-[0.98]', // Slight scale down
  'transition-all duration-100'
)}
```

### Disabled States

```typescript
// Figma: 50% opacity, no interactions
className={cn(
  'disabled:opacity-50',
  'disabled:cursor-not-allowed',
  'disabled:pointer-events-none'
)}
```

## Responsive Design Translation

### Breakpoint Mapping

```typescript
// Figma artboards → Tailwind breakpoints
// Mobile (375px): default (no prefix)
// Tablet (768px): md:
// Desktop (1024px): lg:
// Wide (1280px): xl:

<div
  className={cn(
    // Mobile: Stack vertically, full width
    "flex flex-col gap-4 w-full",
    // Tablet: Side by side, 50% each
    "md:flex-row md:gap-6",
    // Desktop: Max width container
    "lg:max-w-6xl lg:mx-auto"
  )}
/>
```

### Responsive Typography

```typescript
// Figma mobile: 14px, desktop: 16px
<h1 className="text-sm md:text-base lg:text-lg font-semibold">
  Responsive Heading
</h1>
```

### Responsive Spacing

```typescript
// Figma mobile: 16px padding, desktop: 24px
<div className="p-4 md:p-6 lg:p-8">Content</div>
```

## Design System Integration

### Using shadcn/ui Patterns

```typescript
// Leveraging shadcn's composable approach
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "underline-offset-4 hover:underline text-primary",
      },
      size: {
        default: "h-10 py-2 px-4",
        sm: "h-9 px-3 rounded-md",
        lg: "h-11 px-8 rounded-md",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
```

## Color System Translation

### From Figma to CSS Variables

```css
/* Figma colors → CSS variables */
:root {
  /* Primary from Figma #3B82F6 */
  --primary: 221 83% 60%;
  --primary-foreground: 0 0% 100%;

  /* Secondary from Figma #6B7280 */
  --secondary: 220 9% 46%;
  --secondary-foreground: 0 0% 100%;

  /* Backgrounds */
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;

  /* Borders */
  --border: 220 13% 91%;
  --input: 220 13% 91%;
  --ring: 221 83% 60%;

  /* Radius from Figma */
  --radius: 0.5rem;
}
```

### Using in Components

```typescript
<div className="bg-background text-foreground border-border">
  <button className="bg-primary text-primary-foreground">Button</button>
</div>
```

## Animation & Transitions

### Micro-interactions from Figma

```typescript
// Figma: Button scales slightly on hover
<button className={cn(
  'transition-all duration-200',
  'hover:scale-105',
  'active:scale-95'
)}>
  Hover me
</button>

// Figma: Card lifts on hover
<div className={cn(
  'transition-all duration-300',
  'hover:-translate-y-1 hover:shadow-lg'
)}>
  Card content
</div>

// Figma: Fade in on mount
<div className="animate-in fade-in duration-500">
  Fading content
</div>
```

## Measurement Conversion

### Figma Pixels → Tailwind Classes

| Figma | Tailwind | Value    |
| ----- | -------- | -------- |
| 2px   | 0.5      | 0.125rem |
| 4px   | 1        | 0.25rem  |
| 8px   | 2        | 0.5rem   |
| 12px  | 3        | 0.75rem  |
| 16px  | 4        | 1rem     |
| 20px  | 5        | 1.25rem  |
| 24px  | 6        | 1.5rem   |
| 32px  | 8        | 2rem     |
| 40px  | 10       | 2.5rem   |
| 48px  | 12       | 3rem     |

### Custom Values

```typescript
// Figma: 18px (not in default Tailwind)
<div className="w-[18px] h-[18px]">{/* or add to config */}</div>
```

## Accessibility Mapping

### From Visual Design to A11y

```typescript
// Figma shows disabled state
<button
  disabled={isDisabled}
  aria-disabled={isDisabled}
  className={cn(
    isDisabled && 'opacity-50 cursor-not-allowed'
  )}
>
  Submit
</button>

// Figma shows error state
<input
  aria-invalid={hasError}
  aria-describedby={hasError ? 'error-message' : undefined}
  className={cn(
    hasError && 'border-red-500 focus:ring-red-500'
  )}
/>
```

## Common Patterns

### Form Input Translation

**Figma Specs:**

- Height: 44px
- Padding: 12px 16px
- Border: 1px #D1D5DB
- Border radius: 8px
- Focus border: 2px #3B82F6

```typescript
<input
  className={cn(
    "h-11 w-full rounded-lg border border-gray-300 px-4",
    "text-base text-gray-900 placeholder:text-gray-500",
    "focus:border-primary-500 focus:ring-2 focus:ring-primary-500 focus:ring-offset-0",
    "disabled:cursor-not-allowed disabled:opacity-50"
  )}
/>
```

### Icon Button Translation

**Figma Specs:**

- Size: 40x40px
- Icon: 20x20px centered
- Border radius: 8px
- Background hover: #F3F4F6

```typescript
<button
  className={cn(
    "flex h-10 w-10 items-center justify-center rounded-lg",
    "text-gray-700 transition-colors",
    "hover:bg-gray-100",
    "focus-visible:ring-2 focus-visible:ring-primary-500"
  )}
>
  <Icon className="h-5 w-5" />
</button>
```

## Best Practices

1. **Measure twice**: Verify all measurements match Figma exactly
2. **Use design tokens**: Map to tokens, not hardcoded values
3. **All states**: Include hover, focus, active, disabled, error
4. **Responsive**: Implement all breakpoints from design
5. **Accessibility**: Add ARIA where Figma shows states
6. **Animations**: Match transition timings to design
7. **Dark mode**: If designs exist, implement with class variants
8. **Component variants**: Create reusable variant props
9. **Documentation**: Note any deviations from design
10. **Review**: Get designer approval on implementation

## Output Checklist

Every design-to-component translation should include:

- [ ] Exact spacing matching Figma measurements
- [ ] Typography scales and weights
- [ ] All color values from design system
- [ ] Border radius and shadows
- [ ] Hover state styling
- [ ] Focus state styling (accessible)
- [ ] Active/pressed state styling
- [ ] Disabled state styling
- [ ] Responsive breakpoint rules
- [ ] Design token mapping documented
- [ ] Accessibility attributes
- [ ] Component variants for states
