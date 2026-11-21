---
name: video-extend
description: Extend existing video footage beyond original duration using AI. Continue video motion naturally — forward or backward. Use this skill when the user wants to make a video longer by generating additional frames.
allowed-tools:
  - Bash(curl *)
---

# Video Extend

AI-powered video extension that generates additional frames to extend video clips beyond their original duration.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/video/extend" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "video_url": "https://example.com/clip.mp4",
    "extend_seconds": 5,
    "direction": "forward"
  }'
```

## Parameters

| Param            | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `extend_seconds` | Duration to extend (1–30s)                                        |
| `direction`      | `forward` (continue action) or `backward` (prequel)               |
| `prompt`         | Optional description of what should happen in the extended frames |

## Best Practices

1. Keep extensions under 10s for best consistency with the original clip
2. Provide a prompt describing the expected continuation for predictable results
3. Use short source clips (3–5s) for the most natural extensions
