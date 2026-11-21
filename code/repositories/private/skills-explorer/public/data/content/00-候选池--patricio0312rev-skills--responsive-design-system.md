---
name: responsive-design-system
description: Implements responsive design systems with mobile-first breakpoints, container queries, fluid typography, and adaptive layouts using Tailwind CSS. Use when users request "responsive design", "mobile-first", "breakpoints", "fluid typography", or "adaptive layout".
---

# Responsive Design System

Build adaptive, mobile-first layouts with modern CSS features and Tailwind.

## Core Workflow

1. **Define breakpoints**: Establish responsive breakpoint system
2. **Set fluid typography**: Clamp-based responsive fonts
3. **Create layout grid**: Responsive grid system
4. **Add container queries**: Component-level responsiveness
5. **Build responsive components**: Adaptive patterns
6. **Test across devices**: Verify on all viewports

## Breakpoint System

### Tailwind Default Breakpoints

| Breakpoint | Min Width | Target Devices           |
| ---------- | --------- | ------------------------ |
| `sm`       | 640px     | Large phones (landscape) |
| `md`       | 768px     | Tablets                  |
| `lg`       | 1024px    | Laptops                  |
| `xl`       | 1280px    | Desktops                 |
| `2xl`      | 1536px    | Large screens            |

### Custom Breakpoints

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    screens: {
      xs: "475px",
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
      "3xl": "1920px",
      // Max-width breakpoints
      "max-sm": { max: "639px" },
      "max-md": { max: "767px" },
      "max-lg": { max: "1023px" },
      // Range breakpoints
      tablet: { min: "768px", max: "1023px" },
      // Feature queries
      touch: { raw: "(hover: none) and (pointer: coarse)" },
      stylus: { raw: "(hover: none) and (pointer: fine)" },
      mouse: { raw: "(hover: hover) and (pointer: fine)" },
    },
  },
};
```

## Fluid Typography

### CSS Clamp Function

```css
/* globals.css */
:root {
  /* Fluid type scale: min, preferred, max */
  --text-xs: clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem);
  --text-sm: clamp(0.875rem, 0.8rem + 0.35vw, 1rem);
  --text-base: clamp(1rem, 0.9rem + 0.5vw, 1.125rem);
  --text-lg: clamp(1.125rem, 1rem + 0.6vw, 1.25rem);
  --text-xl: clamp(1.25rem, 1.1rem + 0.75vw, 1.5rem);
  --text-2xl: clamp(1.5rem, 1.2rem + 1.5vw, 2rem);
  --text-3xl: clamp(1.875rem, 1.4rem + 2.25vw, 2.5rem);
  --text-4xl: clamp(2.25rem, 1.5rem + 3.75vw, 3.5rem);
  --text-5xl: clamp(3rem, 1.8rem + 6vw, 5rem);

  /* Fluid spacing */
  --space-xs: clamp(0.25rem, 0.2rem + 0.25vw, 0.5rem);
  --space-sm: clamp(0.5rem, 0.4rem + 0.5vw, 0.75rem);
  --space-md: clamp(1rem, 0.8rem + 1vw, 1.5rem);
  --space-lg: clamp(1.5rem, 1rem + 2.5vw, 3rem);
  --space-xl: clamp(2rem, 1.2rem + 4vw, 5rem);
}
```

### Tailwind Fluid Typography

```javascript
// tailwind.config.js
const plugin = require("tailwindcss/plugin");

module.exports = {
  theme: {
    extend: {
      fontSize: {
        "fluid-xs": "clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem)",
        "fluid-sm": "clamp(0.875rem, 0.8rem + 0.35vw, 1rem)",
        "fluid-base": "clamp(1rem, 0.9rem + 0.5vw, 1.125rem)",
        "fluid-lg": "clamp(1.125rem, 1rem + 0.6vw, 1.25rem)",
        "fluid-xl": "clamp(1.25rem, 1.1rem + 0.75vw, 1.5rem)",
        "fluid-2xl": "clamp(1.5rem, 1.2rem + 1.5vw, 2rem)",
        "fluid-3xl": "clamp(1.875rem, 1.4rem + 2.25vw, 2.5rem)",
        "fluid-4xl": "clamp(2.25rem, 1.5rem + 3.75vw, 3.5rem)",
        "fluid-5xl": "clamp(3rem, 1.8rem + 6vw, 5rem)",
      },
    },
  },
};
```

### Usage

```html
<h1 class="text-fluid-4xl font-bold">Responsive Headline</h1>
<p class="text-fluid-base">Body text that scales smoothly.</p>
```

## Container Queries

### Enable Container Queries

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      containers: {
        xs: "320px",
        sm: "384px",
        md: "448px",
        lg: "512px",
        xl: "576px",
        "2xl": "672px",
      },
    },
  },
};
```

