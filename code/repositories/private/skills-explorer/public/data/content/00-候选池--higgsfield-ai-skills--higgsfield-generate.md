---
version: 0.13.0
name: higgsfield-generate
description: |
  Generate images/videos/3D assets/audio via Higgsfield AI. Defaults:
  GPT Image 2.5 for image/design/text, Seedance 2.5 for
  video, Nano Banana 2 for cartoon characters, Marketing
  Studio for ads, Seed Audio 1.0 for audio.
  Use when: "generate an image", "make a video", "animate
  this photo", "image-to-video", "edit/stylize/remix this
  image", "reframe this video", "edit this video from a
  sketch", "create a 3D model/GLB", "create a sound effect",
  "make music", "text-to-audio", "create an ad", "make a UGC
  video", "unboxing", "presenter video", "import product from
  URL", or "analyze video virality". Supports generic generation,
  workflows, Marketing Studio, and Virality Predictor.
  Chain with higgsfield-soul-id for face/identity consistency.
  NOT for: Soul training, brand systems/brandbooks (use
  higgsfield-brandkit), photoshoots, cards, YouTube thumbnails
  (use higgsfield-youtube-thumbnail), explainers (use
  higgsfield-video-explainer), playable games/assets (use
  higgsfield-websites), or TTS.
argument-hint: "[prompt-or-analysis-request] [--model <name>] [--image|--video <path-or-id>]"
allowed-tools: Bash
---

# Higgsfield Generate

Submit jobs to any Higgsfield model. Wraps the `higgsfield` CLI. Covers generic image/video/3D/audio generation, Marketing Studio (branded ads, avatars, products, hooks, settings), and, secondarily, Virality Predictor video scoring.

## Step 0 — Bootstrap

Before any other command:

