---
name: happyhorse-1-0
displayName: "HappyHorse 1.0 — Pro Pack on RunComfy"
description: >
  Generate text-to-video with HappyHorse 1.0 on RunComfy. Documents HappyHorse
  1.0's strengths (#1 on Artificial Analysis Video Arena, native 1080p
  with in-pass synchronized audio, multi-shot character consistency,
  6-language prompt support), the duration / aspect-ratio / resolution
  schema, and when to route to Wan 2.7 / Seedance 2 / LTX 2 instead.
  Calls `runcomfy run happyhorse/happyhorse-1-0/text-to-video` through
  the local RunComfy CLI. Triggers on "happyhorse", "happy horse",
  "happyhorse 1.0", "happyhorse video", or any explicit ask to generate
  video with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# HappyHorse 1.0 — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=happyhorse-1-0) · [Text-to-video](https://www.runcomfy.com/models/happyhorse/happyhorse-1-0/text-to-video?utm_source=skills.sh&utm_medium=skill&utm_campaign=happyhorse-1-0) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/happyhorse-1-0)

**HappyHorse 1.0** — currently #1 on Artificial Analysis Video Arena (Elo 1333 t2v / 1392 i2v) — hosted on the **RunComfy Model API**. Native 1080p video with **in-pass synchronized audio** (dialogue, ambient, Foley) and multi-shot character consistency.

```bash
npx skills add agentspace-so/runcomfy-skills --skill happyhorse-1-0 -g
```

## When to pick this model (vs siblings)

| You want                                               | Use                |
| ------------------------------------------------------ | ------------------ |
| Multi-shot story with character / wardrobe consistency | **HappyHorse 1.0** |
| Native audio in the same generation pass               | **HappyHorse 1.0** |
| Currently-#1 blind-vote video model                    | **HappyHorse 1.0** |
| Detailed lip-synced dialogue + reference video         | Seedance 2.0 Pro   |
| Fine motion control + multi-reference conditioning     | Wan 2.7            |
| Ultra-fast iteration (sub-second per frame)            | LTX 2              |
| Cinematic motion editing on existing footage           | Kling Video O1     |

If the user said "HappyHorse" / "happy horse video" explicitly, route here regardless.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `happyhorse/happyhorse-1-0/text-to-video`

| Field          | Type   | Required | Default | Notes                                               |
| -------------- | ------ | -------- | ------- | --------------------------------------------------- |
| `prompt`       | string | yes      | —       | Up to 2,500 chars. 6 languages (CN/EN/JP/KR/DE/FR). |
| `aspect_ratio` | enum   | no       | `16:9`  | `16:9`, `9:16`, `1:1`, `4:3`, `3:4` only.           |
| `resolution`   | enum   | no       | `1080P` | `720P` or `1080P`.                                  |
| `duration`     | int    | no       | 5       | 3–15 seconds.                                       |
| `seed`         | int    | no       | 0       | 0..2^31-1. Reuse for variant comparisons.           |
| `watermark`    | bool   | no       | true    | Provider watermark.                                 |

## How to invoke

**Default (16:9 1080p 5s):**

```bash
runcomfy run happyhorse/happyhorse-1-0/text-to-video \
  --input '{"prompt": "<user prompt>"}' \
  --output-dir <absolute/path>
```

**Vertical short (9:16, 8s, no watermark):**

```bash
runcomfy run happyhorse/happyhorse-1-0/text-to-video \
  --input '{
    "prompt": "<user prompt>",
    "aspect_ratio": "9:16",
    "duration": 8,
    "watermark": false
  }' \
  --output-dir <absolute/path>
```

**Cheaper test pass (720p):**

```bash
runcomfy run happyhorse/happyhorse-1-0/text-to-video \
  --input '{"prompt": "<user prompt>", "resolution": "720P", "duration": 3}' \
  --output-dir <absolute/path>
```

The CLI submits, polls every 2s until terminal, then downloads any `*.runcomfy.net` / `*.runcomfy.com` URL from the result into `--output-dir`. Stdout is the result JSON. Stderr is progress.

## Prompting — what actually works

**Describe motion over time, not a still.** "A woman turns from the window, walks two paces to the desk, picks up the cup, lifts it to her face, takes a sip" beats "a woman drinking coffee".

**Camera + shot in plain English.** Front-load the shot: `"Wide shot. ..."` / `"Tracking shot. ..."` / `"Locked tripod, low angle. ..."` works as a real directive. Specify lens feel: `"35mm anamorphic"`, `"shallow DOF"`, `"crushed shadows"`.

