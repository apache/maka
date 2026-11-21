---
name: hailuo-video
description: Generate AI videos with MiniMax Hailuo — supports text-to-video and image-to-video with strong visual quality. Use this skill when the user wants to create videos using MiniMax's Hailuo model.
allowed-tools:
  - Bash(curl *)
---

# Hailuo Video — MiniMax AI Video Generation

Generate AI videos using **MiniMax Hailuo** via AceDataCloud API. Known for strong visual quality and artistic style capabilities.

## Usage

```bash
curl -X POST "https://api.acedatacloud.com/v1/hailuo/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Anime style scene of a girl walking through a neon-lit city at night",
    "style": "anime",
    "aspect_ratio": "9:16"
  }'
```

## Parameters

| Param          | Description                                       |
| -------------- | ------------------------------------------------- |
| `prompt`       | Detailed video description                        |
| `style`        | `realistic`, `anime`, `cinematic`, `oil-painting` |
| `aspect_ratio` | `16:9`, `9:16`, `1:1`                             |

## Best Practices

1. Hailuo handles stylized/anime prompts exceptionally well
2. Use image-to-video with reference images for consistent characters
3. Short prompts work better than overly complex descriptions
