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

//! Fit summary excerpts while retaining immutable media and message sources.
use super::{
    frozen::{FrozenDirectory, Items, MessageDescriptor},
    measure_source, serialize_source,
};
use crate::{RunError, prepared_prompt::PreparedPrompt};
use maka_agent_facts::{language::Language, model::prompt_source::source::*};
use maka_model::{DirectoryLease, prompt::Prompt};
use std::{collections::VecDeque, io, sync::Arc};
use tokio_util::sync::CancellationToken;

mod backed;

#[derive(Debug, thiserror::Error)]
pub(crate) enum FitError {
    #[error(
        "summary fitting requires request-local backing ({required_bytes} bytes; resident limit {resident_limit})"
    )]
    NeedsBacking {
        required_bytes: usize,
        resident_limit: usize,
    },
    #[error(transparent)]
    Run(#[from] RunError),
}
fn failure(error: io::Error) -> FitError {
    FitError::Run(RunError::preparation(error))
}
fn overflow() -> io::Error {
    io::Error::other("summary allocation footprint overflow")
}
fn add(total: &mut usize, bytes: usize) -> io::Result<()> {
    *total = total.checked_add(bytes).ok_or_else(overflow)?;
    Ok(())
}
fn array<T>(count: usize) -> io::Result<usize> {
    std::mem::size_of::<T>()
        .checked_mul(count)
        .ok_or_else(overflow)
}
fn arc<T>() -> usize {
    2 * std::mem::size_of::<usize>() + std::mem::size_of::<T>()
}
fn items<T>(count: usize) -> io::Result<usize> {
    Ok(arc::<Items<T>>() + 2 * std::mem::size_of::<usize>() + array::<T>(count)?)
}
struct Owner {
    _input: PreparedPrompt,
    _lease: DirectoryLease,
}
struct Allocation {
    bytes: Box<[u8]>,
    _owner: Arc<Owner>,
}
struct Resident {
    allocation: Arc<Allocation>,
    range: std::ops::Range<usize>,
}
struct ResidentCursor {
    allocation: Arc<Allocation>,
    position: usize,
    end: usize,
}
impl ByteSource for Resident {
    fn len(&self) -> Option<u64> {
        Some((self.range.end - self.range.start) as u64)
    }
    fn slice(&self, range: std::ops::Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        let start = usize::try_from(range.start).map_err(io::Error::other)?;
        let end = usize::try_from(range.end).map_err(io::Error::other)?;
        if start > end || end > self.range.end - self.range.start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "summary text range exceeds allocation",
            ));
        }
        Ok(Arc::new(Self {
            allocation: self.allocation.clone(),
            range: self.range.start + start..self.range.start + end,
        }))
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(ResidentCursor {
            allocation: self.allocation.clone(),
            position: self.range.start,
            end: self.range.end,
        })
    }
}
impl ByteCursor for ResidentCursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let count = buffer.as_mut().len().min(self.end - self.position);
            buffer.as_mut()[..count]
                .copy_from_slice(&self.allocation.bytes[self.position..self.position + count]);
            self.position += count;
            Ok(SourceRead {
                buffer,
                bytes_read: count,
                eof: self.position == self.end,
            })
        })
    }
}
fn resident(text: String, owner: &Arc<Owner>) -> TextSource {
    let bytes = text.into_bytes().into_boxed_slice();
    let end = bytes.len();
    TextSource::new(
        SourceBytes::Source(Arc::new(Resident {
            allocation: Arc::new(Allocation {
                bytes,
                _owner: owner.clone(),
            }),
            range: 0..end,
        })),
        TextEncoding::Utf8,
    )
}
fn literal(text: &'static str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(text.as_bytes().into()),
        TextEncoding::Utf8,
    )
}
fn prefix_capacity(language: Language) -> usize {
    let max = usize::MAX.to_string();
    maka_agent_facts::i18n::summary::media_label_prefix(language, &max, &max).len()
}
fn media_omitted_capacity(language: Language) -> usize {
    // Include max-digit representatives for Russian/CLDR One (...01), Few (...02), and Many (...07).
    [0, 1, 2, 5, i64::MAX, i64::MAX - 5, i64::MAX - 6]
        .into_iter()
        .map(|n| maka_agent_facts::i18n::summary::media_omitted(language, n).len())
        .max()
        .unwrap_or(0)
}
fn label_suffix(language: Language) -> &'static str {
    maka_agent_facts::i18n::summary::media_label_suffix(language)
}
struct Fit<'a> {
    language: Language,
    prefix_capacity: usize,
    owner: &'a Arc<Owner>,
    budget: &'a Arc<dyn SourceBudget>,
    cancel: &'a CancellationToken,
}
impl Fit<'_> {
    fn label(&self, position: usize, index: usize, part: &ContentRecipe) -> io::Result<TextSource> {
        let ContentRecipe::Media { media, .. } = part else {
            return Err(io::Error::other("summary media callback received text"));
        };
        let pos = position.to_string();
        let idx = index.to_string();
        let mut prefix = String::with_capacity(self.prefix_capacity);
        prefix.push_str(&maka_agent_facts::i18n::summary::media_label_prefix(
            self.language,
            &idx,
            &pos,
        ));
        let parts = vec![
            resident(prefix, self.owner),
            media.media_type.clone(),
            literal(label_suffix(self.language)),
        ];
        Ok(text::concat(
            Arc::new(Items::new(parts, self.owner.clone())),
            self.budget.clone(),
        ))
    }
}
struct Ends {
    head: Vec<u8>,
    recent: Vec<u8>,
    tail: Vec<u8>,
    tail_start: usize,
    limit: usize,
}
impl Ends {
    fn new(limit: usize) -> Self {
        Self {
            head: Vec::with_capacity(limit),
            recent: Vec::with_capacity(limit / 2),
            tail: Vec::with_capacity(limit),
            tail_start: 0,
            limit,
        }
    }
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        let count = (self.limit - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..count]);
        let count = (self.limit / 2 - self.recent.len()).min(bytes.len());
        self.recent.extend_from_slice(&bytes[..count]);
        if self.limit == 0 {
            return Ok(());
        }
        if bytes.len() >= self.limit {
            self.tail.clear();
            self.tail
                .extend_from_slice(&bytes[bytes.len() - self.limit..]);
            self.tail_start = 0;
            return Ok(());
        }
        for byte in bytes {
            if self.tail.len() < self.limit {
                self.tail.push(*byte);
            } else {
                self.tail[self.tail_start] = *byte;
                self.tail_start = (self.tail_start + 1) % self.limit;
            }
        }
        Ok(())
    }
    fn ordered_tail(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(self.limit);
        bytes.extend_from_slice(&self.tail[self.tail_start..]);
        bytes.extend_from_slice(&self.tail[..self.tail_start]);
        bytes
    }
}
async fn lossy(
    bytes: &[u8],
    capacity: usize,
    cancellation: &CancellationToken,
) -> Result<String, FitError> {
    let mut result = String::with_capacity(capacity);
    let mut remaining = bytes;
    while !remaining.is_empty() {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        let count = remaining.len().min(4096);
        match std::str::from_utf8(&remaining[..count]) {
            Ok(text) => {
                result.push_str(text);
                remaining = &remaining[count..];
            }
            Err(error) => {
                result.push_str(
                    std::str::from_utf8(&remaining[..error.valid_up_to()])
                        .expect("Utf8Error reports a valid prefix"),
                );
                match error.error_len() {
                    Some(length) => {
                        result.push('\u{fffd}');
                        remaining = &remaining[error.valid_up_to() + length..];
                    }
                    None if count < remaining.len() => {
                        remaining = &remaining[error.valid_up_to()..];
                    }
                    None => {
                        result.push('\u{fffd}');
                        return Ok(result);
                    }
                }
            }
        }
        tokio::task::yield_now().await;
    }
    Ok(result)
}

