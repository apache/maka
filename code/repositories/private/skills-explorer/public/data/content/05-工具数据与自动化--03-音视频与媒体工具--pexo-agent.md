---
name: pexo-agent
description: Full video production pipeline using Pexo — from script/prompt to finished multi-shot video with music, subtitles, and transitions. Auto model selection across 10+ models (Seedance 2, Kling 3.0, Veo, Grok, MiniMax, etc.). Use this when the user wants to produce complete videos from natural language, URLs, scripts, or images.
allowed-tools:
  - Bash(pexo-upload *)
  - Bash(pexo-chat *)
  - Bash(pexo-project-get *)
---

# Pexo Agent — Full Video Production Pipeline

Pexo is an AI video production pipeline that takes a conversation, script, or URL and delivers a finished multi-shot video with music, subtitles, and transitions.

## How It Works

The agent acts as a delivery worker between the user and Pexo's backend:

1. **Upload** — user provides files/images → `pexo-upload.sh`
2. **Relay** — forward user's request → `pexo-chat.sh`
3. **Poll & Deliver** — poll for status → `pexo-project-get.sh` → deliver final video URL

## Key Capabilities

| Feature           | Details                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| **Models**        | Seedance 2, Kling 3.0, HappyHorse, Veo 3.1, Grok, MiniMax, Hunyuan, PixVerse |
| **Input**         | Text, images, URLs, scripts, audio                                           |
| **Output**        | Multi-shot video + music + subtitles + transitions                           |
| **Length**        | 5–120 seconds                                                                |
| **Aspect Ratios** | 16:9, 9:16, 1:1                                                              |

## Workflow

### 1. Upload Assets

```bash
pexo-upload.sh --files video_assets/*.jpg
```

### 2. Send Request

```bash
pexo-chat.sh --message "Create a 15-second product ad for a premium smartwatch. Style: cinematic, dark background, gold accents."
```

### 3. Poll for Status

```bash
pexo-project-get.sh --project-id <project_id>
```

States: `WAIT` → `RESPOND` → `DELIVER`

## Best Practices

1. **Be specific in prompts**: Include style, mood, color palette, camera movement
2. **Timing**: ~8 min for a 15s 3-shot ad, ~20 min for a 60s brand video
3. **Reference images**: Upload style frames for consistent visual identity
4. **Iterate**: Start with shorter drafts, refine prompt, then extend

## Installation

```bash
npx skills add https://github.com/pexoai/pexo-skills --skill pexo-agent
```
