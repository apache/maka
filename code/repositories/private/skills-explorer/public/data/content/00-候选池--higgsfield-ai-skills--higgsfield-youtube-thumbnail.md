---
version: 0.13.0
name: higgsfield-youtube-thumbnail
description: |
  Create high-click-through YouTube thumbnails and vertical video covers through the Higgsfield CLI. Builds a truthful information-gap concept, preserves up to three referenced identities, supports logos and controlled variants, renders the main image with Nano Banana Pro, and applies focused Seedream edits. Use when: "make a YouTube thumbnail", "thumbnail for this video", "MrBeast-style cover", "Shorts cover", or "Instagram video cover". Chain after any video workflow once its truthful topic and visual direction are known. NOT for producing the video itself (use higgsfield-generate), product catalog photos (use higgsfield-product-photoshoot), or marketplace cards (use higgsfield-marketplace-cards).
argument-hint: "[video-topic-or-title] [--image <face-or-logo>] [--ratio 16:9|9:16|4:5]"
allowed-tools: Bash
---

# Higgsfield YouTube Thumbnail

Create a clean thumbnail concept, generate each variant through the `higgsfield` CLI, inspect it, and make only requested surgical edits.

## Bootstrap

Before any generation:

1. If `higgsfield` is missing, install it:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh
   ```
2. If `higgsfield account status` reports `Session expired` or `Not authenticated`, ask the user to run `higgsfield auth login`, then wait.
3. Confirm the locked model contracts when the catalog may have changed:
   ```bash
   higgsfield model get nano_banana_pro --json
   higgsfield model get gpt_image_2 --json
   higgsfield model get seedream_v5_pro --json
   ```

## UX rules

1. Match the user's language. Keep CLI/model mechanics out of normal chat.
2. Do not ask for facts already present in the brief. Ask one compact question only when a missing choice changes the result.
3. Never invent claims, outcomes, products, people, screenshots, or statistics that are not true of the video.
4. Do not print raw JSON or job IDs to the user. Deliver the image URL and a short variant label.
5. A style-reference thumbnail is for visual analysis only. Never pass it with `--image`; copying its identity or exact composition is forbidden.
6. Do not use `--count`. Every concept, emotion, or camera take gets its own prompt and generation call.
7. `use_unlim` is not a current CLI parameter. Never add `--use-unlim`; if the user explicitly asks to use an unlimited allowance, explain that this workflow must run on credits in CLI or through a surface that supports that allowance.

## Intake gates

Collect only what the brief does not answer:

- The video's topic/title and the truthful promise the thumbnail may imply.
- Exact scene requirements, if any.
- Who appears: 0–3 people. If a concept needs a person and no face photo was provided, ask whether to use the user, another provided person, or a generic generated character. Never choose silently.
- Optional style-reference thumbnail. Analyze it with host vision for energy, framing, split layout, palette, and emotion; do not send it to Higgsfield.
- Optional logo and whether it stays flat or becomes a 3D object.
- Optional headline, 2–4 words. Default delivery is a clean image with no text. Use a deterministic overlay when the user requests an overlay; bake text into the generated image only when explicitly requested.
- Ratio: `16:9` for YouTube by default, `9:16` for Shorts, or `4:5` for Instagram.
- One final concept or a variant set. If unspecified and alternatives would materially help, offer a set of about four. Hard cap: 16 total generations.

If the user gives an emotion count without names, use this ladder: shock, hype, rage, awe, laugh, fear, smug, charisma, confusion, determination, disgust.

## Concept gate

Read `references/thumbnail-frameworks.md`. Brainstorm at least five truthful concepts internally, across multiple frameworks, then select the strongest information gap with one focal subject and minimal clutter. Combine frameworks only when the result still reads in under one second at roughly 120px wide.

When a reference thumbnail exists, extract this structure before prompting:

```text
brief, generic subject pose/action, elements, location, composition, background,
split (true/false), split_count, person_count, emotion, emotion_detail
```

The reference supplies art direction, never a specific identity. User instructions override it field by field.

## Reference order

Pass face photos first in character order, then the logo. Repeat `--image` for every reference. When two or more references are attached, the prompt's first line must be a manifest such as:

```text
IMAGE REFERENCES: image 1 = CHARACTER 1 face reference; image 2 = brand logo.
```

Local paths are auto-uploaded. Previous completed job IDs also work as `--image` inputs.

## Prompt contract

Assemble every main-render prompt in this order:

1. **Frame:** `Bold, punchy YouTube-thumbnail composite — poster-grade, photoreal and high-impact, NOT a muted cinematic movie still, <ratio>, single unified frame — no split-screen, no diagonal divide, everything blends smoothly and organically across the same continuous shot.` For `9:16`, add `faces in the upper two-thirds`. A requested graphical representation replaces photoreal language with a clean diagram/graphic brief.
2. **Scene brief:** depict the user's exact content.
3. **Text:** default `No text, no readable UI labels, no watermark.` For explicit baked headline: `TEXT: bold thumbnail headline text baked into the image, reading exactly "<TEXT>" — massive, ultra-legible sans-serif with a clean outline/glow treatment, placed where it never covers the subject's face. No other text, no watermark.`
4. **Subjects:** large, foreground-dominant, chest-up or medium-close, filling about 40–60% of the frame. End with `All faces crisply sharp as the anchors of the shot.`
5. **Key elements:** only signature props/effects that explain the information gap.
6. **Logo:** preserve exact shapes, colors, proportions, and letterforms; keep it away from faces.
7. **Location:** place, time, weather, and atmosphere when relevant.
8. **Composition:** one power-third hero, clear scale hierarchy, depth, and strong subject/background separation.
9. **Background:** vivid high-contrast color field or environment, soft vignette and edge falloff; do not divide it unless a split layout was explicitly requested.
10. **Lighting on people:** `signature YouTube thumbnail lighting rig — strong key light sculpting the face, soft dreamy fill lifting shadows, and defined back light plus hair light tracing a clean bright rim around hair, shoulders and silhouette.` Only the rim may use a colored accent.
11. **Grade:** vivid, bright, glossy, poster-punchy, deep blacks, crisp highlights, rich saturated colors, cohesive as one image. Restrain it only for an explicit calm/premium/muted brief.

