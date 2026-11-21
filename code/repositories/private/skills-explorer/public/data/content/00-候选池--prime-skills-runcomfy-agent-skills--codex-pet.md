---
name: codex-pet
displayName: "Codex Pet — Pro Pack on RunComfy"
description: >
  Codex Pet generator on RunComfy. Build a Codex-compatible Codex Pet
  spritesheet.webp + pet.json from a single reference image, drop it
  into `${CODEX_HOME:-$HOME/.codex}/pets/<name>/` and Codex picks it up
  as a custom Codex Pet next to the 8 built-ins. This skill produces
  the exact Codex Pet atlas Codex expects (1536x1872 PNG/WebP, 8 cols x
  9 rows, 192x208 cells, 9 animation states — idle, running-right,
  running-left, waving, jumping, failed, waiting, running, review).
  Calls OpenAI GPT Image 2 edit ONCE via the local RunComfy CLI as
  `runcomfy run openai/gpt-image-2/edit` to produce a canonical Codex
  Pet pose, then assembles all 9 animation rows programmatically with
  ImageMagick micro-transforms — no Codex Pro, no `$imagegen`, no
  OPENAI_API_KEY required, only RUNCOMFY_TOKEN. Triggers on "codex pet",
  "create codex pet", "make codex pet", "hatch codex pet", "/hatch
  image", "desktop pet codex", "codex pets", "spritesheet.webp", or any
  explicit ask to build a custom pet for OpenAI Codex.
homepage: https://www.runcomfy.com
license: MIT
---

# Codex Pet — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=codex-pet) · [GPT Image 2 edit endpoint](https://www.runcomfy.com/models/openai/gpt-image-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=codex-pet) · [docs](https://docs.runcomfy.com/cli/introduction?utm_source=skills.sh&utm_medium=skill&utm_campaign=codex-pet)

**Codex Pet generator on RunComfy.** Turn one source image into a Codex-compatible custom Codex Pet — `pet.json` + `spritesheet.webp` — drop it into `${CODEX_HOME:-$HOME/.codex}/pets/<name>/`, Codex picks it up next to the 8 built-in Codex Pets.

```bash
npx skills add agentspace-so/runcomfy-agent-skills --skill codex-pet -g
```

## What a Codex Pet is

OpenAI Codex Pets (released May 2026) are pixel-art animated companions that float over your desktop while Codex codes — they react to mouse interaction and Codex status (scratching head when thinking, popping a speech bubble when a task completes). Codex ships with 8 built-in Codex Pets and supports custom Codex Pets installed locally as a folder under `${CODEX_HOME:-$HOME/.codex}/pets/`.

Each custom Codex Pet folder contains exactly two files:

- `pet.json` — manifest with `id`, `displayName`, `description`, `spritesheetPath`.
- `spritesheet.webp` — Codex Pet sprite atlas, **1536x1872** PNG or WebP, 8 columns x 9 rows of 192x208 cells, transparent background.

The 9 rows correspond to 9 animation states Codex plays. Each row uses a fixed number of leading frames; trailing cells stay fully transparent.

## Why this Codex Pet skill (vs OpenAI's official `hatch-pet`)

OpenAI ships an official [`hatch-pet`](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md) skill that produces the same Codex Pet artifact via the Codex-internal `$imagegen` system skill (requires Codex Pro + `$imagegen` configured).

**This Codex Pet skill is a drop-in alternative that runs via the RunComfy CLI**: a single `RUNCOMFY_TOKEN` plus `runcomfy` and `magick` binaries — no Codex Pro, no `$imagegen`, no OPENAI_API_KEY. The output Codex Pet artifact is identical — same `pet.json` shape, same `spritesheet.webp` 1536x1872 atlas, same 9 animation rows — so Codex treats this Codex Pet exactly like one made by `hatch-pet`.

This skill follows the same pattern Codex's built-in Codex Pets use: **one canonical pose, replicated across cells with ImageMagick micro-transforms** for subtle animation (1-2 px shifts, blink frames, tilt frames). That matches what the official `hatch-pet` output actually looks like cell-by-cell — the Codex Pet animation visible in the Codex desktop app is intentionally subtle.

Pick this skill when:

- You want a custom Codex Pet but don't have Codex Pro / `$imagegen`.
- You want a custom Codex Pet built via the RunComfy Model API.
- You want **batch Codex Pet generation** from a folder of source images (one canonical call per pet).
- You're entering the OpenAI Codex Pet contest with a different model behind the visuals.
- You said "codex pet", "/hatch", "make me a codex pet", "spritesheet.webp", "desktop pet for codex" explicitly.

