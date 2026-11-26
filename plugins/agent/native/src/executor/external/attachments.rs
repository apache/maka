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

use super::*;
use maka_agent_facts::{artifact::ArtifactSource, attachment::StorageRef};
use maka_agent_state::artifacts::{ArtifactStore, SessionScope};
use std::{collections::BTreeSet, io::Write};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Image {
    path: String,
    media_type: String,
}

pub(super) struct Materials {
    pub message: String,
    pub images: Vec<Image>,
    directory: Option<tempfile::TempDir>,
}
impl Materials {
    pub fn handoff(&mut self) -> Option<PathBuf> {
        self.directory.take().map(tempfile::TempDir::keep)
    }
}

enum Media {
    Text,
    Image(&'static str),
}
#[derive(Debug)]
pub(super) enum PreparationError {
    Unsupported(String),
    Source(Error),
}
impl From<Error> for PreparationError {
    fn from(error: Error) -> Self {
        Self::Source(error)
    }
}
impl From<PreparationError> for Error {
    fn from(error: PreparationError) -> Self {
        match error {
            PreparationError::Unsupported(message) => Self::Invalid(message),
            PreparationError::Source(error) => error,
        }
    }
}
impl Media {
    fn parse(mime: &str) -> Result<Self, PreparationError> {
        match mime {
            "image/png" => Ok(Self::Image("png")),
            "image/jpeg" => Ok(Self::Image("jpg")),
            "image/gif" => Ok(Self::Image("gif")),
            "image/webp" => Ok(Self::Image("webp")),
            "application/json" => Ok(Self::Text),
            mime if mime.starts_with("text/") => Ok(Self::Text),
            _ => Err(PreparationError::Unsupported(format!(
                "External agent attachment media unsupported: {mime}"
            ))),
        }
    }
}

pub(super) fn render_message_text(
    content: &maka_agent_facts::input::MessageInput,
    language: maka_agent_facts::language::Language,
) -> Result<String, Error> {
    let mut sections = Vec::new();
    if !content.text.is_empty() {
        sections.push(content.text.clone());
    }
    if let Some(quotes) = content.quotes.as_deref().filter(|q| !q.is_empty()) {
        sections.push(
            maka_agent_facts::input::render_quotes(quotes, language).map_err(Error::Invalid)?,
        );
    }
    if let Some(dirs) = content
        .directory_references
        .as_deref()
        .filter(|d| !d.is_empty())
    {
        sections.push(
            maka_agent_facts::input::render_directory_references(dirs, language)
                .map_err(Error::Invalid)?,
        );
    }
    if let Some(rendered) =
        maka_agent_facts::input::render_session_references(&content.text, language)
    {
        sections.push(rendered);
    }
    Ok(sections.join("\n\n"))
}

pub(super) async fn prepare(
    store: &ArtifactStore,
    scope: &SessionScope,
    content: &maka_agent_facts::input::MessageInput,
    language: maka_agent_facts::language::Language,
    cancellation: &CancellationToken,
    material_root: &std::path::Path,
) -> Result<Materials, PreparationError> {
    let mut materials = Materials {
        message: render_message_text(content, language)?,
        images: Vec::new(),
        directory: None,
    };
    let mut seen = BTreeSet::new();
    for attachment in content.attachments.iter().flatten() {
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &attachment.storage_ref
        else {
            return Err(Error::Invalid(
                "External agent attachment must be a session user upload".into(),
            )
            .into());
        };
        if session_id != &scope.session || !seen.insert(relative_path) {
            return Err(Error::Invalid(
                "External agent attachment must be a distinct upload owned by this session".into(),
            )
            .into());
        }
        let attachment = attachment.clone();
        let material_root = material_root.to_owned();
        let cancellation = cancellation.clone();
        // The artifact reader owns the blocking snapshot and all payload I/O;
        // metadata, source and digest are checked together, not in a second lookup.
        materials = store
            .with_content(
                scope.clone(),
                relative_path.clone(),
                move |record, reader| -> Result<Materials, PreparationError> {
                    record
                        .validate_attachment(&attachment)
                        .map_err(|e| Error::Invalid(e.to_string()))?;
                    if record.source != ArtifactSource::UserUpload {
                        return Err(Error::Invalid(
                            "External agent attachment is not an immutable user upload".into(),
                        )
                        .into());
                    }
                    let digest = record.summary.as_deref().ok_or_else(|| {
                        Error::Invalid("External agent upload digest missing".into())
                    })?;
                    let media = Media::parse(&attachment.mime_type)?;
                    let mut text = Vec::new();
                    let mut image = match media {
                        Media::Text => None,
                        Media::Image(extension) => {
                            if materials.directory.is_none() {
                                materials.directory = Some(
                                    tempfile::Builder::new()
                                        .prefix("maka-native-")
                                        .tempdir_in(&material_root)
                                        .map_err(io_error)?,
                                );
                            }
                            let path = materials
                                .directory
                                .as_ref()
                                .expect("image directory")
                                .path()
                                .canonicalize()
                                .map_err(io_error)?
                                .join(format!("{}.{}", materials.images.len(), extension));
                            let file = std::fs::File::create_new(&path).map_err(io_error)?;
                            let path = path.into_os_string().into_string().map_err(|_| {
                                Error::Invalid("External agent image path is not UTF-8".into())
                            })?;
                            materials.images.push(Image {
                                path,
                                media_type: attachment.mime_type.clone(),
                            });
                            Some(file)
                        }
                    };
                    let mut hash = Sha256::new();
                    let mut remaining = attachment.bytes;
                    let mut buffer = [0u8; 64 * 1024];
                    while remaining > 0 {
                        if cancellation.is_cancelled() {
                            return Err(Error::Cancelled.into());
                        }
                        let length = remaining.min(buffer.len() as u64) as usize;
                        let chunk = &mut buffer[..length];
                        reader.read_exact(chunk).map_err(io_error)?;
                        hash.update(&*chunk);
                        match &mut image {
                            Some(file) => file.write_all(chunk).map_err(io_error)?,
                            None => text.extend_from_slice(chunk),
                        }
                        remaining -= length as u64;
                    }
                    if format!("sha256:{}", hex::encode(hash.finalize())) != digest {
                        return Err(
                            Error::Invalid("External agent upload digest mismatch".into()).into(),
                        );
                    }
                    if image.is_none() {
                        let text = String::from_utf8(text).map_err(|_| {
                            Error::Invalid("External agent text attachment is not UTF-8".into())
                        })?;
                        materials.message.push_str(&format!(
                            "\n\n--- Attachment {} ({}) ---\n{}\n--- End attachment ---",
                            serde_json::to_string(&attachment.name).expect("attachment name"),
                            attachment.mime_type,
                            text,
                        ));
                    }
                    Ok(materials)
                },
            )
            .await
            .map_err(|e| Error::Persistence(e.to_string()))?
            .ok_or_else(|| Error::Invalid("External agent user upload unavailable".into()))??;
    }
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled.into());
    }
    Ok(materials)
}

