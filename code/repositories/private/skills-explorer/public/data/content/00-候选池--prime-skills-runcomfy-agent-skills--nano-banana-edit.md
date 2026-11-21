---
name: nano-banana-edit
displayName: "Nano Banana Edit — Pro Pack on RunComfy"
description: >
  Edit images with Google Nano Banana 2 (image-to-image edit endpoint)
  on RunComfy. Documents Nano Banana Edit's strengths (preserve subject
  identity, swap background, localize edits with spatial language,
  multi-image batch edits up to 20 inputs), the schema, and when to
  route to GPT Image 2 edit / Flux Kontext / Nano Banana 2 t2i instead.
  Calls `runcomfy run google/nano-banana-2/edit` through the local
  RunComfy CLI. Triggers on "nano banana edit", "edit with nano banana",
  "image edit nano banana", or any explicit ask to edit with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Nano Banana Edit — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-edit) · [Edit endpoint](https://www.runcomfy.com/models/google/nano-banana-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-edit) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/nano-banana-edit)

Google **Nano Banana 2 Edit** — the image-to-image edit endpoint of the Gemini-family flash-tier image model — hosted on the **RunComfy Model API**. Up to **20 input images per call** for batch edits and multi-reference variation.

```bash
npx skills add agentspace-so/runcomfy-skills --skill nano-banana-edit -g
```

## When to pick this model (vs siblings)

| You want                                                | Use                               |
| ------------------------------------------------------- | --------------------------------- |
| Preserve subject identity, swap background or clothing  | **Nano Banana Edit**              |
| Edit up to 20 images consistently in one batch          | **Nano Banana Edit**              |
| Localize edit to "X only" with spatial language         | **Nano Banana Edit**              |
| Edit multilingual text inside the image (signs, labels) | GPT Image 2 edit                  |
| Single ref + precise local edit ("she's now holding X") | Flux Kontext                      |
| Generate a new image from scratch                       | Nano Banana 2 t2i (sibling skill) |

If the user said "nano banana edit" / "edit with nano banana" explicitly, route here regardless.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `google/nano-banana-2/edit`

| Field               | Type   | Required | Default | Notes                                                                |
| ------------------- | ------ | -------- | ------- | -------------------------------------------------------------------- |
| `prompt`            | string | yes      | —       | Edit instruction. Lead with preservation, end with the change.       |
| `image_urls`        | array  | yes      | —       | **1–20** publicly-fetchable HTTPS URLs.                              |
| `number_of_images`  | int    | no       | 1       | 1–4 outputs per call.                                                |
| `seed`              | int    | no       | —       | Reproducibility.                                                     |
| `aspect_ratio`      | enum   | no       | `auto`  | `auto` (follows input) or fixed ratios — lock for batch consistency. |
| `resolution`        | enum   | no       | `1K`    | `0.5K` / `1K` / `2K` / `4K`.                                         |
| `output_format`     | enum   | no       | `png`   | `png` / `jpeg` / `webp`.                                             |
| `safety_tolerance`  | int    | no       | 4       | 1 (strict) – 6 (permissive).                                         |
| `limit_generations` | bool   | no       | —       | If true, restricts each round to one output.                         |
| `enable_web_search` | bool   | no       | false   | Web grounding (extra cost / latency).                                |

## How to invoke

**Single-image background swap, identity preserved:**

```bash
runcomfy run google/nano-banana-2/edit \
  --input '{
    "prompt": "Keep the subject identity, pose, and clothing unchanged. Convert the background into a rainy neon cyberpunk street.",
    "image_urls": ["https://.../portrait.jpg"]
  }' \
  --output-dir <absolute/path>
```

**Batch edit with locked framing:**

```bash
runcomfy run google/nano-banana-2/edit \
  --input '{
    "prompt": "Replace the watermark in the bottom-right with the text \"AURA\" in clean white sans-serif. Keep everything else exactly as in the input.",
    "image_urls": ["https://.../sku-1.jpg", "https://.../sku-2.jpg", "https://.../sku-3.jpg"],
    "aspect_ratio": "1:1",
    "resolution": "1K"
  }' \
  --output-dir <absolute/path>
```

**Targeted spatial edit ("left object only"):**

```bash
runcomfy run google/nano-banana-2/edit \
  --input '{
    "prompt": "Remove the leftmost object only. Keep the right two objects, the table, and the lighting unchanged.",
    "image_urls": ["https://.../still-life.jpg"]
  }' \
  --output-dir <absolute/path>
```

## Prompting — what actually works

**Preservation first, change last.** Always lead with `"Keep [identity / pose / clothing / brand / framing] unchanged."` Then state the change in one clean sentence. Models honor what's stated up front; tail-end preservations get ignored.

**Localize with spatial language.** "background only", "the left object", "the upper-right corner", "above the headline" — concrete spatial scopes are honored. "make it more X" is vague and drifts.

**Batch consistency** — when editing a series, lock `aspect_ratio` and `resolution`. Use the same prompt grammar across the batch so each output reads as a sibling, not a remix.

**Iterate small.** If a one-pass edit drifts, split into two: pass 1 changes background only, pass 2 swaps the subject's outfit. Cleaner edits, same total cost (assuming similar resolution).

**Multi-image variation** — pass up to 20 inputs to get a coherent batch. Useful for SKU galleries, A/B testing, character sheet variations.

**Anti-patterns:**

- Long compound instructions ("change A and B and C and D") — drift increases per added scope.
- Edit instructions written in passive voice ("the background should be changed") — be imperative.
- Missing preservation goals — model will subtly rewrite the face / brand.
- Aspect ratios that don't match input — causes crops or stretches.

## Where it shines

| Use case                                                | Why Nano Banana Edit                            |
| ------------------------------------------------------- | ----------------------------------------------- |
| **SKU gallery — same product on different backgrounds** | Batch of 20, identity-preserved, framing locked |
| **Influencer / spokesperson background swaps**          | Strong identity preservation across edits       |
| **Localized object removal / addition**                 | Spatial language honored                        |
| **A/B variants for ad creative**                        | Seed lock + multiple `number_of_images`         |
| **Brand-asset relocalization**                          | Same composition with text / palette swap       |

## Sample prompts (verified to produce strong results)

**Background swap (page example):**

```
Keep the subject identity unchanged. Convert the background into a rainy
neon cyberpunk street.
```

**Targeted text replacement:**

```
Keep the bottle, label, and lighting exactly as in the input.
Replace only the brand text on the label from "ALPHA" to "AURA",
same font weight, centered, white on black.
```

**Multi-image batch consistency:**

```
For each input image: keep the subject's pose and identity unchanged.
Convert the background to a soft warm-grey studio sweep with subtle
floor shadow. Center the subject at the same fraction of frame as the
input.
```

## Limitations

- **1–20 input images per call** — the first is treated as primary; the rest provide auxiliary cues.
- **1–4 outputs per call.**
- **Long compound prompts drift** — split into multiple passes.
- **Web search adds latency + cost** — only enable on demand.
- **For multilingual in-image text edits, GPT Image 2 edit wins.**

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-edit).

## How it works

The skill invokes `runcomfy run google/nano-banana-2/edit` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/google/nano-banana-2/edit`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