1. If `higgsfield` is not on `$PATH`, install it:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh
   ```
2. If `higgsfield account status` fails with `Session expired` / `Not authenticated`, ask the user to run `higgsfield auth login` (interactive) and wait for confirmation.

## UX Rules

1. Be concise. No raw IDs, no JSON dumps in chat. Print the media URL for generated assets, or the text summary for Virality Predictor.
2. No internal jargon. Don't narrate "calling higgsfield cost", "polling job".
3. Detect the user's language from the first message and reply in it. Technical args (`--aspect_ratio 16:9`) stay English.
4. Don't batch-ask. Pick a sane default model and ask one thing at a time only if genuinely missing.
5. Don't pre-estimate cost or optimize for cheaper models unless the user asks. Prefer the quality default first.
6. Pass `--wait` to `generate create` so the command blocks until done and prints the result URL itself. Avoid the two-step `create` → `wait` pattern.

## Discovery guardrail

When looking for a Higgsfield feature/model, do not rely only on semantic search or CLI `--help`. First run an unfiltered model list, then inspect likely `job_set_type` names. If the user says a model exists but search returns no results, trust that signal and verify with the full model list before answering.

Workflows are separate from models. Discover them with `higgsfield workflow list` and inspect params with `higgsfield workflow get <workflow_name>`.

Virality Predictor is exposed as:

- Customer-facing name: Virality Predictor
- Technical `job_set_type`: `brain_activity`
- Category/output: text report. This is video-in/text-out analysis, not a text/chat generation model.
- Input: uploaded video
- Purpose: finished-video hook, attention, retention, and virality analysis

If the user says "analyze this video", "score this ad", "evaluate the hook", or similar, route to `brain_activity` even though it appears under text/analysis models. Classify by task intent and required input, not by output category alone.

## Workflow — generic generation

1. **Pick a model.** Start with the core defaults:

   - **GPT Image 2.5** → default image model for high-fidelity general generation, graphic design, UI, banners, typography, and on-image text.
   - **Seedance 2.5** (`seedance_2_5`) → SOTA default video model for serious motion, cinematic clips, multi-shot work, and image-to-video. Supports 4–30s output up to 1080p; use Seedance 2.0 when native 4K is required.
   - **Nano Banana 2** (`nano_banana_flash`) → cartoon and illustrated characters.
   - **Marketing Studio** → default for ads, UGC, product demos, unboxing, TV spots, presenter videos, and brand/product workflows.
   - **Seed Audio 1.0** → default audio model for text-to-audio, voice, sound effects, ambience, foley, and music-like audio unless the user names Sonilo/Mirelo.

   Only the models below are picked without being asked. Any other model is used only when the user names it or explicitly asks for what it offers (cheaper, faster, a specific look); see `references/model-catalog.md`. A model the user names stays in use for follow-ups on the same work.

   **Image:**
   - Complete brand identity, logo system, palette, typography, brandbook, packaging system, signage, or coordinated branded asset suite → use `higgsfield-brandkit` instead.
   - YouTube thumbnail, Shorts cover, or Instagram video cover → use `higgsfield-youtube-thumbnail` instead.
   - Brand product visual (Pinterest pin, lifestyle, hero banner, ad pack, virtual try-on) → use `higgsfield-product-photoshoot` instead. NOT this skill.
   - Branded ad image with avatar + product (Marketing Studio shape) → Marketing Studio Image (see Marketing Studio below)
   - Soul Character (reference id from `higgsfield-soul-id`) → Soul 2.0 for stills, Soul Cinema (`soul_cinematic`) for cinematic
   - New original person — UGC, editorial, fashion, lifestyle → Soul 2.0
   - Cinematic still frame → Soul Cinema (`soul_cinematic`)
   - Character sheet, one-shot face from reference photos, or face edit on a real photo → Seedream 5.0 Pro (`seedream_v5_pro`)
   - Locations / environments / no-people scenes → Soul Location
   - Logo, icon, vector-like illustration, brand mark, controlled-palette graphic → Recraft V4.1 (`recraft_v4_1`, often with `--model_type vector`)
   - Cartoon or illustrated characters, heavily textured photos → Nano Banana 2 (`nano_banana_flash`). The id `nano_banana_2` is an alias for Nano Banana Pro, not Nano Banana 2
   - **Default for everything else → GPT Image 2.5.** Graphic design, UI, banners, typography, product concepts, editing, and high-fidelity general generation.
   - User asks for cheaper or faster → Nano Banana 2 Lite (`nano_banana_2_lite`) for reference edits, Z Image for drafts.

   **Video:**
   - Complete narrated explainer from a topic, story, or document → use `higgsfield-video-explainer`, not generic video generation.
   - All advertising / commercial / branded ad video → Marketing Studio (see Marketing Studio below)
   - Edit existing video from sketch/timestamp, or reframe to another aspect ratio → workflow (`draw_to_video` or `reframe`), not a model. See `references/workflows.md`.
   - **Default for everything else → Seedance 2.5** (`seedance_2_5`): multi-shot, consistent identity, motion-heavy, image-to-video, editing, extension, 4–30s. Modes `t2v` / `omni_reference` / `video_edit` / `video_extension`; use `omni_reference` for reference inputs, including start/end frames; `t2v` accepts no media. Up to 1080p. Do not downgrade because another model's schema looks simpler.
   - User asks for 4K → Seedance 2.0 (`seedance_2_0`); say why you switched.
   - User asks for cheaper or faster → Kling 3.0 Turbo (`kling3_0_turbo`), Veo 3.1 Lite, or Seedance 1.5 Pro.
   - Named by the user → use it, e.g. Cinema Studio 4.0 (`cinematic_studio_video_4_0`), Kling 3.0, Veo 3.1, Gemini Omni Flash (`gemini_omni`), or Grok Video 1.5 (`grok_video_v15`: one `--start-image` or `--image`, duration 2–15s, up to `1080p` without reference media).

   **Video analysis:**
   - Rate a finished video's hook, virality potential, attention, retention, or distraction risk → Virality Predictor (`brain_activity`). This is a video analysis model that returns a text score/report, not a generated media asset.

   **3D:**
   - A 3D asset within a playable game or game-wide asset system → use `higgsfield-websites` (game product type).
   - Create an actual 3D mesh/model/GLB from one or more object/product reference images → Multi-Image to 3D (`multi_image_to_3d`). Pass 1–4 images with repeated `--image`; use `--should_texture true` when the asset needs texture. If the user only asks for a 3D-rendered picture, use an image model instead.

   **Audio:**
   - **Default for audio generation → Seed Audio 1.0 (`seed_audio`).** Use for text-to-audio, sound effects, ambience, foley, impacts, environmental audio, voice-style generations, and music-like audio. It requires `--prompt`; use optional `--audio-references`/`--image-references` only when the user provides references.
   - Use Sonilo Music (`sonilo_music`) only when the user explicitly asks for Sonilo or you need that specialist music model. It requires `--prompt` and `--duration`, and returns audio.
   - Use Mirelo Text to Audio (`mirelo_text_to_audio`) only when the user explicitly asks for Mirelo or you need that legacy SFX model. It requires `--prompt` and `--duration`, and returns audio.

   For the actual `--model` ID to pass to `higgsfield generate create`, run `higgsfield model list --json | jq` to map display names to IDs. See `references/model-catalog.md` for the full table.

2. **Pass media inputs straight to flags.** Media flags accept a local file path **or** a UUID. CLI auto-uploads paths and auto-detects job vs upload for UUIDs. No need to pre-upload. Each model declares accepted media roles or `*_references` params — see `references/media-inputs.md`.
3. **Validate quickly.** If unsure of params, run `higgsfield model get <jst> --json` once and pass only what's needed. Validate the preferred model before falling back to an older one. Use schema defaults otherwise. The server returns `adjustments` for non-fatal coercions (e.g. `aspect_ratio=99:99` → closest match) and a structured error for invalid declared-param values.
4. **Submit and wait in one shot.** `higgsfield generate create <jst> [--prompt "..."] [media flags] [param flags] --wait`. Blocks until terminal status and prints the result on stdout. Tunables: `--wait-timeout 20m` (default 10m), `--wait-interval 5s` (default 3s). Virality Predictor does not need a prompt; pass `--video`.
5. **Deliver.** For generated media and 3D assets, send the primary result URL plus a one-line summary (model, duration if video; GLB/asset URL for 3D). For Virality Predictor, deliver the scores, business interpretation, and the Open report link. Do not surface Virality Predictor `.glb`, `.bin`, or region-table internals in normal chat output.

To inspect or rerun later, `higgsfield generate list --json` and `higgsfield generate get <id> --json` work for retrospection. `higgsfield generate wait <id>` is still available if you ever need to rejoin a job started without `--wait`.

For workflow jobs, use `higgsfield generate workflow <workflow_name> ... --wait`. Cost syntax is `higgsfield generate cost workflow <workflow_name> ...`. See `references/workflows.md`.

## Media flags

| Flag                         | Purpose                                     | Models that accept it                                                                                                          |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--image <path-or-id>`       | reference image                             | most image models, `grok_video_v15`, `multi_image_to_3d`, `seedance_2_0`, `seedance_2_5`, `veo3`, `marketing_studio_video`     |
| `--start-image <path-or-id>` | first frame for image-to-video transitions  | `grok_video_v15`, `kling3_0`, `kling3_0_turbo`, `kling2_6`, `veo3_1`, `seedance_2_0`, `seedance_2_5`, `marketing_studio_video` |
| `--end-image <path-or-id>`   | last frame for transitions                  | `kling3_0`, `seedance_2_0`, `seedance_2_5`, `marketing_studio_video`                                                           |
| `--video <path-or-id>`       | reference or analyzed video                 | `seedance_2_0`, `seedance_2_5`, `brain_activity`                                                                               |
| `--audio <path-or-id>`       | reference audio (lipsync, soundtrack match) | `seedance_2_0`, `seedance_2_5` (reference input; distinct from generating output audio)                                        |

