---
name: maka-theme
description: Make a theme (colors, corners, lines, shadow, font) for the Maka app from what the person describes, or change one, as a maka-theme block they can apply. Use when the person asks for a theme, a color scheme, a look, a palette, dark or light colors, or how Maka looks.
license: Apache-2.0
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Maka theme

A theme is drawn by the person's own device. You cannot apply it. Write it in your reply as one
code block fenced with ```maka-theme; the conversation shows the block as a card with a preview
in light and dark and an Apply button. The person applies it, can undo it, and can fine-tune it in
Settings › General › Theme.

Never say you applied or changed the theme. Tell the person to press Apply on the card.

## The block

The block holds one JSON object, with no comments:

```maka-theme
{
  "name": "Late-night café",
  "base": "paper",
  "cssVars": {
    "light": { "background": "#f3ebe0", "foreground": "#2b211b", "primary": "#9a4a2a" },
    "dark": { "background": "#1c1714", "foreground": "#eadfd3", "primary": "#d08a5c" },
    "theme": { "radius": 10, "shadow-y": 2, "shadow-blur": 12, "shadow-opacity": 0.08 }
  }
}
```

- `name`: what the theme is called, up to 40 characters, in the person's language.
- `base`: the preset nearest in spirit. The theme starts as that preset; every value you write
  replaces the preset's. Write only what differs, and always the three main colors of each
  appearance.
- `cssVars.light` and `cssVars.dark`: colors as `#rrggbb`. Write both, even for a theme described
  as dark ("late night") or light: the device shows whichever its appearance is.
- `cssVars.theme`: font and shape.

Values that are not valid are left out, and the card says so. Keep to the names and ranges below.

## Presets

| `base` | Character |
| --- | --- |
| `default` | Neutral gray and blue, rounded |
| `mono` | Black and white, no accent color |
| `paper` | Warm paper, red ink, serif, slightly spaced letters |
| `morandi` | Muted gray-green, soft shadow, round corners |
| `terminal` | Retro amber and green, monospace, square, green glow |
| `blueprint` | Blue paper, monospace |
| `bauhaus` | Off-white, black lines 2 pt, red or yellow accent, geometric font, square |
| `brutalist` | Cream, black lines 2 pt, yellow accent, hard offset shadow |

## Colors

| Name | What it colors | Rule |
| --- | --- | --- |
| `background` | The conversation and panels | |
| `foreground` | Text | Contrast at least 4.5:1 against `background` |
| `primary` | Accent: buttons, links, selection | Text on it is black or white, chosen for it |
| `card` | Sidebar and cards (optional) | One small step lighter or darker than `background` |
| `border` | Lines (optional) | Low contrast against `background` |
| `muted-foreground` | Secondary text (optional) | Contrast at least 4.5:1 against `background` |
| `shadow-color` | The shadow (optional, black when left out) | On a dark background, near black or a dark gray, never a light or bright color |

Leave out the optional colors unless the description needs them: the app derives them from the
three main colors and keeps them readable.

## Font and shape

| Name | Range | Default |
| --- | --- | --- |
| `font-sans` | One of the three lists below; leave out for the system font | system |
| `radius` | 0 to 20 (corner radius of a control, pt) | 8 |
| `border-width` | 1, 1.5, 2 or 3 (pt) | 1 |
| `letter-spacing` | -0.5 to 1.5 (pt) | 0 |
| `shadow-x`, `shadow-y` | -12 to 12 (pt) | 0 |
| `shadow-blur` | 0 to 32 (pt) | 0 |
| `shadow-spread` | -8 to 8 (pt) | 0 |
| `shadow-opacity` | 0 to 1; 0 is no shadow | 0 |

`font-sans` must be exactly one of:

- Serif: `Georgia, "Songti SC", "Noto Serif CJK SC", serif`
- Monospace: `Menlo, Consolas, "PingFang SC", monospace`
- Geometric: `Futura, "Century Gothic", "PingFang SC", sans-serif`

Be restrained. A soft shadow is about `"shadow-y": 2, "shadow-blur": 12, "shadow-opacity": 0.08`;
a hard one is `"shadow-x": 4, "shadow-y": 4, "shadow-opacity": 1` with no blur.

## Changing a theme

Start from the latest maka-theme block in the conversation, or from a theme the person pasted
(Settings › General › Theme › Copy theme copies the current one). Change only what was asked and
write the whole block again. If you have neither, ask the person to copy their theme and paste it;
do not guess it.

When the person wants options, give at most three blocks, each with its own name.

Do not use a ```spec block for a theme, and do not write a theme to a file.
