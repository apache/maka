---
name: fish-audio
description: Text-to-speech and voice synthesis using Fish Audio. Supports multiple languages, voice cloning, and custom voice creation. Use this skill when the user needs TTS, voice cloning, or speech synthesis.
allowed-tools:
  - Bash(curl *)
---

# Fish Audio — Text-to-Speech & Voice Synthesis

AI text-to-speech and voice synthesis using **Fish Audio** via AceDataCloud API. Supports Chinese, English, Japanese, Korean and more.

## Prerequisites

- AceDataCloud API key (`ACEDATACLOUD_API_KEY`)

## Usage

### Text-to-Speech

```bash
curl -X POST "https://api.acedatacloud.com/v1/fish/tts" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "text": "欢迎使用 AI 语音合成，本系统支持多种语言和音色选择。",
    "voice": "zh-CN-female-studio",
    "speed": 1.0
  }'
```

### Voice Cloning

```bash
curl -X POST "https://api.acedatacloud.com/v1/fish/voice-clone" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "audio_url": "https://example.com/sample_speech.mp3",
    "voice_name": "my-custom-voice"
  }'
```

### Multi-Language TTS

```bash
curl -X POST "https://api.acedatacloud.com/v1/fish/tts" \
  -H "Authorization: Bearer $ACEDATACLOUD_API_KEY" \
  -d '{
    "text": "Hello, this is a multilingual TTS demo.",
    "voice": "en-US-female-studio",
    "speed": 1.0
  }'
```

## Parameters

| Param     | Description                                 |
| --------- | ------------------------------------------- |
| `voice`   | Voice ID or name (language-gender-style)    |
| `speed`   | 0.5–2.0 playback speed                      |
| `emotion` | Optional: `happy`, `sad`, `excited`, `calm` |

## Best Practices

1. Provide 30-60s of clean reference audio for best voice cloning results
2. Voice creation supports Chinese, English, Japanese, Korean
3. Use emotion parameter for expressive narration