fn io_error(error: std::io::Error) -> Error {
    Error::Provider(format!("External agent attachment I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::input::MessageInput;
    use maka_agent_facts::language::Language;
    use serde_json::json;

    #[test]
    fn render_message_text_preserves_quotes_directories_and_session_references() {
        let room_id = "ma_8b708bb06d73d5d83a9265c0464928803a7478a2a9083b6c3647cfc8c7c0f102_f2534dfc81315ef2b71faf2ad291705f";
        let input: MessageInput = serde_json::from_value(json!({
            "text": format!("请参考 [#Reviewers需要关注的事项](maka://session/{room_id}) 做一下审查"),
            "quotes": [{
                "text": "边界条件必须由类型约束保证。",
                "label": "AGENTS.md"
            }],
            "directory_references": [{
                "hostId": "local",
                "path": "/tmp/example-dir"
            }]
        }))
        .unwrap();
        let rendered = render_message_text(&input, Language::ZH_CN).unwrap();
        assert!(
            rendered.contains(r#"<quoted_excerpt label="AGENTS.md">"#),
            "{rendered}"
        );
        assert!(
            rendered.contains("边界条件必须由类型约束保证。"),
            "{rendered}"
        );
        assert!(rendered.contains("<directory_references>"), "{rendered}");
        assert!(rendered.contains("/tmp/example-dir"), "{rendered}");
        assert!(rendered.contains("<session_references>"), "{rendered}");
        assert!(
            rendered.contains(&format!(r#"{{"path":"maka://session/{room_id}"}}"#)),
            "{rendered}"
        );
    }
}