fn gap(language: Language) -> &'static str {
    maka_agent_facts::i18n::summary::omitted_gap(language)
}
fn excerpt(output: &mut String, text: &str, bytes: usize, language: Language) {
    if text.len() <= bytes {
        output.push_str(text);
        return;
    }
    let gap = gap(language);
    if bytes < gap.len() {
        return;
    }
    let remaining = bytes - gap.len();
    let start = text.floor_char_boundary(remaining / 2);
    let end = text.ceil_char_boundary(text.len() - (remaining - remaining / 2));
    output.push_str(&text[..start]);
    output.push_str(gap);
    output.push_str(&text[end..]);
}
struct StoredLabel {
    text: TextSource,
    bytes: usize,
}
struct File {
    label: StoredLabel,
    content: ContentRecipe,
}
struct Media {
    files: VecDeque<File>,
    omitted: usize,
    labels: VecDeque<StoredLabel>,
    label_bytes: usize,
    max_files: usize,
    label_budget: usize,
}
impl Media {
    fn omit(&mut self, label: StoredLabel) -> io::Result<()> {
        self.omitted = self.omitted.checked_add(1).ok_or_else(overflow)?;
        self.label_bytes = self
            .label_bytes
            .checked_add(label.bytes)
            .ok_or_else(overflow)?;
        self.labels.push_back(label);
        while self.label_bytes > self.label_budget {
            let label = self
                .labels
                .pop_front()
                .expect("retained labels own their byte count");
            self.label_bytes -= label.bytes;
        }
        Ok(())
    }
    async fn content(
        &mut self,
        content: &Arc<dyn RecipeSource<ContentRecipe>>,
        position: usize,
        fit: &Fit<'_>,
    ) -> io::Result<()> {
        let mut cursor = content.open(0);
        let mut index = 0usize;
        while let Some(part) = cursor.next().await? {
            if matches!(part, ContentRecipe::Media { .. }) {
                let text = fit.label(position, index, &part)?;
                let bytes = usize::try_from(
                    measure_source::text_bytes(&text, fit.budget, fit.cancel, |_| Ok(())).await?,
                )
                .map_err(io::Error::other)?;
                self.files.push_back(File {
                    label: StoredLabel { text, bytes },
                    content: part,
                });
                if self.files.len() > self.max_files {
                    let file = self
                        .files
                        .pop_front()
                        .expect("overfull media queue has a first element");
                    self.omit(file.label)?;
                }
            }
            index = index.checked_add(1).ok_or_else(overflow)?;
        }
        Ok(())
    }
    async fn message(
        &mut self,
        message: &MessageRecipe,
        position: usize,
        fit: &Fit<'_>,
    ) -> io::Result<()> {
        match message {
            MessageRecipe::User { content, .. } => self.content(content, position, fit).await?,
            MessageRecipe::Assistant { content, .. } => {
                let mut cursor = content.open(0);
                while let Some(part) = cursor.next().await? {
                    if let AssistantRecipe::ToolResult(ToolResultRecipe {
                        output: ToolOutputRecipe::Content(content),
                        ..
                    }) = part
                    {
                        self.content(&content, position, fit).await?;
                    }
                }
            }
            MessageRecipe::Tool { content, .. } => {
                let mut cursor = content.open(0);
                while let Some(result) = cursor.next().await? {
                    if let ToolOutputRecipe::Content(content) = result.output {
                        self.content(&content, position, fit).await?;
                    }
                }
            }
            MessageRecipe::System { .. } => {}
        }
        Ok(())
    }
}
fn notice(language: Language) -> &'static str {
    maka_agent_facts::i18n::summary::excerpt_notice(language)
}
fn headings(language: Language) -> (&'static str, &'static str) {
    (
        maka_agent_facts::i18n::summary::earlier_heading(language),
        maka_agent_facts::i18n::summary::recent_heading(language),
    )
}
struct Plan {
    bytes: usize,
    max_bytes: usize,
    limit: usize,
    files: usize,
    labels: usize,
    prefix_capacity: usize,
    text_capacity: usize,
    omission_capacity: usize,
    systems: usize,
}
impl Plan {
    fn new(
        tokens: u64,
        systems: usize,
        media_count: usize,
        no_conversation: bool,
        language: Language,
    ) -> io::Result<Self> {
        let max_bytes = usize::try_from(tokens.saturating_mul(3)).map_err(io::Error::other)?;
        let limit = if no_conversation { 0 } else { max_bytes / 2 };
        let files = usize::try_from(tokens.saturating_mul(3) / 4 / 1024)
            .map_err(io::Error::other)?
            .min(media_count);
        let fixed_prefix =
            maka_agent_facts::i18n::summary::media_label_prefix(language, "", "").len();
        let prefix_capacity = prefix_capacity(language);
        let labels =
            ((max_bytes / 4) / (fixed_prefix + 2 + label_suffix(language).len())).min(media_count);
        let omission_capacity = notice(language)
            .len()
            .checked_add(if media_count == 0 { 0 } else { max_bytes / 8 })
            .and_then(|bytes| bytes.checked_add(media_omitted_capacity(language)))
            .ok_or_else(overflow)?;
        let (earlier, recent) = headings(language);
        let text_capacity = (if no_conversation { 0 } else { max_bytes })
            .checked_add(omission_capacity)
            .and_then(|bytes| bytes.checked_add(earlier.len() + recent.len() + 5))
            .ok_or_else(overflow)?;
        let mut bytes = 0usize;
        for capacity in [
            limit,
            limit / 2,
            limit,
            limit,
            limit.checked_mul(3).ok_or_else(overflow)?,
            (limit / 2).checked_mul(3).ok_or_else(overflow)?,
            limit.checked_mul(3).ok_or_else(overflow)?,
            if media_count == 0 { 0 } else { max_bytes / 4 },
            omission_capacity,
            text_capacity,
            text_capacity,
        ] {
            add(&mut bytes, capacity)?;
        }
        let label_count = files
            .checked_add(labels)
            .and_then(|count| count.checked_add(3))
            .ok_or_else(overflow)?;
        let label_metadata = items::<TextSource>(3)?
            .checked_add(text::concat_metadata_bytes()?)
            .and_then(|bytes| bytes.checked_add(arc::<Allocation>() + arc::<Resident>()))
            .and_then(|bytes| bytes.checked_add(prefix_capacity))
            .ok_or_else(overflow)?;
        add(
            &mut bytes,
            label_count
                .checked_mul(label_metadata)
                .ok_or_else(overflow)?,
        )?;
        add(
            &mut bytes,
            array::<File>(files.checked_add(1).ok_or_else(overflow)?)?,
        )?;
        add(
            &mut bytes,
            array::<StoredLabel>(labels.checked_add(1).ok_or_else(overflow)?)?,
        )?;
        let content = files
            .checked_mul(2)
            .and_then(|count| count.checked_add(1))
            .ok_or_else(overflow)?;
        add(&mut bytes, array::<ContentRecipe>(content)?)?;
        add(&mut bytes, items::<ContentRecipe>(content)?)?;
        add(
            &mut bytes,
            array::<MessageDescriptor>(systems.checked_add(1).ok_or_else(overflow)?)?,
        )?;
        let descriptor = 2 * items::<IdentifiedText>(0)? + 2 * std::mem::size_of::<usize>() + 64;
        add(
            &mut bytes,
            systems
                .checked_add(1)
                .and_then(|count| count.checked_mul(descriptor))
                .ok_or_else(overflow)?,
        )?;
        add(
            &mut bytes,
            FrozenDirectory::fixed_metadata_bytes()
                + arc::<Owner>()
                + arc::<Allocation>()
                + arc::<Resident>()
                + std::mem::size_of::<Plan>()
                + std::mem::size_of::<Ends>()
                + std::mem::size_of::<Media>(),
        )?;
        add(&mut bytes, 4 * (2 * std::mem::size_of::<usize>() + 64))?;
        Ok(Self {
            bytes,
            max_bytes,
            limit,
            files,
            labels,
            prefix_capacity,
            text_capacity,
            omission_capacity,
            systems,
        })
    }
}

