/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Audio evidence shared by Code Mode and MCP outputs.
use super::{AudioOutput, ProjectionPart};
use crate::event::{Invocation, ProjectionArtifactWrite};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::time::SystemTime;

pub fn valid_mime(mime: &str) -> bool {
    mime.strip_prefix("audio/").is_some_and(|subtype| {
        !subtype.is_empty()
            && subtype.len() <= 100
            && subtype
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".+-".contains(&b))
    })
}

pub(super) fn project(
    data: &str,
    mime: &str,
    id: &str,
    part: usize,
    time: SystemTime,
    invocation: &Invocation,
) -> Option<(ProjectionPart, Option<ProjectionArtifactWrite>)> {
    let mime = match mime.trim().to_ascii_lowercase().as_str() {
        "audio/x-wav" | "audio/wave" => "audio/wav".to_string(),
        "audio/mp3" => "audio/mpeg".to_string(),
        value => value.to_string(),
    };
    if !valid_mime(&mime) || data.len() > super::media::MAX_MEDIA_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.is_empty()
        || bytes.len() > super::media::MAX_MEDIA_BYTES
        || STANDARD.encode(&bytes) != data
    {
        return None;
    }
    if wav_shorter_than_25ms(&bytes) == Some(true) {
        return Some((ProjectionPart::Text { text: "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.".into() }, None));
    }
    let (reference, artifact) =
        super::media::media_artifact(bytes, &mime, id, part, time, invocation).ok()?;
    Some((
        ProjectionPart::Audio {
            audio: AudioOutput {
                mime_type: mime,
                reference,
            },
        },
        Some(artifact),
    ))
}

/// Count actual PCM frames, including WAVs with a streaming/oversized data header.
fn wav_shorter_than_25ms(bytes: &[u8]) -> Option<bool> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut format = None;
    while let Some(header) = bytes.get(offset..offset.checked_add(8)?) {
        let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
        offset = offset.checked_add(8)?;
        let available = bytes.get(offset..)?;
        let chunk = &available[..size.min(available.len())];
        match &header[..4] {
            b"fmt " => {
                let mut encoding = u16::from_le_bytes(chunk.get(..2)?.try_into().ok()?);
                if encoding == 0xfffe {
                    if chunk.get(26..40)?
                        != [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
                    {
                        return None;
                    }
                    encoding = u16::from_le_bytes(chunk.get(24..26)?.try_into().ok()?);
                }
                if !matches!(encoding, 1 | 3) {
                    return None;
                }
                let rate = u32::from_le_bytes(chunk.get(4..8)?.try_into().ok()?);
                let align = u16::from_le_bytes(chunk.get(12..14)?.try_into().ok()?);
                if rate == 0 || align == 0 {
                    return None;
                }
                format = Some((rate, align));
            }
            b"data" => {
                let (rate, align) = format?;
                return Some(
                    (chunk.len() / usize::from(align)) as u64 * 1000 < u64::from(rate) * 25,
                );
            }
            _ => {}
        }
        offset = offset.checked_add(size)?.checked_add(size % 2)?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_pcm_frames_control_short_clip_omission_and_audio_keeps_owned_evidence() {
        let invocation = Invocation {
            session_id: "s".into(),
            turn_id: "t".into(),
            run_id: "r".into(),
            invocation_id: "i".into(),
        };
        for samples in [199usize, 200, 201] {
            let mut wav = b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\xff\xff\xff\xff".to_vec();
            wav.resize(44 + samples * 2, 0);
            let (part, artifact) = project(
                &STANDARD.encode(&wav),
                "audio/wav",
                "e",
                0,
                std::time::UNIX_EPOCH,
                &invocation,
            )
            .unwrap();
            if samples < 200 {
                assert!(matches!(part, ProjectionPart::Text { text } if text.contains("25 ms")));
                assert!(artifact.is_none());
            } else {
                let artifact = artifact.unwrap();
                assert_eq!(artifact.bytes(), wav);
                assert_eq!(
                    artifact.artifact().source,
                    crate::artifact::ArtifactSource::ToolResultProjection
                );
                super::super::DurableToolProjection::Content { parts: vec![part] }
                    .validate("s")
                    .unwrap();
            }
        }
        assert!(
            project(
                "invalid",
                "audio/wav",
                "e",
                0,
                std::time::UNIX_EPOCH,
                &invocation
            )
            .is_none()
        );
    }
}
