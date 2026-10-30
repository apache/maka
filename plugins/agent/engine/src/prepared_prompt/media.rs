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

//! One request-owned whole-image view, shared by counting, encoding and replay.
use super::PreparedPrompt;
use crate::RunError;
use maka_agent_facts::{
    configuration::ImageInput,
    model::prompt_source::source::{self as recipe, *},
};
use maka_model::ProviderConfig;
use std::{
    collections::BTreeMap,
    io,
    io::Write,
    sync::{Arc, OnceLock},
};
use tokio_util::sync::CancellationToken;
mod codec;
mod source;

fn failure(error: impl ToString) -> RunError {
    RunError::Preparation(io::Error::other(error.to_string()))
}
fn add(a: usize, b: usize) -> Result<usize, RunError> {
    a.checked_add(b)
        .ok_or_else(|| failure("image preparation size overflows"))
}

fn geometry(original: codec::Geometry, limits: &ImageInput) -> Result<codec::Geometry, RunError> {
    let hard_width = limits.max_width.unwrap_or(original.width);
    let hard_height = limits.max_height.unwrap_or(original.height);
    if hard_width == 0 || hard_height == 0 {
        return Err(failure("selected route does not accept nonempty images"));
    }
    let hard = fit_within(original, hard_width, hard_height);
    check_minimum(hard, limits)?;
    let preferred = fit_within(
        original,
        limits.max_width.unwrap_or(2000),
        limits.max_height.unwrap_or(2000),
    );
    if check_minimum(preferred, limits).is_ok() {
        return Ok(preferred);
    }
    let minimum = minimum_envelope(original, limits);
    let output = fit_within(
        original,
        limits.max_width.unwrap_or(2000.max(minimum.width)),
        limits.max_height.unwrap_or(2000.max(minimum.height)),
    );
    // Unknown dimensions are soft goals. Integer rounding must never turn them
    // into a rejection after the actual route bounds have proved feasible.
    Ok(if check_minimum(output, limits).is_ok() {
        output
    } else {
        hard
    })
}
fn fit_within(original: codec::Geometry, width: u32, height: u32) -> codec::Geometry {
    let mut output = original;
    if output.width > width {
        output.height =
            (u64::from(output.height) * u64::from(width) / u64::from(output.width)).max(1) as u32;
        output.width = width;
    }
    if output.height > height {
        output.width =
            (u64::from(output.width) * u64::from(height) / u64::from(output.height)).max(1) as u32;
        output.height = height;
    }
    output
}
fn check_minimum(output: codec::Geometry, limits: &ImageInput) -> Result<(), RunError> {
    if output.width < limits.min_width.unwrap_or(1)
        || output.height < limits.min_height.unwrap_or(1)
    {
        return Err(failure(
            "whole image cannot satisfy the selected route's minimum dimensions",
        ));
    }
    Ok(())
}
fn minimum_envelope(original: codec::Geometry, limits: &ImageInput) -> codec::Geometry {
    let width = limits.min_width.unwrap_or(1).max(1);
    let height = limits.min_height.unwrap_or(1).max(1);
    codec::Geometry {
        width: width.max(
            (u64::from(original.width) * u64::from(height)).div_ceil(u64::from(original.height))
                as u32,
        ),
        height: height.max(
            (u64::from(original.height) * u64::from(width)).div_ceil(u64::from(original.width))
                as u32,
        ),
    }
}
fn smaller_geometry(
    original: codec::Geometry,
    current: codec::Geometry,
    limits: &ImageInput,
) -> Option<codec::Geometry> {
    check_minimum(current, limits).ok()?;
    let min_width = limits.min_width.unwrap_or(1).max(1);
    let min_height = limits.min_height.unwrap_or(1).max(1);
    let mut next = fit_within(
        original,
        (current.width - current.width.div_ceil(4)).max(min_width),
        (current.height - current.height.div_ceil(4)).max(min_height),
    );
    if next.width < min_width || next.height < min_height {
        next = minimum_envelope(original, limits);
    }
    (next != current && next.width <= current.width && next.height <= current.height)
        .then_some(next)
}
struct Work {
    key: source::Key,
    media: MediaSource,
    options: Option<JsonSource>,
    probe: codec::ImageProbe,
    format: Option<image::ImageFormat>,
    media_type: TextSource,
    codec: Option<codec::CodecPlan>,
    output: codec::Geometry,
    actual: OnceLock<codec::Geometry>,
    pending: Arc<PendingImage>,
}
struct PendingImage(OnceLock<SourceBytes>);
impl ByteSource for PendingImage {
    fn len(&self) -> Option<u64> {
        self.0.get().and_then(SourceBytes::len)
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        match self.0.get() {
            Some(source) => source.open(budget),
            None => Box::new(Unmaterialized),
        }
    }
}
struct Unmaterialized;
impl ByteCursor for Unmaterialized {
    fn read_chunk(&mut self, _buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async {
            Err(io::Error::other(
                "image view was read before request admission",
            ))
        })
    }
}
pub(super) struct MediaView {
    works: Vec<Work>,
    base: Arc<dyn MessageSource>,
    identity: String,
    arena: crate::history::capture_arena::CaptureArena,
    resources: maka_model::ModelPreparationResources,
    limits: ImageInput,
    peak: usize,
    _directory: Arc<maka_model::DirectoryLease>,
    materialization: tokio::sync::Mutex<bool>,
    #[cfg(test)]
    decoded_jobs: std::sync::atomic::AtomicUsize,
}
impl MediaView {
    pub(super) fn peak_bytes(&self) -> usize {
        self.peak
    }
    fn smaller(&self) -> Result<Option<Arc<Self>>, RunError> {
        let mut works = Vec::with_capacity(self.works.len());
        let mut changed = false;
        for item in &self.works {
            let current = *item
                .actual
                .get()
                .ok_or_else(|| failure("image has not been materialized"))?;
            let next = smaller_geometry(item.probe.geometry, current, &self.limits);
            let (output, codec, bytes, media_type) = if let Some(next) = next {
                let format = item.format.ok_or_else(|| failure("selected route accepts no available whole-image resize encoding (PNG or JPEG)"))?;
                let length = usize::try_from(
                    item.media
                        .bytes
                        .len()
                        .ok_or_else(|| failure("captured image length unavailable"))?,
                )
                .map_err(failure)?;
                let plan =
                    codec::plan_format(&item.probe, length, next, format).map_err(failure)?;
                changed = true;
                (
                    next,
                    Some(plan),
                    None,
                    generated::text(if format == image::ImageFormat::Jpeg {
                        "image/jpeg"
                    } else {
                        "image/png"
                    }),
                )
            } else {
                (
                    current,
                    None,
                    Some(
                        item.pending
                            .0
                            .get()
                            .ok_or_else(|| failure("image bytes have not been materialized"))?
                            .clone(),
                    ),
                    item.media_type.clone(),
                )
            };
            let pending = Arc::new(PendingImage(OnceLock::new()));
            let actual = OnceLock::new();
            if let Some(bytes) = bytes {
                pending
                    .0
                    .set(bytes)
                    .map_err(|_| failure("image bytes initialized twice"))?;
                actual
                    .set(output)
                    .map_err(|_| failure("image geometry initialized twice"))?;
            }
            works.push(Work {
                key: item.key,
                media: item.media.clone(),
                options: item.options.clone(),
                probe: item.probe,
                format: item.format,
                media_type,
                codec,
                output,
                actual,
                pending,
            });
        }
        if !changed {
            return Ok(None);
        }
        let identity = crate::runner::digest(&(
            &self.identity,
            works
                .iter()
                .map(|work| (work.key, work.output.width, work.output.height))
                .collect::<Vec<_>>(),
        ))?;
        Ok(Some(Arc::new(Self {
            works,
            base: self.base.clone(),
            identity,
            arena: self.arena.clone(),
            resources: self.resources.clone(),
            limits: self.limits.clone(),
            peak: self.peak,
            _directory: self._directory.clone(),
            materialization: tokio::sync::Mutex::new(false),
            #[cfg(test)]
            decoded_jobs: std::sync::atomic::AtomicUsize::new(0),
        })))
    }
    pub(super) async fn materialize(
        &self,
        active: Arc<maka_capabilities::model_preparation::ActivePreparation>,
        cancellation: &CancellationToken,
    ) -> Result<(), RunError> {
        let mut done = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(RunError::Cancelled),
            done = self.materialization.lock() => done,
        };
        if *done {
            return Ok(());
        }
        self.arena.promote_to_file().await.map_err(failure)?;
        let work = self.resources.acquire_work().await.map_err(failure)?;
        let budget = work.budget();
        for item in &self.works {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let Some(plan) = &item.codec else {
                continue;
            };
            let lease = active.directory(plan.peak_bytes).map_err(failure)?;
            let encoded = read_owned(
                &item.media.bytes,
                plan.input_bytes,
                budget.clone(),
                cancellation,
            )
            .await?;
            let plan = plan.clone();
            let original = item.output;
            let mut output = original;
            let limits = self.limits.clone();
            let cancelled = cancellation.clone();
            #[cfg(test)]
            self.decoded_jobs
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // The arena worker is physically awaited even after cancellation; its
            // directory lease owns the complete decoder/encoder peak until drain.
            let (range, output) = self.arena.with_writer(move |writer| {
                // Keep the typed codec result inside the arena result so the captured
                // worker boundary cannot flatten cancellation or writer errors.
                let _lease = lease;
                let image = codec::decode(&encoded, &plan).map_err(io::Error::other)?;
                loop {
                    let start = writer.position();
                    if let Err(error) = image.write_image(output, plan.output_format, &mut CancelWriter {writer, cancellation: &cancelled}) {
                        return Ok(Err(error));
                    }
                    let range = start..writer.position();
                    if limits.max_bytes.is_none_or(|limit| range.end - range.start <= limit) {
                        return Ok(Ok((range, output)));
                    }
                    let Some(next) = smaller_geometry(original, output, &limits) else {
                        return Ok(Err(io::Error::other("whole image cannot satisfy the selected route's image byte limit and minimum dimensions")));
                    };
                    output = next;
                }
            }).await.map_err(RunError::Preparation)?.map_err(RunError::preparation)?;
            item.actual
                .set(output)
                .map_err(|_| failure("image geometry was materialized twice"))?;
            item.pending
                .0
                .set(self.arena.pending(range))
                .map_err(|_| failure("image bytes were materialized twice"))?;
        }
        self.arena.seal().await.map_err(failure)?;
        *done = true;
        Ok(())
    }
}
struct CancelWriter<'a, W> {
    writer: &'a mut W,
    cancellation: &'a CancellationToken,
}
impl<W: Write> Write for CancelWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.cancellation.is_cancelled() {
            return Err(crate::preparation_cancelled("image preparation cancelled"));
        }
        self.writer.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}