### Container Query Usage

```html
<!-- Define container -->
<div class="@container">
  <!-- Respond to container size, not viewport -->
  <div class="flex flex-col @md:flex-row @lg:gap-8">
    <div class="@md:w-1/2">
      <h2 class="text-lg @lg:text-2xl">Card Title</h2>
    </div>
    <div class="@md:w-1/2">
      <p class="text-sm @lg:text-base">Card content</p>
    </div>
  </div>
</div>

<!-- Named containers -->
<div class="@container/main">
  <div class="@lg/main:grid-cols-3">...</div>
</div>
```

### Responsive Card Component

```tsx
// components/ResponsiveCard.tsx
export function ResponsiveCard({ title, description, image }: CardProps) {
  return (
    <article className="@container">
      <div className="flex flex-col @sm:flex-row gap-4 p-4 bg-white rounded-lg shadow">
        <img
          src={image}
          alt=""
          className="w-full @sm:w-32 @md:w-48 h-32 @sm:h-auto object-cover rounded"
        />
        <div className="flex-1">
          <h3 className="text-lg @md:text-xl font-semibold">{title}</h3>
          <p className="text-sm @md:text-base text-gray-600 mt-2">{description}</p>
          <button className="mt-4 px-4 py-2 bg-blue-500 text-white rounded @md:px-6">
            Learn More
          </button>
        </div>
      </div>
    </article>
  );
}
```

## Responsive Grid Layouts

### Auto-Fit Grid

```html
<!-- Cards that automatically adjust columns -->
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
  <!-- Cards -->
</div>

<!-- CSS Grid auto-fit -->
<div class="grid gap-6" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">
  <!-- Cards automatically fit -->
</div>
```

### Dashboard Layout

```tsx
// components/DashboardLayout.tsx
export function DashboardLayout({ sidebar, main }: LayoutProps) {
  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Sidebar: Full width on mobile, fixed width on desktop */}
      <aside className="w-full lg:w-64 xl:w-80 bg-gray-900 text-white">
        <div className="p-4 lg:sticky lg:top-0">{sidebar}</div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-4 md:p-6 lg:p-8">
        <div className="max-w-7xl mx-auto">{main}</div>
      </main>
    </div>
  );
}
```

### Holy Grail Layout

```tsx
export function HolyGrailLayout({ header, sidebar, main, aside, footer }: LayoutProps) {
  return (
    <div className="min-h-screen grid grid-rows-[auto_1fr_auto]">
      <header className="bg-white border-b px-4 py-3">{header}</header>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] lg:grid-cols-[240px_1fr_240px]">
        <aside className="hidden md:block bg-gray-50 p-4 border-r">{sidebar}</aside>

        <main className="p-4 md:p-6 overflow-auto">{main}</main>

        <aside className="hidden lg:block bg-gray-50 p-4 border-l">{aside}</aside>
      </div>

      <footer className="bg-gray-900 text-white px-4 py-6">{footer}</footer>
    </div>
  );
}
```

## Responsive Images

### Srcset and Sizes

```html
<img
  src="/images/hero-800.jpg"
  srcset="
    /images/hero-400.jpg   400w,
    /images/hero-800.jpg   800w,
    /images/hero-1200.jpg 1200w,
    /images/hero-1600.jpg 1600w
  "
  sizes="(max-width: 640px) 100vw,
         (max-width: 1024px) 75vw,
         50vw"
  alt="Hero image"
  class="w-full h-auto"
/>
```

### Next.js Image

```tsx
import Image from "next/image";

export function ResponsiveImage({ src, alt }: ImageProps) {
  return (
    <div className="relative aspect-video w-full">
      <Image
        src={src}
        alt={alt}
        fill
        sizes="(max-width: 640px) 100vw,
               (max-width: 1024px) 75vw,
               50vw"
        className="object-cover"
      />
    </div>
  );
}
```

### Art Direction with Picture

```html
<picture>
  <!-- Mobile: Square crop -->
  <source media="(max-width: 639px)" srcset="/images/hero-mobile.jpg" />
  <!-- Tablet: 4:3 crop -->
  <source media="(max-width: 1023px)" srcset="/images/hero-tablet.jpg" />
  <!-- Desktop: Wide crop -->
  <img src="/images/hero-desktop.jpg" alt="Hero" class="w-full h-auto" />
</picture>
```

## Responsive Navigation

### Mobile Menu Pattern

