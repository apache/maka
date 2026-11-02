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

//! Fit only a provider's summary input. Canonical history is never shortened.
use crate::RunInput;
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::language::Language;
use maka_model::prompt::{AssistantPart, ContentPart, Message, ToolOutput};

pub(super) use maka_agent_facts::context::measure::{estimate, json_tokens};

/// Keep 4% of total context capacity (200k if unknown) available for summary
/// output, even when the full prefix must first be sent to the provider.
fn summary_output_reserve<W>(input: &RunInput<W>) -> u64 {
    input
        .context
        .as_ref()
        .and_then(|context| context.model_context_window)
        .unwrap_or(200_000)
        .saturating_mul(4)
        .div_ceil(100)
        .max(1)
}

/// The desired summary output may exceed the reserve; the final request caps
/// it to available capacity. This is not a minimum summary length.
pub(super) fn summary_output_budget<W>(input: &RunInput<W>) -> u64 {
    summary_output_reserve(input).max(maka_agent_facts::context::effective_output_limit(
        input.main_output_limit,
    ))
}

pub(super) fn summary_budget<W>(input: &RunInput<W>) -> u64 {
    let context = input.context.as_ref();
    let total = context
        .and_then(|context| context.model_context_window)
        .unwrap_or(200_000);
    let window = context
        .and_then(|context| context.context_window)
        .unwrap_or(total);
    window.min(total.saturating_sub(summary_output_reserve(input)))
}

pub(super) fn needs_compaction<W>(
    input: &RunInput<W>,
    prompt: &crate::prepared_prompt::PreparedPrompt,
) -> bool {
    prompt.breakdown().estimated_tokens() > summary_budget(input)
}

/// Overflow recovery scans a fixed view once while retaining only bounded excerpts.
/// File bytes remain native media and are never copied into textual JSON excerpts.
pub(super) async fn fit_prepared_summary(
    prompt: &crate::prepared_prompt::PreparedPrompt,
    tokens: u64,
    language: Language,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<crate::prepared_prompt::PreparedPrompt, crate::RunError> {
    if prompt.breakdown().estimated_tokens() <= tokens {
        return Ok(prompt.clone());
    }
    if prompt.is_generated() {
        return fit_generated_summary(prompt, tokens, language, cancellation).await;
    }
    let active = prompt.active().ok_or_else(|| {
        crate::RunError::Internal("summary source was not promoted to its full envelope".into())
    })?;
    crate::history::source_summary::fit(prompt, tokens, language, cancellation, &active)
        .await
        .map_err(|error| match error {
            crate::history::source_summary::FitError::Run(error) => error,
            error @ crate::history::source_summary::FitError::NeedsBacking { .. } => {
                crate::RunError::Preparation(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    error,
                ))
            }
        })
}

