---
name: gpt-image-2
displayName: "GPT Image 2 — Pro Pack on RunComfy"
description: >
  Generate and edit images with OpenAI GPT Image 2 (ChatGPT Images 2.0)
  on RunComfy. Documents GPT Image 2's strengths (embedded text, logos,
  multilingual typography, instruction precision), its 3 fixed sizes,
  edit-with-preservation language, and when to route to a sibling
  (Flux 2 / Nano Banana Pro / Seedream) instead. Calls `runcomfy run
  openai/gpt-image-2/text-to-image` or `/edit` through the local
  RunComfy CLI. Triggers on "gpt image 2", "gpt-image-2", "ChatGPT
  Images 2", "image 2", or any explicit ask to generate or edit with
  this model.
homepage: https://www.runcomfy.com
license: MIT
---

# GPT Image 2 — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-2) · [Text-to-image](https://www.runcomfy.com/models/openai/gpt-image-2/text-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-2) · [Edit](https://www.runcomfy.com/models/openai/gpt-image-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-2) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/gpt-image-2)

OpenAI **GPT Image 2** (ChatGPT Images 2.0) hosted on the **RunComfy Model API** — no OpenAI key, async REST.

```bash
npx skills add agentspace-so/runcomfy-skills --skill gpt-image-2 -g
```

## When to pick this model (vs siblings)

GPT Image 2's distinct strength is **directive precision**: it follows multi-element prompts, layout cues, and embedded-text instructions more reliably than its peers. Pick it when **what's on the canvas matters more than how stylized it looks**.

| You want                                               | Use             |
| ------------------------------------------------------ | --------------- |
| Embedded text, logos, signage, multilingual typography | **GPT Image 2** |
| Brand-safe, e-commerce / ad / UI mockup imagery        | **GPT Image 2** |
| Iterative refinement that holds composition stable     | **GPT Image 2** |
| Heavy stylization, painterly look                      | Flux 2          |
| Hyperrealistic portrait                                | Nano Banana Pro |
| Cinematic / aesthetic-first hero shots                 | Seedream 5      |

If the user explicitly asked for GPT Image 2 / ChatGPT Image 2 / Image 2, route here regardless — don't second-guess the model choice.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

Two endpoints, same model.

### `openai/gpt-image-2/text-to-image`

| Field    | Type   | Required | Default     | Notes                                                                                             |
| -------- | ------ | -------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `prompt` | string | yes      | —           | The positive prompt                                                                               |
| `size`   | enum   | no       | `1024_1024` | `1024_1024` (1:1), `1024_1536` (2:3 portrait), `1536_1024` (3:2 landscape) — **only these three** |

### `openai/gpt-image-2/edit`

| Field    | Type     | Required | Default | Notes                                                                |
| -------- | -------- | -------- | ------- | -------------------------------------------------------------------- |
| `prompt` | string   | yes      | —       | Natural-language **edit instruction**                                |
| `images` | string[] | yes      | —       | **Up to 10** reference image URLs (publicly fetchable HTTPS)         |
| `size`   | enum     | no       | `auto`  | `auto` (preserve input ratio), or one of the three fixed sizes above |

`size=auto` on edit preserves the input aspect ratio — strongly recommended unless the edit explicitly changes framing.

## How to invoke

**Text-to-image:**

```bash
runcomfy run openai/gpt-image-2/text-to-image \
  --input '{"prompt": "<user prompt>", "size": "1024_1536"}' \
  --output-dir <absolute/path>
```

**Edit (single ref):**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "<edit instruction>",
    "images": ["https://..."]
  }' \
  --output-dir <absolute/path>
```

**Edit (multi-ref, up to 10):**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "compose subject from image 1 into the room from image 2; match the lighting of image 2",
    "images": ["https://...subject.jpg", "https://...room.jpg"]
  }' \
  --output-dir <absolute/path>
```

The CLI submits, polls every 2s until terminal, then downloads any `*.runcomfy.net` / `*.runcomfy.com` URL from the result into `--output-dir`. Stdout is the result JSON. Stderr is progress.

For pipe-friendly usage:

```bash
runcomfy --output json run openai/gpt-image-2/text-to-image \
  --input '{"prompt":"..."}' --no-wait | jq -r .request_id
```

## Prompting — what actually works

These are model-specific patterns that empirically improve output quality. Apply to text-to-image and edit alike.

**Be explicit on subject + setting + mood.** "A close-up of a matte ceramic water bottle on warm linen, soft window light, neutral background" — three concrete directives — beats "nice product photo of a bottle".

