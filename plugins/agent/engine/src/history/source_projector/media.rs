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

//! Capture media and reference aliases through the original immutable source.
use super::located;
use super::*;
use maka_agent_facts::history::semantic::directory::{
    AttachmentDirectory, StorageDirectory, ToolPartDirectory,
};
use maka_agent_facts::model::prompt_source::source::{ChargedBuffer, MediaSource};
use maka_event_log::context::semantic::{
    ArtifactIdentityValidity, ArtifactLookup, ArtifactLookupResult, PayloadSource,
};
use std::io::{Read, Write};

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Probe,
    Capture,
}
pub(super) struct Artifact {
    pub id: Option<TextSource>,
    pub body: Option<SourceBytes>,
    pub available: bool,
    pub reason: &'static str,
    pub backing_bytes: usize,
    pub source_bytes: usize,
}
struct ReadArtifact {
    metadata: Option<PayloadSource>,
    body: Option<SourceBytes>,
    available: bool,
    reason: &'static str,
    backing_bytes: usize,
    source_bytes: usize,
}
fn copy_body(
    reader: &mut dyn Read,
    writer: &mut impl Write,
    buffer: &mut ChargedBuffer,
) -> io::Result<u64> {
    let mut length = 0u64;
    loop {
        let count = reader.read(buffer.as_mut())?;
        if count == 0 {
            return Ok(length);
        }
        writer.write_all(&buffer.as_ref()[..count])?;
        length = length.checked_add(count as u64).ok_or_else(invalid)?;
    }
}
pub(super) async fn artifact(
    reference: &StorageDirectory,
    body: bool,
    audio: bool,
    mode: Mode,
    context: &ProjectContext<'_>,
) -> io::Result<Artifact> {
    let unavailable = |reason| Artifact {
        id: None,
        body: None,
        available: false,
        reason,
        backing_bytes: 0,
        source_bytes: 0,
    };
    let StorageDirectory::SessionFile {
        session_id,
        relative_path,
    } = reference
    else {
        return Ok(unavailable("unsupported_ref_kind"));
    };
    let captured = context.captured.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "media capture requires original source",
        )
    })?;
    let root = context.payload_root.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "artifact reference requires original payload token positions",
        )
    })?;
    let session_token = located::range(session_id.range)?;
    let artifact_token = located::range(relative_path.range)?;
    let session = located::text(*session_id, context)?;
    let id = located::text(*relative_path, context)?;
    let local = json::text_eq(
        &session,
        &captured.selection().session,
        context.budget.clone(),
    )
    .await?;
    let work = context.budget.allocate(4096).await?;
    let selection = ArtifactLookup::new(root.clone(), session_token, artifact_token, work)
        .map_err(io::Error::other)?;
    if local && !body {
        let validity = captured
            .validate_artifact_identity(selection)
            .await
            .map_err(io::Error::other)?;
        let mut result = unavailable("not_found");
        if validity == ArtifactIdentityValidity::Valid {
            result.id = Some(id);
        }
        return Ok(result);
    }
    let mut buffer = context.budget.allocate(1024).await?;
    let arena = context.arena.cloned();
    let internal = context.internal_arena;
    let result = captured
        .with_artifact_capture(selection, move |capture, _metadata, reader| {
            let metadata = if local {
                None
            } else {
                capture.protected_metadata
            };
            if !body {
                return Ok(ReadArtifact {
                    metadata,
                    body: None,
                    available: false,
                    reason: "not_found",
                    backing_bytes: 0,
                    source_bytes: 0,
                });
            }
            let sniff_length =
                usize::try_from(capture.bytes.min(1024)).map_err(io::Error::other)?;
            reader.read_exact(&mut buffer.as_mut()[..sniff_length])?;
            if !audio
                && maka_agent_facts::attachment::sniff_binary_mime(&buffer.as_ref()[..sniff_length])
                    .is_none()
            {
                return Ok(ReadArtifact {
                    metadata,
                    body: None,
                    available: false,
                    reason: "unsupported_mime",
                    backing_bytes: 0,
                    source_bytes: 0,
                });
            }
            // Freeze media once: reopening a SQLite Blob for every codec chunk
            // repeatedly walks its overflow chain, including protected artifacts.
            let backing_bytes = usize::try_from(capture.bytes).map_err(io::Error::other)?;
            let source_bytes = super::super::capture_arena::source_metadata_bytes(1)?;
            if matches!(mode, Mode::Probe) {
                return Ok(ReadArtifact {
                    metadata,
                    body: None,
                    available: true,
                    reason: "",
                    backing_bytes,
                    source_bytes,
                });
            }
            let arena = arena.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "media capture requires request backing",
                )
            })?;
            let range = arena.with_writer_sync(|writer| {
                let start = writer.position();
                writer.write_all(&buffer.as_ref()[..sniff_length])?;
                let rest = copy_body(reader, writer, &mut buffer)?;
                if rest.checked_add(sniff_length as u64) != Some(capture.bytes) {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "captured media length changed",
                    ));
                }
                Ok(start..writer.position())
            })?;
            Ok(ReadArtifact {
                metadata,
                body: Some(if internal {
                    arena.inspect(range)
                } else {
                    arena.pending(range)
                }),
                available: true,
                reason: "",
                backing_bytes,
                source_bytes,
            })
        })
        .await
        .map_err(io::Error::other)?;
    let result = match result {
        ArtifactLookupResult::InvalidIdentity => {
            return Ok(unavailable(if local {
                "not_found"
            } else {
                "session_mismatch"
            }));
        }
        ArtifactLookupResult::Missing => {
            let mut result = unavailable(if local {
                "not_found"
            } else {
                "session_mismatch"
            });
            if local {
                result.id = Some(id);
            }
            return Ok(result);
        }
        ArtifactLookupResult::Captured(result) => result,
    };
    let id = if local {
        id
    } else {
        let metadata = result.metadata.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "history alias metadata was not protected",
            )
        })?;
        lookup(
            &JsonSource::new(SourceBytes::Source(
                captured.byte_source(&metadata).map_err(io::Error::other)?,
            )),
            "id",
            context,
        )
        .await?
        .text()?
    };
    Ok(Artifact {
        id: Some(id),
        body: result.body,
        available: result.available,
        reason: result.reason,
        backing_bytes: result.backing_bytes,
        source_bytes: result.source_bytes,
    })
}

