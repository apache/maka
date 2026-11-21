---
name: image-edit
displayName: "Image Edit — Pro Pack on RunComfy"
description: >
  Edit images on RunComfy — this skill is a smart router that matches
  the user's intent to the right edit model in the RunComfy catalog.
  Picks Nano Banana Edit (batch up to 20, identity-preserving default),
  OpenAI GPT Image 2 Edit (multilingual in-image text rewrite,
  multi-ref composition, layout precision), Flux Kontext Pro
  (single-ref high-fidelity local edit), or Z-Image Turbo Inpaint
  (mask-driven precise region edit). Bundles each model's documented
  prompting patterns so the skill gets sharper edits without burning
  iterations on the wrong model. Calls `runcomfy run <vendor>/<model>/edit`
  through the local RunComfy CLI. Triggers on "image edit", "edit image",
  "image-to-image", "i2i", "swap background", "remove object",
  "rewrite headline", or any explicit ask to edit a single or batch
  of images.
homepage: https://www.runcomfy.com
license: MIT
---

# Image Edit — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit) · [Nano Banana Edit](https://www.runcomfy.com/models/google/nano-banana-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit) · [GPT Image 2 Edit](https://www.runcomfy.com/models/openai/gpt-image-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit) · [Flux Kontext](https://www.runcomfy.com/models/blackforestlabs/flux-1-kontext-pro/image-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit) · [Z-Image Inpaint](https://www.runcomfy.com/models/tongyi-mai/z-image/turbo/inpainting?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/image-edit)

**Image edit, intent-routed.** This skill doesn't lock you to one model — it picks the right edit model in the RunComfy catalog based on what the user actually wants: batch identity-preservation, multilingual text rewrite, single-shot precise edit, or mask-driven region replacement.

```bash
npx skills add agentspace-so/runcomfy-skills --skill image-edit -g
```

## Pick the right model for the user's intent

| User intent                                                                                         | Model                     | Why                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| Batch edit 1–20 images consistently (SKU gallery, A/B variants)                                     | **Nano Banana Edit**      | Up to 20 input images per call; locked aspect/resolution for series |
| Swap background, preserve subject identity                                                          | **Nano Banana Edit**      | Strong identity preservation under "keep X unchanged" prompts       |
| Localized object removal / addition with spatial language ("the left object", "upper-right corner") | **Nano Banana Edit**      | Honors directional spatial scope                                    |
| Multilingual / non-Latin in-image text rewrite (Japanese kana, Cyrillic, Arabic)                    | **GPT Image 2 Edit**      | Strongest in class for multilingual typography                      |
| Multi-reference composition (subject from img1, scene from img2, palette from img3)                 | **GPT Image 2 Edit**      | Numbered refs route cues correctly                                  |
| Layout-precise repositioning ("move headline from top-right to bottom-center")                      | **GPT Image 2 Edit**      | Directional language honored at layout level                        |
| Identity preservation across translated headline variants                                           | **GPT Image 2 Edit**      | Same source asset → many language variants, identity stable         |
| Single-shot precise local edit ("she's now holding an orange umbrella")                             | **Flux Kontext Pro**      | Single-ref single-instruction, high-fidelity preservation           |
| Mask-driven object removal (cables, watermarks, distractions)                                       | **Z-Image Turbo Inpaint** | Mask-required, strength-tunable, edge-consistent                    |
| Mask-driven region replacement (full background swap with mask)                                     | **Z-Image Turbo Inpaint** | High strength + clean mask = clean replacement                      |
| Default if unspecified                                                                              | **Nano Banana Edit**      | Most flexible, supports both single and batch                       |

The agent reads this table, classifies the user's intent, and picks the matching subsection below.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login`.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>`.

---

## Route 1: Nano Banana Edit — default for general edit + batch

**Model**: `google/nano-banana-2/edit`

### Schema

| Field               | Type   | Required | Default | Notes                                              |
| ------------------- | ------ | -------- | ------- | -------------------------------------------------- |
| `prompt`            | string | yes      | —       | Lead with preservation goals, end with the change. |
| `image_urls`        | array  | yes      | —       | **1–20** publicly-fetchable HTTPS URLs.            |
| `number_of_images`  | int    | no       | 1       | 1–4 outputs per call.                              |
| `aspect_ratio`      | enum   | no       | `auto`  | `auto` follows input; lock for batch consistency.  |
| `resolution`        | enum   | no       | `1K`    | `0.5K` / `1K` / `2K` / `4K`.                       |
| `output_format`     | enum   | no       | `png`   | `png` / `jpeg` / `webp`.                           |
| `seed`              | int    | no       | —       | Reproducibility.                                   |
| `enable_web_search` | bool   | no       | false   | Web-grounded edits (extra latency).                |

### Invoke

```bash
runcomfy run google/nano-banana-2/edit \
  --input '{
    "prompt": "Keep the subject identity, pose, and clothing unchanged. Convert the background into a rainy neon cyberpunk street.",
    "image_urls": ["https://.../portrait.jpg"]
  }' \
  --output-dir <absolute/path>
```

**Batch (lock aspect + resolution):**

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

### Prompting tips

- **Preservation first**: `"Keep [identity / pose / brand / framing] unchanged."` Then state the change.
- **Spatial scope**: "background only", "the left object", "upper-right quadrant" — concrete locations honored.
- **Batch consistency**: lock `aspect_ratio` and `resolution` across the batch.
- **Iterate small**: split compound edits into multiple shorter passes.

---

## Route 2: GPT Image 2 Edit — multilingual text + multi-ref composition

**Model**: `openai/gpt-image-2/edit`

### Schema