## Codex Pet animation rows

Codex reads one fixed atlas: 8 columns, 9 rows, 192x208 cells. Each Codex Pet row corresponds to one animation state with a specific number of leading frames.

| Row | State         | Used columns | Frames | Codex Pet behavior                                                        |
| --- | ------------- | ------------ | ------ | ------------------------------------------------------------------------- |
| 0   | idle          | 0-5          | 6      | calm breathing/blinking; the reduced-motion first frame for the Codex Pet |
| 1   | running-right | 0-7          | 8      | Codex Pet locomotion to the right                                         |
| 2   | running-left  | 0-7          | 8      | mirrored locomotion to the left                                           |
| 3   | waving        | 0-3          | 4      | greeting / attention gesture                                              |
| 4   | jumping       | 0-4          | 5      | anticipation, lift, peak, descent, settle                                 |
| 5   | failed        | 0-7          | 8      | error / sad / deflated reaction                                           |
| 6   | waiting       | 0-5          | 6      | patient idle variant                                                      |
| 7   | running       | 0-5          | 6      | active working / in-progress loop (NOT foot-running)                      |
| 8   | review        | 0-5          | 6      | focused / inspecting / thinking                                           |

Trailing cells after each row's last used column must be fully transparent.

## Codex Pet style

The Codex Pet visual house style:

- **EXAGGERATED chibi proportions**: head occupies ~60 percent of total figure height; body and legs are tiny stubby and short. The whole figure should fit a near-square bounding box.
- pixel-art-adjacent low-resolution mascot, chunky silhouette
- thick dark 1-2 px outlines, visible stepped pixel edges
- limited palette, flat cel shading, simple expressive face, tiny limbs
- transparent background

Avoid: motion lines, drop shadows, glows, sparkles, floating effects, text labels, scenery, white/black backgrounds.

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login`. CI alternative: `RUNCOMFY_TOKEN=<token>`.
3. **ImageMagick** — `brew install imagemagick` (macOS) or `apt-get install imagemagick` (Linux). Provides the `magick` command for the deterministic atlas assembly.
4. **A source image URL** — publicly fetchable HTTPS, JPEG/PNG/WebP, the subject the Codex Pet will be modeled on.

## Codex Pet pipeline (1 GPT Image 2 call, ~2 min)

1. **Canonical Codex Pet** — single `runcomfy run openai/gpt-image-2/edit` call producing one 1024x1024 chibi pose on a magenta chroma-key background.
2. **Cell normalization** — chroma-key magenta → alpha 0, trim, aspect-fit into 192x208 with transparent padding.
3. **9 row strips, programmatic** — for each of 9 animation states, build the row's 8 cells via ImageMagick micro-transforms (translate / mask / mirror) of the canonical cell. Trailing cells filled with transparent 192x208.
4. **Atlas** — stack 9 row strips vertically into the 1536x1872 Codex Pet atlas.
5. **WebP** — convert atlas PNG to WebP.
6. **Manifest + install** — write `pet.json`, copy both files into `${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/`.

The micro-transform approach matches what Codex's built-in Codex Pets actually do — the Codex Pet animation is intentionally subtle, so 1-2 px shifts and blink masks per cell give the right visual feel without burning 72 GPT Image 2 calls.

### Step 1: Generate the canonical Codex Pet (1 call)

```bash
PET_NAME="my-pet"
PET_DESC="A friendly companion for late-night refactors."
SOURCE_URL="https://.../source.png"
RUN_DIR="./codex-pet-run/${PET_NAME}"
CHROMA="#FF00FF"   # magenta chroma-key
mkdir -p "${RUN_DIR}"

runcomfy run openai/gpt-image-2/edit \
  --input "{
    \"prompt\": \"Generate one canonical Codex digital pet sprite based on the input image. EXAGGERATED chibi proportions: the head occupies about 60 percent of the total figure height; body and legs are tiny stubby and short. The whole pet figure must fit within a near-square bounding box (overall aspect close to 1:1). Pixel-art-adjacent low-resolution mascot, chunky whole-body silhouette, thick dark 1-2 px outline, visible stepped pixel edges, limited palette, flat cel shading, simple expressive face, tiny limbs. Centered in the image. No polished illustration, no painterly render, no anime key art, no 3D render, no glossy app-icon polish, no realistic detail. Background: solid flat magenta ${CHROMA} chroma-key fill outside the pet silhouette. The pet itself must not use the chroma-key color or any close-to-magenta highlights. No gradients, no shadows, no halos, no scenery, no text. Identity preserved from the input image.\",
    \"images\": [\"${SOURCE_URL}\"],
    \"size\": \"1024*1024\"
  }" \
  --output-dir "${RUN_DIR}/decoded/"