pub(super) struct Part {
    pub content: Option<ContentRecipe>,
    pub metadata_bytes: usize,
    pub backing_bytes: usize,
}
fn unavailable_text(audio: bool, reason: &'static str, context: &ProjectContext<'_>) -> TextSource {
    let (prefix, suffix) = match (audio, context.language) {
        (false, Language::En) => ("Image could not be loaded from artifact storage: ", "."),
        (false, Language::ZhCn) => ("无法从工件存储加载图片：", "。"),
        (false, Language::ZhTw) => ("無法從成品儲存載入圖片：", "。"),
        (true, Language::En) => ("Audio could not be loaded from artifact storage: ", "."),
        (true, Language::ZhCn) => ("无法从工件存储加载音频：", "。"),
        (true, Language::ZhTw) => ("無法從成品儲存載入音訊：", "。"),
    };
    concat(
        vec![literal(prefix), literal(reason), literal(suffix)],
        context,
    )
}
pub(super) async fn tool(
    part: &ToolPartDirectory,
    mode: Mode,
    context: &ProjectContext<'_>,
) -> io::Result<Part> {
    let (media, audio) = match part {
        ToolPartDirectory::Audio(media) => (media, true),
        ToolPartDirectory::Artifact(media) => (media, false),
        ToolPartDirectory::Text(_) => return Err(invalid()),
    };
    if !audio && !context.vision {
        return Ok(Part {
            content: Some(ContentRecipe::Text {
                text: literal(super::super::images::no_vision(context.language)),
                provider_options: None,
            }),
            metadata_bytes: 0,
            backing_bytes: 0,
        });
    }
    let mime = located::text(media.mime_type, context)?;
    let detail = media
        .detail
        .map(|value| located::text(value, context))
        .transpose()?;
    let artifact = artifact(&media.reference, true, audio, mode, context).await?;
    if !artifact.available {
        let metadata_bytes = items_footprint::<TextSource>(3)?
            .checked_add(source_text::concat_metadata_bytes()?)
            .ok_or_else(invalid)?;
        return Ok(Part {
            content: Some(ContentRecipe::Text {
                text: unavailable_text(audio, artifact.reason, context),
                provider_options: None,
            }),
            metadata_bytes,
            backing_bytes: 0,
        });
    }
    let mut metadata_bytes = artifact.source_bytes;
    footprint_add(&mut metadata_bytes, raw_footprint(mime.bytes())?)?;
    if let Some(detail) = &detail {
        footprint_add(&mut metadata_bytes, raw_footprint(detail.bytes())?)?;
    }
    let content = artifact.body.map(|bytes| ContentRecipe::Media {
        media: MediaSource {
            bytes,
            media_type: mime,
            detail,
        },
        provider_options: None,
    });
    Ok(Part {
        content,
        metadata_bytes,
        backing_bytes: artifact.backing_bytes,
    })
}

