---
name: video-inpainting
description: Remove or replace unwanted objects, people, or artifacts in video frames using AI inpainting. Use this skill when the user needs to erase elements from video footage.
allowed-tools:
  - Bash(curl *)
---

# Video Inpainting

Remove or replace unwanted objects, people, text, or artifacts from video footage while maintaining natural motion and background consistency.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/video/inpaint" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "video_url": "https://example.com/video.mp4",
    "mask_prompt": "Remove the red car from the scene",
    "frames": "all"
  }'
```

## Parameters

| Param | Description |
|-------|-------------|
| `mask_prompt` | Describe what to remove in natural language |
| `frames` | `all` or specific frame range like `0-30` |

## Best Practices

1. Be specific in mask prompt: "Remove the person in blue jacket" not just "Remove person"
2. For best results on long videos, process in segments
3. Stationary backgrounds yield better inpainting than rapidly moving scenes
