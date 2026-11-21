---
name: suno-music
description: Generate AI music, lyrics, covers, and vocal extraction using Suno AI. Use this skill when the user wants to create original music, generate lyrics, produce song covers, or extract vocals from existing tracks.
allowed-tools:
  - Bash(curl *)
  - Bash(echo *)
---

# Suno Music — AI Music Generation

Generate AI music using **Suno AI** via the AceDataCloud API. Create original songs, generate lyrics, produce covers, and extract vocals.

## Prerequisites

- AceDataCloud API key (`ACEDATACLOUD_API_KEY` environment variable)
- Or use [SunoMCP](https://github.com/AceDataCloud/SunoMCP) server

## Capabilities

| Capability            | Description                                    |
| --------------------- | ---------------------------------------------- |
| **Text-to-Music**     | Generate original music from text descriptions |
| **Lyrics Generation** | Auto-generate lyrics for a given theme/style   |
| **Song Cover**        | Create a cover version of an existing song     |
| **Vocal Extraction**  | Separate vocals from instrumental tracks       |
| **Track Extension**   | Extend an existing audio track                 |

## Usage Examples

### Generate Music from Description

```bash
curl -X POST "https://api.acedatacloud.com/v1/suno/music" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "An upbeat indie pop song with electric guitar and catchy chorus, 120 BPM",
    "style": "indie pop",
    "duration": 30,
    "instrumental": false
  }'
```

### Generate Lyrics

```bash
curl -X POST "https://api.acedatacloud.com/v1/suno/lyrics" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "theme": "sunset beach memories",
    "style": "acoustic ballad",
    "structure": "verse-chorus-verse-chorus-bridge-chorus"
  }'
```

### Vocal Extraction

```bash
curl -X POST "https://api.acedatacloud.com/v1/suno/vocal-extract" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "audio_url": "https://example.com/song.mp3",
    "output": "vocals-only"
  }'
```

## Best Practices

1. **Be specific about genre**: Include genre, BPM, instruments, and mood in prompts
2. **Song structure**: Specify verse/chorus/bridge structure for better results
3. **Reference tracks**: Mention artists or songs for style reference
4. **Short first**: Generate 15-30 second previews before committing to full length
