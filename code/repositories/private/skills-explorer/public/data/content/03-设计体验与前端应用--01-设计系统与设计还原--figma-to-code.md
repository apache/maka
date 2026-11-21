---
name: figma-to-code
description: Convert Figma designs to production-ready code with pixel-perfect accuracy. Supports component decomposition, style matching, and self-correcting validation loops. Use this skill when the user needs to implement UI from Figma design files.
allowed-tools:
  - Bash(npx figma-to-code *)
  - Bash(curl *)
---

# Figma to Code — Design to Production UI

Convert Figma designs to production-ready React/components with pixel-perfect accuracy. Uses a decompose-build-verify approach.

## Workflow

1. **Decompose** — break the Figma design into nested sub-components
2. **Build bottom-up** — implement each component from leaf to root
3. **Verify** — cross-check CSS values against Figma data, iterate up to 3 rounds

## Usage

```bash
npx figma-to-code --figma-url "https://www.figma.com/file/xxx/design" \
  --framework react \
  --output ./src/components
```

### With Playwright Verification

```bash
npx figma-to-code --figma-url "https://www.figma.com/file/xxx/design" \
  --framework react \
  --output ./src/components \
  --verify-with-playwright
```

## Best Practices

1. Start with small, isolated components before tackling full pages
2. Use --verify-with-playwright for automated pixel matching
3. The skill self-corrects — up to 3 iterations per component for accuracy
4. Combine with design-taste-frontend for responsive adjustments