For reference-array models, the explicit flags are `--image-references`, `--video-references`, and `--audio-references`; `--image`, `--video`, and `--audio` are short aliases when the schema exposes those params.

Each flag accepts either a local file path (auto-uploaded) or a UUID (upload id from `higgsfield upload create`, or a previous job id). Each model declares its own media roles or `*_references` params. See `references/media-inputs.md` for the full table.

## Common params

Flags pass through to model schema. Use `higgsfield model get <jst>` to discover.

```bash
higgsfield generate create gpt_image_2_5 --prompt "neon city at dusk" --aspect_ratio 16:9 --resolution 2k --wait
higgsfield generate create nano_banana_flash --prompt "anime character concept, expressive pose" --image ./ref.png --wait
higgsfield generate create seedance_2_5 --prompt "camera dollies in" --mode omni_reference --start-image ./first.png --duration 12 --resolution 1080p --wait
higgsfield generate create grok_video_v15 --prompt "cinematic handheld shot, neon rainy street" --start-image ./image.png --duration 5 --resolution 720p --wait
higgsfield generate create text2image_soul_v2 --prompt "..." --soul-id <soul_ref_id> --quality 2k --wait
higgsfield generate create multi_image_to_3d --image ./front.png --image ./side.png --should_texture true --wait
higgsfield generate create seed_audio --prompt "cinematic rain ambience with distant thunder" --wait
higgsfield generate create sonilo_music --prompt "cinematic synthwave track" --duration 12 --wait
higgsfield generate create mirelo_text_to_audio --prompt "glass breaking in a large hall" --duration 4 --wait
higgsfield generate create brain_activity --video ./ad.mp4 --wait
```

