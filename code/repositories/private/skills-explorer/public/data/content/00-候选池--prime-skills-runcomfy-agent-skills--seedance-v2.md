---
name: seedance-v2
displayName: "Seedance 2.0 Pro — Pro Pack on RunComfy"
description: >
  Generate cinematic short-form video with ByteDance Seedance 2.0 Pro
  on RunComfy. Documents Seedance 2.0 Pro's strengths (multi-modal references
  — up to 9 images, 3 videos, 3 audio — synchronized in-pass audio with
  natural lip-sync, cinematic motion refinement), the 4–15s duration
  schema, and when to route to HappyHorse 1.0 / Wan 2.7 / Kling instead.
  Calls `runcomfy run bytedance/seedance-v2/pro` through the local
  RunComfy CLI. Triggers on "seedance", "seedance 2", "seedance v2",
  "seedance pro", "bytedance video", or any explicit ask to generate
  video with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Seedance 2.0 Pro — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=seedance-v2) · [Seedance 2.0 Pro](https://www.runcomfy.com/models/bytedance/seedance-v2/pro?utm_source=skills.sh&utm_medium=skill&utm_campaign=seedance-v2) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/seedance-v2)

ByteDance **Seedance 2.0 Pro** — multimodal cinematic video generator with native lip-synced audio — hosted on the **RunComfy Model API**.

```bash
npx skills add agentspace-so/runcomfy-skills --skill seedance-v2 -g
```

## When to pick this model (vs siblings)

Seedance 2.0 Pro's distinct strength is **multi-modal cinematic short-form**: combine character images + scene videos + reference audio into one coherent shot. Pick it when **fidelity to a reference identity / scene matters and you want native lip-sync**.

| You want                                       | Use                   |
| ---------------------------------------------- | --------------------- |
| Lip-synced spokesperson / dialogue ad          | **Seedance 2.0 Pro**  |
| Multi-modal references (image + video + audio) | **Seedance 2.0 Pro**  |
| Brand-consistent multi-language narrative      | **Seedance 2.0 Pro**  |
| Currently-#1 blind-vote video quality          | HappyHorse 1.0        |
| Audio-driven lip-sync from your own track      | Wan 2.7 (`audio_url`) |
| Motion editing on existing footage             | Kling Video O1        |
| Ultra-fast iteration                           | LTX 2                 |

If the user said "Seedance" / "Seedance 2" / "ByteDance video" explicitly, route here regardless.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `bytedance/seedance-v2/pro`

| Field            | Type   | Required | Default    | Notes                                                    |
| ---------------- | ------ | -------- | ---------- | -------------------------------------------------------- |
| `prompt`         | string | yes      | —          | CN ≤ 500 chars OR EN ≤ 1000 words.                       |
| `image_url`      | array  | no       | `[]`       | 0–9 references (JPEG/PNG/WebP/BMP/TIFF/GIF).             |
| `video_url`      | array  | no       | `[]`       | 0–3 clips (MP4/MOV), 2–15s each.                         |
| `audio_url`      | array  | no       | `[]`       | 0–3 audio refs (WAV/MP3), 2–15s, < 15MB each.            |
| `aspect_ratio`   | enum   | no       | `adaptive` | `adaptive`, `16:9`, `9:16`, `4:3`, `3:4`, `1:1`, `21:9`. |
| `duration`       | int    | no       | 5          | 4–15 (whole seconds).                                    |
| `resolution`     | enum   | no       | `720p`     | `480p` or `720p`.                                        |
| `generate_audio` | bool   | no       | true       | In-pass synchronized speech / SFX / music.               |
| `seed`           | int    | no       | —          | Reproducibility.                                         |

## How to invoke

**Default (text only, 5s, 720p with audio):**

```bash
runcomfy run bytedance/seedance-v2/pro \
  --input '{"prompt": "<user prompt>"}' \
  --output-dir <absolute/path>
```

**Lip-synced ad with character reference (image-stable, text-evolves):**

```bash
runcomfy run bytedance/seedance-v2/pro \
  --input '{
    "prompt": "Medium close-up. The woman explains today'\''s special in a warm friendly tone, slow push-in, soft window light, gentle cafe ambience.",
    "image_url": ["https://.../barista-headshot.jpg"],
    "duration": 8,
    "aspect_ratio": "9:16"
  }' \
  --output-dir <absolute/path>
```

**Multi-modal (image + video + audio refs):**

```bash
runcomfy run bytedance/seedance-v2/pro \
  --input '{
    "prompt": "Subject from image 1 walks through the café from video 1, voice tone matches audio 1.",
    "image_url": ["https://.../subject.jpg"],
    "video_url": ["https://.../cafe-locked-shot.mp4"],
    "audio_url": ["https://.../voice-ref.mp3"]
  }' \
  --output-dir <absolute/path>
```

The CLI submits, polls, fetches the result, downloads `*.runcomfy.net`/`*.runcomfy.com` URLs into `--output-dir`.

## Prompting — what actually works

**Image vs text division.** This is the single most important rule. Stable identity (face, costume, brand mark, logo) → put in `image_url`. Evolving narrative (action, mood, lighting, camera) → put in `prompt`. Trying to verbally describe a face in detail wastes tokens and produces drift.

**Camera + motion in plain language.** "Medium close-up", "slow push-in", "handheld follow", "locked-off wide" all work as directives. Combine: `"Medium close-up. Slow push-in over 3 seconds. Handheld, slight breathing motion."`

**Audio direction with `generate_audio: true`** — say the tone: `"warm friendly conversational"`, `"calm instructional"`, `"crisp newsroom delivery"`. For ambient: `"gentle cafe chatter, distant traffic, no foreground music"`.

**Reference media specs** — videos must be 2–15s; audio must be ≤15MB and 2–15s. Out-of-range files reject. Match aspect ratio of refs to your output to avoid crops.

**Anti-patterns:**

- Mixing radically different aesthetic refs (watercolor + photoreal) → confuses.
- Conflicting style cues in prompt → simplify by removing contradictions.
- Trying to describe stable identity verbally → use `image_url` instead.
- Asking for >15s clips → 422; segment into multiple calls.

## Where it shines

| Use case                                        | Why Seedance 2.0 Pro                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| **Spokesperson / dialogue ads**                 | Native in-pass lip-sync, no separate TTS step          |
| **Brand-consistent multi-language narratives**  | Image refs hold identity; text drives translation      |
| **Cinematic short-form film previs**            | Camera-shot grammar + multi-modal refs                 |
| **Ad creatives with reference music / VO tone** | Audio refs guide voice / mood without locking lip-sync |
| **Reproducible variant testing**                | Seed control + fixed schema                            |

## Sample prompts (verified to produce strong results)

**Default playground example:**

```
Golden hour on a quiet cafe terrace: a barista wipes the counter, then
looks up and explains today's special in a friendly tone, natural
lip-sync. Medium close-up, slow push-in; warm side light, soft bokeh
through glass, gentle cafe ambience and subtle film grain.
```

**Multi-modal lip-sync (text + image):**

```
Same person as image 1 in a softly-lit recording booth, leaning into
the mic, says: "We just shipped the biggest update of the year."
Calm conversational tone. Medium close-up, locked tripod, shallow DOF,
warm key light from camera-left.
```

## Limitations

- **Duration 4–15s** — no longer clips on this endpoint.
- **Resolution ceiling 720p** on the playground variant.
- **Reference media specs** — videos / audio must be 2–15s; audio < 15MB.
- **Lip-sync quality** — depends on prompt clarity; not guaranteed perfect under all conditions.
- **No `@`-syntax for character binding** — relies on image refs + prompt alignment.

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=seedance-v2).

## How it works

The skill invokes `runcomfy run bytedance/seedance-v2/pro` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/bytedance/seedance-v2/pro`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
