---
name: veo-video
description: Generate AI videos with Google Veo — supports text-to-video with native audio generation. High-quality cinematic output with realistic motion. Use this skill when the user wants to create videos using Google's Veo model.
allowed-tools:
  - Bash(curl *)
---

# Veo Video — Google Veo AI Video Generation

Generate high-quality AI videos using **Google Veo** via the AceDataCloud API. Supports text-to-video with native audio track generation.

## Prerequisites

- AceDataCloud API key (`ACEDATACLOUD_API_KEY`)

## Usage

```bash
curl -X POST "https://api.acedatacloud.com/v1/veo/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A cinematic drone shot over a misty mountain range at sunrise",
    "aspect_ratio": "16:9",
    "duration": 10,
    "generate_audio": true
  }'
```

## Parameters

| Param            | Description                             |
| ---------------- | --------------------------------------- |
| `prompt`         | Detailed video description              |
| `aspect_ratio`   | `16:9`, `9:16`, `1:1`                   |
| `duration`       | 5–30 seconds                            |
| `generate_audio` | `true` to generate native ambient audio |

## Best Practices

1. Veo excels at cinematic, realistic scenes — emphasize lighting and camera motion
2. Enable `generate_audio` for videos that need ambient sound effects
3. Use detailed visual descriptions for best results (mood, lighting, camera angle)
