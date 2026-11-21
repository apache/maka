---
name: tailwind-gradient-builder
description: Creates modern CSS gradients using Tailwind CSS including linear, radial, conic, mesh gradients, animated gradients, glassmorphism, and gradient text effects. Use when users request "gradient background", "tailwind gradient", "modern gradient", "mesh gradient", or "animated gradient".
---

# Tailwind Gradient Builder

Create stunning modern gradients with Tailwind CSS for backgrounds, text, borders, and animations.

## Core Workflow

1. **Choose gradient type**: Linear, radial, conic, or mesh
2. **Select color palette**: Define color stops and positions
3. **Add direction/angle**: Configure gradient orientation
4. **Apply effects**: Blur, animation, glassmorphism
5. **Optimize**: Ensure performance and accessibility

## Basic Linear Gradients

### Simple Two-Color Gradient

```html
<!-- Left to Right -->
<div class="bg-gradient-to-r from-blue-500 to-purple-600"></div>

<!-- Top to Bottom -->
<div class="bg-gradient-to-b from-cyan-400 to-blue-600"></div>

<!-- Diagonal -->
<div class="bg-gradient-to-br from-pink-500 to-orange-400"></div>
```

### Direction Classes

| Class               | Direction                |
| ------------------- | ------------------------ |
| `bg-gradient-to-t`  | Bottom to Top            |
| `bg-gradient-to-tr` | Bottom-left to Top-right |
| `bg-gradient-to-r`  | Left to Right            |
| `bg-gradient-to-br` | Top-left to Bottom-right |
| `bg-gradient-to-b`  | Top to Bottom            |
| `bg-gradient-to-bl` | Top-right to Bottom-left |
| `bg-gradient-to-l`  | Right to Left            |
| `bg-gradient-to-tl` | Bottom-right to Top-left |

### Three-Color Gradients

```html
<!-- With via for middle color -->
<div class="bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>

<!-- Sunset gradient -->
<div class="bg-gradient-to-r from-orange-500 via-red-500 to-pink-500"></div>

<!-- Ocean gradient -->
<div class="bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500"></div>
```

## Modern Gradient Presets

### Aurora Borealis

```html
<div class="bg-gradient-to-r from-green-300 via-blue-500 to-purple-600"></div>
```

### Sunset Vibes

```html
<div class="bg-gradient-to-r from-amber-200 via-rose-400 to-violet-500"></div>
```

### Neon Glow

```html
<div class="bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500"></div>
```

### Forest Mist

```html
<div class="bg-gradient-to-br from-emerald-400 via-teal-500 to-cyan-600"></div>
```

### Midnight City

```html
<div class="bg-gradient-to-b from-gray-900 via-purple-900 to-violet-600"></div>
```

### Peach Sunset

```html
<div class="bg-gradient-to-r from-rose-100 via-pink-300 to-orange-200"></div>
```

## Gradient Text

```html
<!-- Gradient text effect -->
<h1 class="bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 bg-clip-text text-transparent">
  Gradient Text
</h1>

<!-- Animated gradient text -->
<h1
  class="animate-gradient bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 bg-[length:200%_auto] bg-clip-text text-transparent"
>
  Animated Gradient
</h1>
```

### Tailwind Config for Animated Gradient Text

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      animation: {
        gradient: "gradient 3s ease infinite",
      },
      keyframes: {
        gradient: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
      },
    },
  },
};
```

## Radial Gradients

```html
<!-- Custom radial gradient with arbitrary values -->
<div
  class="bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-900 via-indigo-800 to-slate-900"
></div>

<!-- Radial from top -->
<div
  class="bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-amber-200 via-violet-600 to-sky-900"
></div>

<!-- Circle gradient -->
<div
  class="bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white to-gray-300"
></div>
```

### Radial Position Variants

```html
<!-- Top center -->
<div
  class="bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-sky-400 to-indigo-900"
></div>

<!-- Bottom right -->
<div
  class="bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-rose-400 to-orange-300"
></div>

<!-- Custom position -->
<div
  class="bg-[radial-gradient(ellipse_at_30%_70%,_var(--tw-gradient-stops))] from-emerald-300 to-cyan-800"
