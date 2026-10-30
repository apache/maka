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

//! Composable provider-input accounting with per-term rounding.
use crate::context::{ContextBucket, ContextCounts, PreparedContextBreakdown};
use crate::model::ToolInput;
use crate::model::prompt::{AssistantPart, ContentPart, Message, ToolOutput};

/// A preflight estimate, never measured provider usage. Attachment encodings
/// are not text tokens; provider overflow is handled by fitting a smaller request.
pub fn estimate(prompt: &[Message]) -> u64 {
    prompt_breakdown(prompt).estimated_tokens()
}

pub fn breakdown(
    prompt: &[Message],
    tools: &[crate::tools::ToolDefinition],
) -> PreparedContextBreakdown {
    let mut measured = prompt_breakdown(prompt);
    measured.counts.tools = tools.len() as u64;
    add_json(&mut measured.tool_schemas, tools);
    measured
}

pub fn prompt_breakdown(prompt: &[Message]) -> PreparedContextBreakdown {
    let mut measured = PreparedContextBreakdown::default();
    for message in prompt {
        measured.counts.messages += 1;
        let (bucket, counts) = match message {
            Message::System { .. } => (&mut measured.system, &mut measured.counts),
            Message::User { .. } => (&mut measured.user, &mut measured.counts),
            Message::Assistant { .. } => (&mut measured.assistant, &mut measured.counts),
            Message::Tool { .. } => (&mut measured.tool, &mut measured.counts),
        };
        bucket.estimated_tokens += 16;
        match message {
            Message::System { content, .. } => add_text(bucket, content),
            Message::User { content, .. } => {
                for part in content {
                    add_content(bucket, counts, part);
                }
            }
            Message::Assistant { content, .. } => {
                for part in content {
                    match part {
                        AssistantPart::Text { text, .. }
                        | AssistantPart::Reasoning { text, .. } => add_text(bucket, text),
                        AssistantPart::ToolCall {
                            tool_name, input, ..
                        } => {
                            counts.tool_calls += 1;
                            bucket.estimated_tokens += 16;
                            add_text(bucket, tool_name);
                            match input {
                                ToolInput::Json(value) => add_json(bucket, value),
                                ToolInput::InvalidJson { raw } => add_text(bucket, raw),
                            }
                        }
                        AssistantPart::ToolResult {
                            tool_name, output, ..
                        } => add_result(bucket, counts, tool_name, output),
                    }
                }
            }
            Message::Tool { content, .. } => {
                for part in content {
                    add_result(bucket, counts, &part.tool_name, &part.output);
                }
            }
        }
    }
    measured
}

fn add_text(bucket: &mut ContextBucket, text: &str) {
    add_bytes(bucket, text.len() as u64);
}
fn add_bytes(bucket: &mut ContextBucket, bytes: u64) {
    bucket.content_bytes += bytes;
    // Preserve each original estimator term's rounding, not ceil(sum(bytes)/3).
    bucket.estimated_tokens += bytes.div_ceil(3);
}
fn add_json(bucket: &mut ContextBucket, value: &(impl serde::Serialize + ?Sized)) {
    add_bytes(bucket, json_bytes(value));
}
fn add_content(bucket: &mut ContextBucket, counts: &mut ContextCounts, part: &ContentPart) {
    match part {
        ContentPart::Text { text, .. } => add_text(bucket, text),
        ContentPart::File { .. } => {
            counts.media += 1;
            bucket.estimated_tokens += 1024;
        }
    }
}
fn add_result(
    bucket: &mut ContextBucket,
    counts: &mut ContextCounts,
    name: &str,
    output: &ToolOutput,
) {
    counts.tool_results += 1;
    bucket.estimated_tokens += 16;
    add_text(bucket, name);
    match output {
        ToolOutput::Text(text) | ToolOutput::ErrorText(text) => add_text(bucket, text),
        ToolOutput::Json(value) | ToolOutput::ErrorJson(value) => add_json(bucket, value),
        ToolOutput::Content(parts) => {
            for part in parts {
                add_content(bucket, counts, part);
            }
        }
    }
}
pub fn json_tokens(value: &(impl serde::Serialize + ?Sized)) -> u64 {
    json_bytes(value).div_ceil(3)
}
fn json_bytes(value: &(impl serde::Serialize + ?Sized)) -> u64 {
    struct Count(u64);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len() as u64);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).expect("model prompt is serializable");
    count.0
}
