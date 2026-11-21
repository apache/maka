---
name: flux-2-klein
displayName: "Flux 2 Klein — Pro Pack on RunComfy"
description: >
  Generate images with Flux 2 Klein (Black Forest Labs' distilled fast
  variant of Flux 2) on RunComfy — bundled with the model's documented
  prompting patterns so the skill gets sharper output than naive
  prompting against the same model. Documents Flux 2 Klein's strengths
  (sub-second latency, multi-reference brand styling, declarative
  subject-first prompts), the step-count strategy (4–8 for fast
  iteration, ~25 for polish), the 9B vs 4B variant trade-off, and when
  to route to Flux 2 Pro / Seedream 5 / GPT Image 2 instead. Calls
  `runcomfy run blackforestlabs/flux-2-klein/9b/text-to-image` (or
  `/4b/`) through the local RunComfy CLI. Triggers on "flux 2 klein",
  "flux-2-klein", "flux klein", "BFL flux 2", or any explicit ask to
  generate with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Flux 2 Klein — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-2-klein) · [9B model](https://www.runcomfy.com/models/blackforestlabs/flux-2-klein/9b/text-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-2-klein) · [4B model](https://www.runcomfy.com/models/blackforestlabs/flux-2-klein/4b/text-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-2-klein) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/flux-2-klein)

Black Forest Labs' **Flux 2 Klein** (the distilled, low-latency variant of Flux 2) hosted on the **RunComfy Model API** — no API key, async REST.

```bash
npx skills add agentspace-so/runcomfy-skills --skill flux-2-klein -g
```

## When to pick this model (vs siblings)

Flux 2 Klein's distinct strength is **latency-first creative iteration**: sub-second feedback enables live art-direction sessions and rapid product visualization that batch-style models can't sustain. Pick it when **iteration speed matters more than ceiling resolution**.

| You want                                            | Use                 |
| --------------------------------------------------- | ------------------- |
| Real-time / live art-direction sessions             | **Flux 2 Klein 4B** |
| Fast iteration with strong detail at the end        | **Flux 2 Klein 9B** |
| Multi-reference brand styling with consistent looks | **Flux 2 Klein**    |
| 2K–4K hero images, max resolution                   | Seedream 5          |
| Maximum prompt adherence + extreme detail           | Flux 2 Pro          |
| Embedded text, logos, multilingual signage          | GPT Image 2         |
| Hyperrealistic portrait                             | Nano Banana Pro     |

If the user said "Flux 2 Klein" / "BFL Klein" / "flux klein" explicitly, route here regardless. If they said "Flux 2" generically, ask whether they want **Klein** (fast) or **Pro** (max quality) before defaulting.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

Two variants, same endpoint shape, same prompt grammar.

### `blackforestlabs/flux-2-klein/9b/text-to-image`

The fidelity-first variant. Use for polish / final output.

| Field    | Type   | Required | Default | Notes                                                                                               |
| -------- | ------ | -------- | ------- | --------------------------------------------------------------------------------------------------- |
| `prompt` | string | yes      | —       | Up to ~512 tokens. Longer degrades.                                                                 |
| `steps`  | int    | no       | 25      | 4–50. **Step-distilled architecture** — 4–8 enough for concepting; ~25 for polish; >25 buys little. |
| `width`  | int    | no       | 1024    | 512–1536 typical. **Aspect ratio capped at 16:9**, max ~2K total.                                   |
| `height` | int    | no       | 1024    | Match `width`'s aspect intent.                                                                      |

### `blackforestlabs/flux-2-klein/4b/text-to-image`

The latency-first variant. Sub-second 4-step inference. Use for live iteration / concepting.

Same field set as 9B. Default `steps` is effectively 4 — the variant is built for that step count.

### Reference images (both variants)

Up to **4 simultaneous reference images** are supported on the same endpoint for style transfer / guided composition. The exact field name in the JSON body is documented on the [model's API tab](https://www.runcomfy.com/models/blackforestlabs/flux-2-klein/9b/text-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-2-klein) — pass it through the CLI verbatim. Reference-image use enables editing-style workflows without a separate `/edit` endpoint.

## How to invoke

**Fast concepting (4B, sub-second):**

```bash
runcomfy run blackforestlabs/flux-2-klein/4b/text-to-image \
  --input '{"prompt": "<user prompt>"}' \
  --output-dir <absolute/path>
```

**Polish / final (9B, ~25 steps):**

```bash
runcomfy run blackforestlabs/flux-2-klein/9b/text-to-image \
  --input '{
    "prompt": "<user prompt>",
    "steps": 25,
    "width": 1024,
    "height": 1024
  }' \
  --output-dir <absolute/path>
```

**Wide-format poster:**

```bash
runcomfy run blackforestlabs/flux-2-klein/9b/text-to-image \
  --input '{"prompt": "<user prompt>", "width": 1536, "height": 864}' \
  --output-dir <absolute/path>
```

The CLI submits, polls every 2s until terminal, then downloads any `*.runcomfy.net` / `*.runcomfy.com` URL from the result into `--output-dir`. Stdout is the result JSON. Stderr is progress.

For pipe-friendly usage:

```bash
runcomfy --output json run blackforestlabs/flux-2-klein/4b/text-to-image \
  --input '{"prompt":"..."}' --no-wait | jq -r .request_id
```

## Prompting — what actually works

These are model-specific patterns that empirically improve output quality.

**Subject-first declarative grammar.** The structure Flux 2 Klein was trained on is _"Subject + action + scene + style + lighting + camera + quality"_. Front-load the subject; trail with directives. Example: `"A vibrant hummingbird mid-flight sipping nectar from a bright pink hibiscus, iridescent feathers in morning sun, soft bokeh tropical garden, macro photography, razor-sharp detail, cinematic lighting"`.

**Specificity wins over flowery language.** "4k product photo, softbox lighting, reflective table, 35mm, f/2.8" guides predictably. "A really pretty product image" doesn't.

**Step-count by phase.**

- **Concepting**: 4–8 steps on the 4B variant — sub-second feedback for live exploration.
- **Refinement**: 8–15 steps still on 4B, locking in subject + framing.
- **Polish**: ~25 steps on the 9B variant — texture, microdetail, fine typography.

**Multi-reference alignment.** When passing reference images, **keep their aesthetics aligned**. Mixing a watercolor + a photoreal + a 3D render in the same call confuses the editor. Pick one consistent visual register across all refs.

**Conditional edits**: state what stays, then what changes. _"Same composition and lighting as reference, but change the background from beach to mountain studio."_ This pattern holds composition stable.

**For text rendering** (Klein has the 8B Qwen3 embedder, decent but not GPT Image 2 territory): add `"crisp typography, high-contrast label"` and bump steps to ~25 if the text comes out soft. For heavy in-image text or multilingual rendering, route to GPT Image 2 instead.

**Anti-patterns**:

- Don't conflict adjectives. "minimalist + ornate" cancels.
- Don't exceed ~512 tokens. The model degrades, doesn't truncate gracefully.
- Don't ask for 4K — the model's resolution ceiling is ~2K.
- Don't ask for ultra-wide (>16:9) — the model crops.

## Where it shines

| Use case                               | Why Flux 2 Klein                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Live art-direction sessions**        | Sub-second feedback (4B) enables real-time iteration                                               |
| **Interactive product visualization**  | Fast UI previews and product comps without batch waits                                             |
| **Multi-reference brand styling**      | Strong style consistency across references for unified asset packs                                 |
| **Rapid concepting → polish workflow** | 4B for exploration, 9B for the final pass — same prompt grammar throughout                         |
| **Consumer-GPU-friendly inference**    | 4B variant runs on modest hardware; relevant for self-host comparisons but RunComfy-hosted is fine |

## Sample prompts (verified to produce strong results)

**From the model page (BFL example):**

```
A vibrant hummingbird mid-flight sipping nectar from a bright pink hibiscus
flower, iridescent emerald and sapphire feathers catching the morning sun,
soft bokeh tropical garden background, macro photography, razor-sharp
detail, cinematic lighting
```

**Product-photo pattern:**

```
A matte ceramic mug on a reclaimed-wood table, soft northern window light
from the left, shallow depth of field, 50mm prime, f/2.0, neutral
background, e-commerce ready, 4K product photography
```

**Brand-consistent pair (multi-ref):**

```
Same composition and lighting as the reference image, but the bottle
label is now blue with white sans-serif typography reading "AURA";
keep the bottle silhouette, table, and shadow exactly as in the reference
```

## Limitations

- **Resolution ceiling ~2K** — for higher native res, route to Seedream 5.
- **Aspect ratio cap 16:9** — extreme wide/tall ratios get cropped.
- **Prompt cap ~512 tokens** — longer degrades quality; doesn't truncate gracefully.
- **Reference image cap 4** — more than 4 increases latency and dilutes guidance.
- **Text rendering** — the 8B Qwen3 embedder helps but GPT Image 2 still wins for embedded text precision.

## Exit codes

The `runcomfy` CLI uses sysexits-style codes:

| code | meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | success                                                         |
| 64   | bad CLI args                                                    |
| 65   | bad input JSON / schema mismatch (e.g. `width: 4096` would 422) |
| 69   | upstream 5xx                                                    |
| 75   | retryable: timeout / 429                                        |
| 77   | not signed in or token rejected                                 |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-2-klein).

## How it works

1. The skill invokes `runcomfy run blackforestlabs/flux-2-klein/<variant>/text-to-image` with a JSON body matching the schema.
2. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/blackforestlabs/flux-2-klein/<variant>/text-to-image` with the user's bearer token.
3. The Model API returns a `request_id`; the CLI polls `GET .../requests/<id>/status` every 2 seconds.
4. On terminal status, the CLI fetches `GET .../requests/<id>/result` and downloads any URL whose host ends with `.runcomfy.net` or `.runcomfy.com` into `--output-dir`. Other URLs are listed but not fetched.
5. `Ctrl-C` while polling sends `POST .../requests/<id>/cancel` so you don't get billed for GPU you stopped.

## What this skill is not

Not a self-hosted Flux runner. Not a capability grant — depends on a working RunComfy account. Not multi-tenant.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
