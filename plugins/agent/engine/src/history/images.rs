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

use maka_agent_facts::language::Language;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::attachment::sniff_binary_mime;
use maka_agent_facts::tool_output::AudioOutput;
use maka_agent_facts::tool_output::ImageOutput;
use maka_event_log::root_store::SessionStore;
use maka_model::prompt::{ContentPart, FileData, Message, ToolOutput};
use tokio_util::sync::CancellationToken;

use crate::RunError;

pub(super) fn no_vision(language: Language) -> &'static str {
    match language {
        Language::En => "Image was read, but the selected model does not support image input.",
        Language::ZhCn => "已读取图片，但所选模型不支持图片输入。",
        Language::ZhTw => "已讀取圖片，但所選模型不支援圖片輸入。",
    }
}

/// Targets borrow canonical evidence and are emitted alongside their messages.
/// Arbitrary JSON tool results cannot authorize a storage read.
pub(super) enum Target<'a> {
    Audio {
        message: usize,
        part: usize,
        audio: &'a AudioOutput,
    },
    User {
        message: usize,
        image: &'a AttachmentRef,
    },
    Tool {
        message: usize,
        part: usize,
        image: &'a ImageOutput,
    },
}

enum ImageRead {
    Bytes(Vec<u8>),
    Unavailable(String),
}

/// Resolve the structural media references belonging to one semantic page.
#[allow(clippy::too_many_arguments)]
pub(super) async fn materialize_targets<'a>(
    log: &SessionStore,
    session: &str,
    mut messages: Vec<Message>,
    targets: impl IntoIterator<Item = Target<'a>>,
    resources: &super::resources::Resources<'_>,
    cancellation: &CancellationToken,
    language: Language,
    snapshot: Option<&[maka_agent_facts::history::media::MediaBinding]>,
) -> Result<
    (
        Vec<Message>,
        Vec<maka_agent_facts::history::media::MediaBinding>,
    ),
    RunError,
> {
    use maka_agent_facts::history::media::MediaBinding;
    let mut bindings = Vec::new();
    for (index, target) in targets.into_iter().enumerate() {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let (reference, mime) = match &target {
            Target::Audio { audio, .. } => (&audio.reference, &audio.mime_type),
            Target::User { image, .. } => (&image.storage_ref, &image.mime_type),
            Target::Tool { image, .. } => (&image.reference, &image.mime_type),
        };
        let audio = matches!(target, Target::Audio { .. });
        let (read, binding) = if let Some(snapshot) = snapshot {
            let binding = snapshot.get(index).ok_or_else(|| {
                RunError::ReconciliationRequired("prepared media snapshot is incomplete".into())
            })?;
            let read = match binding {
                MediaBinding::Available { reference } => {
                    match read(log, session, reference, audio).await? {
                        value @ ImageRead::Bytes(_) => value,
                        ImageRead::Unavailable(_) => {
                            return Err(RunError::ReconciliationRequired(
                                "captured immutable media is unavailable".into(),
                            ));
                        }
                    }
                }
                MediaBinding::Unavailable { reason } => ImageRead::Unavailable(reason.clone()),
            };
            (read, binding.clone())
        } else {
            let resolved = resources.resolve(reference);
            let read = match resolved {
                Some(reference) => read(log, session, reference, audio).await?,
                None => ImageRead::Unavailable("session_mismatch".into()),
            };
            let binding = match &read {
                ImageRead::Bytes(_) => MediaBinding::Available {
                    reference: resolved.expect("available media has a reference").clone(),
                },
                ImageRead::Unavailable(reason) => MediaBinding::Unavailable {
                    reason: reason.clone(),
                },
            };
            (read, binding)
        };
        bindings.push(binding);
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let part = match read {
            ImageRead::Bytes(bytes) => ContentPart::File {
                data: FileData::Data(STANDARD.encode(bytes)),
                media_type: mime.clone(),
                provider_options: match &target {
                    Target::Tool { image, .. } => image
                        .detail
                        .map(|detail| serde_json::json!({"openai":{"imageDetail":detail}})),
                    Target::User { .. } | Target::Audio { .. } => None,
                },
            },
            ImageRead::Unavailable(reason) => match &target {
                Target::User { image, .. } => ContentPart::text(match language {
                    Language::En => format!(
                        "Image attachment \"{}\" could not be loaded: {reason}.",
                        image.name
                    ),
                    Language::ZhCn => format!("无法加载图片附件 \"{}\"：{reason}。", image.name),
                    Language::ZhTw => format!("無法載入圖片附件 \"{}\"：{reason}。", image.name),
                }),
                Target::Audio { .. } => ContentPart::text(match language {
                    Language::En => {
                        format!("Audio could not be loaded from artifact storage: {reason}.")
                    }
                    Language::ZhCn => format!("无法从工件存储加载音频：{reason}。"),
                    Language::ZhTw => format!("無法從成品儲存載入音訊：{reason}。"),
                }),
                Target::Tool { .. } => ContentPart::text(match language {
                    Language::En => {
                        format!("Image could not be loaded from artifact storage: {reason}.")
                    }
                    Language::ZhCn => format!("无法从工件存储加载图片：{reason}。"),
                    Language::ZhTw => format!("無法從成品儲存載入圖片：{reason}。"),
                }),
            },
        };
        match target {
            Target::User { message, .. } => {
                let Message::User { content, .. } = &mut messages[message] else {
                    unreachable!("user image target comes from the user message builder");
                };
                content.push(part);
            }
            Target::Audio {
                message,
                part: index,
                ..
            }
            | Target::Tool {
                message,
                part: index,
                ..
            } => {
                let Message::Tool { content, .. } = &mut messages[message] else {
                    unreachable!("tool image target comes from the tool message builder");
                };
                let ToolOutput::Content(parts) = &mut content[0].output else {
                    unreachable!("image target comes from a structured content output");
                };
                parts[index] = part;
            }
        }
    }
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    if snapshot.is_some_and(|snapshot| snapshot.len() != bindings.len()) {
        return Err(RunError::ReconciliationRequired(
            "prepared media snapshot has a different target set".into(),
        ));
    }
    Ok((messages, bindings))
}