BASE=$(ls "${RUN_DIR}/decoded/"*.png | head -1)
echo "canonical Codex Pet: ${BASE}"
```

### Step 2: Normalize the canonical into a 192x208 Codex Pet cell

Chroma-key magenta to alpha, trim to the pet sprite bounding box, aspect-fit into 192x208 with transparent padding.

```bash
magick "${BASE}" \
  -fuzz 18% -transparent "${CHROMA}" \
  -alpha set \
  -trim +repage \
  -resize 192x208 \
  -gravity center \
  -background none \
  -extent 192x208 \
  "${RUN_DIR}/cell.png"
```

The 18% fuzz is tuned for GPT Image 2's anti-aliased magenta edges. Adjust to 25% if the Codex Pet has wider magenta halos, or to 8-10% if the pet has near-magenta highlights getting clipped.

### Step 3: Build the 9 Codex Pet row strips programmatically

For each row, build 8 cells from the canonical via ImageMagick micro-transforms, fill unused trailing cells with transparent, then concatenate into a 1536x208 row strip.

```bash
SRC="${RUN_DIR}/cell.png"
mkdir -p "${RUN_DIR}/cells"

# Helpers
shift_cell() { magick "$SRC" -background none -roll "+${1}+${2}" -alpha set "$3"; }
rotate_cell() { magick "$SRC" -background none -distort SRT "$1" -alpha set "$2"; }
make_blink() {
  # Eyes are roughly at y=80-100 in a 208-tall cell.
  # Soften with a skin-tone overlay across that horizontal band.
  magick "$SRC" \
    -region 80x6+56+82 -fill "#f4e6d8" -colorize 70% -blur 0x0.5 +region "$1"
}
blank_cell() { magick -size 192x208 xc:none -alpha set "PNG32:$1"; }

build_row() {
  local row=$1; shift
  local i=0
  for spec in "$@"; do
    local out="${RUN_DIR}/cells/row${row}-frame${i}.png"
    case "$spec" in
      base)      cp "$SRC" "$out" ;;
      blink)     make_blink "$out" ;;
      shift:*)   IFS=':' read -r _ x y <<< "$spec"; shift_cell "$x" "$y" "$out" ;;
      rotate:*)  IFS=':' read -r _ ang <<< "$spec"; rotate_cell "$ang" "$out" ;;
    esac
    i=$((i+1))
  done
  while [ "$i" -lt 8 ]; do
    blank_cell "${RUN_DIR}/cells/row${row}-frame${i}.png"
    i=$((i+1))
  done
  magick "${RUN_DIR}/cells/row${row}-frame"*.png +append -alpha set \
    "${RUN_DIR}/cells/row${row}-strip.png"
}

# 9 Codex Pet rows with their per-frame micro-transforms
build_row 0 base base blink base base blink                                       # idle (6)
build_row 1 base shift:1:0 shift:2:-1 shift:1:0 base shift:-1:0 shift:-2:-1 shift:-1:0  # running-right (8)
# row 2 = running-left = horizontal flip of row 1, built below
build_row 3 base shift:0:-1 base shift:0:-1                                       # waving (4)
build_row 4 shift:0:2 base shift:0:-8 shift:0:-2 base                              # jumping (5) — vertical arc
build_row 5 base shift:0:1 rotate:1 shift:0:1 shift:0:2 shift:0:1 rotate:-1 base  # failed (8)
build_row 6 base base shift:0:-1 base base shift:0:1                              # waiting (6)
build_row 7 base shift:0:-1 base shift:0:-1 base shift:0:-1                       # running (6)
build_row 8 base rotate:-2 base rotate:2 base base                                # review (6)

# Row 2: running-left = mirror of running-right
magick "${RUN_DIR}/cells/row1-strip.png" -flop -alpha set "${RUN_DIR}/cells/row2-strip.png"
```

The micro-transform table is what gives the Codex Pet its readable-but-subtle motion in Codex. Tweak the numbers per row to taste; the deltas are intentionally small (1-2 px) so the Codex Pet feels alive without becoming distracting.

### Step 4: Compose the Codex Pet atlas

Stack the 9 row strips vertically into the 1536x1872 Codex Pet atlas, then convert to WebP.

```bash
magick \
  "${RUN_DIR}/cells/row0-strip.png" \
  "${RUN_DIR}/cells/row1-strip.png" \
  "${RUN_DIR}/cells/row2-strip.png" \
  "${RUN_DIR}/cells/row3-strip.png" \
  "${RUN_DIR}/cells/row4-strip.png" \
  "${RUN_DIR}/cells/row5-strip.png" \
  "${RUN_DIR}/cells/row6-strip.png" \
  "${RUN_DIR}/cells/row7-strip.png" \
  "${RUN_DIR}/cells/row8-strip.png" \
  -append -alpha set "${RUN_DIR}/spritesheet.png"

