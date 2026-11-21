---
name: animation-micro-interaction-pack
description: Provides reusable interaction patterns and motion presets that make UI feel polished. Includes hover effects, transitions, entrance animations, gesture feedback, and reduced-motion support. Use when adding "animations", "transitions", "micro-interactions", or "motion design".
---

# Animation & Micro-interaction Pack

Create polished, performant animations and micro-interactions.

## Animation Patterns

**Hover Effects**: Scale, lift (translateY), glow (box-shadow), color shifts
**Entrance**: Fade-in, slide-in, zoom-in with stagger for lists
**Exit**: Fade-out, slide-out, scale-out
**Loading**: Pulse, skeleton waves, progress bars
**Gestures**: Ripple on click, drag feedback, swipe indicators

## Tailwind Animations

```css
/* tailwind.config.js */
animation: {
  'fade-in': 'fadeIn 0.5s ease-out',
  'slide-up': 'slideUp 0.3s ease-out',
  'scale-in': 'scaleIn 0.2s ease-out',
}
```

## Framer Motion Examples

```tsx
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
/>
```

## Best Practices

Use 200-300ms for micro-interactions, respect prefers-reduced-motion, animate transform/opacity for performance, add easing functions, stagger list items, provide hover/active states.