async fn read(
    log: &SessionStore,
    session: &str,
    reference: &StorageRef,
    audio: bool,
) -> Result<ImageRead, RunError> {
    let StorageRef::SessionFile {
        session_id,
        relative_path,
    } = reference
    else {
        return Ok(ImageRead::Unavailable("unsupported_ref_kind".into()));
    };
    if session_id != session {
        return Ok(ImageRead::Unavailable("session_mismatch".into()));
    }
    if maka_agent_facts::interaction::entity_id(relative_path).is_err() {
        return Ok(ImageRead::Unavailable("not_found".into()));
    }
    let Some(bytes) = log
        .with_artifact(
            maka_event_log::artifacts::ArtifactReadScope::Session(session),
            relative_path,
            |_, reader| {
                let mut bytes = Vec::new();
                reader.read_to_end(&mut bytes)?;
                Ok::<_, maka_event_log::StoreError>(bytes)
            },
        )
        .await?
        .transpose()?
    else {
        return Ok(ImageRead::Unavailable("not_found".into()));
    };
    if !audio && sniff_binary_mime(&bytes).is_none() {
        return Ok(ImageRead::Unavailable("unsupported_mime".into()));
    }
    Ok(ImageRead::Bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        artifact::{Artifact, ArtifactKind, ArtifactSource},
        attachment::AttachmentKind,
    };

    #[tokio::test]
    async fn captured_unavailable_media_never_turns_into_a_new_retry_payload() {
        let (_directory, root) = crate::test_support::root().await;
        let log = crate::test_support::session(&root, "session").await;
        let bytes = b"\x89PNG\r\n\x1a\n";
        let image = AttachmentRef {
            kind: AttachmentKind::Image,
            name: "image.png".into(),
            mime_type: "image/png".into(),
            bytes: bytes.len() as u64,
            storage_ref: StorageRef::SessionFile {
                session_id: "session".into(),
                relative_path: "image".into(),
            },
        };
        let resources = super::super::resources::Resources::native("session");
        let cancellation = CancellationToken::new();
        let (missing, manifest) = materialize_targets(
            &log,
            "session",
            vec![Message::user("question")],
            vec![Target::User {
                message: 0,
                image: &image,
            }],
            &resources,
            &cancellation,
            Language::En,
            None,
        )
        .await
        .unwrap();
        log.commit_artifact(
            Artifact {
                id: "image".into(),
                session_id: "session".into(),
                turn_id: "turn".into(),
                created_at: 1,
                name: "image.png".into(),
                kind: ArtifactKind::Image,
                size_bytes: bytes.len() as u64,
                mime_type: Some("image/png".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(maka_agent_facts::artifact::content_digest(bytes)),
            },
            bytes.to_vec(),
        )
        .await
        .unwrap();
        let (retry, _) = materialize_targets(
            &log,
            "session",
            vec![Message::user("question")],
            vec![Target::User {
                message: 0,
                image: &image,
            }],
            &resources,
            &cancellation,
            Language::En,
            Some(&manifest),
        )
        .await
        .unwrap();
        assert_eq!(
            retry, missing,
            "a later artifact cannot mutate captured absence"
        );
        let (fresh, available) = materialize_targets(
            &log,
            "session",
            vec![Message::user("question")],
            vec![Target::User {
                message: 0,
                image: &image,
            }],
            &resources,
            &cancellation,
            Language::En,
            None,
        )
        .await
        .unwrap();
        assert_ne!(
            fresh, missing,
            "a new request may capture newly available media"
        );
        log.delete_user_artifact("session", "image").await.unwrap();
        assert!(
            materialize_targets(
                &log,
                "session",
                vec![Message::user("question")],
                vec![Target::User {
                    message: 0,
                    image: &image
                }],
                &resources,
                &cancellation,
                Language::En,
                Some(&available)
            )
            .await
            .is_err(),
            "losing a captured resource fails instead of changing model input"
        );
        root.close().await.unwrap();
    }
}
