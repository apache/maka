---
name: wan-2-7
displayName: "Wan 2.7 — Pro Pack on RunComfy"
description: >
  Generate text-to-video with Wan 2.7 (Wan-AI's flagship motion model)
  on RunComfy. Documents Wan 2.7's strengths (multi-reference conditioning,
  audio-driven lip-sync via `audio_url`, smoother transitions, prompt
  expansion), the duration / resolution / aspect-ratio schema, and
  when to route to HappyHorse 1.0 / Seedance 2.0 / Kling / LTX 2
  instead. Calls `runcomfy run wan-ai/wan-2-7/text-to-video` through
  the local RunComfy CLI. Triggers on "wan", "wan 2.7", "wan-2-7",
  "wan video", or any explicit ask to generate video with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# Wan 2.7 — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=wan-2-7) · [Text-to-video](https://www.runcomfy.com/models/wan-ai/wan-2-7/text-to-video?utm_source=skills.sh&utm_medium=skill&utm_campaign=wan-2-7) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/wan-2-7)

Wan-AI's **Wan 2.7** — flagship video model with multi-reference conditioning and audio-driven lip-sync — hosted on the **RunComfy Model API**.

```bash
npx skills add agentspace-so/runcomfy-skills --skill wan-2-7 -g
```

## When to pick this model (vs siblings)

| You want                                                                     | Use                       |
| ---------------------------------------------------------------------------- | ------------------------- |
| Lip-sync video to an audio track you supply                                  | **Wan 2.7** (`audio_url`) |
| Multi-reference fine motion control                                          | **Wan 2.7**               |
| Smooth transitions, accurate motion physics                                  | **Wan 2.7**               |
| Currently-#1 blind-vote video model                                          | HappyHorse 1.0            |
| Multi-modal cinematic with image+video+audio refs + in-pass voice generation | Seedance 2.0 Pro          |
| Cinematic motion editing on existing footage                                 | Kling Video O1            |
| Ultra-fast iteration                                                         | LTX 2                     |

If the user said "Wan" / "Wan 2.7" / "wan-ai" / "alibaba video" explicitly, route here regardless.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `wan-ai/wan-2-7/text-to-video`

| Field                     | Type   | Required | Default | Notes                                                                               |
| ------------------------- | ------ | -------- | ------- | ----------------------------------------------------------------------------------- |
| `prompt`                  | string | yes      | —       | Up to ~5000 chars / ~1500 tokens.                                                   |
| `audio_url`               | string | no       | —       | WAV/MP3, 3–30s, ≤15MB. **Drives lip-sync.** Omit → background music auto-generated. |
| `aspect_ratio`            | enum   | no       | `16:9`  | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`.                                                |
| `resolution`              | enum   | no       | `1080p` | `720p` or `1080p`.                                                                  |
| `duration`                | enum   | no       | `5`     | 2–15 (whole seconds).                                                               |
| `negative_prompt`         | string | no       | —       | Up to 500 chars. Concrete issues to avoid.                                          |
| `enable_prompt_expansion` | bool   | no       | true    | Auto-rewrites short prompts. Disable for literal control.                           |
| `seed`                    | int    | no       | —       | 0..2^31-1. Reuse for variants.                                                      |

## How to invoke

**Default (5s 1080p 16:9, prompt-expanded):**

```bash
runcomfy run wan-ai/wan-2-7/text-to-video \
  --input '{"prompt": "<user prompt>"}' \
  --output-dir <absolute/path>
```

**Audio-driven lip-sync (your own track):**

```bash
runcomfy run wan-ai/wan-2-7/text-to-video \
  --input '{
    "prompt": "Medium close-up of the spokesperson, warm key light, locked tripod, slight breathing motion.",
    "audio_url": "https://.../voiceover.mp3",
    "duration": 12,
    "aspect_ratio": "9:16"
  }' \
  --output-dir <absolute/path>
```

**Literal control (no auto-expansion):**

```bash
runcomfy run wan-ai/wan-2-7/text-to-video \
  --input '{
    "prompt": "<exactly what you want, verbatim>",
    "enable_prompt_expansion": false,
    "negative_prompt": "no subtitles, no flicker, no distorted hands"
  }' \
  --output-dir <absolute/path>
```

## Prompting — what actually works

**Camera + motion in plain English.** "Slow dolly in", "locked tripod, low angle", "handheld follow", "crane move from above". Front-load the shot.

**One primary action per clip.** Don't pile up multiple competing actions. Pick the beat: "she turns, then smiles" not "she turns AND smiles AND a bus passes AND...".

**Use `negative_prompt` for concrete issues.** Good: "no subtitles, no watermark, no flicker". Bad (vague): "no bad lighting".

**Prompt expansion is on by default.** Short prompts get auto-rewritten by the model. For terse / literal prompts (e.g. brand-strict ad copy), disable with `enable_prompt_expansion: false`.

**Audio specs matter.** `audio_url` must be 3–30s, ≤15MB, WAV/MP3. Out-of-range files reject. Match audio length to clip duration.

**Iterate seeds.** Reuse the same seed when you want consistent output across variants of the same prompt. Change seed for genuine variety.

**Anti-patterns:**

- Static-frame descriptions → motion will be vague.
- Vague negatives ("no bad colors") → ignored.
- Audio outside the 3–30s / 15MB / WAV-MP3 spec → rejected.
- Prompts > 5000 chars / 1500 tokens → degraded output.

## Where it shines

| Use case                                 | Why Wan 2.7                                     |
| ---------------------------------------- | ----------------------------------------------- |
| **Lip-synced ads with custom voiceover** | `audio_url` accepts your track                  |
| **Multi-language dub variants**          | Same prompt, different `audio_url` per language |
| **Multi-reference motion control**       | Up to 5 reference media (image / video / voice) |
| **Smooth transitions + motion physics**  | Strong physics-aware motion priors              |
| **Negative-prompted clean output**       | Targeted issue exclusion                        |

## Sample prompts (verified to produce strong results)

**Page example (product showcase):**

```
Cinematic medium shot of a product on a marble surface, soft studio
lighting, slow subtle camera push-in, shallow depth of field, premium
commercial look, crisp 1080p detail
```

**Lip-synced spokesperson (with `audio_url`):**

```
Medium close-up of a confident spokesperson in a softly-lit recording
booth, leaning slightly toward the camera, locked tripod, shallow depth
of field, warm key light from camera-left.
```

**Vertical platform-native:**

```
9:16 vertical short. A barista pulls a single espresso shot, steam
rising into morning sun, rich crema slowly forming. Close-up handheld,
shallow DOF, warm cafe ambience.
```

## Limitations

- **Duration cap 15s.** For longer narratives, stitch multiple calls.
- **No native 4K** — 1080p ceiling.
- **Aspect ratios** — only the 5 documented values.
- **Audio specs** — 3–30s, ≤15MB, WAV/MP3 only.
- **Reference media cap 5** (image + video + voice combined).
- **For in-pass voice generation (no separate audio track), use Seedance 2.0 Pro** — Wan accepts audio rather than generating it.

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=wan-2-7).

## How it works

The skill invokes `runcomfy run wan-ai/wan-2-7/text-to-video` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/wan-ai/wan-2-7/text-to-video`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
