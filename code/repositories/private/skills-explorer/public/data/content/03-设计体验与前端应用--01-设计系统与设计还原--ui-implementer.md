---
name: ui-implementer
description: Implement UI components from Figma designs, screenshots, or mockups with pixel-level accuracy validation. Use this skill when the user needs to convert visual designs into working UI code.
allowed-tools:
  - Bash(echo *)
---

# UI Implementer — Design to Component

Implement UI components from design inputs (Figma URLs, screenshots, mockups) with precision validation.

## Input Types

| Input              | Supported |
| ------------------ | :-------: |
| Figma URL          |    Yes    |
| Screenshot/Image   |    Yes    |
| Mockup description |    Yes    |
| Design spec PDF    |    Yes    |

## Workflow

1. **Analyze** — examine the design input for layout, spacing, colors, typography
2. **Implement** — build the component using the project's existing design system
3. **Validate** — check pixel-level accuracy against the source
4. **Adapt** — ensure responsive behavior across breakpoints

## Best Practices

1. Understand the existing design system before implementing new components
2. Extract design tokens (colors, spacing, fonts) from Figma for consistency
3. Validate against the source at multiple zoom levels
4. For complex layouts, implement section by section rather than all at once
