---
name: seedance-video
description: Generate AI videos with ByteDance Seedance — optimized for dance, motion, and dynamic scenes. Use this skill when the user wants to create dance videos, motion-heavy content, or energetic scenes.
allowed-tools:
  - Bash(curl *)
---

# Seedance Video — ByteDance Seedance AI Video Generation

Generate AI videos using **ByteDance Seedance** via AceDataCloud API. Specialized in dance choreography, motion dynamics, and high-energy scenes.

## Prerequisites

- AceDataCloud API key (`ACEDATACLOUD_API_KEY`)

## Usage

```bash
curl -X POST "https://api.acedatacloud.com/v1/seedance/video" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A person doing contemporary dance in a studio with dramatic lighting",
    "motion_type": "dance",
    "duration": 15,
    "aspect_ratio": "9:16"
  }'
```

## Parameters

| Param          | Description                               |
| -------------- | ----------------------------------------- |
| `prompt`       | Video description with motion details     |
| `motion_type`  | `dance`, `sports`, `walking`, `cinematic` |
| `duration`     | 5–30 seconds                              |
| `aspect_ratio` | `16:9`, `9:16`, `1:1`                     |

## Best Practices

1. Seedance excels at dance and body movement — describe specific motions
2. Use `motion_type: dance` for choreographed movement, `cinematic` for general scenes
3. 9:16 aspect ratio works well for TikTok/Reels style dance content
4. Combine with pexo-agent for full music+dance video production