| Field    | Type     | Required | Default | Notes                                                          |
| -------- | -------- | -------- | ------- | -------------------------------------------------------------- |
| `prompt` | string   | yes      | —       | Edit instruction; lead with preservation.                      |
| `images` | string[] | yes      | —       | **Up to 10** HTTPS URLs. First is primary; rest are auxiliary. |
| `size`   | enum     | no       | `auto`  | `auto`, `1024_1024`, `1024_1536`, `1536_1024`. **Only these.** |

### Invoke

**Multilingual text rewrite:**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "Keep the photograph, layout, and brand mark exactly as in the input. Replace only the in-image headline. The new headline reads \"今日のおすすめ\" in bold Japanese kana, same position and font weight.",
    "images": ["https://.../poster-en.jpg"]
  }' \
  --output-dir <absolute/path>
```

**Multi-ref composition:**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "Compose subject from image 1 into the room from image 2. Match the lighting and color palette of image 2. Keep image 1 subject identity unchanged.",
    "images": ["https://.../subject.jpg", "https://.../room.jpg"]
  }' \
  --output-dir <absolute/path>
```

### Prompting tips

- **Quote in-image text exactly.** Name the script for non-Latin: `"Japanese kana"`, `"Cyrillic"`, `"Arabic right-to-left"`.
- **Number multi-refs**: `"subject from image 1, lighting from image 2"`.
- **Directional layout language**: `"move the headline from top-right to bottom-center"`, `"replace the watermark in the bottom-right"`.
- **`size: "auto"`** preserves input ratio — recommended unless the edit changes framing.

---

## Route 3: Flux Kontext Pro — single-shot precise local edit

**Model**: `blackforestlabs/flux-1-kontext/pro/edit`

### Schema (minimal)

| Field          | Type   | Required | Notes                             |
| -------------- | ------ | -------- | --------------------------------- |
| `prompt`       | string | yes      | One declarative edit instruction. |
| `image`        | string | yes      | **Single** source image URL.      |
| `aspect_ratio` | enum   | no       | Pick from supported W:H values.   |
| `seed`         | int    | no       | Reproducibility.                  |

Single image only — no array. For multi-image flows, use Route 1 (Nano Banana Edit).

### Invoke

```bash
runcomfy run blackforestlabs/flux-1-kontext/pro/edit \
  --input '{
    "prompt": "Keep the person'\''s face, pose, and clothing unchanged. Add an orange umbrella in her left hand and a slight smile.",
    "image": "https://.../portrait.jpg"
  }' \
  --output-dir <absolute/path>
```

### Prompting tips

- **One declarative instruction.** "She is now holding an orange umbrella and smiling" — imperative, single change.
- **Preservation first.** Lead with `"Keep [unchanged elements]"` then state the change.
- **Iterate small.** Compound edits drift on a single pass; split into sequential passes.

---

## Route 4: Z-Image Turbo Inpaint — mask-driven precise region edit

**Model**: `tongyi-mai/z-image/turbo/inpainting`

### Schema

| Field           | Type   | Required | Notes                                                                       |
| --------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `prompt`        | string | yes      | What to fill / replace; preservation constraints for the unmasked surround. |
| `image`         | string | yes      | Source image URL.                                                           |
| `mask_image`    | string | yes      | **Grayscale mask URL** (white = inpaint, black = preserve).                 |
| `strength`      | float  | no       | 0.3–0.6 retouching, 0.7–1.0 full replacement.                               |
| `control_scale` | float  | no       | 0.6–0.9 typical.                                                            |
| `aspect_ratio`  | enum   | no       | W:H output ratio.                                                           |
| `seed`          | int    | no       | Reproducibility.                                                            |

### Invoke

**Object removal (low strength):**

```bash
runcomfy run tongyi-mai/z-image/turbo/inpainting \
  --input '{
    "prompt": "Remove overhead cables; preserve rooflines and sky gradient; thin clean sky.",
    "image": "https://.../street.jpg",
    "mask_image": "https://.../cables-mask.png",
    "strength": 0.5,
    "control_scale": 0.8
  }' \
  --output-dir <absolute/path>
```

**Region replacement (high strength):**

```bash
runcomfy run tongyi-mai/z-image/turbo/inpainting \
  --input '{
    "prompt": "Replace busy backdrop with smooth light gray studio paper; mask background only.",
    "image": "https://.../product.jpg",
    "mask_image": "https://.../bg-mask.png",
    "strength": 0.9
  }' \
  --output-dir <absolute/path>
```

### Prompting tips

- **A mask URL is required** — grayscale, white = inpaint region, black = preserve. Slight blur on mask edges (1–3px) blends better than sharp binary.
- **Strength by intent**: `0.3–0.5` for retouching / cleanup, `0.6–0.7` for object replacement with style match, `0.8–1.0` for full-region replacement.
- **Name what stays outside the mask** in the prompt: `"preserve rooflines and sky gradient"`, `"match brick pattern and mortar tone"`.
- **Spatial labels still help** even though the mask defines the region: `"the left shelf"`, `"upper-right quadrant"`.

---

## Limitations

- **Each route inherits its model's limits.** Nano Banana: 1–20 inputs, 1–4 outputs. GPT Image 2 Edit: up to 10 refs, 4 fixed sizes. Flux Kontext: single ref. Z-Image Inpaint: mask required.
- **No multi-route blending.** This skill picks one model per call.
- **Brand-specific overrides** — if the user named a specific model, route to the corresponding brand skill (`gpt-image-edit`, `flux-kontext`, `nano-banana-edit`) for fuller treatment.

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=image-edit).

## How it works

The skill picks one of Nano Banana Edit / GPT Image 2 Edit / Flux Kontext Pro / Z-Image Turbo Inpaint based on user intent and invokes `runcomfy run <model_id>` with the matching JSON body. The CLI POSTs to the Model API, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