magick "${RUN_DIR}/spritesheet.png" "${RUN_DIR}/spritesheet.webp"
```

### Step 5: Write the Codex Pet manifest

```bash
cat > "${RUN_DIR}/pet.json" <<EOF
{
  "id": "${PET_NAME}",
  "displayName": "${PET_NAME}",
  "description": "${PET_DESC}",
  "spritesheetPath": "spritesheet.webp"
}
EOF
```

### Step 6: Install the Codex Pet

```bash
DEST="${CODEX_HOME:-$HOME/.codex}/pets/${PET_NAME}"
mkdir -p "${DEST}"
cp "${RUN_DIR}/pet.json" "${RUN_DIR}/spritesheet.webp" "${DEST}/"
echo "Codex Pet installed at ${DEST}"
```

Restart Codex (or reload the pet list) and the custom Codex Pet appears next to the 8 built-ins.

## Prompting the canonical Codex Pet — what works

The single GPT Image 2 call decides everything. Get this prompt right and the rest is deterministic.

**Lead with the chibi proportion lock.** "EXAGGERATED chibi proportions, head ~60 percent of figure height" is the difference between a thin tall character (which fits the 192x208 cell badly with pillarbox) and a head-dominant chibi (which fills the cell naturally). The latter is what Codex's built-in Codex Pets look like.

**Demand the magenta `#FF00FF` chroma-key explicitly** in every Codex Pet base prompt. GPT Image 2 only outputs RGB (no alpha), so the only way to get a transparent Codex Pet is to chroma-key a known background color out post-process.

**Forbid the chroma-key color in the pet itself.** Add: "The pet itself must not use the chroma-key color or any close-to-magenta highlights." Otherwise the chroma-key step removes Codex Pet body parts that happen to be magenta-ish.

**Pin the style.** "pixel-art-adjacent, chunky silhouette, 1-2 px outline, limited palette, flat cel shading" — pin every term that makes the Codex Pet match the Codex house style.

**Forbid the wrong styles.** "No polished illustration, no painterly render, no anime key art, no 3D render, no glossy app-icon polish, no realistic detail." Without this, GPT Image 2 will gravitate toward over-rendered anime art.

**Anti-patterns**:

- Generic "transparent background" — GPT Image 2 paints near-white instead. Use chroma-key.
- Letting the model freestyle proportions — it will draw a tall narrow chibi that doesn't fit 192x208.
- Mixing styles in one prompt — pin one style anchor and stick to it.

## Tuning the micro-animation

The default ImageMagick recipe in step 3 produces a Codex Pet animation similar to the built-in Codex Pets — subtle bob, occasional blink, jumping arc, head tilt. To make the animation more or less perceptible, tweak the deltas:

- **Bigger idle bob**: change `shift:0:-1` to `shift:0:-2` in row 0.
- **Faster running cycle**: increase the horizontal shifts in row 1 (e.g. `shift:3:0` instead of `shift:2:-1`).
- **Higher jump**: change row 4's peak from `shift:0:-8` to `shift:0:-12`.
- **Stronger head tilt** in review: change `rotate:-2` / `rotate:2` to `rotate:-4` / `rotate:4`.

Keep deltas small (≤ 4 px or ≤ 4°) so the Codex Pet doesn't become distracting.

## FAQ — Codex Pet

**What is a Codex Pet?** OpenAI Codex Pets are pixel-art animated companions launched May 2026 that float over your desktop and react to Codex's coding status. Custom Codex Pets live as `pet.json` + `spritesheet.webp` files under `${CODEX_HOME:-$HOME/.codex}/pets/<name>/`.

**Why use this Codex Pet skill instead of `hatch-pet`?** Official `hatch-pet` requires the Codex-internal `$imagegen` system skill (Codex Pro). This skill needs only `RUNCOMFY_TOKEN` and runs the same animation-row spec via the RunComfy CLI, with one GPT Image 2 call total.

**How long does a Codex Pet generation take?** ~2 minutes — 1 GPT Image 2 edit call (~90s) plus a few seconds of ImageMagick atlas assembly.

