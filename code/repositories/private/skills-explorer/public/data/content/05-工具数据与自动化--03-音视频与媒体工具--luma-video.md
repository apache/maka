---
name: luma-video
description: Generate AI videos with Luma Dream Machine via AceDataCloud API. Supports text-to-video, image-to-video, and video extension. Use this skill when the user wants to create, extend, or enhance videos using Luma's video generation model.
allowed-tools:
  - Bash(curl *)
  - Bash(npx @acedatacloud/luma *)
  - Bash(echo *)
---

# Luma Video Generation

Generate AI videos using **Luma Dream Machine** via the AceDataCloud API. Supports text-to-video, image-to-video, and video extension workflows.

## Prerequisites

- AceDataCloud API key configured (environment variable `ACEDATACLOUD_API_KEY`)
- Or use the [LumaMCP](https://github.com/AceDataCloud/LumaMCP) server

## Parameters

| Parameter      | Type    | Description                                          |
| -------------- | ------- | ---------------------------------------------------- |
| `prompt`       | string  | Text description of the video content                |
| `action`       | enum    | `text-to-video`, `image-to-video`, `video-extension` |
| `aspect_ratio` | string  | `16:9`, `9:16`, `1:1`, `4:3`                         |
| `loop`         | boolean | Enable seamless looping                              |
| `enhancement`  | boolean | Apply video enhancement                              |
| `duration`     | number  | Target duration in seconds (5–30)                    |

## Usage Examples

### Text-to-Video

```bash
curl -X POST "https://api.acedatacloud.com/v1/luma/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A cinematic aerial shot of a futuristic city at sunset with flying cars",
    "aspect_ratio": "16:9",
    "duration": 10
  }'
```

### Image-to-Video

```bash
curl -X POST "https://api.acedatacloud.com/v1/luma/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "prompt": "A serene lake scene at dawn",
    "action": "image-to-video",
    "start_image_url": "https://example.com/start.jpg"
  }'
```

## Video Extension

```bash
curl -X POST "https://api.acedatacloud.com/v1/luma/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "action": "video-extension",
    "input_video_url": "https://example.com/input.mp4"
  }'
```

## Polling for Results

After initiating generation, poll the status endpoint:

```bash
curl -s "https://api.acedatacloud.com/v1/luma/video/${generation_id}" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY"
```

## Best Practices

1. **Prompt detail**: Be specific about camera motion, lighting, color palette, and subject behavior
2. **Reference images**: Provide high-quality reference images for better consistency
3. **Aspect ratio**: Match to target platform (16:9 for YouTube, 9:16 for TikTok/Reels)
4. **Short videos work best**: 5–10 second clips produce the most consistent results
