---
name: video-edit
description: AI-powered video editing, extension, inpainting, outpainting, lip-sync, and face-swap. Use this when the user needs to edit, modify, extend, or enhance existing videos.
allowed-tools:
  - Bash(curl *)
  - Bash(echo *)
---

# Video Editing & Manipulation

AI-powered video editing tools for post-production: video extension, inpainting, outpainting, lip-sync, and face-swap.

## Capabilities

| Capability            | Description                                    |
| --------------------- | ---------------------------------------------- |
| **Video Edit**        | Trim, cut, merge, apply transitions            |
| **Video Extend**      | Extend footage beyond original duration        |
| **Video Inpainting**  | Remove or replace objects in video frames      |
| **Video Outpainting** | Expand frame beyond original boundaries        |
| **Lip Sync**          | Synchronize lip movements with new audio       |
| **Face Swap**         | Replace faces while maintaining natural motion |

## Usage Examples

### Video Inpainting

```bash
curl -X POST "https://api.runcomfy.com/v1/video/inpaint" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{"video_url": "https://example.com/video.mp4", "mask_prompt": "Remove the red car", "frames": "all"}'
```

### Lip Sync

```bash
curl -X POST "https://api.runcomfy.com/v1/video/lipsync" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{"video_url": "https://example.com/speaker.mp4", "audio_url": "https://example.com/new_audio.mp3"}'
```

## Best Practices

1. **High quality source**: Start with the highest resolution source video
2. **Mask precision**: For inpainting, be very specific about what to remove
3. **Audio sync**: Use clean audio for best lip-sync results
