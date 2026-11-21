---
name: face-swap
description: Replace faces in video with another face using AI face-swap technology. Use this skill when the user wants to change a person's face in video footage while preserving natural expressions and motion.
allowed-tools:
  - Bash(curl *)
---

# Face Swap

Replace faces in video with a reference face image. Preserves natural expressions, head movements, and lighting while applying the new facial features.

## Usage

```bash
curl -X POST "https://api.runcomfy.com/v1/video/face-swap" \
  -H "Authorization: Bearer $RUNCOMFY_API_KEY" \
  -d '{
    "video_url": "https://example.com/video.mp4",
    "face_image_url": "https://example.com/reference_face.jpg",
    "target_person": "person_1"
  }'
```

## Parameters

| Param            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `face_image_url` | Reference image of the face to swap in                           |
| `target_person`  | Specify which person in the video to replace (if multiple faces) |
| `frames`         | `all` or specific range                                          |

## Best Practices

1. Use a high-quality, front-facing reference photo with good lighting
2. The reference face should have a similar head angle to the source for best results
3. For videos with multiple people, use `target_person` to specify
4. Short clips (under 30s) produce the most consistent results
