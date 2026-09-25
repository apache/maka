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
#[cfg(test)]
use crate::pages::chat::presentation::prompt_content as content;
use unicode_width::UnicodeWidthStr;

/// Three-line prompt previews, following grok-build's user-message hierarchy.
pub(super) fn preview(text: &str, width: u16, ascii: bool) -> Result<(Layout, bool), &'static str> {
    // Attachment-only inputs can leave empty separators at the start of a batched turn.
    // Spend preview rows on content, preserving indentation and full-message source offsets.
    let start: usize = text
        .split_inclusive('\n')
        .take_while(|line| line.trim().is_empty())
        .map(str::len)
        .sum();
    let text = &text[start..];
    // Enough for four wrapped lines, without laying out an entire pasted document.
    let prefix: String = text
        .graphemes(true)
        .take(usize::from(width) * 4 + 32)
        .collect();
    let mut layout = layout::plain(&prefix, width)?;
    for line in &mut layout.lines {
        line.source += start;
        for span in &mut line.mapping {
            span.source.start += start;
            span.source.end += start;
        }
    }
    let expandable = layout
        .lines
        .iter()
        .skip(3)
        .any(|line| !line.line.to_string().trim().is_empty())
        || !text[prefix.len()..].trim().is_empty();
    if !expandable {
        layout.lines.truncate(3);
        return Ok((layout, false));
    }
    layout.lines.truncate(3);
    let last = layout.lines.last_mut().unwrap();
    let ellipsis = if ascii { "." } else { "…" };
    let limit = usize::from(width.saturating_sub(1));
    let rendered = last.line.to_string();
    let mut cells = 0;
    let visible: String = rendered
        .graphemes(true)
        .take_while(|glyph| {
            cells += glyph.width();
            cells <= limit
        })
        .collect();
    let cut = visible.len();
    last.mapping.retain_mut(|span| {
        if span.display.start >= cut {
            return false;
        }
        if span.display.end > cut {
            // A partial expanded tab isn't a selectable source character.
            if !span.exact {
                return false;
            }
            let removed = span.display.end - cut;
            span.display.end = cut;
            span.logical.end -= removed;
            span.source.end -= removed;
        }
        true
    });
    last.line = Line::raw(format!("{visible}{ellipsis}"));
    let end = layout
        .lines
        .iter()
        .flat_map(|line| &line.mapping)
        .map(|span| span.logical.end)
        .max()
        .unwrap_or(0);
    layout.text.truncate(end);
    Ok((layout, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_prompts_stay_whole_long_prompts_preview_three_lines_without_copying_ellipsis_or_hidden_text()
     {
        for text in ["one", "one\ntwo", "one\ntwo\nthree"] {
            let (layout, expandable) = preview(text, 20, false).unwrap();
            assert!(!expandable);
            assert_eq!(layout.text, text);
        }
        let (layout, expandable) = preview("一二三四五六七八九十 hidden", 6, false).unwrap();
        assert!(expandable);
        assert_eq!(layout.lines.len(), 3);
        assert!(layout.lines[2].line.to_string().ends_with('…'));
        assert_eq!(layout.text, "一二三四五六七八");
        assert!(layout.lines.iter().all(|line| line.line.width() <= 6));
        let (wide, expandable) = preview("一二三四五六七八九十 hidden", 80, false).unwrap();
        assert!(!expandable);
        assert!(wide.text.ends_with("hidden"));
        assert!(
            !preview("one\n\n\n\n\n", 20, false).unwrap().1,
            "blank omitted rows do not offer an empty expansion"
        );
    }
    #[test]
    fn resource_only_prompts_show_selected_directories_but_not_attachment_storage_paths() {
        let mut row = serde_json::json!({"text":"", "attachments":[
            {"name":"布局.md", "bytes":113, "ref":{"kind":"session_file","relativePath":"private-storage"}},
            {"name":"image.png", "bytes":2048}
        ]});
        let text = content(&row, false);
        assert_eq!(text, "↳ 布局.md · 113 B\n↳ image.png · 2.0 KiB");
        let (layout, expandable) = preview(&text, 60, false).unwrap();
        assert!(!expandable);
        assert_eq!(layout.text, text);
        row["text"] = serde_json::json!("raw body");
        row["displayText"] = serde_json::json!("visible body");
        assert!(content(&row, true).starts_with("visible body\n+ 布局.md"));
        let directory = serde_json::json!({"text":"", "directoryReferences":[{"hostId":"private-root", "path":"/workspace/目录"}]});
        assert_eq!(content(&directory, false), "▱ /workspace/目录");
        assert_eq!(content(&directory, true), "/ /workspace/目录");
    }

    #[test]
    fn preview_skips_empty_leading_rows_without_losing_indentation_or_source_mapping() {
        let text = "\n \r\n\n\n\n\n\n\n  保留正文\n↳ 布局.md\nthird\nfourth";
        let (layout, expandable) = preview(text, 30, false).unwrap();
        assert!(expandable);
        assert_eq!(layout.lines.len(), 3);
        assert_eq!(layout.lines[0].line.to_string(), "  保留正文");
        assert_eq!(layout.text, "  保留正文\n↳ 布局.md\nthird");
        assert_eq!(layout.lines[0].source, text.find("  保留正文").unwrap());
        for span in layout.lines.iter().flat_map(|line| &line.mapping) {
            assert!(span.exact);
            assert_eq!(
                &text[span.source.clone()],
                &layout.text[span.logical.clone()]
            );
        }
        let (empty, expandable) = preview("\n \r\n", 30, false).unwrap();
        assert!(!expandable);
        assert!(empty.text.is_empty());
    }
}