async fn read_owned(
    source: &SourceBytes,
    length: usize,
    budget: Arc<dyn SourceBudget>,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, RunError> {
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(failure)?;
    let mut cursor = source.open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await.map_err(failure)?;
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let read = cursor.read_chunk(buffer).await.map_err(failure)?;
        if read.bytes_read > length.saturating_sub(bytes.len()) {
            return Err(failure("image source length changed"));
        }
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(failure("image source made no progress"));
        }
    }
    if bytes.len() != length {
        return Err(failure("image source length changed"));
    }
    Ok(bytes)
}
async fn read_text(value: &TextSource, budget: Arc<dyn SourceBudget>) -> Result<String, RunError> {
    let mut cursor = recipe::text::cursor(value.clone(), budget.clone());
    let mut buffer = budget.allocate(4096).await.map_err(failure)?;
    let mut bytes = Vec::new();
    loop {
        let read = cursor.read_chunk(buffer).await.map_err(failure)?;
        bytes.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        buffer = read.buffer;
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(failure("image identity made no progress"));
        }
    }
    String::from_utf8(bytes).map_err(failure)
}
async fn visit_content(
    source: &dyn RecipeSource<ContentRecipe>,
    message: usize,
    group: usize,
    visit: &mut impl FnMut(source::Key, MediaSource, Option<JsonSource>) -> Result<(), RunError>,
) -> Result<(), RunError> {
    let mut cursor = source.open(0);
    let mut index = 0;
    while let Some(part) = cursor.next().await.map_err(failure)? {
        if let ContentRecipe::Media {
            media,
            provider_options,
        } = part
        {
            visit((message, group, index), media, provider_options)?;
        }
        index += 1;
    }
    Ok(())
}
async fn visit_images(
    source: &dyn MessageSource,
    visit: &mut impl FnMut(source::Key, MediaSource, Option<JsonSource>) -> Result<(), RunError>,
) -> Result<(), RunError> {
    let mut cursor = source.open(0);
    let mut message = 0;
    while let Some(value) = cursor.next().await.map_err(failure)? {
        match value {
            MessageRecipe::User { content, .. } => {
                visit_content(content.as_ref(), message, 0, visit).await?
            }
            MessageRecipe::Assistant { content, .. } => {
                let mut parts = content.open(0);
                let mut group = 0;
                while let Some(part) = parts.next().await.map_err(failure)? {
                    if let AssistantRecipe::ToolResult(ToolResultRecipe {
                        output: ToolOutputRecipe::Content(content),
                        ..
                    }) = part
                    {
                        visit_content(content.as_ref(), message, group, visit).await?;
                    }
                    group += 1;
                }
            }
            MessageRecipe::Tool { content, .. } => {
                let mut results = content.open(0);
                let mut group = 0;
                while let Some(result) = results.next().await.map_err(failure)? {
                    if let ToolOutputRecipe::Content(content) = result.output {
                        visit_content(content.as_ref(), message, group, visit).await?;
                    }
                    group += 1;
                }
            }
            MessageRecipe::System { .. } => {}
        }
        message += 1;
    }
    Ok(())
}

