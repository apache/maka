---
name: producer-music
description: AI music production — create songs, covers, track extension, and vocal swapping. Use this skill when the user wants advanced music production capabilities via AceDataCloud.
allowed-tools:
  - Bash(curl *)
---

# Producer Music — AI Music Production

Advanced AI music production via AceDataCloud API. Create original music, remix tracks, swap vocals, and extend existing songs.

## Usage

### Track Extension

```bash
curl -X POST "https://api.acedatacloud.com/v1/producer/extend" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "audio_url": "https://example.com/snippet.mp3",
    "duration": 60,
    "style": "Continue in the same genre and mood"
  }'
```

### Vocal Swap

```bash
curl -X POST "https://api.acedatacloud.com/v1/producer/vocal-swap" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "audio_url": "https://example.com/original.mp3",
    "vocal_style": "female pop vocal, airy and bright"
  }'
```

### Song Cover

```bash
curl -X POST "https://api.acedatacloud.com/v1/producer/cover" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "audio_url": "https://example.com/original.mp3",
    "genre": "jazz",
    "mood": "relaxed, intimate"
  }'
```

## Best Practices

1. For covers, specify a genre transformation for best results
2. Track extension works best with 15-30s source snippets
3. Vocal swap is ideal for demoing different vocal styles on the same instrumental