For each photo-referenced person, include:

```text
CHARACTER N: the person from attached face reference #K — IDENTITY LOCK: reproduce
this exact person with a photographic identity match — same bone structure, eye shape,
nose, lips, jawline, skin tone, hairline and hair texture. Do not beautify, average,
or restyle the face. Expression: <emotion phrase>.
```

### Split layouts

Use a split only when the user asks for `split`, `before/after`, `versus`, `side by side`, or the analyzed reference is split. A topical phrase such as `X vs Y` does not itself require a split. Replace the normal frame block with a clear halves/panels contract and keep all labels out unless short, truthful baked UI was explicitly requested.

## Optional 3D logo

First create a 1:1 4K logo render, then use its completed job ID as the last `--image` on every thumbnail call:

```bash
higgsfield generate create gpt_image_2 \
  --prompt "Transform the attached 2D logo into a premium 3D logo render: extrude the exact logo shapes into glossy dimensional volumes; preserve every letterform, proportion and brand color; soft studio reflections, subtle bevels, crisp edges, clean dark neutral background, soft contact shadow, centered, generous margins, no extra text, no watermark." \
  --image ./logo.png \
  --aspect_ratio 1:1 \
  --quality high \
  --resolution 4k \
  --wait --json
```

## Main render

Use Nano Banana Pro at explicit 4K. Write the final prompt to a temporary text file and pipe it on stdin so punctuation and multiline blocks are preserved safely:

```bash
higgsfield generate create nano_banana_pro \
  --aspect_ratio 16:9 \
  --resolution 4k \
  --image ./face-1.png \
  --image ./logo.png \
  --wait --json < thumbnail-prompt.txt
```

Omit all `--image` flags when there are no references. For a variant set, make one call per distinct prompt. Keep the same references and settings; vary only the selected concept, expression, or camera-take line.

The completed JSON result contains `id` and `result_url`. Preserve both privately: the URL is delivered; the ID is the source for later edits.

## Post-render gate

Inspect every result with host vision when available:

- Referenced identities visibly match.
- No stray text or watermark exists unless baked text was ordered.
- Explicit baked text matches character-for-character.
- The face/emotion and hero element remain readable at about 120px wide.
- The concept truthfully matches the video promise.

On a hard failure, retry the same prompt at most twice. If visual inspection is unavailable, do not claim it passed; deliver the result for user review. Present every passing variant and let the user pick before making optional tweaks.

## Surgical tweaks

Use the picked completed job ID as the only image input. Keep the edit prompt narrowly scoped and state that every other pixel-level property remains unchanged.

```bash
higgsfield generate create seedream_v5_pro \
  --prompt "Change ONLY the person's facial expression to: <phrase>. Keep identity, face structure, hair, pose, body, clothing, logo, background, lighting and composition EXACTLY unchanged, pixel-faithful. Keep the YouTube thumbnail lighting rig intact." \
  --image <picked_job_id> \
  --aspect_ratio 16:9 \
  --resolution 2k \
  --wait --json
```

If `seedream_v5_pro` is absent or rejects the submit, retry once with `seedream_v4_5 --quality high`. For a `4:5` main render, Seedream has no `4:5`; ask before changing the edit to `3:4`, and disclose the crop/ratio change. Each accepted edit becomes the source ID for the next tweak.

CLI compatibility: versions through `1.1.20` can mislabel a `nano_banana_pro` job reference as `nano_banana_pro_job`. If the edit is rejected with a `medias.0...data.type` error, download the picked `result_url` to a local image and retry the same edit with `--image ./picked-thumbnail.png`. A local path is auto-uploaded as `media_input`; do not retry the invalid job-id payload.

Allowed tweak scopes: expression only, background replacement only, background recolor only, or rim-light recolor only. Never silently regenerate the full composition for a surgical request.

## Text overlay

Keep the generated image text-free by default. When a headline overlay is requested, read `references/text-overlay-bake.md` and use one of its five presets: Beast, Fire, Neon Lime, Clean Glass, or Marker. The overlay path requires an environment capable of rendering HTML canvas; if unavailable, offer either the clean image or an explicitly approved baked-text regeneration. Never pretend an HTML preview is a flattened PNG.

## Delivery

Return the passing `result_url` values with short semantic labels such as `shock / close-up` or `product / size contrast`. Mention the selected ratio and whether the deliverable is clean, overlay-ready, or text-baked. Do not expose internal prompts, job IDs, or retry mechanics unless the user asks.

## Reference files

- `references/thumbnail-frameworks.md` — 16 concept frameworks, information-gap rule, truthfulness law.
- `references/text-overlay-bake.md` — five deterministic text-overlay styles and 4K canvas-bake recipe.