/// Explicit small generated input retains the owned-message test/UI boundary.
async fn fit_generated_summary(
    prompt: &crate::prepared_prompt::PreparedPrompt,
    tokens: u64,
    language: Language,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<crate::prepared_prompt::PreparedPrompt, crate::RunError> {
    use std::collections::VecDeque;
    if prompt.breakdown().estimated_tokens() <= tokens {
        return Ok(prompt.clone());
    }
    let max_bytes = usize::try_from(tokens.saturating_mul(3)).unwrap_or(usize::MAX);
    struct Ends {
        head: Vec<u8>,
        recent: Vec<u8>,
        tail: VecDeque<u8>,
        limit: usize,
    }
    impl std::io::Write for Ends {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let keep = self.limit.saturating_sub(self.head.len()).min(bytes.len());
            self.head.extend_from_slice(&bytes[..keep]);
            let keep = (self.limit / 2)
                .saturating_sub(self.recent.len())
                .min(bytes.len());
            self.recent.extend_from_slice(&bytes[..keep]);
            if bytes.len() >= self.limit {
                self.tail.clear();
                self.tail.extend(&bytes[bytes.len() - self.limit..]);
            } else {
                while self.tail.len() + bytes.len() > self.limit {
                    self.tail.pop_front();
                }
                self.tail.extend(bytes);
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut excerpts = Ends {
        head: Vec::new(),
        recent: Vec::new(),
        tail: VecDeque::new(),
        limit: max_bytes / 2,
    };
    let mut files = VecDeque::new();
    let max_files = (tokens.saturating_mul(3) / 4 / 1024) as usize;
    let mut omitted = 0;
    let mut omitted_labels = VecDeque::new();
    fn remember_omitted(labels: &mut VecDeque<String>, label: String, budget: usize) {
        labels.push_back(label);
        while labels.iter().map(String::len).sum::<usize>() > budget {
            labels.pop_front();
        }
    }
    let mut system = Vec::new();
    let mut cursor = prompt.open();
    let mut position = 0;
    while let Some(mut message) = cursor.next().await? {
        if cancellation.is_cancelled() {
            return Err(crate::RunError::Cancelled);
        }
        if let Message::System { .. } = message {
            system.push(message);
            position += 1;
            continue;
        }
        if matches!(message, Message::User { .. }) {
            excerpts.recent.clear();
        }
        let mut selected = Vec::new();
        let label = format!("request-source message position {position}");
        match &mut message {
            Message::User { content, .. } => {
                extract_media(content, &label, &mut selected, language)
            }
            Message::Assistant { content, .. } => {
                for part in content {
                    if let AssistantPart::ToolResult {
                        output: ToolOutput::Content(parts),
                        ..
                    } = part
                    {
                        extract_media(parts, &label, &mut selected, language);
                    }
                }
            }
            Message::Tool { content, .. } => {
                for result in content {
                    if let ToolOutput::Content(parts) = &mut result.output {
                        extract_media(parts, &label, &mut selected, language);
                    }
                }
            }
            Message::System { .. } => unreachable!(),
        }
        for file in selected {
            files.push_back(file);
            if files.len() > max_files {
                if let Some((label, _)) = files.pop_front() {
                    remember_omitted(&mut omitted_labels, label, max_bytes / 4);
                }
                omitted += 1;
            }
        }
        serde_json::to_writer(&mut excerpts, &message)
            .map_err(|error| crate::RunError::Internal(error.to_string()))?;
        std::io::Write::write_all(&mut excerpts, b"\n")
            .map_err(|error| crate::RunError::Internal(error.to_string()))?;
        position += 1;
    }
    let head = String::from_utf8_lossy(&excerpts.head).into_owned();
    let recent = String::from_utf8_lossy(&excerpts.recent).into_owned();
    let tail = String::from_utf8_lossy(&excerpts.tail.into_iter().collect::<Vec<_>>()).into_owned();
    let notice = match language {
        Language::En => {
            "Conversation excerpts for summarization: text is omitted to fit this model. Complete history remains stored locally."
        }
        Language::ZhCn => "用于总结的对话节选：为适应模型，已省略部分文本；完整历史仍保存在本地。",
        Language::ZhTw => {
            "用於總結的對話節錄：為符合模型容量，已省略部分文字；完整歷史仍儲存在本機。"
        }
    };
    let mut text_bytes = max_bytes.saturating_sub(estimate(&system).saturating_mul(3) as usize);
    loop {
        let omission = if omitted == 0 {
            notice.to_owned()
        } else {
            match language {
                Language::En => format!(
                    "{notice}\n[{omitted} media parts omitted; original media remains in locally stored history.]\n"
                ),
                Language::ZhCn => {
                    format!("{notice}\n[省略了 {omitted} 个媒体部分；原件仍保存在本地历史中。]\n")
                }
                Language::ZhTw => {
                    format!("{notice}\n[省略了 {omitted} 個媒體部分；原件仍儲存在本機歷史中。]\n")
                }
            }
        };
        let omission = if omitted == 0 {
            omission
        } else {
            format!(
                "{omission}{}",
                excerpt(
                    &omitted_labels.iter().cloned().collect::<String>(),
                    max_bytes / 8,
                    language
                )
            )
        };
        let (earlier_label, recent_label) = match language {
            Language::En => ("Earlier task or summary:", "Recent conversation:"),
            Language::ZhCn => ("早期任务或摘要：", "近期对话："),
            Language::ZhTw => ("早期任務或摘要：", "近期對話："),
        };
        let mut content = vec![ContentPart::text(format!(
            "{omission}\n{earlier_label}\n{}\n{recent_label}\n{}\n{}",
            excerpt(&head, text_bytes / 3, language),
            excerpt(&recent, text_bytes / 3, language),
            excerpt(&tail, text_bytes / 3, language)
        ))];
        for (label, file) in &files {
            content.push(ContentPart::text(label));
            content.push(file.clone());
        }
        let mut fitted = system.clone();
        fitted.push(Message::User {
            content,
            provider_options: None,
        });
        let used = estimate(&fitted);
        if used <= tokens || (text_bytes == 0 && files.is_empty()) {
            let mut body = maka_model::prompt::Prompt::from_messages(fitted);
            if let Some(provider) = prompt.model().normalization() {
                body = body.with_normalization(provider.clone());
            }
            let mut fitted = crate::prepared_prompt::PreparedPrompt::new(body);
            if let Some(resources) = prompt.resources() {
                fitted = fitted.with_resources(resources.clone());
            }
            if let Some(arena) = prompt.arena() {
                fitted = fitted.with_arena(arena.clone());
            }
            return Ok(fitted.with_preparation_from(prompt));
        }
        if text_bytes > 0 {
            text_bytes = text_bytes
                .saturating_sub((used - tokens).saturating_mul(3) as usize)
                .min(text_bytes / 2);
        } else if let Some((label, _)) = files.pop_front() {
            remember_omitted(&mut omitted_labels, label, max_bytes / 4);
            omitted += 1;
        }
    }
}

fn extract_media(
    parts: &mut [ContentPart],
    source: &str,
    files: &mut Vec<(String, ContentPart)>,
    language: Language,
) {
    for (index, part) in parts.iter_mut().enumerate() {
        if let ContentPart::File { media_type, .. } = part {
            let label = match language {
                Language::En => format!(
                    "[Media: {source}, content part {index}, {media_type}; original in locally stored history]\n"
                ),
                Language::ZhCn => format!(
                    "[媒体：{source}，内容部分 {index}，{media_type}；原件保存在本地历史中]\n"
                ),
                Language::ZhTw => format!(
                    "[媒體：{source}，內容部分 {index}，{media_type}；原件儲存在本機歷史中]\n"
                ),
            };
            let file = std::mem::replace(part, ContentPart::text(&label));
            files.push((label, file));
        }
    }
}

fn excerpt(text: &str, bytes: usize, language: Language) -> String {
    if text.len() <= bytes {
        return text.into();
    }
    let gap = match language {
        Language::En => "\n[… omitted from summary input …]\n",
        Language::ZhCn => "\n[… 已从总结输入中省略 …]\n",
        Language::ZhTw => "\n[… 已從總結輸入中省略 …]\n",
    };
    if bytes < gap.len() {
        return String::new();
    }
    let remaining = bytes - gap.len();
    let start = text.floor_char_boundary(remaining / 2);
    let end = text.ceil_char_boundary(text.len() - (remaining - remaining / 2));
    format!("{}{gap}{}", &text[..start], &text[end..])
}

/// The final request owns its output reserve, after all prompt/tool projections.
/// This cap never changes the configured model limit or the persisted history.
pub(super) fn output_limit(
    window: Option<u64>,
    estimated_input_tokens: u64,
    requested: u64,
    purpose: ModelPurpose,
) -> u64 {
    let minimum = match purpose {
        ModelPurpose::Main => 1,
        ModelPurpose::Summary => window
            .unwrap_or(200_000)
            .saturating_mul(4)
            .div_ceil(100)
            .max(1),
    };
    window.map_or(requested, |window| {
        requested.min(window.saturating_sub(estimated_input_tokens).max(minimum))
    })
}