pub(super) async fn prepare(
    prompt: &mut PreparedPrompt,
    provider: &ProviderConfig,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    if prompt.media_view.is_some() || prompt.body.breakdown().counts.media == 0 {
        return Ok(());
    }
    let Some(base) = prompt.body.recipes().cloned() else {
        return Ok(());
    };
    let Some(resources) = prompt.resources.clone() else {
        return Ok(());
    };
    let work = resources.acquire_work().await.map_err(failure)?;
    let budget = work.budget();
    let mut count = 0usize;
    visit_images(base.as_ref(), &mut |_, _, _| {
        count = add(count, 1)?;
        Ok(())
    })
    .await?;
    if count == 0 {
        return Ok(());
    }
    let directory_bytes = count
        .checked_mul(
            std::mem::size_of::<Work>()
                + std::mem::size_of::<(source::Key, MediaSource, Option<JsonSource>)>()
                + std::mem::size_of::<(source::Key, source::Replacement)>()
                + std::mem::size_of::<PendingImage>()
                + 2 * std::mem::size_of::<ContentRecipe>()
                + 8 * std::mem::size_of::<usize>(),
        )
        .and_then(|bytes| bytes.checked_mul(3))
        .ok_or_else(|| failure("image directory size overflows"))?;
    let directory = prompt
        .preparation
        .as_ref()
        .ok_or_else(|| failure("images lack their staging account"))?
        .plan_directory(directory_bytes)
        .map_err(failure)?;
    let mut inputs = Vec::with_capacity(count);
    visit_images(base.as_ref(), &mut |key, media, options| {
        inputs.push((key, media, options));
        Ok(())
    })
    .await?;
    let limits = provider.image_input.clone().unwrap_or_default();
    let mut total = 0u64;
    let mut per_message = BTreeMap::<usize, u64>::new();
    let mut works = Vec::new();
    let mut peak = 0;
    for (key, media, options) in inputs {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let mime = read_text(&media.media_type, budget.clone()).await?;
        if !mime.starts_with("image/") {
            continue;
        }
        if provider.capabilities.vision == Some(false) {
            return Err(failure(
                "selected route does not support image input; original image is preserved",
            ));
        }
        total += 1;
        let message_count = per_message.entry(key.0).or_default();
        *message_count += 1;
        if limits.max_per_request.is_some_and(|limit| total > limit)
            || limits
                .max_per_message
                .is_some_and(|limit| *message_count > limit)
        {
            return Err(failure(
                "image count exceeds the selected route's declared request/message limit; original images are preserved",
            ));
        }
        let read = media
            .bytes
            .open(budget.clone())
            .read_chunk(budget.allocate(32 * 1024).await.map_err(failure)?)
            .await
            .map_err(failure)?;
        let probe = probe_source(
            &media.bytes,
            &read.buffer.as_ref()[..read.bytes_read],
            budget.clone(),
        )
        .await
        .map_err(failure)?;
        drop(read);
        let output = geometry(probe.geometry, &limits)?;
        let length = media
            .bytes
            .len()
            .ok_or_else(|| failure("captured image length unavailable"))?;
        let accepts = |mime: &str| {
            limits
                .mime_types
                .as_ref()
                .is_none_or(|types| types.iter().any(|value| value == mime))
        };
        let needs_format = !accepts(&mime);
        let transform = output != probe.geometry
            || needs_format
            || limits.max_bytes.is_some_and(|limit| length > limit);
        if !transform && limits.request_bytes.is_none() {
            continue;
        }
        let format = match probe.format {
            image::ImageFormat::Jpeg if accepts("image/jpeg") => Some(image::ImageFormat::Jpeg),
            _ if accepts("image/png") => Some(image::ImageFormat::Png),
            _ if accepts("image/jpeg") => Some(image::ImageFormat::Jpeg),
            _ => None,
        };
        let plan = format
            .map(|format| {
                codec::plan_format(
                    &probe,
                    usize::try_from(length).map_err(failure)?,
                    output,
                    format,
                )
                .map_err(failure)
            })
            .transpose()?;
        if transform && plan.is_none() {
            return Err(failure(
                "selected route accepts no available whole-image output format (PNG or JPEG); original image is preserved",
            ));
        }
        if let Some(plan) = &plan {
            let future_row = if limits.request_bytes.is_some()
                && output == probe.geometry
                && plan.output_format == image::ImageFormat::Png
            {
                plan.decoded_bytes / probe.geometry.height as usize
            } else {
                0
            };
            peak = peak.max(add(plan.peak_bytes, future_row)?);
        }
        let pending = Arc::new(PendingImage(OnceLock::new()));
        let actual = OnceLock::new();
        if !transform {
            pending
                .0
                .set(media.bytes.clone())
                .map_err(|_| failure("image bytes initialized twice"))?;
            actual
                .set(output)
                .map_err(|_| failure("image geometry initialized twice"))?;
        }
        let media_type = if transform {
            generated::text(if format == Some(image::ImageFormat::Jpeg) {
                "image/jpeg"
            } else {
                "image/png"
            })
        } else {
            media.media_type.clone()
        };
        works.push(Work {
            key,
            media,
            options,
            probe,
            format,
            media_type,
            codec: if transform { plan } else { None },
            output,
            actual,
            pending,
        });
    }
    if works.is_empty() {
        return Ok(());
    }
    let identity =
        crate::runner::digest(&(prompt.body.identity(), &provider.image_input, 2000u32))?;
    let view = Arc::new(MediaView {
        works,
        base: base.clone(),
        identity: identity.clone(),
        arena: prompt
            .arena
            .clone()
            .ok_or_else(|| failure("image preparation lacks original request backing"))?,
        resources,
        limits,
        peak,
        _directory: Arc::new(directory),
        materialization: tokio::sync::Mutex::new(false),
        #[cfg(test)]
        decoded_jobs: std::sync::atomic::AtomicUsize::new(0),
    });
    install(prompt, view.clone());
    prompt.resident_bytes = add(prompt.resident_bytes, directory_bytes)?;
    Ok(())
}