**One visual beat per clip when iterating.** Don't pile up "she walks AND the dog runs AND a car passes". Pick the beat, get it sharp, then layer with multi-shot prompts.

**Multi-shot consistency** — when describing two beats, restate the anchor at each: `"Shot 1: tall woman in red wool coat, blue scarf, in a rainy alley. Shot 2: same woman in red coat / blue scarf, now ducking under an awning."` HappyHorse holds the look but needs the anchor.

**Audio direction** — say what you want to hear: `"distant temple bells, footsteps on wet pavement, no dialogue"` or `"warm friendly tone, English"`.

**Anti-patterns:**

- Static-frame descriptions (no temporal verbs) → motion will be vague.
- Conflicting style directions → cancels.
- > 2500 char prompts → degrades.
- Aspect ratios outside the 5 supported → 422.

## Where it shines

| Use case                                                        | Why HappyHorse 1.0                         |
| --------------------------------------------------------------- | ------------------------------------------ |
| **Multi-shot brand stories with one consistent character**      | Native cross-shot identity preservation    |
| **Talking-head explainers needing in-clip voiceover + ambient** | Synchronized audio in the same pass        |
| **Multilingual short-form ads**                                 | 6 prompt languages, no script-quality drop |
| **Cinematic 1080p delivery**                                    | Native 1080p output, broadcast-ready       |
| **Blind-vote leader for general video quality**                 | #1 on Artificial Analysis Video Arena      |

## Sample prompts (verified to produce strong results)

**From the model page (cinematic scope):**

```
Wide shot. A lone astronaut in dusty orange suit with blue-gray harness
skis across lunar plain, leaving parallel tracks in gray regolith.
Mid-stride, poles planted, pushing in 1/6th gravity with subtle upward
drift. Fine dust haze along ski tracks. Crescent Earth above lunar
horizon, blue-white glow against black sky. Raw sunlight, crushed
shadows, no fill. 8K photorealistic.
```

**Multi-shot consistency:**

```
Shot 1: Medium close-up. A woman in a navy trench coat enters a
rain-slick neon-lit Tokyo alley, looks left, holds up an umbrella.
Shot 2: Same woman in same navy trench, now under the awning of a
ramen shop, shaking water off the umbrella. Warm interior glow, soft
chatter, gentle rain on metal roof in the audio.
```

**Vertical platform-native:**

```
9:16 vertical short. A barista in a black apron pulls a single
espresso shot, steam rising into the morning sun, rich crema slowly
forming. Close-up handheld, shallow DOF, warm cafe ambience and the
hiss of the steam wand.
```

## Limitations

- **Duration cap 15s** — for longer narratives, segment into multi-shot prompts and stitch.
- **Aspect ratios** — only the 5 documented values; ultra-wide cinematic gets cropped or rejected.
- **Audio is in-pass only** — you can't pass external audio to drive lip-sync. For audio-driven lip-sync, use Wan 2.7 (which accepts an `audio_url`) or Seedance 2.0 Pro.
- **No free image-to-video on this template** — i2v is supported by HappyHorse via a separate pipeline; the t2v endpoint here is text-only.

## Exit codes

The `runcomfy` CLI uses sysexits-style codes:

| code | meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | success                                                          |
| 64   | bad CLI args                                                     |
| 65   | bad input JSON / schema mismatch (e.g. `duration: 30` would 422) |
| 69   | upstream 5xx                                                     |
| 75   | retryable: timeout / 429                                         |
| 77   | not signed in or token rejected                                  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=happyhorse-1-0).

## How it works

1. The skill invokes `runcomfy run happyhorse/happyhorse-1-0/text-to-video` with a JSON body matching the schema.
2. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/happyhorse/happyhorse-1-0/text-to-video` with the user's bearer token.
3. The Model API returns a `request_id`; the CLI polls `GET .../requests/<id>/status` every 2 seconds.
4. On terminal status, the CLI fetches `GET .../requests/<id>/result` and downloads any URL whose host ends with `.runcomfy.net` or `.runcomfy.com` into `--output-dir`. Other URLs are listed but not fetched.
5. `Ctrl-C` while polling sends `POST .../requests/<id>/cancel` so you don't get billed for GPU you stopped.

## What this skill is not

Not a self-hosted video runner. Not a capability grant — depends on a working RunComfy account.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
