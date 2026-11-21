---
name: snipgrapher
description: Configures and uses snipgrapher to generate polished code snippet images, including syntax-highlighted PNGs, SVGs, and WebP exports with custom themes, profiles, and styling options. Use when the user wants to create code screenshots, turn code into shareable images, generate pretty code snippets for docs or social posts, produce syntax-highlighted images from source files, or explicitly mentions snipgrapher. Supports single-file renders, batch jobs, watch mode, and reusable named profiles via the snipgrapher CLI or npx.
metadata:
  tags: snipgrapher, snippets, images, svg, png, webp, cli
---

## When to use

Use this skill when you need to:

- Generate image snippets from source code
- Configure reusable snippet rendering defaults
- Batch-render snippet assets for docs, social posts, or changelogs
- Use published `snipgrapher` from npm to generate snippet images

## Quick start

Render a single file to a PNG immediately with no config required:

```bash
npx snipgrapher render file.ts -o output.png
```

For ongoing use, initialise a project config first, then render:

```bash
npx snipgrapher init          # creates snipgrapher.config.json
npx snipgrapher render file.ts --profile default -o output.png
```

After rendering, verify the output exists and is non-zero in size before treating the job as successful:

```bash
ls -lh output.png   # confirm file exists and size > 0
```

## How to use

Read these rule files in order:

- [rules/setup-and-configuration.md](rules/setup-and-configuration.md) - Install, select executable, initialize config, and define profiles
- [rules/rendering-workflows.md](rules/rendering-workflows.md) - Render single snippets, batch jobs, watch mode, and output practices

## Core principles

- **Configure first**: establish a project config before repeated renders
- **Reproducible output**: prefer named profiles and explicit output paths
- **Portable commands**: use command patterns that work with installed binaries and `npx`
- **Automation-friendly**: rely on CLI flags/config/env precedence intentionally

## Troubleshooting common render failures

If a render fails or produces an unexpected output, check for these common causes:

- **Missing fonts**: ensure any custom font specified in the profile or config is installed on the system
- **Unsupported syntax**: confirm the language/extension is supported by snipgrapher; fall back to plain text highlighting if not
- **Empty or corrupt output**: re-run with `--verbose` (if supported) to surface error details, and verify the input file is readable and non-empty
- **Profile not found**: run `npx snipgrapher init` to regenerate `snipgrapher.config.json` if the config file is missing or malformed
