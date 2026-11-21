---
name: video-outpainting
description: Expand video frames beyond their original boundaries using AI outpainting. Extend the scene in any direction while maintaining visual consistency. Use this skill when the user needs to change aspect ratio or add content around the original frame.
allowed-tools:
  - Bash(curl *)
---

# Video Outpainting

Expand video frames beyond the original boundaries — add content above, below, left, or right of the frame. Useful for changing aspect ratios or adding contextual environment.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/video/outpaint" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "video_url": "https://example.com/video.mp4",
    "expand": {
      "top": 100,
      "bottom": 100,
      "left": 0,
      "right": 200
    },
    "prompt": "Extend the landscape with mountains and sky"
  }'
```

## Parameters

| Param          | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `expand`       | Pixels to add per direction: `{top, bottom, left, right}`         |
| `prompt`       | Description of what should appear in the expanded area            |
| `aspect_ratio` | Target ratio (e.g., `16:9`, `9:16`) — alternative to pixel expand |

## Best Practices

1. Use pixel expand for precise control, aspect_ratio for standard conversions
2. Provide clear prompts for the expanded areas to guide generation
3. Expand in smaller increments (50–100px) for better quality with complex scenes