fn install(prompt: &mut PreparedPrompt, view: Arc<MediaView>) {
    let replacements = view
        .works
        .iter()
        .map(|item| {
            let mut media = item.media.clone();
            media.media_type = item.media_type.clone();
            media.bytes = SourceBytes::Source(item.pending.clone());
            (
                item.key,
                source::Replacement {
                    part: ContentRecipe::Media {
                        media,
                        provider_options: item.options.clone(),
                    },
                },
            )
        })
        .collect();
    let mapped = source::mapped(
        view.base.clone(),
        Arc::new(replacements),
        view.identity.clone(),
        view.clone(),
    );
    let normalization = prompt.body.normalization().cloned();
    let original_body = prompt.body.clone();
    prompt.body = maka_model::prompt::Prompt::from_recipes(
        mapped,
        view.identity.clone(),
        prompt.body.len(),
        prompt.body.breakdown().clone(),
    );
    prompt.body = prompt.body.clone().with_instructions_from(&original_body);
    if let Some(normalization) = normalization {
        prompt.body = prompt.body.clone().with_normalization(normalization);
    }
    prompt.media_view = Some(view);
    prompt.wire = None;
    prompt.rebuild_recipes();
}

pub(super) async fn fit_request(
    prompt: &mut PreparedPrompt,
    language: maka_agent_facts::language::Language,
    provider: &ProviderConfig,
    options: &serde_json::Value,
    tools: &[maka_model::ToolDefinition],
    max_output_tokens: Option<u64>,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    let Some(limit) = provider
        .image_input
        .as_ref()
        .and_then(|limits| limits.request_bytes)
    else {
        return Ok(());
    };
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let request = maka_model::ModelRequest {
            language,
            provider: provider.clone(),
            prompt: prompt.model(),
            tools: tools.to_vec(),
            provider_options: options.clone(),
            max_output_tokens,
        };
        let bytes = request.encoded_request_sizes().await?.largest();
        if bytes <= limit {
            return Ok(());
        }
        let smaller = prompt
            .media_view
            .as_ref()
            .map(|view| view.smaller())
            .transpose()?
            .flatten();
        let Some(smaller) = smaller else {
            return Err(maka_model::ModelError::ImageInputPayloadTooLarge { bytes, limit }.into());
        };
        install(prompt, smaller);
        super::wire::compile(prompt, language, provider, options, tools, cancellation).await?;
    }
}
#[cfg(test)]
mod tests;

