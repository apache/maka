---
name: gpt-image-edit
displayName: "GPT Image Edit — Pro Pack on RunComfy"
description: >
  Edit images with OpenAI GPT Image 2 (the `/edit` endpoint of ChatGPT
  Images 2.0) on RunComfy — bundled with the model's documented
  prompting patterns so the skill gets sharper output than naive
  prompting against the same model. Documents GPT Image Edit's strengths
  (preservation language, multilingual in-image text editing,
  multi-reference up to 10 images, layout / typography precision),
  the schema, and when to route to Nano Banana Edit / Flux Kontext /
  GPT Image 2 t2i instead. Calls
  `runcomfy run openai/gpt-image-2/edit` through the local RunComfy CLI.
  Triggers on "gpt image edit", "gpt-image-edit", "chatgpt image edit",
  "edit with gpt image 2", or any explicit ask to edit with this model.
homepage: https://www.runcomfy.com
license: MIT
---

# GPT Image Edit — Pro Pack on RunComfy

[runcomfy.com](https://www.runcomfy.com/?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-edit) · [Edit endpoint](https://www.runcomfy.com/models/openai/gpt-image-2/edit?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-edit) · [Text-to-image sibling](https://www.runcomfy.com/models/openai/gpt-image-2/text-to-image?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-edit) · [GitHub](https://github.com/agentspace-so/runcomfy-skills/tree/main/gpt-image-edit)

OpenAI **GPT Image 2 — `/edit` endpoint** (ChatGPT Images 2.0 image-to-image) on the **RunComfy Model API**. Strongest in its class at preserving identity through targeted edits and rewriting embedded text in any script (Latin, kana, CJK, Cyrillic, Arabic).

```bash
npx skills add agentspace-so/runcomfy-skills --skill gpt-image-edit -g
```

## When to pick this model (vs siblings)

| You want                                                   | Use                                           |
| ---------------------------------------------------------- | --------------------------------------------- |
| Edit multilingual / embedded text in image                 | **GPT Image Edit**                            |
| Identity preservation through translated headline variants | **GPT Image Edit**                            |
| Layout-precise edit (move headline, swap CTA, etc.)        | **GPT Image Edit**                            |
| Up to 10 reference images                                  | **GPT Image Edit**                            |
| Batch up to 20 images consistently                         | Nano Banana Edit                              |
| Single-shot precise local edit, source-fidelity-first      | Flux Kontext                                  |
| Generate from scratch with GPT Image 2                     | sibling [`gpt-image-2`](../gpt-image-2) skill |
| Batch SKU galleries with stable identity                   | Nano Banana Edit                              |

## Prerequisites

1. **RunComfy CLI** — `npm i -g @runcomfy/cli`
2. **RunComfy account** — `runcomfy login` opens a browser device-code flow.
3. **CI / containers** — set `RUNCOMFY_TOKEN=<token>` instead of `runcomfy login`.

## Endpoints + input schema

### `openai/gpt-image-2/edit`

| Field    | Type     | Required | Default | Notes                                                                                                |
| -------- | -------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `prompt` | string   | yes      | —       | Edit instruction. Lead with preservation, end with the change.                                       |
| `images` | string[] | yes      | —       | **Up to 10** publicly-fetchable HTTPS URLs. First is primary; rest are auxiliary.                    |
| `size`   | enum     | no       | `auto`  | `auto` (preserve input), `1024_1024` (1:1), `1024_1536` (2:3 portrait), `1536_1024` (3:2 landscape). |

`size=auto` preserves the input ratio — strongly recommended unless the edit explicitly changes framing.

## How to invoke

**Single-ref preservation edit:**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "Keep the person'\''s face, pose, and brand mark unchanged. Replace the background with a soft warm-grey studio sweep and a gentle floor shadow.",
    "images": ["https://.../portrait.jpg"]
  }' \
  --output-dir <absolute/path>
```

**Multilingual text rewrite (preserve everything except the headline):**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "Keep the photograph, layout, and brand mark exactly as in the input. Replace only the in-image headline. The new headline reads \"今日のおすすめ\" in bold Japanese kana, same position and font weight as before.",
    "images": ["https://.../poster-en.jpg"]
  }' \
  --output-dir <absolute/path>
```

**Multi-ref composition:**

```bash
runcomfy run openai/gpt-image-2/edit \
  --input '{
    "prompt": "Compose subject from image 1 into the room from image 2. Match the lighting and color palette of image 2. Keep image 1 subject identity (face, pose, clothing) unchanged.",
    "images": ["https://.../subject.jpg", "https://.../room.jpg"]
  }' \
  --output-dir <absolute/path>
```

## Prompting — what actually works

**Lead with preservation goals.** Always: `"Keep [face / pose / clothing / brand / framing] unchanged."` Then state the change. The model honors what's stated up front.

