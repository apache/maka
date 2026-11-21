---
name: flux-kontext
displayName: "Flux Kontext Pro — Pro Pack on RunComfy"
description: >
  Edit images with Flux 1 Kontext Pro (Black Forest Labs' precise local
  image-edit model) on RunComfy — bundled with the model's documented
  prompting patterns so the skill gets sharper output than naive
  prompting against the same model. Documents Flux Kontext's strengths
  (single-reference precise local edits, strong prompt control,
  consistent high-fidelity outputs), the schema (single image + prompt),
  and when to route to Nano Banana Edit / GPT Image 2 edit / Flux 2
  Klein instead. Calls
  `runcomfy run blackforestlabs/flux-1-kontext/pro/edit` through the
  local RunComfy CLI. Triggers on "flux kontext", "flux-kontext",
  "flux 1 kontext", "kontext", "BFL kontext", or any explicit ask to
  edit with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Flux Kontext Pro — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-kontext) · [Model page](https://www.runcomfy.com/models/blackforestlabs/flux-1-kontext-pro/image-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-kontext) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/flux-kontext)

Black Forest Labs' **Flux 1 Kontext Pro** — single-reference precise local image edit — hosted on the **RunComfy Model API**. Strong prompt control, consistent outputs, high fidelity.

```bash
npx skills add agentspace-so/runcomfy-skills --skill flux-kontext -g
```

## When to pick this model (vs siblings)

| You want                                                | Use              |
| ------------------------------------------------------- | ---------------- |
| Single-image precise local edit ("she's now holding X") | **Flux Kontext** |
| High-fidelity preservation of source identity           | **Flux Kontext** |
| Batch edits across 1–20 images                          | Nano Banana Edit |
| Edit multilingual / embedded text in image              | GPT Image 2 edit |
| Generate from scratch, no source image                  | Flux 2 Klein     |

If the user said "Flux Kontext" / "kontext" / "BFL Kontext" explicitly, route here regardless.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `blackforestlabs/flux-1-kontext/pro/edit`

| Field          | Type   | Required | Default | Notes                                               |
| -------------- | ------ | -------- | ------- | --------------------------------------------------- |
| `prompt`       | string | yes      | —       | Single declarative edit instruction.                |
| `image`        | string | yes      | —       | Single source image URL (publicly fetchable HTTPS). |
| `aspect_ratio` | enum   | no       | (input) | Pick from supported W:H options on the model page.  |
| `seed`         | int    | no       | —       | Reuse for variant comparisons.                      |

The schema is intentionally minimal — Kontext leans on prompt + single ref. For multi-image or web-grounded edits, route to Nano Banana Edit.

## How to invoke

**Default — local edit, preserve everything else:**

```bash
runcomfy run blackforestlabs/flux-1-kontext/pro/edit \
  --input '{
    "prompt": "Keep the person'\''s face, pose, and clothing unchanged. Add an orange umbrella in her left hand and a slight smile.",
    "image": "https://.../portrait.jpg"
  }' \
  --output-dir <absolute/path>
```

**With seed for reproducible variant series:**

```bash
runcomfy run blackforestlabs/flux-1-kontext/pro/edit \
  --input '{
    "prompt": "Keep the bottle, label, and lighting unchanged. Replace the brand text on the label from \"ALPHA\" to \"AURA\".",
    "image": "https://.../bottle.jpg",
    "seed": 42
  }' \
  --output-dir <absolute/path>
```

## Prompting — what actually works

**One declarative instruction.** Kontext shines on prompts shaped like the docs example: `"She is now holding an orange umbrella and smiling"`. Imperative mood, single change.

**Preservation first.** Lead with `"Keep [identity / pose / framing / brand] unchanged."` Then the change. Models honor what's stated up front.

**Single ref only — pick the right one.** No multi-image fanout here. If you have multiple references, decide which is primary and pass that one. For multi-image flows, route to Nano Banana Edit.

**Iterate on small changes.** If Kontext drifts, split a compound edit into sequential single-instruction passes (pass 1: change background, pass 2: change clothing).

**Aspect ratio — pick from the supported enum.** Out-of-list values 422 or crop.

**Anti-patterns:**

- Compound prompts ("change A and add B and remove C") → drift.
- Trying to fan out to multiple source images → wrong model (use Nano Banana Edit).
- Prompts written in passive voice → less reliable.
- Asking for novel composition without a source image → wrong model (use Flux 2 Klein t2i).

## Where it shines

| Use case                                             | Why Flux Kontext                               |
| ---------------------------------------------------- | ---------------------------------------------- |
| **Single-shot precise local edit**                   | Specifically designed for this; high fidelity  |
| **Preserve source identity through targeted change** | Strong preservation under explicit instruction |
| **Brand-asset text or color swap**                   | Quoted text + preservation lead-in works well  |
| **Quick iteration on one image**                     | Short prompts + single ref = fast result loop  |

## Sample prompts (verified to produce strong results)

**Page example:**

```
She is now holding an orange umbrella and smiling
```

**Preservation-led brand edit:**

```
Keep the bottle silhouette, table, and lighting exactly as in the input.
Replace only the brand text on the label, from "ALPHA" to "AURA".
Same font weight, white on black, centered.
```

**Compositional micro-edit:**

```
Keep the person's face, pose, and clothing unchanged. Add a leather
shoulder bag, dark brown, hanging on the right shoulder.
```

## Limitations

- **Single source image only.** For multi-image flows, use Nano Banana Edit (1–20).
- **Public RunComfy docs are minimal** — schema fields beyond prompt + image + aspect_ratio + seed may exist; check the [model page](https://www.runcomfy.com/models/blackforestlabs/flux-1-kontext-pro/image-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-kontext) for the latest field list.
- **Compound prompts drift** — split into sequential passes.
- **For multilingual / embedded text editing, GPT Image 2 edit usually wins.**

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=flux-kontext).

## How it works

The skill invokes `runcomfy run blackforestlabs/flux-1-kontext/pro/edit` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/blackforestlabs/flux-1-kontext/pro/edit`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
