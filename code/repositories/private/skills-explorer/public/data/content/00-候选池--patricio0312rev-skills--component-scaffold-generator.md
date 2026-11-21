---
name: component-scaffold-generator
description: Generates clean React/Vue component skeletons with TypeScript types, prop variants, styling hooks, test files, Storybook stories, and usage documentation. Use when users request "create a component", "scaffold component", "new React component", or "generate component boilerplate".
---

# Component Scaffold Generator

Generate production-ready component skeletons with types, variants, tests, and documentation.

## Core Workflow

1. **Gather requirements**: Component name, framework (React/Vue), props needed
2. **Choose pattern**: Determine if functional, compound, or polymorphic component
3. **Generate component**: Create main component file with TypeScript types
4. **Add variants**: Include common variants (size, color, state)
5. **Setup styling**: Add styling approach (Tailwind, CSS Modules, styled-components)
6. **Create tests**: Generate test file with basic coverage
7. **Add story**: Create Storybook story with examples
8. **Document usage**: Include JSDoc and usage examples

## Component Patterns

### Basic Functional Component (React)

````typescript
// Button.tsx
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

/**
 * Button component with multiple variants and sizes
 *
 * @example
 * ```tsx
 * <Button variant="primary" size="md">
 *   Click me
 * </Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      isLoading = false,
      leftIcon,
      rightIcon,
      className,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-50",
          {
            // Variants
            "bg-blue-600 text-white hover:bg-blue-700": variant === "primary",
            "bg-gray-200 text-gray-900 hover:bg-gray-300":
              variant === "secondary",
            "hover:bg-gray-100": variant === "ghost",
            "bg-red-600 text-white hover:bg-red-700": variant === "destructive",
            // Sizes
            "h-8 px-3 text-sm": size === "sm",
            "h-10 px-4 text-base": size === "md",
            "h-12 px-6 text-lg": size === "lg",
          },
          className
        )}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading && (
          <svg
            className="mr-2 h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {leftIcon && <span className="mr-2">{leftIcon}</span>}
        {children}
        {rightIcon && <span className="ml-2">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = "Button";
````

### Compound Component Pattern

```typescript
// Card.tsx
import { createContext, useContext } from "react";

interface CardContextValue {
  variant: "default" | "outlined" | "elevated";
}

const CardContext = createContext<CardContextValue | undefined>(undefined);

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "outlined" | "elevated";
}

export const Card = ({
  variant = "default",
  className,
  children,
  ...props
}: CardProps) => {
  return (
    <CardContext.Provider value={{ variant }}>
      <div className={cn("rounded-lg", className)} {...props}>
        {children}
      </div>
    </CardContext.Provider>
  );
};

export const CardHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-6", className)} {...props} />
);

export const CardTitle = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-2xl font-semibold", className)} {...props} />
);

export const CardContent = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("p-6 pt-0", className)} {...props} />
);

export const CardFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center p-6 pt-0", className)} {...props} />
);
```

## Test File Template

```typescript
// Button.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children correctly", () => {
    render(<Button>Click me</Button>);
    expect(
      screen.getByRole("button", { name: /click me/i })
    ).toBeInTheDocument();
  });

  it("applies variant classes correctly", () => {
    const { rerender } = render(<Button variant="primary">Test</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-blue-600");

    rerender(<Button variant="secondary">Test</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-gray-200");
  });

  it("handles click events", () => {
    const handleClick = jest.fn();
    render(<Button onClick={handleClick}>Click</Button>);

    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("shows loading state", () => {
    render(<Button isLoading>Loading</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toContainHTML("svg");
  });

  it("renders with icons", () => {
    render(
      <Button leftIcon={<span data-testid="left">←</span>}>With Icon</Button>
    );
    expect(screen.getByTestId("left")).toBeInTheDocument();
  });

  it("forwards ref correctly", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Test</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
```

## Storybook Story Template

```typescript
// Button.stories.tsx
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary", "ghost", "destructive"],
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg"],
    },
    isLoading: {
      control: "boolean",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: {
    variant: "primary",
    children: "Button",
  },
};

export const Secondary: Story = {
  args: {
    variant: "secondary",
    children: "Button",
  },
};

export const WithIcons: Story = {
  args: {
    children: "With Icons",
    leftIcon: "←",
    rightIcon: "→",
  },
};

export const Loading: Story = {
  args: {
    children: "Loading",
    isLoading: true,
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex gap-4 items-center">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className="flex gap-4">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
    </div>
  ),
};
```

## Vue Component Pattern

```vue
<!-- Button.vue -->
<script setup lang="ts">
import { computed } from "vue";

interface Props {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: "primary",
  size: "md",
  isLoading: false,
  disabled: false,
});

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const buttonClasses = computed(() => {
  return [
    "inline-flex items-center justify-center rounded-md font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    // Variants
    {
      "bg-blue-600 text-white hover:bg-blue-700": props.variant === "primary",
      "bg-gray-200 text-gray-900 hover:bg-gray-300": props.variant === "secondary",
      "hover:bg-gray-100": props.variant === "ghost",
      "bg-red-600 text-white hover:bg-red-700": props.variant === "destructive",
    },
    // Sizes
    {
      "h-8 px-3 text-sm": props.size === "sm",
      "h-10 px-4 text-base": props.size === "md",
      "h-12 px-6 text-lg": props.size === "lg",
    },
  ];
});

const handleClick = (event: MouseEvent) => {
  if (!props.disabled && !props.isLoading) {
    emit("click", event);
  }
};
</script>

<template>
  <button :class="buttonClasses" :disabled="disabled || isLoading" @click="handleClick">
    <svg
      v-if="isLoading"
      class="mr-2 h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
    <slot />
  </button>
</template>
```

## Index File (Barrel Export)

```typescript
// index.ts
export { Button } from "./Button";
export type { ButtonProps } from "./Button";
```

## Usage Documentation Template

````markdown
# Button Component

A flexible button component with multiple variants, sizes, and states.

## Installation

```bash
npm install @/components/ui/button
```
````

## Usage

```tsx
import { Button } from "@/components/ui/button";

function App() {
  return (
    <Button variant="primary" size="md" onClick={() => console.log("Clicked!")}>
      Click me
    </Button>
  );
}
```

## Props

| Prop      | Type                                                 | Default   | Description           |
| --------- | ---------------------------------------------------- | --------- | --------------------- |
| variant   | 'primary' \| 'secondary' \| 'ghost' \| 'destructive' | 'primary' | Visual style variant  |
| size      | 'sm' \| 'md' \| 'lg'                                 | 'md'      | Button size           |
| isLoading | boolean                                              | false     | Shows loading spinner |
| leftIcon  | ReactNode                                            | -         | Icon before text      |
| rightIcon | ReactNode                                            | -         | Icon after text       |
| disabled  | boolean                                              | false     | Disables the button   |

## Examples

### With Icons

```tsx
<Button leftIcon={<ChevronLeft />}>Back</Button>
```

### Loading State

```tsx
<Button isLoading>Saving...</Button>
```

### Destructive Action

```tsx
<Button variant="destructive" onClick={handleDelete}>
  Delete Account
</Button>
```

## Accessibility

- Keyboard navigable
- ARIA attributes included
- Focus visible styling
- Disabled state properly handled

```

## Component Structure Template

```

ComponentName/
├── ComponentName.tsx # Main component
├── ComponentName.test.tsx # Tests
├── ComponentName.stories.tsx # Storybook
├── types.ts # TypeScript types (if complex)
├── styles.module.css # CSS Modules (if used)
└── index.ts # Barrel export

```

## Common Component Types

### UI Primitives
- Button, Input, Select, Checkbox, Radio
- Typography (Text, Heading, Label)
- Icons, Avatar, Badge

### Layout Components
- Container, Stack, Grid, Flex
- Card, Panel, Section
- Divider, Spacer

### Data Display
- Table, List, DataGrid
- Tooltip, Popover, Dropdown
- Tabs, Accordion, Collapse

### Feedback
- Alert, Toast, Modal
- Progress, Spinner, Skeleton
- EmptyState, ErrorBoundary

### Forms
- FormField, FormGroup, FormLabel
- FileUpload, DatePicker, RangePicker
- SearchInput, TagInput

## Best Practices

1. **Forward refs**: Use `forwardRef` for DOM access
2. **Type props properly**: Extend native HTML element props
3. **Use composition**: Compound components when appropriate
4. **Accessibility first**: ARIA attributes, keyboard nav
5. **Variants system**: Size, color, state variants
6. **Loading states**: Handle async operations
7. **Error states**: Validate and show errors
8. **Test coverage**: At least 80% coverage
9. **Document usage**: JSDoc and README examples
10. **Export types**: Make TypeScript types available

## Styling Approaches

### Tailwind CSS (Recommended)
- Use `cn()` utility for conditional classes
- Define variants with object syntax
- Responsive utilities built-in

### CSS Modules
- Scoped styles by default
- Type-safe with TypeScript
- Better for complex animations

### Styled Components
- CSS-in-JS with props
- Dynamic theming support
- Runtime styling

## Output Checklist

Every generated component should include:

- [ ] Main component file with TypeScript types
- [ ] Prop interface with JSDoc comments
- [ ] Multiple variants (size, color, state)
- [ ] Accessibility attributes
- [ ] Test file with key scenarios
- [ ] Storybook story with examples
- [ ] Barrel export (index.ts)
- [ ] Usage documentation
- [ ] Error handling
- [ ] Loading states (if applicable)
```
