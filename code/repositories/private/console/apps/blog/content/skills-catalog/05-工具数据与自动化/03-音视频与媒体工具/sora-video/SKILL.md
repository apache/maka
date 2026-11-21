---
name: sora-video
description: Generate AI videos with OpenAI Sora. Supports text-to-video, image-to-video, and video editing via the OpenAI API. Use this skill when the user wants to create videos using OpenAI's Sora model.
allowed-tools:
  - Bash(curl *)
  - Bash(echo *)
---

# Sora Video Generation

Generate AI videos using **OpenAI Sora**. Create stunning videos from text descriptions or reference images.

## Prerequisites

- OpenAI API key configured (environment variable `OPENAI_API_KEY`)

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | string | Detailed text description of the video |
| `model` | string | `sora-1` or `sora-1-pro` |
| `n` | number | Number of videos to generate (1–4) |
| `size` | string | Resolution: `1920x1080`, `1080x1920`, `1080x1080` |
| `duration` | enum | `short` (5s), `medium` (10s), `long` (20s) |

## Usage Examples

### Text-to-Video
```bash
curl -X POST "https://api.openai.com/v1/video/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sora-1",
    "prompt": "A majestic wolf running through a snowy forest at golden hour",
    "size": "1920x1080",
    "duration": "medium"
  }'
```

### Image-to-Video
```bash
curl -X POST "https://api.openai.com/v1/video/generations" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "sora-1",
    "prompt": "A peaceful garden panorama",
    "image": "https://example.com/reference.jpg",
    "size": "1920x1080"
  }'
```

## Best Practices

1. **Detailed prompts**: Include camera movement, mood, lighting, and composition
2. **Pro model**: Use `sora-1-pro` for higher quality production work
3. **Resolution**: Match output resolution to target platform
