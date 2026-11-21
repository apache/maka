---
name: lipsync
description: Synchronize lip movements in video with new audio using AI lip-sync technology. Use this skill when the user wants to change the spoken audio of a video and have the speaker's lips match the new words.
allowed-tools:
  - Bash(curl *)
---

# Lip Sync

Synchronize a speaker's lip movements in video to match new or replacement audio. Supports multiple languages and preserves original facial expressions.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/video/lipsync" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "video_url": "https://example.com/speaker.mp4",
    "audio_url": "https://example.com/new_audio.mp3",
    "sync_mode": "accurate"
  }'
```

## Parameters

| Param | Description |
|-------|-------------|
| `audio_url` | The replacement audio track |
| `sync_mode` | `accurate` (precise lip match) or `smooth` (natural, less precise) |
| `face_mask` | Optional: specify face region for focused processing |

## Best Practices

1. Use clean audio without background noise for best sync quality
2. Speaker should be facing the camera with visible lips
3. `smooth` mode is better for casual content, `accurate` for professional dubbing
4. For non-English languages, ensure the video subject naturally speaks that language
