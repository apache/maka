---
name: ai-music
description: General AI music generation — create original music tracks across genres. Use this skill when the user wants to generate background music, jingles, or custom songs without specifying a particular provider.
allowed-tools:
  - Bash(curl *)
---

# AI Music — General Music Generation

General-purpose AI music generation via RunComfy. Create original music across genres — from cinematic scores to pop songs, ambient backgrounds to energetic beats.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/music/generate" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "prompt": "Upbeat corporate background music with piano and strings",
    "duration": 30,
    "genre": "corporate"
  }'
```

## Parameters

| Param      | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `prompt`   | Music description (genre, mood, instruments)                     |
| `duration` | 10–120 seconds                                                   |
| `genre`    | `cinematic`, `pop`, `electronic`, `lofi`, `corporate`, `ambient` |

## Best Practices

1. For best results, describe instruments, tempo, and mood
2. Genre presets help the model understand the target style
3. Use shorter generations (15–30s) for prototyping before full length
4. For project-specific music, combine with video-edit or pexo-agent
