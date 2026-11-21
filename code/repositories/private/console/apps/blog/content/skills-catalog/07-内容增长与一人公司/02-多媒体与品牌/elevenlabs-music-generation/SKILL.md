---
name: elevenlabs-music-generation
description: Generate music using ElevenLabs AI — supports text-to-music, style transfer, and music variation. Use this skill when the user wants to generate background music, jingles, or custom tracks via ElevenLabs.
allowed-tools:
  - Bash(curl *)
---

# ElevenLabs Music Generation

Generate AI music using **ElevenLabs**. Create original music tracks from text descriptions, generate variations, and apply style transfer.

## Prerequisites

- ElevenLabs API key (`ELEVENLABS_API_KEY`)

## Usage

### Text-to-Music
```bash
curl -X POST "https://api.elevenlabs.io/v1/music/generate" \
  -H "Authorization: Bearer $ELEVENLABS_API_KEY" \
  -d '{
    "prompt": "Ambient electronic background music for a tech product video, 120 BPM",
    "duration": 30,
    "style": "ambient electronic"
  }'
```

### Music Variation
```bash
curl -X POST "https://api.elevenlabs.io/v1/music/variation" \
  -H "Authorization: Bearer $ELEVENLABS_API_KEY" \
  -d '{
    "audio_url": "https://example.com/track.mp3",
    "variation_type": "instrumental",
    "duration": 30
  }'
```

## Parameters

| Param | Description |
|-------|-------------|
| `prompt` | Music description including genre, mood, instruments |
| `duration` | 10–180 seconds |
| `style` | Genre/style tag (e.g., `cinematic`, `lofi`, `electronic`) |

## Best Practices

1. Specify genre, BPM, and mood for predictable results
2. Generate 15-30s first, then extend once you like the style
3. Use `variation_type: instrumental` to get background tracks from existing songs