/// JPEG metadata can precede SOF by more than one work buffer. Walk marker
/// segments without retaining EXIF/ICC payloads or imposing a header-size cap.
async fn probe_source(
    source: &SourceBytes,
    initial: &[u8],
    budget: Arc<dyn SourceBudget>,
) -> Result<codec::ImageProbe, String> {
    match codec::probe(initial) {
        Ok(probe) => return Ok(probe),
        Err(error) if !initial.starts_with(&[0xff, 0xd8]) => return Err(error),
        Err(_) => {}
    }
    let mut input = HeaderStream {
        cursor: source.open(budget.clone()),
        buffer: budget
            .allocate(32 * 1024)
            .await
            .map_err(|error| error.to_string())?,
        position: 0,
        used: 0,
        eof: false,
    };
    input.skip(2).await?;
    loop {
        if input.byte().await? != 0xff {
            return Err("JPEG header marker is missing".into());
        }
        let marker = loop {
            let marker = input.byte().await?;
            if marker != 0xff {
                break marker;
            }
        };
        if marker == 0xda || marker == 0xd9 {
            return Err("JPEG dimensions are missing before pixel data".into());
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length = u16::from_be_bytes([input.byte().await?, input.byte().await?]);
        if length < 2 {
            return Err("JPEG header segment has an invalid length".into());
        }
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let mut header = budget
                .allocate(usize::from(length) + 4)
                .await
                .map_err(|error| error.to_string())?;
            header.as_mut()[..6].copy_from_slice(&[
                0xff,
                0xd8,
                0xff,
                marker,
                (length >> 8) as u8,
                length as u8,
            ]);
            input
                .copy(&mut header.as_mut()[6..usize::from(length) + 4])
                .await?;
            return codec::probe(&header.as_ref()[..usize::from(length) + 4]);
        }
        input.skip(usize::from(length) - 2).await?;
    }
}
struct HeaderStream {
    cursor: Box<dyn ByteCursor>,
    buffer: ChargedBuffer,
    position: usize,
    used: usize,
    eof: bool,
}
impl HeaderStream {
    async fn fill(&mut self) -> Result<(), String> {
        if self.position < self.used {
            return Ok(());
        }
        if self.eof {
            return Err("image header ended before dimensions".into());
        }
        // A cursor returns its supplied work buffer. A temporary empty buffer
        // only transfers ownership across the awaited bounded read.
        let buffer = std::mem::replace(&mut self.buffer, ChargedBuffer::new(Vec::new(), ()));
        let read = self
            .cursor
            .read_chunk(buffer)
            .await
            .map_err(|error| error.to_string())?;
        self.buffer = read.buffer;
        self.position = 0;
        self.used = read.bytes_read;
        self.eof = read.eof;
        if self.used == 0 {
            return Err("image header made no progress".into());
        }
        Ok(())
    }
    async fn byte(&mut self) -> Result<u8, String> {
        self.fill().await?;
        let value = self.buffer.as_ref()[self.position];
        self.position += 1;
        Ok(value)
    }
    async fn skip(&mut self, mut bytes: usize) -> Result<(), String> {
        while bytes != 0 {
            self.fill().await?;
            let count = bytes.min(self.used - self.position);
            self.position += count;
            bytes -= count;
        }
        Ok(())
    }
    async fn copy(&mut self, mut output: &mut [u8]) -> Result<(), String> {
        while !output.is_empty() {
            self.fill().await?;
            let count = output.len().min(self.used - self.position);
            output[..count]
                .copy_from_slice(&self.buffer.as_ref()[self.position..self.position + count]);
            self.position += count;
            output = &mut output[count..];
        }
        Ok(())
    }
}