></div>
```

## Conic Gradients

```html
<!-- Color wheel -->
<div
  class="bg-[conic-gradient(from_0deg,_red,_yellow,_lime,_aqua,_blue,_magenta,_red)] rounded-full"
></div>

<!-- Subtle sweep -->
<div
  class="bg-[conic-gradient(at_top_right,_var(--tw-gradient-stops))] from-yellow-200 via-emerald-200 to-yellow-200"
></div>

<!-- Pie chart effect -->
<div
  class="bg-[conic-gradient(from_45deg,_#3b82f6_0deg_120deg,_#10b981_120deg_240deg,_#f59e0b_240deg_360deg)] rounded-full"
></div>
```

## Mesh Gradients

### CSS Mesh Gradient (Multiple Radials)

```html
<div class="relative min-h-screen overflow-hidden">
  <!-- Base layer -->
  <div class="absolute inset-0 bg-slate-950"></div>

  <!-- Mesh gradient layers -->
  <div
    class="absolute inset-0 bg-[radial-gradient(at_40%_20%,hsla(240,100%,70%,0.3)_0px,transparent_50%)]"
  ></div>
  <div
    class="absolute inset-0 bg-[radial-gradient(at_80%_0%,hsla(189,100%,56%,0.3)_0px,transparent_50%)]"
  ></div>
  <div
    class="absolute inset-0 bg-[radial-gradient(at_0%_50%,hsla(355,100%,66%,0.3)_0px,transparent_50%)]"
  ></div>
  <div
    class="absolute inset-0 bg-[radial-gradient(at_80%_50%,hsla(340,100%,70%,0.3)_0px,transparent_50%)]"
  ></div>
  <div
    class="absolute inset-0 bg-[radial-gradient(at_0%_100%,hsla(269,100%,70%,0.3)_0px,transparent_50%)]"
  ></div>
</div>
```

### Reusable Mesh Component

```tsx
// MeshGradient.tsx
interface MeshGradientProps {
  colors?: string[];
  className?: string;
}

export function MeshGradient({
  colors = [
    "hsla(240,100%,70%,0.3)",
    "hsla(189,100%,56%,0.3)",
    "hsla(355,100%,66%,0.3)",
    "hsla(340,100%,70%,0.3)",
  ],
  className = "",
}: MeshGradientProps) {
  const positions = ["40%_20%", "80%_0%", "0%_50%", "80%_50%"];

  return (
    <div className={`relative ${className}`}>
      <div className="absolute inset-0 bg-slate-950" />
      {colors.map((color, i) => (
        <div
          key={i}
          className="absolute inset-0"
          style={{
            background: `radial-gradient(at ${positions[i]}, ${color} 0px, transparent 50%)`,
          }}
        />
      ))}
    </div>
  );
}
```

## Animated Gradients

### Flowing Gradient Animation

```html
<div
  class="animate-gradient-x bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 bg-[length:200%_auto]"
></div>
```

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      animation: {
        "gradient-x": "gradient-x 3s ease infinite",
        "gradient-y": "gradient-y 3s ease infinite",
        "gradient-xy": "gradient-xy 3s ease infinite",
      },
      keyframes: {
        "gradient-x": {
          "0%, 100%": {
            "background-size": "200% 200%",
            "background-position": "left center",
          },
          "50%": {
            "background-size": "200% 200%",
            "background-position": "right center",
          },
        },
        "gradient-y": {
          "0%, 100%": {
            "background-size": "200% 200%",
            "background-position": "center top",
          },
          "50%": {
            "background-size": "200% 200%",
            "background-position": "center bottom",
          },
        },
        "gradient-xy": {
          "0%, 100%": {
            "background-size": "400% 400%",
            "background-position": "left top",
          },
          "50%": {
            "background-size": "400% 400%",
            "background-position": "right bottom",
          },
        },
      },
    },
  },
};
```

### Breathing/Pulsing Gradient

```html
<div class="animate-pulse-gradient bg-gradient-to-r from-blue-500 to-purple-600"></div>
```

```javascript
// Add to tailwind.config.js
{
  animation: {
    'pulse-gradient': 'pulse-gradient 4s ease-in-out infinite',
  },
  keyframes: {
    'pulse-gradient': {
      '0%, 100%': { opacity: '1' },
      '50%': { opacity: '0.7' },
    },
  },
}
```

## Glassmorphism

### Basic Glass Effect