**Why only one API call?** The Codex Pet animation in the Codex desktop app is intentionally subtle (you can confirm by inspecting any built-in Codex Pet's atlas — 72 cells of nearly-identical poses with tiny variations). One canonical pose plus deterministic ImageMagick micro-transforms produces the same animation feel without burning 72 separate generation calls.

**Can the Codex Pet skill take a non-human subject?** Yes — pets, mascots, objects, foods all work. The base prompt simplifies the source into the Codex Pet house style automatically.

**How do I install my Codex Pet?** Copy `pet.json` and `spritesheet.webp` into `${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/` and reload Codex.

**What if the canonical Codex Pet drifts off identity?** Re-run step 1 with a tighter identity-preservation prompt (e.g. name specific features: hair color, glasses, accessory). Steps 2-6 are deterministic and don't need to change.

**What size is each Codex Pet frame?** 192x208 px. Each row strip is 1536x208 (8 frames). Final Codex Pet atlas is 1536x1872 (9 stacked rows).

**Can I add custom poses or replace rows?** Yes — modify the `build_row` calls in step 3. The atlas slot count per row must match the Codex contract (idle=6, running-right/left=8, waving=4, jumping=5, failed=8, waiting/running/review=6) for Codex to play them correctly.

## Limitations

- **One canonical pose per Codex Pet** — animation is via ImageMagick transforms, not multi-frame model generation. This matches the built-in Codex Pets' subtle animation but won't produce dramatic motion (e.g. distinct frame-by-frame running cycle).
- **GPT Image 2 doesn't output alpha** — the magenta chroma-key + post-process is a workaround. If the Codex Pet has near-magenta colors (rare for chibi palettes), switch the chroma-key to a different solid (`#00FFFF` cyan or `#00FF00` green) in both the prompt and the post-process.
- **Identity drift** — GPT Image 2 may simplify the source image identity into Codex Pet style; specific small features (e.g. earrings, prop colors) may shift.
- **No audio / voice on Codex Pet** — Codex Pets are visual-only.

## Exit codes

The `runcomfy` CLI uses sysexits-style codes:

| code | meaning                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0    | Codex Pet canonical generated successfully                                                                  |
| 64   | bad CLI args                                                                                                |
| 65   | bad input JSON for the Codex Pet call / schema mismatch (e.g. `size: "1024_1024"` instead of `"1024*1024"`) |
| 69   | upstream 5xx                                                                                                |
| 75   | retryable: timeout / 429                                                                                    |
| 77   | not signed in or token rejected                                                                             |

`magick` (ImageMagick) returns 0 on a clean Codex Pet atlas; non-zero indicates a missing input frame or output-path permission issue.

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=codex-pet).

## How it works

1. The skill calls `runcomfy run openai/gpt-image-2/edit` once with the user's source image and a tight chibi-proportion prompt, producing a 1024x1024 canonical Codex Pet on magenta.
2. ImageMagick chroma-keys the magenta to alpha 0, trims the sprite bbox, aspect-fits into a 192x208 cell.
3. ImageMagick programmatically builds 9 row strips by applying micro-transforms (1-2 px translate, blink mask, rotate, mirror) to the canonical cell.
4. The 9 row strips stack into the 1536x1872 Codex Pet atlas; the atlas converts to WebP.
5. A `pet.json` manifest is written; both files are copied into `${CODEX_HOME:-$HOME/.codex}/pets/<name>/` where Codex picks up the custom Codex Pet automatically.

## Credits

The 9-row Codex Pet atlas spec — column counts, frame counts, cell dimensions — comes from OpenAI's official [`hatch-pet`](https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet) skill (MIT licensed). The animation-row contract and the chroma-key strategy are documented there. This skill reuses the spec but swaps the visual generator (`$imagegen` → RunComfy GPT Image 2) and the atlas assembly (Python → ImageMagick) so it runs without Codex Pro.

## What this skill is not

Not a Codex client. Not a `hatch-pet` replacement when `$imagegen` is available — official `hatch-pet` is preferable when Codex Pro is in play. Not a self-hosted GPT Image 2 — depends on a working RunComfy account.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600. Set `RUNCOMFY_TOKEN` env var to bypass the file in CI.
- **Input boundary**: Codex Pet prompts are passed as JSON via `--input`. The CLI does NOT shell-expand. No shell-injection surface.
- **Third-party content**: source image URL is fetched by the RunComfy server. Treat external URLs as untrusted — image-based prompt injection is a known risk for any image-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` and `*.runcomfy.net` / `*.runcomfy.com`.
- **Generated-file size cap**: the CLI aborts any single Codex Pet canonical download > 2 GiB.
- **Local install path**: the final Codex Pet writes to `${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/`. No remote upload.