**Quote embedded text exactly. Keep it short.** GPT Image 2 is the strongest text-rendering model in this class, but only when you **put the literal characters in quotes**. Long blocks of text degrade. For multilingual text, name the script: "Japanese kana", "Cyrillic", "Arabic right-to-left".

**Use compositional cues directly.** "rule of thirds", "close-up", "aerial view", "centered subject", "shallow depth of field" — these have learned-meaning to the model.

**Iterate one attribute at a time.** When refining, change one thing per iteration (lighting OR background OR pose OR text) and keep the rest of the prompt verbatim. The model holds composition stable across iterations when only one knob moves.

**Don't conflict instructions.** "no text" + "the word 'AQUA+' on the label" is incoherent — the model will pick one and you don't control which.

**Don't pile up styles.** "ukiyo-e + watercolor + 8K + cinematic + minimalist" cancels out. Pick one or two style anchors max.

For the **edit** endpoint specifically:

- **State preservation goals.** "**keep** the person's pose and face identity unchanged", "**keep** the brand mark and typography on the package", "**keep** the overall framing". The model needs to know what NOT to change.
- **Use directional language for spatial edits.** "Move the headline from top-right to bottom-center", not "reposition the headline".
- **Multi-ref**: number the images in the prompt — "subject from image 1, lighting and background from image 2" — and the model will route the cues correctly.

## Where it shines

| Use case                                 | Why GPT Image 2                                                      |
| ---------------------------------------- | -------------------------------------------------------------------- |
| **E-commerce product photography**       | Reliable text on labels, brand-safe lighting, consistent across SKUs |
| **High-conversion ads**                  | Headline + visual integration in one pass                            |
| **Brand asset localization**             | One source asset → many language variants of the same headline       |
| **Signage, posters, packaging mock-ups** | Text rendering accuracy at multiple scales                           |
| **UI mockups, scientific illustrations** | Layout precision and label legibility                                |

## Sample prompts (verified to produce strong results)

**Text-to-image — product hero:**

```
A minimal hero product still life: a matte ceramic water bottle on warm linen,
soft window light, the word "AQUA+" in clean sans-serif on the label,
subtle rim highlights, e-commerce ready, 8K detail, neutral background
```

**Text-to-image — multilingual signage:**

```
A small Tokyo café storefront at dusk, warm interior glow,
the sign reads "コーヒー" in bold Japanese kana on a wooden plaque,
shallow depth of field, rule of thirds, cinematic
```

**Edit — background swap with preservation:**

```
Turn the background into a bright minimal white-to-soft-gray studio sweep
with gentle floor shadow; add a large headline in-image that reads
"OPEN STUDIO" in a bold clean sans-serif, high contrast, centered;
keep the main person or product, pose, and face identity unchanged
```

## Limitations

- **Only 3 fixed sizes** on text-to-image (and the same 3 + `auto` on edit). Extreme aspect ratios are auto-resized to the nearest supported one.
- **Prompt length** ~ a few thousand tokens. Long blocks of embedded text degrade output.
- **Edit's multi-image** support is "guidance from up to 10 refs", not ControlNet-style stacks. The first image is treated as the primary; the rest provide auxiliary cues.
- **Photorealism on portraits** is not its strongest suit — Nano Banana Pro wins that head-to-head.

## Exit codes

The `runcomfy` CLI uses sysexits-style codes:

| code | meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | success                                                               |
| 64   | bad CLI args                                                          |
| 65   | bad input JSON / schema mismatch (e.g. `size: "2048_2048"` would 422) |
| 69   | upstream 5xx                                                          |
| 75   | retryable: timeout / 429                                              |
| 77   | not signed in or token rejected                                       |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-2).

## How it works

1. The skill invokes `runcomfy run openai/gpt-image-2/<endpoint>` with a JSON body matching the schema above.
2. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/openai/gpt-image-2/<endpoint>` with the user's bearer token.
3. The Model API returns a `request_id`; the CLI polls `GET .../requests/<id>/status` every 2 seconds.
4. On terminal status, the CLI fetches `GET .../requests/<id>/result` and downloads any URL whose host ends with `.runcomfy.net` or `.runcomfy.com` into `--output-dir`. Other URLs are listed but not fetched.
5. `Ctrl-C` while polling sends `POST .../requests/<id>/cancel` so you don't get billed for GPU you stopped.

## What this skill is not

Not a direct OpenAI API client. Not a capability grant — depends on a working RunComfy account. Not multi-tenant.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
