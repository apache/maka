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

//! The Memory page's model-context preview: what the Host gives the model
//! from a MEMORY.md, built from the text in the page's editor as Maka
//! Desktop builds it (`buildLocalMemoryPromptBody` over the draft, in
//! memory-settings-view-model.ts; the parsing is `parseLocalMemoryMarkdownRaw`
//! in packages/core/src/local-memory.ts). It is a preview only: the Host
//! builds the real context from the saved file.
//!
//! Each `## ` heading starts an entry; the first `<!-- maka-memory: … -->`
//! line under it holds its metadata; an entry with no text is skipped.
//! Active entries for every task are kept (one task's entries are not, as
//! no task is open here), each as its heading, its tags, and its text,
//! joined by blank lines and cut at [`PROMPT_MAX_CHARS`]. Desktop also
//! redacts suspected secrets in the preview; this client does not (the
//! Host redacts the file when it is saved).

use host_protocol::MEMORY_DOCUMENT_MAX_BYTES;

/// The longest body the Host gives the model, in UTF-16 units
/// (`LOCAL_MEMORY_PROMPT_MAX_CHARS`).
pub const PROMPT_MAX_CHARS: usize = 12_000;

/// What the preview shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptPreview {
    /// The text is over the Host's size limit: no context at all.
    SafeMode,
    /// No active entry would be given.
    Empty,
    /// The body, and whether it was cut at the limit (the caller appends
    /// the truncation marker in the interface's language).
    Body { text: String, truncated: bool },
}

/// One entry as the preview needs it.
struct Section {
    title: String,
    meta: Option<Vec<(String, String)>>,
    body: Vec<String>,
}

impl Section {
    fn meta(&self, key: &str) -> Option<&str> {
        self.meta.as_ref()?.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// The metadata of a `<!-- maka-memory: key=value … -->` line
/// (`parseMetaComment`).
fn parse_meta(line: &str) -> Option<Vec<(String, String)>> {
    let inner = line.trim().strip_prefix("<!--")?.strip_suffix("-->")?.trim_start();
    let inner = inner.strip_prefix("maka-memory:")?;
    let mut meta = Vec::new();
    for part in inner.split_whitespace() {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let valid_key = key.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if valid_key && value.chars().count() <= 128 && !meta.iter().any(|(k, _)| k == key) {
            meta.push((key.to_owned(), value.to_owned()));
        }
    }
    Some(meta)
}

/// The tags of an entry (`parseTags`): lowercased, runs of anything but
/// letters, digits, CJK, `_`, and `-` as one `-`, at most 32 characters
/// each and eight in all, without repeats.
fn parse_tags(value: Option<&str>) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for raw in value.unwrap_or_default().split(',') {
        let mut tag = String::new();
        let mut replacing = false;
        for c in raw.trim().to_lowercase().chars() {
            let kept = c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || ('\u{4e00}'..='\u{9fa5}').contains(&c)
                || c == '_'
                || c == '-';
            if kept {
                tag.push(c);
            } else if !replacing {
                tag.push('-');
            }
            replacing = !kept;
        }
        let tag: String = tag.trim_matches('-').chars().take(32).collect();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
            if tags.len() >= 8 {
                break;
            }
        }
    }
    tags
}

/// The sections of `text`, in order.
fn sections(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for line in text.lines() {
        if let Some(title) = line.strip_prefix("##").filter(|rest| rest.starts_with([' ', '\t'])) {
            let title = title.trim();
            if !title.is_empty() {
                sections.push(Section { title: title.to_owned(), meta: None, body: Vec::new() });
                continue;
            }
        }
        let Some(current) = sections.last_mut() else {
            continue;
        };
        if let Some(meta) = parse_meta(line) {
            if current.meta.is_none() {
                current.meta = Some(meta);
            }
            continue;
        }
        current.body.push(line.to_owned());
    }
    sections
}

/// The context the Host would give the model from `text`.
pub fn prompt_preview(text: &str) -> PromptPreview {
    if text.len() > MEMORY_DOCUMENT_MAX_BYTES {
        return PromptPreview::SafeMode;
    }
    let blocks: Vec<String> = sections(text)
        .into_iter()
        .filter_map(|section| {
            let content = section.body.join("\n").trim().to_owned();
            // No status is active; an unknown one is not.
            let active = section.meta("status").is_none_or(|status| status == "active");
            let session = section.meta("scope") == Some("session");
            if content.is_empty() || !active || session {
                return None;
            }
            let mut lines = vec![format!("## {}", section.title)];
            let tags = parse_tags(section.meta("tags"));
            if !tags.is_empty() {
                lines.push(format!("Tags: {}", tags.join(", ")));
            }
            lines.push(content);
            Some(lines.join("\n"))
        })
        .collect();
    let body = blocks.join("\n\n").trim().to_owned();
    if body.is_empty() {
        return PromptPreview::Empty;
    }
    if body.encode_utf16().count() <= PROMPT_MAX_CHARS {
        return PromptPreview::Body { text: body, truncated: false };
    }
    // Cut at a character boundary, never inside a surrogate pair
    // (`truncateUtf16Safe`).
    let mut units = 0;
    let cut: String = body
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= PROMPT_MAX_CHARS
        })
        .collect();
    PromptPreview::Body { text: cut.trim_end().to_owned(), truncated: true }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = "# Maka memory\n\nIntro text outside any entry.\n\n\
        ## Preference\n<!-- maka-memory: id=mem-1 origin=manual status=active tags=Style,中文_Notes,style,a--b -->\n\
        Use concise answers.\n\n\
        ## Old\n<!-- maka-memory: id=mem-2 status=archived -->\nNo longer true.\n\n\
        ## One task only\n<!-- maka-memory: id=mem-3 scope=session sessionId=s1 -->\nOnly there.\n\n\
        ## Handwritten\nNo metadata, active by default.\n\n\
        ## Empty\n<!-- maka-memory: id=mem-4 -->\n\n";

    #[test]
    fn the_preview_keeps_active_entries_for_every_task() {
        assert_eq!(
            prompt_preview(DOCUMENT),
            PromptPreview::Body {
                text: "## Preference\nTags: style, 中文_notes, a--b\nUse concise answers.\n\n\
                       ## Handwritten\nNo metadata, active by default."
                    .to_owned(),
                truncated: false,
            }
        );
        assert_eq!(prompt_preview(""), PromptPreview::Empty);
        assert_eq!(
            prompt_preview("## Old\n<!-- maka-memory: status=archived -->\nx"),
            PromptPreview::Empty
        );
    }

    #[test]
    fn a_long_body_is_cut_at_the_limit_and_an_oversize_file_gives_none() {
        let long = format!("## Long\n{}", "字".repeat(PROMPT_MAX_CHARS));
        let PromptPreview::Body { text, truncated } = prompt_preview(&long) else {
            panic!("a body");
        };
        assert!(truncated);
        assert_eq!(text.encode_utf16().count(), PROMPT_MAX_CHARS);
        let emoji = format!("## E\n{}", "😀".repeat(PROMPT_MAX_CHARS));
        let PromptPreview::Body { text, .. } = prompt_preview(&emoji) else {
            panic!("a body");
        };
        assert!(text.encode_utf16().count() <= PROMPT_MAX_CHARS, "no half surrogate pair");
        let oversize = "a".repeat(MEMORY_DOCUMENT_MAX_BYTES + 1);
        assert_eq!(prompt_preview(&oversize), PromptPreview::SafeMode);
    }
}