async fn plan(
    prompt: &PreparedPrompt,
    tokens: u64,
    language: Language,
    cancel: &CancellationToken,
    resident_limit: usize,
) -> Result<Plan, FitError> {
    let source = prompt.recipes().ok_or_else(|| {
        FitError::Run(RunError::Internal(
            "source summary fitting requires immutable message recipes".into(),
        ))
    })?;
    let mut systems = 0usize;
    let mut conversations = 0usize;
    let mut metadata = source.open_metadata(0);
    while let Some(message) = metadata.next().await.map_err(failure)? {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        if message.role == MessageRole::System {
            systems = systems.checked_add(1).ok_or_else(|| failure(overflow()))?;
        } else {
            conversations = conversations
                .checked_add(1)
                .ok_or_else(|| failure(overflow()))?;
        }
    }
    let plan = Plan::new(
        tokens,
        systems,
        usize::try_from(prompt.breakdown().counts.media)
            .map_err(|error| failure(io::Error::other(error)))?,
        conversations == 0,
        language,
    )
    .map_err(|_| FitError::NeedsBacking {
        required_bytes: usize::MAX,
        resident_limit,
    })?;
    let required = prompt
        .resident_bytes()
        .checked_add(prompt.overlay_bytes())
        .and_then(|bytes| bytes.checked_add(plan.bytes))
        .ok_or(FitError::NeedsBacking {
            required_bytes: usize::MAX,
            resident_limit,
        })?;
    if required > resident_limit {
        return Err(FitError::NeedsBacking {
            required_bytes: required,
            resident_limit,
        });
    }
    Ok(plan)
}

