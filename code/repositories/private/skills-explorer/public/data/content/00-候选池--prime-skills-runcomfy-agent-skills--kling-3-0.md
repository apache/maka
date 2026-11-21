---
name: kling-3-0
displayName: "Kling 3.0 - Pro Pack on RunComfy"
description: >
  Kling 3.0 video generation on RunComfy. Kling 3.0 (also called Kling
  V3.0) is Kuaishou Technology's third-generation multi-shot video
  model with native synchronized audio and consistent character
  identity across shots. This skill covers all six Kling 3.0
  endpoints, spanning three rendering tiers (Standard, Pro, 4K) and
  two modes (text-to-video, image-to-video). Calls runcomfy run
  kling/kling-3.0/<tier>/<mode> through the local RunComfy CLI.
  Triggers on "kling", "kling 3.0", "kling v3", "kling pro",
  "kling 4k", "kling text to video", "kling image to video", or any
  explicit ask to generate or animate with Kling 3.0.
homepage: https://www.runcomfy.com
license: MIT
---

# Kling 3.0 - Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=kling-3-0) · [docs](https://docs.runcomfy.com/cli/introduction) · [GitHub](https://github.com/agentspace-so/runcomfy-agent-skills/tree/main/kling-3-0)

[Kling 3.0](https://www.runcomfy.com/models/kling/kling-3.0) is Kuaishou Technology's third-generation cinematic video model. This skill covers all six Kling 3.0 rendering endpoints on RunComfy: three quality tiers (Standard, Pro, 4K) across two modes (text-to-video and image-to-video).

## What Kling 3.0 is

Kling 3.0 is the V3 generation of the Kling video model. It produces multi-shot cinematic video with synchronized native audio, consistent character identity across shots, and physics-aware motion. Compared to Kling 2.x, Kling 3.0 supports longer clips (up to 15 seconds), native 4K output on the 4K tier, and a unified multi-prompt segment system that lets one Kling 3.0 generation contain several distinct scenes with controlled transitions.

Kling 3.0 ships in three rendering tiers on RunComfy, each available as text-to-video or image-to-video:

- **Standard** - cheapest tier, up to 1080p output. Use Kling 3.0 Standard for fast iteration, previews, A/B variants, social shorts.
- **Pro** - highest fidelity at 1080p. Use Kling V3.0 Pro for hero-quality 1080p clips where motion realism and identity preservation matter most.
- **4K** - native 3840x2160 output. Use Kling V3.0 4K for high-resolution brand films, big-screen cinematic sequences, and finished masters at native resolution.

All three tiers share the same Kling 3.0 multi-shot architecture. Tiers differ in resolution ceiling, motion-fidelity budget, and pricing.

## The 6 Kling 3.0 endpoints

Each endpoint corresponds to one (tier, mode) pair. All six endpoints share the same Kling 3.0 base model.

| Endpoint                                  | Anchor                                                                               | Resolution  | Rate (no audio) | Rate (with audio) |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ----------- | --------------- | ----------------- |
| `kling/kling-3.0/standard/text-to-video`  | [Kling 3.0](https://www.runcomfy.com/models/kling/kling-3.0) Standard t2v            | up to 1080p | $0.084/s        | $0.126/s          |
| `kling/kling-3.0/standard/image-to-video` | [Kling 3.0 Standard Image to Video](https://www.runcomfy.com/models/kling/kling-3.0) | up to 1080p | $0.084/s        | $0.126/s          |
| `kling/kling-3.0/pro/text-to-video`       | [Kling V3.0 Pro Text-to-Video](https://www.runcomfy.com/models/kling/kling-3.0)      | 1080p       | $0.112/s        | $0.168/s          |
| `kling/kling-3.0/pro/image-to-video`      | [Kling V3.0 Pro Image-to-Video](https://www.runcomfy.com/models/kling/kling-3.0)     | 1080p       | $0.112/s        | $0.168/s          |
| `kling/kling-3.0/4k/text-to-video`        | [Kling V3.0 4K Text-to-Video](https://www.runcomfy.com/models/kling/kling-3.0)       | 3840x2160   | $0.42/s flat    | $0.42/s flat      |
| `kling/kling-3.0/4k/image-to-video`       | [Kling V3.0 4K Image-to-Video](https://www.runcomfy.com/models/kling/kling-3.0)      | 3840x2160   | $0.42/s flat    | $0.42/s flat      |

The 4K tier prices the same regardless of audio. Standard and Pro tiers charge ~50% more per second when audio is enabled.

## When to pick which Kling 3.0 tier

Pick a Kling 3.0 tier based on the output's role in the pipeline.

- **Drafts, previews, social shorts, A/B variants**: Kling 3.0 Standard. Cheapest. Quality is fine for everything except hero shots.
- **Hero 1080p clips, ad creative, talking heads with high motion fidelity**: Kling V3.0 Pro. About 33% more expensive than Standard for noticeably tighter motion and identity hold at the same resolution.
- **4K brand films, big-screen cinematic, finished masters**: Kling V3.0 4K. Native 3840x2160 (no upscale step). Flat $0.42/s makes budgeting predictable. Use only when the output truly needs 4K - it is roughly 5x the cost of Standard.

Pick the mode based on whether you have a source image:

- **Text-to-Video (t2v)**: prompt only, Kling 3.0 generates the look from scratch. Use Kling 3.0 t2v for novel scenes, brand new compositions, environments without an existing reference.
- **Image-to-Video (i2v)**: prompt + source image, Kling 3.0 animates the image. Use Kling 3.0 i2v when you have an exact reference (face, product, scene) that must survive into the output.

If the user explicitly asked for Kling 3.0, Kling V3.0, Kling Pro, or Kling 4K, route to this skill regardless.

## Prerequisites

1. **RunComfy CLI**: `npm i -g @runcomfy/cli`
2. **RunComfy account**: `runcomfy login` opens a browser device-code flow.
3. **CI / containers**: set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.
4. **For i2v endpoints**: a publicly fetchable source image URL (HTTPS, JPEG/PNG/WebP).

## Input schema (shared across all 6 Kling 3.0 endpoints)

| Field             | Type   | Required       | Default | Notes                                                                                                                                                           |
| ----------------- | ------ | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | string | yes            | -       | Text description of scene, motion, camera, atmosphere. Multi-segment prompts supported via `prompt_segments` for scene transitions in one Kling 3.0 generation. |
| `image_url`       | string | yes (i2v only) | -       | Source image for Kling 3.0 i2v. HTTPS URL. JPEG/PNG/WebP.                                                                                                       |
| `tail_image_url`  | string | no (i2v only)  | -       | Optional ending image for controlled start-to-end frame transition on Kling 3.0 i2v.                                                                            |
| `negative_prompt` | string | no             | -       | Elements to exclude from the Kling 3.0 output.                                                                                                                  |
| `duration`        | int    | no             | 5       | 3-15 seconds per Kling 3.0 generation.                                                                                                                          |
| `aspect_ratio`    | enum   | no             | `16:9`  | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9`.                                                                                                                    |
| `cfg_scale`       | float  | no             | 0.5     | Prompt guidance strength. Higher = stricter adherence to prompt.                                                                                                |
| `generate_audio`  | bool   | no             | false   | Enable Kling 3.0 in-pass synchronized audio. Adds cost on Standard and Pro tiers; flat-rate on 4K.                                                              |
| `seed`            | int    | no             | -       | Reproducibility for Kling 3.0 variant testing.                                                                                                                  |

## How to invoke each Kling 3.0 endpoint

**Kling 3.0 Standard text-to-video (cheapest 1080p draft):**

```bash
runcomfy run kling/kling-3.0/standard/text-to-video \
  --input '{
    "prompt": "<Kling 3.0 prompt>",
    "duration": 5,
    "aspect_ratio": "16:9"
  }' \
  --output-dir <absolute/path>
```

**Kling 3.0 Standard image-to-video (animate a still):**

```bash
runcomfy run kling/kling-3.0/standard/image-to-video \
  --input '{
    "prompt": "<motion description for Kling 3.0 i2v>",
    "image_url": "https://.../source.jpg",
    "duration": 5
  }' \
  --output-dir <absolute/path>
```

**Kling V3.0 Pro text-to-video (highest 1080p fidelity):**

```bash
runcomfy run kling/kling-3.0/pro/text-to-video \
  --input '{
    "prompt": "<Kling 3.0 Pro prompt>",
    "duration": 8,
    "aspect_ratio": "16:9",
    "generate_audio": true
  }' \
  --output-dir <absolute/path>
```

**Kling V3.0 Pro image-to-video (hero animation from source image):**

```bash
runcomfy run kling/kling-3.0/pro/image-to-video \
  --input '{
    "prompt": "<motion description for Kling V3.0 Pro i2v>",
    "image_url": "https://.../subject.jpg",
    "duration": 8,
    "generate_audio": true
  }' \
  --output-dir <absolute/path>
```

**Kling V3.0 4K text-to-video (native 4K cinematic):**

```bash
runcomfy run kling/kling-3.0/4k/text-to-video \
  --input '{
    "prompt": "<Kling V3.0 4K prompt>",
    "duration": 10,
    "aspect_ratio": "16:9",
    "generate_audio": true
  }' \
  --output-dir <absolute/path>
```

**Kling V3.0 4K image-to-video (4K animation of a reference image):**

```bash
runcomfy run kling/kling-3.0/4k/image-to-video \
  --input '{
    "prompt": "<motion description for Kling V3.0 4K i2v>",
    "image_url": "https://.../source-4k.jpg",
    "duration": 10,
    "generate_audio": true
  }' \
  --output-dir <absolute/path>
```

The CLI submits the Kling 3.0 request, polls every 2s, fetches the result, and downloads any `*.runcomfy.net` / `*.runcomfy.com` URL into `--output-dir`.

## Prompting Kling 3.0 - what works

Kling 3.0 responds to specific prompting patterns better than naive prose.

**Lead with motion and camera language.** Kling 3.0 reads "wide shot, slow push-in", "tracking shot, low angle", "handheld follow" as real directives. Front-load these.

**Multi-shot in one Kling 3.0 generation.** A single Kling 3.0 prompt can describe a sequence of shots. Number them: "Shot 1: wide of the cafe at dusk. Shot 2: medium close-up of the barista. Shot 3: tight on the espresso pour." Kling 3.0 will preserve identity (face, wardrobe, props) across the shots.

**Identity anchors for i2v.** When using Kling 3.0 i2v, restate what should remain stable: "preserve the subject's face, pose, and clothing; only the camera moves and the background changes."

**`tail_image_url` for controlled endings.** On Kling 3.0 i2v, supply a tail image to lock the final frame. Kling 3.0 will interpolate motion from source to tail.

**`generate_audio: true` for one-pass dialogue.** Describe what Kling 3.0 should produce in audio: "warm friendly tone, English voiceover" or "city ambience, distant traffic, no dialogue." Audio adds cost on Standard / Pro; flat on 4K.

**`cfg_scale` tuning.** Default 0.5 works for most Kling 3.0 prompts. Raise to 0.7-0.9 for strict prompt adherence on stylized output. Lower to 0.3-0.4 for natural motion when the prompt is loose.

**Anti-patterns:**

- Conflicting style cues in one Kling 3.0 prompt -> simplify, pick one or two style anchors.
- Asking for greater than 15 seconds in one Kling 3.0 call -> 422 error; segment the script and stitch.
- Aspect ratios outside the supported set -> rejected.
- For Kling V3.0 4K, demanding aggressive multi-shot story plus 15s plus dialogue plus 6 cuts -> Kling 3.0 will deliver, but cost climbs to about $6.30 per generation. Validate with Standard first.

## Where Kling 3.0 shines

| Use case                                                 | Best Kling 3.0 endpoint                               |
| -------------------------------------------------------- | ----------------------------------------------------- |
| Cinematic 1080p brand stories with consistent characters | Kling V3.0 Pro (t2v or i2v)                           |
| Native 4K hero films and big-screen cinematic            | Kling V3.0 4K (t2v or i2v)                            |
| Cheap iteration, social-first shorts, A/B variants       | Kling 3.0 Standard t2v                                |
| Animating brand assets, product photos, character art    | Kling 3.0 Standard i2v or Kling V3.0 Pro i2v          |
| Multi-shot ads with synchronized dialogue in one pass    | Kling V3.0 Pro with `generate_audio: true`            |
| Premium 4K finished masters with native audio            | Kling V3.0 4K with `generate_audio: true` (flat rate) |

## Sample Kling 3.0 prompts

**Kling 3.0 cinematic multi-shot (Pro tier recommended):**

```
Cinematic multi-shot of a young American couple celebrating their
anniversary at a candlelit rooftop restaurant. Shot 1: wide of the
city skyline at golden hour. Shot 2: medium two-shot, the couple
toasting. Shot 3: tight on the woman's smile, soft bokeh, warm fill
light. Subtle ambient string music, gentle wind, distant traffic.
```

**Kling 3.0 i2v (animate a portrait, 4K tier):**

```
Gentle camera dolly-in on the subject from the source image. Subtle
breathing motion, identity-stable features, soft natural light,
shallow depth of field. Background: warm golden-hour glow with a
slow drift of dust motes. No dialogue, only ambient room tone.
```

**Kling 3.0 vertical short (Standard tier, 9:16):**

```
9:16 vertical. A barista in a black apron pulls a single espresso
shot, steam rising into morning sun, rich crema slowly forming.
Close-up handheld, shallow depth of field, warm cafe ambience and
the hiss of the steam wand.
```

## Kling 3.0 FAQ

**What is the maximum duration of a Kling 3.0 clip?** 15 seconds per generation across all three tiers. For longer narratives, segment the script into multiple Kling 3.0 calls and stitch.

**How is Kling V3.0 4K priced compared to Standard and Pro?** Kling V3.0 4K is a flat $0.42 per second whether or not audio is enabled. Standard is $0.084/s without audio (cheapest). Pro is $0.112/s without audio. The 4K tier costs roughly 5x Standard for the resolution upgrade.

**Does Kling 3.0 support multi-shot in a single generation?** Yes. All Kling 3.0 endpoints accept multi-segment prompts. Number the shots ("Shot 1:", "Shot 2:", etc.) and Kling 3.0 will preserve character identity across them.

**Can Kling 3.0 generate audio?** Yes. Set `generate_audio: true`. Kling 3.0 produces synchronized dialogue, ambient sound, and music in the same generation pass. On 4K the price stays flat at $0.42/s; on Standard / Pro the rate jumps about 50% with audio.

**What aspect ratios does Kling 3.0 support?** 16:9, 9:16, 1:1, 4:3, 3:4, 21:9. The 4K tier renders 21:9 as wide cinema crops at native 3840x2160.

**Does Kling 3.0 i2v support a tail image?** Yes. `tail_image_url` locks the final frame; Kling 3.0 interpolates motion from source to tail.

**How is Kling 3.0 different from Kling 2.x?** Kling 3.0 has stronger multi-shot identity preservation, longer max duration (15s vs 10s on the 2.x flagship), native 4K on the 4K tier, and unified multi-prompt segment input across all tiers.

## Limitations

- **Per-call duration cap 15 seconds** on every Kling 3.0 tier.
- **Maximum 6 continuous shots** in one Kling 3.0 4K generation.
- **i2v requires a publicly fetchable HTTPS image URL.** Local files are not supported.
- **Aspect ratios are fixed** to the documented six. Other ratios get cropped or rejected.
- **4K output files are large.** Plan disk and bandwidth before batch Kling V3.0 4K runs.

## Exit codes

The `runcomfy` CLI uses sysexits-style codes:

| code | meaning                                        |
| ---- | ---------------------------------------------- |
| 0    | Kling 3.0 generation succeeded                 |
| 64   | bad CLI args                                   |
| 65   | bad input JSON for Kling 3.0 / schema mismatch |
| 69   | upstream 5xx                                   |
| 75   | retryable: timeout / 429                       |
| 77   | not signed in or token rejected                |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting).

## How it works

1. The skill picks one of six Kling 3.0 endpoints based on the user's tier (Standard / Pro / 4K) and mode (t2v / i2v) intent.
2. It invokes `runcomfy run kling/kling-3.0/<tier>/<mode>` with a JSON body matching the schema.
3. The CLI POSTs to the RunComfy Model API with the user's bearer token.
4. The Model API returns a `request_id`; the CLI polls every 2 seconds until the Kling 3.0 generation finishes.
5. On terminal status, the CLI fetches the Kling 3.0 result and downloads any `.runcomfy.net` / `.runcomfy.com` URL into `--output-dir`.
6. `Ctrl-C` cancels the in-flight Kling 3.0 request before billing.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600. Set `RUNCOMFY_TOKEN` env var in CI / containers.
- **Input boundary**: the Kling 3.0 prompt is passed as JSON via `--input`. The CLI does not shell-expand. No shell-injection surface.
- **Third-party content**: image URLs you pass are fetched by the RunComfy server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any video model that accepts image inputs.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist).
- **Generated-file size cap**: the CLI aborts any single download greater than 2 GiB to prevent disk-fill from a runaway Kling 3.0 4K output.
