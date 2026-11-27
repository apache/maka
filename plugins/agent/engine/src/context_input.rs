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
use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::language::Language;
use maka_model::prompt::{AssistantPart, ContentPart, Message, ToolOutput};

pub(super) use maka_agent_facts::context::measure::estimate;

pub fn summary_budget(context: Option<&maka_agent_facts::context::ModelRequestContext>) -> u64 {
    let total = context
        .and_then(|value| value.model_context_window)
        .unwrap_or(200_000);
    let reserve = total.saturating_mul(4).div_ceil(100).max(1);
    context
        .and_then(|value| value.context_window)
        .unwrap_or(total)
        .min(total.saturating_sub(reserve))
}

/// Overflow recovery scans a fixed view once while retaining only bounded excerpts.
/// File bytes remain native media and are never copied into textual JSON excerpts.
pub async fn fit_prepared_summary(
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
    crate::history::source_summary::fit(prompt, tokens, language, cancellation)
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
        let pos = position.to_string();
        let label = maka_agent_facts::i18n::summary::source_message_position(language, &pos);
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
    let notice = maka_agent_facts::i18n::summary::excerpt_notice(language);
    let mut text_bytes = max_bytes.saturating_sub(estimate(&system).saturating_mul(3) as usize);
    loop {
        let omission = if omitted == 0 {
            notice.to_owned()
        } else {
            format!(
                "{notice}{}",
                maka_agent_facts::i18n::summary::media_omitted(language, i64::from(omitted),)
            )
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
        let earlier_label = maka_agent_facts::i18n::summary::earlier_heading(language);
        let recent_label = maka_agent_facts::i18n::summary::recent_heading(language);
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
            let idx = index.to_string();
            let label =
                maka_agent_facts::i18n::summary::media_label(language, &idx, media_type, source);
            let file = std::mem::replace(part, ContentPart::text(&label));
            files.push((label, file));
        }
    }
}

fn excerpt(text: &str, bytes: usize, language: Language) -> String {
    if text.len() <= bytes {
        return text.into();
    }
    let gap = maka_agent_facts::i18n::summary::omitted_gap(language);
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
pub fn output_limit(
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