For machine-readable output (chained pipelines, agent context), add `--json`. With `--wait --json` you get the final job object array. Without `--wait`, you get the job IDs. Virality Predictor stores raw analysis and render artifacts in the job params, but the default text output should stay to scores plus Open report.

Stdin prompt: `echo "..." | higgsfield generate create z_image --wait`.

Soul image quality: for `text2image_soul_v2` and `soul_cinematic`, pass `--quality 1.5k` or `--quality 2k`. These are UI-facing tiers; the backend maps them to `720p`/`1080p` and model-specific dimensions from the selected `--aspect_ratio`. `soul_location` has no quality selector; it uses fixed dimensions per aspect ratio.

Soul style presets: `text2image_soul_v2` accepts `--style_id <uuid>`; list curated styles with `higgsfield preset list soul-v2` and pass the chosen id. `--style_id` combines with `--soul-id` but not with an image reference. `soul_cinema_studio` also accepts `--style_id`.

## Marketing Studio

Branded image/video gen: avatars + products + optional setup hooks/settings + ad-style modes. Use models `marketing_studio_video` and `marketing_studio_image`.

### Concepts

- **Avatar** — presenter face. Curated `preset` (browse `higgsfield marketing-studio avatars list`) or `custom` (uploaded photos via `higgsfield marketing-studio avatars create`). For UGC modes, an avatar is optional if the brief clearly mentions a person; the backend can create a Soul Character automatically. Pass an avatar when the user wants a specific presenter.
- **Product** — brand item with title + reference images. Imported from URL (`higgsfield marketing-studio products fetch --url ...`) or created from uploaded images (`higgsfield marketing-studio products create`).
- **Webproduct** — App Store / web page version. Auto-routes when fetching App Store URLs.
- **Hook** — reusable opening angle / ad hook. Browse with `higgsfield marketing-studio hooks list`. Hook text is prepended to the user's prompt; it does not replace `--prompt`.
- **Setting** — reusable environment / scene context. Browse with `higgsfield marketing-studio settings list`.
- **Ad reference** — reusable inspiration video that can be bound to an avatar and/or product. Created from an uploaded video (`--video-input <upload_id>`) or a previous generation job (`--job <job_id>`). Browse with `higgsfield marketing-studio ad-references list`. See `references/marketing-ad-references.md`.
- **Brand kit** — captures a brand's identity (name, logo, hero images, colours, fonts, tone) for reuse across image generations. Created by handing in a website URL (`higgsfield marketing-studio brand-kits fetch --url https://… --wait`). See `references/marketing-brand-kits.md`.
- **Ad format** — presets that drives the visual structure of a generated image (`headline`, `bullet-points`, etc.). Read-only, browse with `higgsfield marketing-studio ad-formats list`. Required input for `dtc-ads generate`.

