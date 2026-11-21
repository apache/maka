---
name: nano-banana-2
displayName: "Nano Banana 2 — Pro Pack on RunComfy"
description: >
  Generate images with Google Nano Banana 2 (Gemini-family flash-tier
  text-to-image) on RunComfy — bundled with the model's documented
  prompting patterns so the skill gets sharper output than naive
  prompting against the same model. Documents Nano Banana 2's strengths
  (rapid iteration, in-image typography rendering, predictable framing,
  optional web-grounded context), the resolution-tier pricing, the
  safety-tolerance dial, and when to route to Nano Banana Pro / GPT
  Image 2 / Flux 2 / Seedream instead. Calls
  `runcomfy run google/nano-banana-2/text-to-image` through the local
  RunComfy CLI. Triggers on "nano banana", "nano-banana-2", "nano banana 2",
  "google image gen", "gemini image", or any explicit ask to generate
  with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Nano Banana 2 — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-2) · [Model page](https://www.runcomfy.com/models/google/nano-banana-2?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-2) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/nano-banana-2)

Google **Nano Banana 2** — the flash-tier text-to-image model in the Gemini family — hosted on the **RunComfy Model API**. Optimized for ideation, social-thumbnail batches, and rapid drafts with strong in-image typography.

```bash
npx skills add agentspace-so/runcomfy-skills --skill nano-banana-2 -g
```

## When to pick this model (vs siblings)

Nano Banana 2 is the **flash-tier** of the Google image-gen line. Pick it when iteration speed and predictable framing matter more than maximum detail.

| You want                                            | Use                                     |
| --------------------------------------------------- | --------------------------------------- |
| Rapid drafts, social thumbnails, batch variants     | **Nano Banana 2**                       |
| In-image typography with predictable rendering      | **Nano Banana 2**                       |
| Web-grounded image (current events / real entities) | **Nano Banana 2** + `enable_web_search` |
| Image **edit** (preserve subject, swap background)  | **Nano Banana Edit** (sibling skill)    |
| Heavy stylization, painterly look                   | Flux 2                                  |
| Maximum prompt adherence + multilingual text        | GPT Image 2                             |
| 2K–4K hero shots, max realism                       | Seedream 5                              |
| Hyperrealistic portrait                             | Nano Banana Pro                         |

If the user said "Nano Banana" / "nano-banana-2" / "Gemini image" explicitly, route here regardless. If they said "Nano Banana" without specifying 2 vs Pro, default to **Pro** for portraits and **2** for everything else.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `google/nano-banana-2/text-to-image`

| Field               | Type   | Required | Default | Notes                                                                            |
| ------------------- | ------ | -------- | ------- | -------------------------------------------------------------------------------- |
| `prompt`            | string | yes      | —       | Subject-first description.                                                       |
| `num_images`        | int    | no       | 1       | 1–4. Use 4 for ideation rounds.                                                  |
| `seed`              | int    | no       | 0       | Reuse for reproducibility.                                                       |
| `aspect_ratio`      | enum   | no       | `auto`  | `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`. |
| `resolution`        | enum   | no       | `1K`    | `0.5K` (drafts), `1K` (default), `2K` (final), `4K` (max).                       |
| `output_format`     | enum   | no       | `png`   | `png`, `jpeg`, `webp`.                                                           |
| `safety_tolerance`  | int    | no       | 4       | 1 (strict) – 6 (permissive).                                                     |
| `limit_generations` | bool   | no       | true    | Limit each prompt round to one generation.                                       |
| `enable_web_search` | bool   | no       | false   | Adds web grounding (extra cost + latency).                                       |

For image edit (preserve subject + apply changes), see the sibling [`nano-banana-edit`](../nano-banana-edit) skill.

## How to invoke

**Default draft (1K, square, png):**

```bash
runcomfy run google/nano-banana-2/text-to-image \
  --input '{"prompt": "<user prompt>"}' \
  --output-dir <absolute/path>
```

**Vertical 4-up batch for ideation:**

```bash
runcomfy run google/nano-banana-2/text-to-image \
  --input '{
    "prompt": "<user prompt>",
    "num_images": 4,
    "aspect_ratio": "9:16",
    "resolution": "0.5K"
  }' \
  --output-dir <absolute/path>
```

**Final at 2K with seed lock:**

```bash
runcomfy run google/nano-banana-2/text-to-image \
  --input '{
    "prompt": "<user prompt>",
    "resolution": "2K",
    "aspect_ratio": "16:9",
    "seed": 42
  }' \
  --output-dir <absolute/path>
```

**Web-grounded (current event / real entity):**

```bash
runcomfy run google/nano-banana-2/text-to-image \
  --input '{
    "prompt": "<prompt referencing a real-world event from this week>",
    "enable_web_search": true
  }' \
  --output-dir <absolute/path>
```

## Prompting — what actually works

**Subject-first declarative grammar.** "A cinematic close-up portrait of an American woman standing under neon lights in rainy Tokyo, shallow depth of field, reflective wet streets, ultra-detailed, realistic skin texture" — primary subject, then action, environment, style, camera. Front-load subject; trail with directives.

**Exact text quoting for in-image typography.** "The label reads 'AURA' in clean bold sans-serif, centered, white on black" — quote the literal characters. Specify placement and font style. Don't say "with the brand name on it" and hope.

**Consistent seeds for refinement.** Lock `seed` when iterating a single prompt across small variants — keeps composition stable.

**Web-grounding, sparingly.** Turn on `enable_web_search` only when the prompt names current events / real entities. Adds latency + cost; off by default.

**Don't conflict styles.** "minimalist + ornate + retro + cyberpunk" cancels. Pick 1–2 anchors.

**Anti-patterns:**

- Trying to verbally describe a stable subject identity — use the **edit** endpoint with image refs instead.
- Asking for resolutions outside the 4 tiers → 422.
- Aspect ratios outside the 11 supported values → 422.
- Non-quoted in-image text → unpredictable rendering.

## Where it shines

| Use case                                    | Why Nano Banana 2                                     |
| ------------------------------------------- | ----------------------------------------------------- |
| **Marketing draft thumbnails (batch of 4)** | Fast iteration at 0.5K, then promote winner to 2K     |
| **Social-platform-native**                  | Wide aspect ratio support including 9:16, 4:5, 21:9   |
| **In-image typography for posters / cards** | Predictable text rendering when characters are quoted |
| **Web-grounded current-event imagery**      | `enable_web_search` integrates fresh info             |
| **Reproducible variant testing**            | Strong seed + consistent framing                      |

## Sample prompts (verified to produce strong results)

**Cinematic portrait (page example):**

```
A cinematic close-up portrait of an American woman standing under neon
lights in rainy Tokyo, shallow depth of field, reflective wet streets,
ultra-detailed, realistic skin texture
```

**Brand-asset card with quoted text:**

```
A minimalist 16:9 product card: a matte black ceramic mug centered on a
soft warm-grey paper background, rim highlight from upper-left, the
headline "Brewed Quietly" in clean bold sans-serif top-right, balanced
negative space below, e-commerce ready, clean studio lighting
```

**Vertical platform-native:**

```
A 9:16 vertical hero for a wellness brand: a single ceramic teacup on a
linen runner, soft morning side-light, the words "Slow Down" in
hand-drawn serif large at the top, gentle steam rising, neutral color
palette, uncluttered
```

## Limitations

- **Still images only.** No video on this endpoint.
- **Max 4 outputs per request.**
- **Web search adds latency + cost** — only enable on demand.
- **2K / 4K cost more** — default to 1K unless user asked for higher.
- **For image edit, use the `/edit` endpoint** — not this one.

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=nano-banana-2).

## How it works

The skill invokes `runcomfy run google/nano-banana-2/text-to-image` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/google/nano-banana-2/text-to-image`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