```tsx
"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";

export function ResponsiveNav({ links }: NavProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="relative">
      {/* Desktop Navigation */}
      <div className="hidden md:flex items-center gap-8">
        {links.map((link) => (
          <a key={link.href} href={link.href} className="hover:text-blue-500">
            {link.label}
          </a>
        ))}
      </div>

      {/* Mobile Menu Button */}
      <button onClick={() => setIsOpen(!isOpen)} className="md:hidden p-2" aria-label="Toggle menu">
        {isOpen ? <X size={24} /> : <Menu size={24} />}
      </button>

      {/* Mobile Navigation */}
      {isOpen && (
        <div className="absolute top-full left-0 right-0 bg-white shadow-lg md:hidden">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="block px-4 py-3 border-b hover:bg-gray-50"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </nav>
  );
}
```

## Responsive Tables

### Horizontal Scroll

```html
<div class="overflow-x-auto">
  <table class="min-w-full">
    <!-- Table content -->
  </table>
</div>
```

### Stacked on Mobile

```tsx
export function ResponsiveTable({ headers, rows }: TableProps) {
  return (
    <>
      {/* Desktop Table */}
      <table className="hidden md:table w-full">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-4 py-2 text-left">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile Cards */}
      <div className="md:hidden space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="bg-white p-4 rounded-lg shadow">
            {row.map((cell, j) => (
              <div key={j} className="flex justify-between py-2 border-b last:border-0">
                <span className="font-medium text-gray-600">{headers[j]}</span>
                <span>{cell}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
```

## Touch-Friendly Targets

```css
/* Minimum touch target size: 44x44px */
.touch-target {
  min-height: 44px;
  min-width: 44px;
}

/* Tailwind equivalent */
@layer components {
  .btn-touch {
    @apply min-h-[44px] min-w-[44px] px-4 py-2;
  }
}
```

```html
<!-- Buttons with proper touch targets -->
<button class="min-h-[44px] min-w-[44px] px-4 py-2 bg-blue-500 text-white rounded">Click Me</button>

<!-- Links with padding for touch -->
<a href="#" class="inline-block py-3 px-4"> Touch-friendly link </a>
```

## Responsive Spacing

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      spacing: {
        // Fluid spacing
        "fluid-1": "clamp(0.25rem, 0.5vw, 0.5rem)",
        "fluid-2": "clamp(0.5rem, 1vw, 1rem)",
        "fluid-4": "clamp(1rem, 2vw, 2rem)",
        "fluid-8": "clamp(2rem, 4vw, 4rem)",
        "fluid-16": "clamp(4rem, 8vw, 8rem)",
      },
    },
  },
};
```

```html
<!-- Section with fluid spacing -->
<section class="py-fluid-8 px-fluid-4">
  <h2 class="mb-fluid-4">Section Title</h2>
  <p>Content with responsive spacing</p>
</section>
```

## Testing Responsive Designs

### Device Testing Checklist

```markdown
## Viewport Testing

- [ ] 320px (iPhone SE)
- [ ] 375px (iPhone 12/13)
- [ ] 390px (iPhone 14 Pro)
- [ ] 428px (iPhone 14 Pro Max)
- [ ] 768px (iPad)
- [ ] 1024px (iPad Pro / Small laptop)
- [ ] 1280px (Laptop)
- [ ] 1440px (Desktop)
- [ ] 1920px (Full HD)
- [ ] 2560px (QHD)

## Orientation Testing

- [ ] Portrait mode
- [ ] Landscape mode

## Interaction Testing

- [ ] Touch interactions
- [ ] Hover states (mouse)
- [ ] Keyboard navigation
```

## Best Practices

1. **Mobile-first**: Start with mobile styles, enhance for larger screens
2. **Use relative units**: `rem`, `em`, `%`, `vw/vh` over `px`
3. **Test real devices**: Emulators don't catch everything
4. **Fluid over fixed**: Use `clamp()` for smooth scaling
5. **Container queries**: For component-level responsiveness
6. **Touch targets**: Minimum 44x44px for interactive elements
7. **Content priority**: Show most important content first on mobile
8. **Performance**: Serve appropriate image sizes

## Output Checklist

Every responsive implementation should include:

- [ ] Mobile-first approach
- [ ] Breakpoints defined and consistent
- [ ] Fluid typography with clamp()
- [ ] Container queries for components
- [ ] Responsive images with srcset
- [ ] Touch-friendly tap targets (44px+)
- [ ] Tested on real devices
- [ ] Horizontal scroll prevented
- [ ] Navigation adapts to screen size
- [ ] Tables readable on mobile