pub(crate) async fn fit(
    prompt: &PreparedPrompt,
    tokens: u64,
    language: Language,
    cancel: &CancellationToken,
) -> Result<PreparedPrompt, FitError> {
    if prompt.breakdown().estimated_tokens() <= tokens {
        return Ok(prompt.clone());
    }
    let resources = prompt.resources().ok_or_else(|| {
        FitError::Run(RunError::Internal(
            "source summary fitting requires Host preparation resources".into(),
        ))
    })?;
    let source = prompt.recipes().ok_or_else(|| {
        FitError::Run(RunError::Internal(
            "source summary fitting requires immutable message recipes".into(),
        ))
    })?;
    let model = prompt.model();
    let policy = resources.policy();
    let limit = policy.staging_bytes.min(
        policy
            .resident_bytes
            .saturating_sub(PreparedPrompt::backed_wire_bytes()),
    );
    let plan = match plan(prompt, tokens, language, cancel, limit).await {
        Ok(plan) => plan,
        Err(FitError::NeedsBacking { .. }) if prompt.arena().is_some() => {
            return backed::fit(prompt, tokens, language, cancel).await;
        }
        Err(error) => return Err(error),
    };
    let required = prompt
        .resident_bytes()
        .checked_add(prompt.overlay_bytes())
        .and_then(|bytes| bytes.checked_add(plan.bytes))
        .ok_or_else(|| failure(overflow()))?;
    if cancel.is_cancelled() {
        return Err(RunError::Cancelled.into());
    }
    let lease = match prompt.plan_directory(plan.bytes) {
        Ok(lease) => lease,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock && prompt.arena().is_some() => {
            return backed::fit(prompt, tokens, language, cancel).await;
        }
        Err(error) => return Err(failure(error)),
    };
    let owner = Arc::new(Owner {
        _input: prompt.without_wire(),
        _lease: lease,
    });
    let work = tokio::select! { biased; _ = cancel.cancelled() => return Err(RunError::Cancelled.into()), work = resources.acquire_work() => work.map_err(failure)? };
    let budget = work.budget();
    let fit = Fit {
        language,
        prefix_capacity: plan.prefix_capacity,
        owner: &owner,
        budget: &budget,
        cancel,
    };
    let mut ends = Ends::new(plan.limit);
    let mut media = Media {
        files: VecDeque::with_capacity(plan.files + 1),
        omitted: 0,
        labels: VecDeque::with_capacity(plan.labels + 1),
        label_bytes: 0,
        max_files: plan.files,
        label_budget: plan.max_bytes / 4,
    };
    let mut system = Vec::with_capacity(plan.systems + 1);
    let mut cursor = source.open(0);
    let mut position = 0usize;
    while let Some(message) = cursor.next().await.map_err(failure)? {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        if matches!(message, MessageRecipe::System { .. }) {
            system.push(
                measure_source::describe(message, &budget, owner.clone(), cancel)
                    .await
                    .map_err(failure)?,
            );
            position = position.checked_add(1).ok_or_else(|| failure(overflow()))?;
            continue;
        }
        if matches!(message, MessageRecipe::User { .. }) {
            ends.recent.clear();
        }
        media
            .message(&message, position, &fit)
            .await
            .map_err(failure)?;
        serialize_source::message(
            &message,
            &budget,
            cancel,
            &mut |bytes| ends.write(bytes),
            &mut |index, part| fit.label(position, index, part),
        )
        .await
        .map_err(failure)?;
        ends.write(b"\n").map_err(failure)?;
        position = position.checked_add(1).ok_or_else(|| failure(overflow()))?;
    }
    drop(cursor);
    let head = lossy(&ends.head, plan.limit * 3, cancel).await?;
    let recent = lossy(&ends.recent, (plan.limit / 2) * 3, cancel).await?;
    let ordered = ends.ordered_tail();
    let tail = lossy(&ordered, plan.limit * 3, cancel).await?;
    let system_tokens = system.iter().fold(0u64, |total, message| {
        total.saturating_add(message.breakdown.estimated_tokens())
    });
    let mut text_bytes = plan
        .max_bytes
        .saturating_sub(usize::try_from(system_tokens.saturating_mul(3)).unwrap_or(usize::MAX));
    loop {
        if cancel.is_cancelled() {
            return Err(RunError::Cancelled.into());
        }
        let mut omission = String::with_capacity(plan.omission_capacity);
        omission.push_str(notice(language));
        if media.omitted != 0 {
            omission.push_str(&maka_agent_facts::i18n::summary::media_omitted(
                language,
                i64::try_from(media.omitted).unwrap_or(i64::MAX),
            ));
            let mut labels = Vec::with_capacity(plan.max_bytes / 4);
            for label in &media.labels {
                measure_source::text_bytes(&label.text, &budget, cancel, |bytes| {
                    labels.extend_from_slice(bytes);
                    Ok(())
                })
                .await
                .map_err(failure)?;
            }
            let labels =
                String::from_utf8(labels).map_err(|error| failure(io::Error::other(error)))?;
            excerpt(&mut omission, &labels, plan.max_bytes / 8, language);
        }
        let (earlier, recent_label) = headings(language);
        let mut text = String::with_capacity(plan.text_capacity);
        text.push_str(&omission);
        text.push('\n');
        text.push_str(earlier);
        text.push('\n');
        excerpt(&mut text, &head, text_bytes / 3, language);
        text.push('\n');
        text.push_str(recent_label);
        text.push('\n');
        excerpt(&mut text, &recent, text_bytes / 3, language);
        text.push('\n');
        excerpt(&mut text, &tail, text_bytes / 3, language);
        let used = media.files.iter().fold(
            system_tokens
                .saturating_add(16)
                .saturating_add((text.len() as u64).div_ceil(3)),
            |total, file| {
                total
                    .saturating_add(1024)
                    .saturating_add((file.label.bytes as u64).div_ceil(3))
            },
        );
        if used <= tokens || (text_bytes == 0 && media.files.is_empty()) {
            let mut content = Vec::with_capacity(1 + 2 * media.files.len());
            content.push(ContentRecipe::Text {
                text: resident(text, &owner),
                provider_options: None,
            });
            for file in &media.files {
                content.push(ContentRecipe::Text {
                    text: file.label.text.clone(),
                    provider_options: None,
                });
                content.push(file.content.clone());
            }
            let recipe = MessageRecipe::User {
                content: Arc::new(Items::new(content, owner.clone())),
                provider_options: None,
            };
            let descriptor = measure_source::describe(recipe, &budget, owner.clone(), cancel)
                .await
                .map_err(failure)?;
            system.push(descriptor);
            let directory = FrozenDirectory::new(system, owner.clone());
            let identity = directory.identity();
            let count = directory.len();
            let breakdown = directory.breakdown().clone();
            let mut body = Prompt::from_recipes(Arc::new(directory), identity, count, breakdown);
            if let Some(provider) = model.normalization() {
                body = body.with_normalization(provider.clone());
            }
            body = body.with_instructions_from(&model);
            let mut fitted = PreparedPrompt::new(body)
                .with_preparation_from(prompt)
                .with_resources(resources.clone())
                .with_resident_bytes(required);
            if let Some(arena) = prompt.arena() {
                fitted = fitted.with_arena(arena.clone());
            }
            return Ok(fitted);
        }
        if text_bytes > 0 {
            text_bytes = text_bytes
                .saturating_sub(
                    usize::try_from((used - tokens).saturating_mul(3)).unwrap_or(usize::MAX),
                )
                .min(text_bytes / 2);
        } else if let Some(file) = media.files.pop_front() {
            media.omit(file.label).map_err(failure)?;
        }
    }
}
