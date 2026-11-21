---
name: kling-video
description: Generate AI videos with Kuaishou Kling — supports text-to-video, image-to-video with advanced motion control. Use this skill when the user wants to create videos with precise motion control.
allowed-tools:
  - Bash(curl *)
---

# Kling Video — Kuaishou Kling AI Video Generation

Generate AI videos using **Kuaishou Kling** via AceDataCloud API. Known for excellent motion control and physics simulation.

## Prerequisites

- AceDataCloud API key (`ACEDATACLOUD_API_KEY`)

## Usage

```bash
curl -X POST "https://api.acedatacloud.com/v1/kling/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A white horse galloping across a grassy field, slow motion",
    "motion_strength": 0.8,
    "aspect_ratio": "16:9"
  }'
```

## Parameters

| Param | Description |
|-------|-------------|
| `prompt` | Detailed video description |
| `motion_strength` | 0–1.0, controls movement intensity |
| `aspect_ratio` | `16:9`, `9:16`, `1:1` |
| `image_url` | Optional: reference image as starting frame |

## Best Practices

1. Kling excels at realistic physics — use prompts involving motion, fluid, or particles
2. Lower motion_strength (0.3–0.5) for subtle movements, higher (0.7–1.0) for dynamic action
3. Image-to-video works well for consistent character/scene continuation
