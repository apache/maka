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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::{artifact::ArtifactKind, attachment::StorageRef};
use maka_agent_state::artifacts::{ArtifactScope, SessionScope};

fn id(reference: &StorageRef, session: &str) -> Result<String, String> {
    match reference {
        StorageRef::SessionFile {
            session_id,
            relative_path,
        } if session_id == session => Ok(relative_path.clone()),
        _ => Err("agent_image_source_invalid".into()),
    }
}
fn validate(image: &maka_agent_state::artifacts::ArtifactChunk) -> Result<(), String> {
    if image.record.artifact.kind != ArtifactKind::Image
        || !image
            .record
            .artifact
            .mime_type
            .as_deref()
            .is_some_and(|mime| {
                matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
                )
            })
    {
        return Err("agent_image_source_invalid".into());
    }
    Ok(())
}
async fn uploaded(
    owner: &Owner,
    scope: &Scope,
    session: &str,
    id: String,
    offset: u64,
) -> Result<maka_agent_state::artifacts::ArtifactChunk, String> {
    let image = scoped_state(owner, scope)?
        .artifacts()
        .chunk(
            SessionScope {
                owner: owner.run_owner(),
                session: session.into(),
            },
            id,
            offset,
            32 * 1024,
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or("agent_image_unavailable")?;
    validate(&image)?;
    if image.record.artifact.source != maka_agent_facts::artifact::ArtifactSource::UserUpload {
        return Err("agent_image_source_invalid".into());
    }
    Ok(image)
}
async fn historical(
    owner: &Owner,
    scope: &Scope,
    selected: &source::Selected,
    reference: &StorageRef,
    offset: u64,
) -> Result<maka_agent_state::artifacts::ArtifactChunk, String> {
    if matches!(&selected.data, data::DataSource::Snapshot(_)) {
        return snapshot_artifact(selected, reference, offset).await;
    }
    let maka_agent_state::session_history::source_tree::SourceItem::Canonical(item) =
        &selected.item
    else {
        return Err("agent_image_source_invalid".into());
    };
    let source = selected
        .data
        .run_source(item.recorded.run)
        .await
        .map_err(|error| error.to_string())?;
    let artifact = id(reference, &source.spec.session_id)?;
    let image = scoped_state(owner, scope)?
        .artifacts()
        .chunk(
            ArtifactScope {
                owner: source.spec.owner,
                session: source.spec.session_id,
                run: item.recorded.run,
                through: item.recorded.revision,
            },
            artifact,
            offset,
            32 * 1024,
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or("agent_image_unavailable")?;
    validate(&image)?;
    Ok(image)
}
async fn snapshot_artifact(
    selected: &source::Selected,
    reference: &StorageRef,
    offset: u64,
) -> Result<maka_agent_state::artifacts::ArtifactChunk, String> {
    use maka_agent_state::session_history::source_tree::SourceItem;
    let data::DataSource::Snapshot(snapshot) = &selected.data else {
        return Err("agent_image_source_invalid".into());
    };
    let (owner, session, run) = match &selected.item {
        SourceItem::Canonical(item) => {
            let source = selected
                .data
                .run_source(item.recorded.run)
                .await
                .map_err(|error| error.to_string())?;
            (
                source.spec.owner,
                source.spec.session_id,
                Some(item.recorded.run),
            )
        }
        SourceItem::Imported { message, .. } => (
            message.artifact_scope.owner.clone(),
            message.artifact_scope.session.clone(),
            None,
        ),
    };
    let artifact = id(reference, &session)?;
    let record = snapshot
        .artifact(owner, session, run, artifact)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("agent_image_unavailable")?;
    let bytes = snapshot
        .chunk(&record.payload, offset, 32 * 1024)
        .await
        .map_err(|error| error.to_string())?;
    let image = maka_agent_state::artifacts::ArtifactChunk {
        total_bytes: record.payload.bytes,
        record,
        bytes,
    };
    validate(&image)?;
    Ok(image)
}
fn bounded_data(metadata: &impl serde::Serialize, bytes: &[u8]) -> Result<String, String> {
    let room = (60_usize * 1024)
        .checked_sub(encoded_bytes(metadata)?)
        .ok_or("agent_history_metadata_exceeds_page")?;
    let take = bytes.len().min(room / 4 * 3);
    if !bytes.is_empty() && take == 0 {
        return Err("agent_history_metadata_exceeds_page".into());
    }
    Ok(STANDARD.encode(&bytes[..take]))
}
pub(crate) async fn attachment_image(
    owner: &Owner,
    scope: &Scope,
    input: ui::AttachmentImageRead,
) -> Result<ui::AttachmentImagePage, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let image = match &input.source {
        ui::AttachmentImageSource::Uploaded { id } => {
            uploaded(owner, scope, &input.session_id, id.clone(), input.offset).await?
        }
        ui::AttachmentImageSource::History {
            through,
            position,
            attachment_index,
        } => {
            let cut = cut(&history, Some(*through)).await?;
            let tree =
                maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
                    .await
                    .map_err(|error| error.to_string())?;
            let selected = source::selected(
                &tree,
                position,
                &mut source::Cache::default(),
                &scope.cancellation,
            )
            .await?;
            let attachment = selected
                .row
                .chunk
                .attachments
                .get(*attachment_index as usize)
                .ok_or("agent_image_source_invalid")?;
            historical(
                owner,
                scope,
                &selected,
                &attachment.storage_ref,
                input.offset,
            )
            .await?
        }
    };
    authorize(owner, scope, &input.session_id).await?;
    let mut page = ui::AttachmentImagePage::Ready {
        source: input.source,
        offset: input.offset,
        total_bytes: image.total_bytes,
        mime_type: image
            .record
            .artifact
            .mime_type
            .ok_or("agent_image_source_invalid")?,
        digest: image.record.payload.digest,
        data: String::new(),
    };
    let payload = bounded_data(&page, &image.bytes)?;
    let ui::AttachmentImagePage::Ready { data, .. } = &mut page;
    *data = payload;
    Ok(page)
}
pub(super) async fn describe_source(
    data: &data::DataSource,
    item: &HistoryItem,
    row: &mut projection::Row,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    if let Some(metadata) = stream::media_metadata_from(data, item, stop).await? {
        describe(row, metadata);
    }
    Ok(())
}
pub(super) async fn describe_imported(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    ordinal: u64,
    row: &mut projection::Row,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    if let Some(metadata) = stream::imported_media(snapshot, ordinal, row, stop).await? {
        describe(row, metadata);
    }
    Ok(())
}
fn describe(row: &mut projection::Row, (image, images, is_error): (bool, u32, bool)) {
    if let Some(result) = row
        .chunk
        .tool
        .as_mut()
        .and_then(|tool| tool.result.as_mut())
    {
        result.is_error |= is_error;
        result.image = image;
        result.images = images;
    }
}
pub(crate) async fn tool_image(
    owner: &Owner,
    scope: &Scope,
    input: ui::ToolImageRead,
) -> Result<ui::ToolImagePage, String> {
    let history = open(owner, scope, &input.session_id).await?;
    let cut = cut(&history, Some(input.through)).await?;
    let tree = maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
        .await
        .map_err(|error| error.to_string())?;
    let selected = source::selected(
        &tree,
        &input.position,
        &mut source::Cache::default(),
        &scope.cancellation,
    )
    .await?;
    let reference = stream::selected_image(&selected, input.image, &scope.cancellation).await?;
    let image = historical(owner, scope, &selected, &reference, input.offset).await?;
    authorize(owner, scope, &input.session_id).await?;
    let mut page = ui::ToolImagePage::Ready {
        through: cut.through_sequence,
        position: input.position,
        offset: input.offset,
        total_bytes: image.total_bytes,
        mime_type: image
            .record
            .artifact
            .mime_type
            .ok_or("agent_image_source_invalid")?,
        digest: image.record.payload.digest,
        data: String::new(),
    };
    let payload = bounded_data(&page, &image.bytes)?;
    let ui::ToolImagePage::Ready { data, .. } = &mut page;
    *data = payload;
    Ok(page)
}

fn snapshot_reply(
    position: wire::HistoryRowAddress,
    offset: u64,
    image: maka_agent_state::artifacts::ArtifactChunk,
) -> Result<ui::HistoryImagePage, String> {
    let mut page = ui::HistoryImagePage::Ready {
        position,
        offset,
        total_bytes: image.total_bytes,
        mime_type: image
            .record
            .artifact
            .mime_type
            .ok_or("agent_image_source_invalid")?,
        digest: image.record.payload.digest,
        data: String::new(),
    };
    let payload = bounded_data(&page, &image.bytes)?;
    let ui::HistoryImagePage::Ready { data, .. } = &mut page;
    *data = payload;
    Ok(page)
}
pub(crate) async fn snapshot_tool_image(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    position: wire::HistoryRowAddress,
    image: Option<u32>,
    offset: u64,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<ui::HistoryImagePage, String> {
    let tree = maka_agent_state::session_history::source_tree::SourceTree::snapshot(snapshot)
        .await
        .map_err(|error| error.to_string())?;
    let selected = source::selected(&tree, &position, &mut source::Cache::default(), stop).await?;
    let reference = stream::selected_image(&selected, image, stop).await?;
    let chunk = snapshot_artifact(&selected, &reference, offset).await?;
    if stop.is_cancelled() {
        return Err("agent_observation_cancelled".into());
    }
    snapshot_reply(position, offset, chunk)
}
pub(crate) async fn snapshot_attachment_image(
    snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
    position: wire::HistoryRowAddress,
    attachment_index: u32,
    offset: u64,
    stop: &tokio_util::sync::CancellationToken,
) -> Result<ui::HistoryImagePage, String> {
    let tree = maka_agent_state::session_history::source_tree::SourceTree::snapshot(snapshot)
        .await
        .map_err(|error| error.to_string())?;
    let selected = source::selected(&tree, &position, &mut source::Cache::default(), stop).await?;
    let attachment = selected
        .row
        .chunk
        .attachments
        .get(attachment_index as usize)
        .ok_or("agent_image_source_invalid")?;
    let chunk = snapshot_artifact(&selected, &attachment.storage_ref, offset).await?;
    if stop.is_cancelled() {
        return Err("agent_observation_cancelled".into());
    }
    snapshot_reply(position, offset, chunk)
}