### Discovery commands

Use these exact list commands when the user asks what already exists:

```bash
higgsfield marketing-studio avatars list --json
higgsfield marketing-studio products list --json
higgsfield marketing-studio hooks list --json
higgsfield marketing-studio settings list --json
higgsfield marketing-studio ad-references list --json
higgsfield marketing-studio brand-kits list --json
higgsfield marketing-studio ad-formats list --json
```

`--hook_id` and `--setting_id` are supported by `marketing_studio_video` only; do not pass them to `marketing_studio_image`.

### UX rules (additional)

- One question per phase. Don't ask product+avatar+mode upfront.
- **Two ad approaches are mutually exclusive.** Either the user gives an ad reference video (reference-driven) **or** picks hook/setting blocks (composed-from-blocks) — never both. If the user has an ad reference selected, do not offer hook/setting; if hook/setting are picked, do not offer to attach an ad reference.
- **Ad reference source.** The only valid inputs are a local video file (uploaded via `higgsfield upload create ... --video`) or a prior video job. If the user provides anything else, ask for a local file.
- **`dtc-ads` ad format is mandatory.** Always ask the user to pick from `ad-formats list`. There is no auto-default — both the CLI and server reject calls without `--format-id`.
- **`dtc-ads` optional inputs.** Suggest avatars, products, and reference media when the brief calls for them; only attach what the user picks.

### Workflow — quick ad video

1. **Get product.**
   - Existing product → `higgsfield marketing-studio products list --json`
   - URL → `higgsfield marketing-studio products fetch --url <url> --wait` (polls until import done)
   - Local images → `higgsfield upload create <photo>...` then `higgsfield marketing-studio products create --title "..." --image <id>...`
     Capture product id. When using `--hook_id`, strongly prefer passing `--product_ids`; hooks are designed to pivot into a product and work poorly without product context.
2. **Pick avatar if needed.**
   - Default: `higgsfield marketing-studio avatars list` and pick a preset matching the brand voice.
   - Custom: `higgsfield marketing-studio avatars create --name "..." --image <upload_id>`.
     For UGC modes, you may omit `--avatars` when no specific presenter is required and the brief mentions a person; the backend can synthesize a Soul Character.
3. **Optionally pick setup items.**
   - Hook: `higgsfield marketing-studio hooks list --json`
   - Setting: `higgsfield marketing-studio settings list --json`
     Pass selected IDs as `--hook_id <hook_id>` and `--setting_id <setting_id>` for `marketing_studio_video` only. Do not copy the hook's prompt into `--prompt` unless the user explicitly wants to reinforce the same wording.
4. **Pick mode if needed.** Default is `ugc`; `--mode` is not required just because `--hook_id` is present. Other current slugs: `ugc_how_to`, `ugc_unboxing`, `product_showcase`, `product_review`, `tv_spot`, `wild_card`, `ugc_virtual_try_on`, `virtual_try_on`. **Hook/setting are valid only for `ugc`, `ugc_how_to`, `ugc_unboxing`, `product_review`, `ugc_virtual_try_on`** — do not pass `--hook_id` / `--setting_id` with the other modes. See `references/marketing-modes.md`.
5. **Generate (one-shot).**
   ```bash
   PRODUCT_IDS_JSON=$(mktemp)
   AVATARS_JSON=$(mktemp)
   printf '["<product_id>"]' > "$PRODUCT_IDS_JSON"
   printf '[{"id":"<avatar_id>","type":"preset"}]' > "$AVATARS_JSON"

   higgsfield generate create marketing_studio_video \
     --prompt "..." \
     --avatars @"$AVATARS_JSON" \
     --product_ids @"$PRODUCT_IDS_JSON" \
     --mode ugc \
     --duration 15 \
     --resolution 720p \
     --aspect_ratio 9:16 \
     --wait
   ```
   Add `--hook_id <hook_id>` and/or `--setting_id <setting_id>` when a setup hook/setting was selected.
   `product_ids` and `avatars` are JSON arrays; pass them via `@/path/to/file.json`. Do not pass a bare UUID to `--product_ids`.
   Resolution is `480p`, `720p`, or `1080p`. Aspect ratio is one of `auto`/`21:9`/`16:9`/`4:3`/`1:1`/`3:4`/`9:16`. `--generate-audio true` is supported here (default `false`). `--wait` blocks until done; bump `--wait-timeout 30m` for longer ad runs.