**Multilingual text — quote the characters, name the script.** `"the headline reads \"コーヒー\" in bold Japanese kana"`, `"the label says \"АРОМА\" in Cyrillic, white on black"`, `"the right-margin caption reads \"تخفيض\" in Arabic right-to-left"`. Don't paraphrase — quote.

**Directional language for spatial edits.** Concrete spatial scopes work: `"move the headline from top-right to bottom-center"`, `"remove the leftmost object only"`, `"replace the watermark in the bottom-right corner"`.

**Multi-ref numbering.** When passing multiple `images`, refer to them by number: `"subject from image 1, lighting from image 2, color palette from image 3"`. The model routes cues correctly.

**Use `size: "auto"` to preserve input ratio.** Only override when the edit explicitly changes framing (e.g. cropping a 16:9 to 1:1).

**Anti-patterns:**

- Long compound edit instructions ("change A and B and C and D") → drift increases per added scope.
- Missing preservation goals → model subtly rewrites the face / brand / framing.
- Paraphrasing in-image text instead of quoting it → text comes out different.
- Asking for `size` outside the 3 fixed values + `auto` → 422.

## Where it shines

| Use case                                                         | Why GPT Image Edit                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Multilingual ad localization**                                 | One source asset → many language variants of the same headline          |
| **Brand-safe headline / CTA swaps**                              | Layout precision + preservation language hold the rest stable           |
| **Multi-ref composition (subject from one, scene from another)** | Numbered refs route cues correctly                                      |
| **Layout-precise repositioning**                                 | Directional language ("top-right to bottom-center") honored             |
| **Identity preservation across signage edits**                   | Strongest in class for face / brand preservation through targeted edits |

## Sample prompts (verified to produce strong results)

**Background swap with full preservation (page example):**

```
Turn the background into a bright minimal white-to-soft-gray studio
sweep with gentle floor shadow; add a large headline in-image that
reads "OPEN STUDIO" in a bold clean sans-serif, high contrast, centered;
keep the main person or product, pose, and face identity unchanged
```

**Multilingual variant:**

```
Keep the photograph, layout, lighting, and brand mark exactly as in the
input. Replace only the in-image headline.
The new headline reads "コーヒー" in bold Japanese kana, same position
and font weight as before.
```

**Multi-ref composition:**

```
Compose subject from image 1 into the kitchen from image 2.
Match the warm window light and color palette of image 2.
Keep subject identity (face, pose, clothing) from image 1 unchanged.
```

## Limitations

- **`size`: 3 fixed values + `auto`** — anything else 422s.
- **`images`: up to 10** — first is primary, rest are auxiliary cues.
- **Long compound prompts drift** — split into multiple passes when needed.
- **For batch consistency across many SKU images, Nano Banana Edit (up to 20) is better.**
- **Photorealism on portraits** — Nano Banana Pro wins head-to-head.

## Exit codes

| code | meaning                          |
| ---- | -------------------------------- |
| 0    | success                          |
| 64   | bad CLI args                     |
| 65   | bad input JSON / schema mismatch |
| 69   | upstream 5xx                     |
| 75   | retryable: timeout / 429         |
| 77   | not signed in or token rejected  |

Full reference: [docs.runcomfy.com/cli/troubleshooting](https://docs.runcomfy.com/cli/troubleshooting?utm_source=skills.sh&utm_medium=skill&utm_campaign=gpt-image-edit).

## How it works

The skill invokes `runcomfy run openai/gpt-image-2/edit` with a JSON body matching the schema. The CLI POSTs to `https://model-api.runcomfy.net/v1/models/openai/gpt-image-2/edit`, polls the request, fetches the result, and downloads any `.runcomfy.net`/`.runcomfy.com` URL into `--output-dir`. `Ctrl-C` cancels the remote request before exit.

## Security & Privacy

- **Token storage**: `runcomfy login` writes the API token to `~/.config/runcomfy/token.json` with mode 0600 (owner-only read/write). Set `RUNCOMFY_TOKEN` env var to bypass the file entirely in CI / containers.
- **Input boundary**: the user prompt is passed as a JSON string to the CLI via `--input`. The CLI does NOT shell-expand the prompt; it transmits the JSON body directly to the Model API over HTTPS. No shell injection surface from prompt content.
- **Third-party content**: image / mask / video URLs you pass are fetched by the RunComfy model server, not by the CLI on your machine. Treat external URLs as untrusted; image-based prompt injection is a known risk for any image-edit / video-edit model.
- **Outbound endpoints**: only `model-api.runcomfy.net` (request submission) and `*.runcomfy.net` / `*.runcomfy.com` (download whitelist for generated outputs). No telemetry, no callbacks.
- **Generated-file size cap**: the CLI aborts any single download > 2 GiB to prevent disk-fill from a malicious or runaway model output.
