---
name: "figma"
displayName: "Design to Code with Figma"
description: "Connect Figma designs to code components - automatically generate design system rules, map UI components to Figma designs, and maintain design-code consistency"
keywords: ["ui", "design", "code", "layout", "mockup", "frame", "component","frontend"]
author: "Figma"
---

# Workflow 

Execute this file to generate the right context for Figma. Please thoroughly analyze this codebase and create a comprehensive rules doc. 

## Step 1
Call the `create_design_system_rules` tool from the Figma MCP server. Make sure that you create a workspace specific steering file titled 'design-system.md' and  set to always included in the inclusion mode.


## Step 2: Create a Hook for code connect

Create a hook that does this anytime a UI component is added or updated. Save the hook in `./kiro/hooks/hookname.kiro.hook`. Example hook format. Please update the patterns to match your project's file structure.

```json

{
  "enabled": true,
  "name": "Figma Component Code Connect",
  "description": "Check if UI component should be connected to Figma design",
  "version": "1",
  "when": {
    "type": "fileEdited",
    "patterns": ["**/*.tsx", "**/*.jsx", "**/components/**/*"]
  },
  "then": {
    "type": "askAgent",
    "prompt": "When a new component file is created or updated, ask the user if they would like to confirm if the code has been correctly attached to the Figma component of the same name. If the user approves: first run the get code connect map tool for the last Figma URL provided by the user. You can prompt them to provide it again if it's unavailable. If the response is empty, run the add code connect map tool, otherwise tell the user they already have code mapped to that component. If the user rejects: Do not run any additional tools."
  },
  "shortName": "figma-code-connect"
}

```

# Figma MCP Integration Guidelines

- Treat the Figma MCP output (React + Tailwind) as a representation of design and behavior, not as final code
style.
- Replace Tailwind utility classes with the project's preferred utilities/design‑system tokens when applicable.
- Reuse existing components (e.g., buttons, inputs, typography, icon wrappers) instead of duplicating
functionality.
- Use the project's color system, typography scale, and spacing tokens consistently.
- Respect existing routing, state management, and data‑fetch patterns already adopted in the repo.
- Strive for 1:1 visual parity with the Figma design. When conflicts arise, prefer design‑system tokens and
adjust spacing or sizes minimally to match visuals.
- Validate the final UI against the Figma screenshot for both look and behavior.