pub(super) struct Attachment {
    pub has_content: bool,
    pub pieces: Vec<TextSource>,
    pub content: Option<ContentRecipe>,
    pub metadata_bytes: usize,
    pub backing_bytes: usize,
}
pub(super) async fn attachment(
    value: &AttachmentDirectory,
    mode: Mode,
    context: &ProjectContext<'_>,
) -> io::Result<Attachment> {
    let image = value.image;
    let name = located::text(value.name, context)?;
    let mime = located::text(value.mime_type, context)?;
    let want_media = image && context.vision;
    let artifact = artifact(&value.reference, want_media, false, mode, context).await?;
    let mut metadata_bytes = raw_footprint(name.bytes())?;
    footprint_add(&mut metadata_bytes, raw_footprint(mime.bytes())?)?;
    let mut pieces = Vec::with_capacity(if artifact.id.is_some() {
        if image { 13 } else { 10 }
    } else {
        9
    });
    pieces.push(literal("<attachment>\n"));
    let read_prefix = match context.language {
        Language::En => "Read argument: {\"path\":",
        Language::ZhCn => "Read 参数: {\"path\":",
        Language::ZhTw => "Read 參數: {\"path\":",
    };
    if let Some(id) = artifact.id {
        footprint_add(&mut metadata_bytes, raw_footprint(id.bytes())?)?;
        footprint_add(&mut metadata_bytes, items_footprint::<TextSource>(2)?)?;
        footprint_add(&mut metadata_bytes, source_text::concat_metadata_bytes()?)?;
        footprint_add(
            &mut metadata_bytes,
            source_text::transform_metadata_bytes(TextEncoding::Utf8)?,
        )?;
        let uri = concat(
            vec![
                literal(maka_agent_facts::attachment::ATTACHMENT_RESOURCE_PREFIX),
                id,
            ],
            context,
        );
        let resource = source_text::json_string(uri, context.budget.clone());
        pieces.push(literal(read_prefix));
        pieces.push(resource.clone());
        pieces.push(literal("}\n"));
        if image {
            pieces.push(literal(match context.language {
                Language::En => "Markdown image source: ",
                Language::ZhCn => "Markdown 图片来源: ",
                Language::ZhTw => "Markdown 圖片來源: ",
            }));
            pieces.push(resource);
            pieces.push(literal("\n"));
        }
        pieces.push(literal(match context.language {
            Language::En => {
                "Session resource; the Read path above differs from the display name.\n"
            }
            Language::ZhCn => "会话资源；上面的 Read 路径与显示名称不同。\n",
            Language::ZhTw => "工作階段資源；上面的 Read 路徑與顯示名稱不同。\n",
        }));
    } else {
        let path = match value.reference {
            StorageDirectory::WorkspaceFile { relative_path } => Some(relative_path),
            StorageDirectory::ExternalFile { absolute_path } => Some(absolute_path),
            StorageDirectory::SessionFile { .. } | StorageDirectory::SessionContext { .. } => None,
        };
        if let Some(path) = path {
            let path = located::text(path, context)?;
            footprint_add(&mut metadata_bytes, raw_footprint(path.bytes())?)?;
            pieces.push(literal(read_prefix));
            pieces.push(raw_json(JsonSource::new(path.into_bytes())));
            pieces.push(literal("}\n"));
        } else {
            pieces.push(literal(match context.language {
                Language::En => "The attachment content is unavailable to Read.\n",
                Language::ZhCn => "Read 无法读取该附件内容。\n",
                Language::ZhTw => "Read 無法讀取該附件內容。\n",
            }));
        }
    }
    pieces.push(literal("name: "));
    pieces.push(raw_json(JsonSource::new(name.bytes().clone())));
    pieces.push(literal("\nmime_type: "));
    pieces.push(raw_json(JsonSource::new(mime.bytes().clone())));
    pieces.push(literal("\n</attachment>"));
    let content = if !want_media {
        None
    } else if artifact.available {
        footprint_add(&mut metadata_bytes, artifact.source_bytes)?;
        artifact.body.map(|bytes| ContentRecipe::Media {
            media: MediaSource {
                bytes,
                media_type: mime,
                detail: None,
            },
            provider_options: None,
        })
    } else {
        let (prefix, middle, suffix) = match context.language {
            Language::En => ("Image attachment \"", "\" could not be loaded: ", "."),
            Language::ZhCn => ("无法加载图片附件 \"", "\"：", "。"),
            Language::ZhTw => ("無法載入圖片附件 \"", "\"：", "。"),
        };
        footprint_add(&mut metadata_bytes, items_footprint::<TextSource>(5)?)?;
        footprint_add(&mut metadata_bytes, source_text::concat_metadata_bytes()?)?;
        Some(ContentRecipe::Text {
            text: concat(
                vec![
                    literal(prefix),
                    name,
                    literal(middle),
                    literal(artifact.reason),
                    literal(suffix),
                ],
                context,
            ),
            provider_options: None,
        })
    };
    Ok(Attachment {
        has_content: want_media,
        pieces,
        content,
        metadata_bytes,
        backing_bytes: artifact.backing_bytes,
    })
}
