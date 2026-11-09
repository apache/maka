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
use crate::event::ProjectionArtifactWrite;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::time::SystemTime;

use crate::durable::ExecutionIdentity;

pub fn valid_mime(mime: &str) -> bool {
    mime.strip_prefix("audio/").is_some_and(|subtype| {
        !subtype.is_empty()
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
    execution: &ExecutionIdentity,
) -> Option<(ProjectionPart, Option<ProjectionArtifactWrite>)> {
    let mime = match mime.trim().to_ascii_lowercase().as_str() {
        "audio/x-wav" | "audio/wave" => "audio/wav".to_string(),
        "audio/mp3" => "audio/mpeg".to_string(),
        value => value.to_string(),
    };
    if !valid_mime(&mime) {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.is_empty() || STANDARD.encode(&bytes) != data {
        return None;
    }
    let (reference, artifact) =
        super::media::media_artifact(bytes, &mime, id, part, time, execution).ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_short_and_long_audio_keep_owned_evidence() {
        let execution = ExecutionIdentity {
            session_id: "s".into(),
            turn_id: "t".into(),
            run_id: crate::durable::RunId::try_from(uuid::Uuid::from_u128(1)).unwrap(),
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
                &execution,
            )
            .unwrap();
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
        assert!(
            project(
                "invalid",
                "audio/wav",
                "e",
                0,
                std::time::UNIX_EPOCH,
                &execution
            )
            .is_none()
        );
    }
}