```html
<div class="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl shadow-xl">
  <!-- Content -->
</div>
```

### Glass Card Component

```tsx
// GlassCard.tsx
interface GlassCardProps {
  children: React.ReactNode;
  blur?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

export function GlassCard({ children, blur = "md", className = "" }: GlassCardProps) {
  const blurClasses = {
    sm: "backdrop-blur-sm",
    md: "backdrop-blur-md",
    lg: "backdrop-blur-lg",
    xl: "backdrop-blur-xl",
  };

  return (
    <div
      className={`
        ${blurClasses[blur]}
        bg-white/10
        dark:bg-gray-900/20
        border border-white/20
        dark:border-gray-700/30
        rounded-2xl
        shadow-xl
        ${className}
      `}
    >
      {children}
    </div>
  );
}
```

### Glass with Gradient Border

```html
<div class="relative p-[1px] rounded-2xl bg-gradient-to-r from-pink-500 via-purple-500 to-blue-500">
  <div class="backdrop-blur-xl bg-black/80 rounded-2xl p-6">
    <!-- Content -->
  </div>
</div>
```

## Gradient Borders

### Gradient Border with Pseudo-element

```html
<div class="relative p-[2px] rounded-lg bg-gradient-to-r from-pink-500 to-violet-500">
  <div class="bg-white dark:bg-gray-900 rounded-lg p-4">Content with gradient border</div>
</div>
```

### Animated Gradient Border

```html
<div class="relative p-[2px] rounded-lg overflow-hidden">
  <div
    class="absolute inset-0 animate-spin-slow bg-gradient-to-r from-pink-500 via-purple-500 to-blue-500"
  ></div>
  <div class="relative bg-white dark:bg-gray-900 rounded-lg p-4">Animated border content</div>
</div>
```

```javascript
// tailwind.config.js
{
  animation: {
    'spin-slow': 'spin 3s linear infinite',
  },
}
```

## Gradient Overlays

### Image Overlay

```html
<div class="relative">
  <img src="/hero.jpg" alt="Hero" class="w-full h-96 object-cover" />
  <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent"></div>
  <div class="absolute bottom-0 left-0 p-8 text-white">
    <h1>Title</h1>
  </div>
</div>
```

### Fade Edge Effect

```html
<!-- Fade to sides -->
<div class="relative">
  <div class="overflow-x-scroll">
    <!-- Scrollable content -->
  </div>
  <div
    class="absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-white to-transparent pointer-events-none"
  ></div>
  <div
    class="absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white to-transparent pointer-events-none"
  ></div>
</div>
```

## Dark Mode Gradients

```html
<!-- Gradient that adapts to dark mode -->
<div
  class="bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900 dark:to-purple-900"
></div>

<!-- Mesh gradient for dark mode -->
<div
  class="
  bg-gradient-to-br from-slate-100 to-slate-200
  dark:bg-slate-950
  dark:bg-[radial-gradient(ellipse_at_top_right,_hsla(240,100%,70%,0.15)_0%,transparent_50%)]
"
></div>
```

## Performance Tips

1. **Limit animation complexity**: Use `will-change` sparingly
2. **Prefer CSS over JS**: CSS gradients are GPU-accelerated
3. **Reduce gradient stops**: Fewer colors = better performance
4. **Use opacity over complex gradients**: Simpler blends render faster
5. **Test on mobile**: Mesh gradients can be heavy on mobile devices

```html
<!-- Optimize with will-change for animated gradients -->
<div class="animate-gradient-x will-change-[background-position] ..."></div>
```

## Best Practices

1. **Maintain contrast**: Ensure text is readable over gradients
2. **Consistent palette**: Use colors from your design system
3. **Subtle animations**: Avoid distracting motion
4. **Fallback colors**: Provide solid color fallback
5. **Test in dark mode**: Gradients should work in both themes
6. **Accessibility**: Check contrast ratios for overlaid text

## Output Checklist

Every gradient implementation should include:

- [ ] Appropriate gradient type for use case
- [ ] Colors from design system palette
- [ ] Dark mode variant if applicable
- [ ] Animation config added to tailwind.config.js
- [ ] Performance optimization for animated gradients
- [ ] Fallback for older browsers
- [ ] Text contrast verification
- [ ] Mobile device testing