6. **Deliver.** URL + one-line summary (mode, duration).

### Click-to-Ad shortcut (URL-driven)

When the user gives a product URL and wants a marketing video in one go:

```bash
# 1. Trigger fetch (returns the product id, import runs in the background)
higgsfield marketing-studio products fetch --url https://shop.example.com/sneakers --wait

# 2. Generate the marketing video against the same URL — backend reuses the entity
higgsfield generate create marketing_studio_video \
  --url https://shop.example.com/sneakers \
  --mode ugc \
  --duration 15 \
  --aspect_ratio 9:16 \
  --wait
```

Backend dedupes by URL, so repeated runs reuse the existing entity instead of re-fetching.

### Workflow — marketing image

Same as above but use `marketing_studio_image` model:

```bash
higgsfield generate create marketing_studio_image \
  --prompt "..." \
  --aspect_ratio 1:1 \
  --resolution 2k \
  --wait
```

## Virality Predictor video scoring

Use Virality Predictor (`brain_activity`) when the user wants to evaluate a finished video as a business creative: hook strength, virality potential, attention, retention, or how well the content/product holds focus and minimizes distraction. Treat "Virality Predictor" as the customer-facing feature name; `brain_activity` is only the CLI/job_set_type.

```bash
higgsfield generate create brain_activity --video ./creative.mp4 --wait
```

The result is text, not a generated image/video. Report the overall score, peak hook second, sustain score, strongest/weakest regions, and report URL if present. Interpret it as an objective attention proxy for creative testing: higher Visual/Auditory/Language/Attention scores suggest stronger stimulus and focus; lower Default Mode is better because it suggests less mind-wandering.

The CLI prints an Open report URL like `https://<app-domain>/apps/virality-predictor?resultJobId=<job_id>`. Send that URL for the visual report. Raw artifact URLs such as `brain_example_url`, `vertexMapBinaryUrl`, and `vertexMapUrl` are implementation details; mention them only when the user asks for raw data or implementation details.

Good final shape:

```text
Overall score: 44/100
Peak hook: 49% at 1s
Sustain: 89%
Strongest region: Visual Cortex
Risk: Default Mode is high, which can indicate mind-wandering.

Open report: <report_url>
```

## Errors

- `Missing required params: prompt` → user gave no prompt; ask for it.
- `Missing required params: medias` on `brain_activity` / Virality Predictor → pass exactly one video via `--video <path-or-id>`.
- `Invalid values: aspect_ratio=99:99 (allowed: ...)` → bad enum; pick from allowed.
- `Unknown params: foo` → schema doesn't accept that flag; check `higgsfield model get <jst>`. If this happens for `hook_id` or `setting_id`, the selected model/job_set_type does not support Marketing Studio setup items.
- `Session expired` → `higgsfield auth login`.

See `references/troubleshooting.md` for more.

## Reference docs

Load on demand:

- `references/model-catalog.md` — picking the right model for the task
- `references/workflows.md` — `draw_to_video` and `reframe` workflow generation
- `references/prompt-engineering.md` — writing prompts that work
- `references/media-inputs.md` — image/video/audio reference flows and Virality Predictor video analysis
- `references/troubleshooting.md` — common errors and fixes
- `references/marketing-avatars.md` — preset vs custom avatars
- `references/marketing-products.md` — URL fetch vs manual product create
- `references/marketing-setup-items.md` — hooks/settings discovery and usage
- `references/marketing-ad-references.md` — ad reference videos (create/list/get)
- `references/marketing-brand-kits.md` — brand kits (fetch from URL, list, get)
- `references/marketing-dtc-ads.md` — DTC Ads Engine (`dtc-ads generate`)
- `references/marketing-modes.md` — every Marketing Studio mode
