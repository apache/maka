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
use maka_capabilities::model_preparation::ActivePreparation;
use maka_model::{DirectoryLease, prompt::Prompt};
use std::{collections::VecDeque, fmt::Write as _, io, sync::Arc};
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
    FitError::Run(if error.kind() == io::ErrorKind::Interrupted {
        RunError::Cancelled
    } else {
        RunError::Preparation(error)
    })
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
    TextSource {
        bytes: SourceBytes::Source(Arc::new(Resident {
            allocation: Arc::new(Allocation {
                bytes,
                _owner: owner.clone(),
            }),
            range: 0..end,
        })),
        encoding: TextEncoding::Utf8,
    }
}
fn literal(text: &'static str) -> TextSource {
    TextSource {
        bytes: SourceBytes::Inline(text.as_bytes().into()),
        encoding: TextEncoding::Utf8,
    }
}
fn prefix_parts(language: Language) -> (&'static str, &'static str, &'static str) {
    match language {
        Language::En => (
            "[Media: request-source message position ",
            ", content part ",
            ", ",
        ),
        Language::ZhCn => (
            "[媒体：request-source message position ",
            "，内容部分 ",
            "，",
        ),
        Language::ZhTw => (
            "[媒體：request-source message position ",
            "，內容部分 ",
            "，",
        ),
    }
}
fn label_suffix(language: Language) -> &'static str {
    match language {
        Language::En => "; original in locally stored history]\n",
        Language::ZhCn => "；原件保存在本地历史中]\n",
        Language::ZhTw => "；原件儲存在本機歷史中]\n",
    }
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
        let (start, middle, end) = prefix_parts(self.language);
        let mut prefix = String::with_capacity(self.prefix_capacity);
        write!(&mut prefix, "{start}{position}{middle}{index}{end}")
            .expect("reserved summary prefix accepts formatting");
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
    match language {
        Language::En => "\n[… omitted from summary input …]\n",
        Language::ZhCn => "\n[… 已从总结输入中省略 …]\n",
        Language::ZhTw => "\n[… 已從總結輸入中省略 …]\n",
    }
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
    match language {
        Language::En => {
            "Conversation excerpts for summarization: text is omitted to fit this model. Complete history remains stored locally."
        }
        Language::ZhCn => "用于总结的对话节选：为适应模型，已省略部分文本；完整历史仍保存在本地。",
        Language::ZhTw => {
            "用於總結的對話節錄：為符合模型容量，已省略部分文字；完整歷史仍儲存在本機。"
        }
    }
}
fn headings(language: Language) -> (&'static str, &'static str) {
    match language {
        Language::En => ("Earlier task or summary:", "Recent conversation:"),
        Language::ZhCn => ("早期任务或摘要：", "近期对话："),
        Language::ZhTw => ("早期任務或摘要：", "近期對話："),
    }
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
        let digits = usize::MAX.ilog10() as usize + 1;
        let (start, middle, end) = prefix_parts(language);
        let fixed_prefix = start.len() + middle.len() + end.len();
        let prefix_capacity = fixed_prefix + 2 * digits;
        let labels =
            ((max_bytes / 4) / (fixed_prefix + 2 + label_suffix(language).len())).min(media_count);
        let omitted_copy = match language {
            Language::En => {
                "\n[ media parts omitted; original media remains in locally stored history.]\n"
            }
            Language::ZhCn => "\n[省略了  个媒体部分；原件仍保存在本地历史中。]\n",
            Language::ZhTw => "\n[省略了  個媒體部分；原件仍儲存在本機歷史中。]\n",
        };
        let omission_capacity = notice(language)
            .len()
            .checked_add(if media_count == 0 { 0 } else { max_bytes / 8 })
            .and_then(|bytes| bytes.checked_add(digits + omitted_copy.len()))
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
            array::<[u8; 32]>(systems.checked_add(2).ok_or_else(overflow)?)?,
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
    resident_limit: Option<usize>,
) -> Result<Plan, FitError> {
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
    let resident_limit = resident_limit.unwrap_or(resources.policy().resident_bytes);
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

/// The additional peak reserved before promoting the original Summary source.
pub(crate) async fn peak_bytes(
    prompt: &PreparedPrompt,
    tokens: u64,
    language: Language,
    cancel: &CancellationToken,
) -> Result<usize, FitError> {
    let estimated = prompt.breakdown().estimated_tokens();
    if estimated == 0 {
        return Ok(0);
    }
    match plan(prompt, tokens.min(estimated - 1), language, cancel, None).await {
        Ok(plan) => Ok(plan.bytes),
        Err(FitError::NeedsBacking { .. }) if prompt.arena().is_some() => {
            backed_peak_bytes(language).map_err(failure)
        }
        Err(error) => Err(error),
    }
}

/// Used only when the complete request's intrinsic resident peak needs backing.
pub(crate) fn backed_peak_bytes(language: Language) -> io::Result<usize> {
    backed::allocation_bytes(language)
}
pub(crate) async fn fit(
    prompt: &PreparedPrompt,
    tokens: u64,
    language: Language,
    cancel: &CancellationToken,
    active: &ActivePreparation,
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
    let plan = match plan(
        prompt,
        tokens,
        language,
        cancel,
        Some(
            active
                .capacity()
                .saturating_sub(PreparedPrompt::backed_wire_bytes()),
        ),
    )
    .await
    {
        Ok(plan) => plan,
        Err(FitError::NeedsBacking { .. }) if prompt.arena().is_some() => {
            return backed::fit(prompt, tokens, language, cancel, active).await;
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
    let lease = active.directory(plan.bytes).map_err(failure)?;
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
            match language { Language::En => write!(&mut omission, "\n[{} media parts omitted; original media remains in locally stored history.]\n", media.omitted), Language::ZhCn => write!(&mut omission, "\n[省略了 {} 个媒体部分；原件仍保存在本地历史中。]\n", media.omitted), Language::ZhTw => write!(&mut omission, "\n[省略了 {} 個媒體部分；原件仍儲存在本機歷史中。]\n", media.omitted) }.expect("reserved summary omission accepts formatting");
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::source::generated::{
        GeneratedMessages, GeneratedRecipes,
    };
    use maka_agent_facts::{context::PreparedContextBreakdown, model::prompt::Message};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct CountedMedia {
        opens: Arc<AtomicUsize>,
    }
    struct MediaCursor {
        position: usize,
    }
    impl ByteSource for CountedMedia {
        fn len(&self) -> Option<u64> {
            Some(20)
        }
        fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            Box::new(MediaCursor { position: 0 })
        }
    }
    impl ByteCursor for MediaCursor {
        fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async move {
                let bytes = b"native-media-payload";
                let count = (bytes.len() - self.position).min(buffer.as_mut().len());
                buffer.as_mut()[..count]
                    .copy_from_slice(&bytes[self.position..self.position + count]);
                self.position += count;
                Ok(SourceRead {
                    buffer,
                    bytes_read: count,
                    eof: self.position == bytes.len(),
                })
            })
        }
    }
    struct Input {
        recipes: GeneratedRecipes<MessageRecipe>,
        metadata: GeneratedMessages,
    }
    impl RecipeSource<MessageRecipe> for Input {
        fn len(&self) -> usize {
            self.recipes.len()
        }
        fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
            self.recipes.open(start)
        }
    }
    impl MessageSource for Input {
        fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
            self.metadata.open_metadata(start)
        }
        fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
            self.metadata.prefix_identity(messages)
        }
    }
    pub(super) fn fixture() -> (PreparedPrompt, Arc<AtomicUsize>, Arc<dyn ByteSource>) {
        let opens = Arc::new(AtomicUsize::new(0));
        let body: Arc<dyn ByteSource> = Arc::new(CountedMedia {
            opens: opens.clone(),
        });
        let content = vec![
            ContentRecipe::Text {
                text: generated::text("earlier log 😀 中 é ".repeat(10_000)),
                provider_options: None,
            },
            ContentRecipe::Media {
                media: MediaSource {
                    bytes: SourceBytes::Source(body.clone()),
                    media_type: literal("image/png"),
                    detail: None,
                },
                provider_options: None,
            },
        ];
        let input = Input {
            recipes: GeneratedRecipes::new(vec![MessageRecipe::User {
                content: Arc::new(GeneratedRecipes::new(content)),
                provider_options: None,
            }]),
            metadata: GeneratedMessages::new(&[Message::user("fixture metadata")]),
        };
        let mut breakdown = PreparedContextBreakdown::default();
        breakdown.user.estimated_tokens = 100_000;
        breakdown.counts.media = 1;
        breakdown.counts.messages = 1;
        let resources =
            maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy::default())
                .unwrap();
        (
            PreparedPrompt::new(Prompt::from_recipes(
                Arc::new(input),
                "fixture",
                1,
                breakdown,
            ))
            .with_resources(resources),
            opens,
            body,
        )
    }
    #[tokio::test]
    async fn summary_retains_native_media_and_hashes_it_only_after_fitting() {
        for (tokens, expected_media) in [(2_000, 1), (500, 0)] {
            let (prompt, opens, original_media) = fixture();
            let peak = peak_bytes(&prompt, tokens, Language::En, &CancellationToken::new())
                .await
                .unwrap();
            let staged = prompt
                .resources()
                .unwrap()
                .reserve_staging(0)
                .await
                .unwrap();
            let active = staged
                .promote(peak + PreparedPrompt::backed_wire_bytes())
                .await
                .unwrap();
            let fitted = fit(
                &prompt,
                tokens,
                Language::En,
                &CancellationToken::new(),
                &active,
            )
            .await
            .unwrap();
            assert!(fitted.breakdown().estimated_tokens() <= tokens);
            assert_eq!(
                opens.load(Ordering::SeqCst),
                expected_media,
                "candidate reductions must not reread media"
            );
            let source = fitted.recipes().unwrap();
            let mut cursor = source.open(0);
            let Some(MessageRecipe::User { content, .. }) = cursor.next().await.unwrap() else {
                panic!("expected fitted user excerpt")
            };
            let work = fitted.resources().unwrap().acquire_work().await.unwrap();
            let budget = work.budget();
            let mut content = content.open(0);
            let mut media = 0;
            let mut text = Vec::new();
            while let Some(part) = content.next().await.unwrap() {
                match part {
                    ContentRecipe::Text { text: source, .. } => {
                        measure_source::text_bytes(
                            &source,
                            &budget,
                            &CancellationToken::new(),
                            |bytes| {
                                text.extend_from_slice(bytes);
                                Ok(())
                            },
                        )
                        .await
                        .unwrap();
                    }
                    ContentRecipe::Media {
                        media:
                            MediaSource {
                                bytes: SourceBytes::Source(source),
                                ..
                            },
                        ..
                    } => {
                        assert!(Arc::ptr_eq(&source, &original_media));
                        media += 1;
                    }
                    _ => panic!("media must retain its native source"),
                }
            }
            assert_eq!(media, expected_media);
            let text = String::from_utf8(text).unwrap();
            assert!(!text.contains("native-media-payload"));
            if expected_media == 0 {
                assert!(text.contains("1 media parts omitted"));
                assert!(text.contains("image/png"));
            }
        }
    }
    #[tokio::test]
    async fn summary_reports_self_residency_overflow_before_reading_bodies() {
        let (prompt, opens, _) = fixture();
        let limit = prompt.resources().unwrap().policy().resident_bytes;
        let prompt = prompt.with_resident_bytes(limit);
        assert!(
            matches!(peak_bytes(&prompt, 500, Language::En, &CancellationToken::new()).await, Err(FitError::NeedsBacking { resident_limit, .. }) if resident_limit == limit)
        );
        assert_eq!(opens.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn summary_retries_reuse_the_active_envelope_without_host_readmission() {
        use futures_util::poll;
        use std::task::Poll;
        let (prompt, _, _) = fixture();
        let peak = peak_bytes(&prompt, 2_000, Language::En, &CancellationToken::new())
            .await
            .unwrap();
        let full = prompt.resident_bytes()
            + prompt.overlay_bytes()
            + peak
            + PreparedPrompt::backed_wire_bytes();
        let resources = maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
            resident_bytes: full,
            ..Default::default()
        })
        .unwrap();
        let prompt = prompt.with_resources(resources.clone());
        let active = resources
            .reserve_staging(0)
            .await
            .unwrap()
            .promote(full)
            .await
            .unwrap();
        let competing = resources.reserve_staging(0).await.unwrap();
        let mut competing = Box::pin(competing.promote(full));
        assert!(matches!(poll!(competing.as_mut()), Poll::Pending));
        let mut last_slice = None;
        for tokens in [2_000, 500] {
            let fitted = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                fit(
                    &prompt,
                    tokens,
                    Language::En,
                    &CancellationToken::new(),
                    &active,
                ),
            )
            .await
            .expect("fitting must not wait for another Full grant")
            .unwrap();
            assert!(fitted.breakdown().estimated_tokens() <= tokens);
            assert!(matches!(poll!(competing.as_mut()), Poll::Pending));
            if tokens == 500 {
                last_slice = Some({
                    let source = fitted.recipes().unwrap();
                    let mut messages = source.open(0);
                    let Some(MessageRecipe::User { content, .. }) = messages.next().await.unwrap()
                    else {
                        panic!("expected summary user")
                    };
                    let mut parts = content.open(0);
                    let Some(ContentRecipe::Text { text, .. }) = parts.next().await.unwrap() else {
                        panic!("expected summary excerpt")
                    };
                    text.bytes.slice(0..1).unwrap()
                });
            }
            drop(fitted);
            assert!(matches!(poll!(competing.as_mut()), Poll::Pending));
        }
        drop(active);
        assert!(
            matches!(poll!(competing.as_mut()), Poll::Pending),
            "last exported source slice must retain its allocation/account"
        );
        drop(last_slice);
        let competing = tokio::time::timeout(std::time::Duration::from_secs(2), competing)
            .await
            .expect("competitor must advance after final source owner is released")
            .unwrap();
        drop(competing);
    }
    async fn logical(prompt: &PreparedPrompt, budget: &Arc<dyn SourceBudget>) -> Vec<u8> {
        let source = prompt.recipes().unwrap();
        let mut cursor = source.open(0);
        let mut result = Vec::new();
        while let Some(recipe) = cursor.next().await.unwrap() {
            serialize_source::message(
                &recipe,
                budget,
                &CancellationToken::new(),
                &mut |bytes| {
                    result.extend_from_slice(bytes);
                    Ok(())
                },
                &mut |_, _| Ok(literal("NATIVE_MEDIA")),
            )
            .await
            .unwrap();
            result.push(b'\n');
        }
        result
    }
    #[tokio::test]
    async fn backed_summary_matches_resident_and_preserves_captured_prefix() {
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let captured = execution
            .store()
            .capture_source(maka_event_log::context::semantic::SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: 1,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        let (prompt, _, _) = fixture();
        let resources = prompt.resources().unwrap().clone();
        let staged = resources.reserve_staging(128).await.unwrap();
        let arena = crate::history::capture_arena::CaptureArena::new(
            captured,
            Some(staged.directory(128).unwrap()),
        )
        .await
        .unwrap();
        let prefix = {
            let work = resources.acquire_work().await.unwrap();
            arena
                .append(
                    SourceBytes::Inline(b"captured-deletable-media".as_slice().into()),
                    work.budget(),
                    &CancellationToken::new(),
                )
                .await
                .unwrap()
        };
        arena.seal().await.unwrap();
        let old_prefix = arena.pending(prefix);
        let prompt = prompt.with_arena(arena.clone()).with_resident_bytes(128);
        let peak = peak_bytes(&prompt, 2_000, Language::En, &CancellationToken::new())
            .await
            .unwrap()
            .max(backed_peak_bytes(Language::En).unwrap());
        let full = prompt.resident_bytes()
            + prompt.overlay_bytes()
            + peak
            + PreparedPrompt::backed_wire_bytes();
        let active = staged.promote(full).await.unwrap();
        for tokens in [2_000, 500] {
            let (expected, identity, breakdown) = {
                let fitted = fit(
                    &prompt,
                    tokens,
                    Language::En,
                    &CancellationToken::new(),
                    &active,
                )
                .await
                .unwrap();
                let work = resources.acquire_work().await.unwrap();
                (
                    logical(&fitted, &work.budget()).await,
                    fitted.model().identity().to_owned(),
                    fitted.breakdown(),
                )
            };
            let fitted = backed::fit(
                &prompt,
                tokens,
                Language::En,
                &CancellationToken::new(),
                &active,
            )
            .await
            .unwrap();
            let work = resources.acquire_work().await.unwrap();
            assert_eq!(
                logical(&fitted, &work.budget()).await,
                expected,
                "storage strategy must not change summary excerpts at {tokens}"
            );
            assert_eq!(fitted.model().identity(), identity);
            assert_eq!(fitted.breakdown(), breakdown);
            let mut prefix_bytes = Vec::new();
            measure_source::raw_bytes(
                &old_prefix,
                &work.budget(),
                &CancellationToken::new(),
                |bytes| {
                    prefix_bytes.extend_from_slice(bytes);
                    Ok(())
                },
            )
            .await
            .unwrap();
            assert_eq!(prefix_bytes, b"captured-deletable-media");
            drop(fitted);
        }
        arena.close().await.unwrap();
        execution.finish();
    }
    #[tokio::test]
    async fn summary_backing_preserves_the_next_wire_allowance() {
        let cancellation = CancellationToken::new();
        let wire_bytes = PreparedPrompt::backed_wire_bytes();
        let expected = {
            let (prompt, _, _) = fixture();
            let peak = peak_bytes(&prompt, 2_000, Language::En, &cancellation)
                .await
                .unwrap();
            let resources = prompt.resources().unwrap();
            let active = resources
                .reserve_staging(0)
                .await
                .unwrap()
                .promote(peak + prompt.resident_bytes() + prompt.overlay_bytes() + wire_bytes)
                .await
                .unwrap();
            let fitted = fit(&prompt, 2_000, Language::En, &cancellation, &active)
                .await
                .unwrap();
            let work = resources.acquire_work().await.unwrap();
            logical(&fitted, &work.budget()).await
        };
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let captured = execution
            .store()
            .capture_source(maka_event_log::context::semantic::SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: 1,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        let (prompt, _, _) = fixture();
        let resources = prompt.resources().unwrap().clone();
        let staged = resources.reserve_staging(128).await.unwrap();
        let arena = crate::history::capture_arena::CaptureArena::new(
            captured,
            Some(staged.directory(128).unwrap()),
        )
        .await
        .unwrap();
        arena.seal().await.unwrap();
        let prompt = prompt.with_arena(arena.clone()).with_resident_bytes(128);
        let resident_peak = peak_bytes(&prompt, 2_000, Language::En, &cancellation)
            .await
            .unwrap();
        let backed_peak = backed_peak_bytes(Language::En).unwrap();
        assert!(
            resident_peak >= backed_peak + wire_bytes,
            "fixture must fit backing and wire while resident fitting alone consumes the envelope"
        );
        let full = prompt.resident_bytes() + prompt.overlay_bytes() + resident_peak;
        let active = staged.promote(full).await.unwrap();
        let fitted = fit(&prompt, 2_000, Language::En, &cancellation, &active)
            .await
            .unwrap();
        let _wire = active
            .directory(wire_bytes)
            .expect("summary must preserve the next wire's fixed allowance");
        let work = resources.acquire_work().await.unwrap();
        assert_eq!(logical(&fitted, &work.budget()).await, expected);
        arena.close().await.unwrap();
        execution.finish();
    }
    pub(super) async fn captured_summary_source() -> (
        tempfile::TempDir,
        maka_event_log::root_store::RootStore,
        maka_event_log::root_store::SessionExecutionLease,
        maka_event_log::context::semantic::CapturedSource,
    ) {
        let (directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let captured = execution
            .store()
            .capture_source(maka_event_log::context::semantic::SemanticSelection {
                session: "session".into(),
                lineage: None,
                after: 0,
                through: 0,
                before: 1,
                captured_through: 0,
                replay: None,
                prior_unknown: false,
            })
            .await
            .unwrap();
        (directory, root, execution, captured)
    }
    #[tokio::test]
    async fn backed_label_slice_and_read_buffer_keep_the_fit_account() {
        use futures_util::poll;
        let (_directory, root, execution, captured) = captured_summary_source().await;
        let arena = crate::history::capture_arena::CaptureArena::new(captured, None)
            .await
            .unwrap();
        let (prompt, _, _) = fixture();
        let full = backed_peak_bytes(Language::En).unwrap()
            + prompt.overlay_bytes()
            + PreparedPrompt::backed_wire_bytes();
        let resources = maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
            resident_bytes: full,
            ..Default::default()
        })
        .unwrap();
        let prompt = prompt
            .with_resources(resources.clone())
            .with_arena(arena.clone());
        let active = resources
            .reserve_staging(0)
            .await
            .unwrap()
            .promote(full)
            .await
            .unwrap();
        let fitted = backed::fit(
            &prompt,
            2_000,
            Language::En,
            &CancellationToken::new(),
            &active,
        )
        .await
        .unwrap();
        let label = {
            let recipes = fitted.recipes().unwrap();
            let mut messages = recipes.open(0);
            let Some(MessageRecipe::User { content, .. }) = messages.next().await.unwrap() else {
                panic!("expected fitted User");
            };
            let mut parts = content.open(1);
            let Some(ContentRecipe::Text { text, .. }) = parts.next().await.unwrap() else {
                panic!("expected retained native media label");
            };
            text.bytes.slice(0..1).unwrap()
        };
        let mut competing = Box::pin(resources.reserve_staging(0).await.unwrap().promote(full));
        drop((fitted, prompt, active));
        assert!(
            poll!(competing.as_mut()).is_pending(),
            "exported label slice must retain Full"
        );
        let work = resources.acquire_work().await.unwrap();
        let mut cursor = label.open(work.budget());
        let read = cursor
            .read_chunk(work.budget().allocate(1).await.unwrap())
            .await
            .unwrap();
        assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"[");
        drop((cursor, label));
        assert!(
            poll!(competing.as_mut()).is_pending(),
            "returned read buffer must retain Full"
        );
        drop(read);
        drop(
            tokio::time::timeout(std::time::Duration::from_secs(2), competing)
                .await
                .expect("Full must advance after the last output buffer")
                .unwrap(),
        );
        arena.close().await.unwrap();
        drop(arena);
        execution.finish();
        root.shutdown().await.unwrap();
    }
}
