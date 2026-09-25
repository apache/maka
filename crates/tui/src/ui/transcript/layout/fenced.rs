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
use pulldown_cmark::CowStr;

/// Parse the fence body once as a unit, but retain each Markdown event's original
/// source range (list indentation and CRLF normalization can split those ranges).
pub(super) fn render<'a>(
    writer: &mut Writer,
    source: &str,
    kind: CodeBlockKind<'a>,
    start: usize,
    events: &mut impl Iterator<Item = (Event<'a>, Range<usize>)>,
    cache: &mut syntax::Cache,
    ascii: bool,
) -> Result<(), &'static str> {
    writer.boundary()?;
    let style = writer.style;
    let info = match kind {
        CodeBlockKind::Fenced(info) => info,
        CodeBlockKind::Indented => CowStr::from(""),
    };
    let width = writer.width;
    let indent = writer.indent.min(width.saturating_sub(1));
    // A flat recessed band, without a border or language label: code reads as
    // content, not as a nested window. Terminal-owned colors keep a left rule.
    let panel = width.saturating_sub(indent) >= 8;
    if panel {
        writer.width = width - indent - 2;
        writer.indent = 0;
    } else if !info.is_empty() {
        writer.style = Style::default().fg(cache.colors.subtle);
        writer.decoration(&info, start)?;
        writer.flush()?;
    }
    let mut parts = Vec::new();
    let first_line = writer.lines.len();
    let mut body = String::new();
    for (event, range) in events.by_ref() {
        match event {
            Event::End(TagEnd::CodeBlock) => break,
            Event::Text(value) => {
                if body.len().saturating_add(value.len()) > MAX_BYTES {
                    return Err("Code block exceeds local capacity");
                }
                body.push_str(&value);
                parts.push((value, range));
            }
            _ => {}
        }
    }
    let tokens = cache.highlight(start, &info, &body).unwrap_or_default();
    let mut tokens = tokens.iter().peekable();
    let mut offset = 0;
    for (value, range) in parts {
        let exact = source
            .get(range.clone())
            .and_then(|raw| raw.find(value.as_ref()))
            .map(|at| range.start + at);
        // Select style at grapheme starts. Lexer boundaries must never split a
        // combining character or ZWJ sequence into separate terminal cells.
        for (local, grapheme) in value.grapheme_indices(true) {
            while tokens
                .peek()
                .is_some_and(|token| token.range.end <= offset + local)
            {
                tokens.next();
            }
            writer.style = tokens
                .peek()
                .map_or(Style::default(), |token| token.style(cache.colors));
            let source_range = exact.map_or_else(
                || range.clone(),
                |at| at + local..at + local + grapheme.len(),
            );
            writer.text(grapheme, source_range, exact.is_some())?;
        }
        offset += value.len();
    }
    if panel {
        writer.boundary()?;
        if writer.lines.len() == first_line {
            // An empty (or still-open) fence anchors its band at the fence, so
            // streamed prefixes and the full render agree.
            writer.source = Some(start);
            writer.flush()?;
        }
        let colors = cache.colors;
        let base = colors.base().bg(colors.panel());
        let (bar, bar_style) = if colors.terminal {
            (if ascii { "| " } else { "│ " }, base.fg(colors.border))
        } else {
            (" ", base)
        };
        let prefix_bytes = indent + bar.len();
        for line in &mut writer.lines[first_line..] {
            let padding = writer.width.saturating_sub(line.line.width()) + 2 - bar.width();
            writer.bytes += prefix_bytes + padding + 3 * std::mem::size_of::<Span<'static>>();
            // Style only the band spans: Line.style also colors the chat's
            // disclosure gutter, which sits outside this layout.
            for span in &mut line.line.spans {
                span.style = base.patch(span.style);
            }
            line.line.spans.insert(0, Span::styled(bar, bar_style));
            if indent > 0 {
                line.line.spans.insert(0, Span::raw(" ".repeat(indent)));
            }
            line.line
                .spans
                .push(Span::styled(" ".repeat(padding), base));
            for span in &mut line.mapping {
                span.display.start += prefix_bytes;
                span.display.end += prefix_bytes;
            }
        }
        writer.width = width;
        writer.indent = indent;
    }
    writer.style = style;
    writer.gap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fenced_highlighting_preserves_source_copy_graphemes_and_unknown_languages() {
        for language in ["rust", "unknown-language"] {
            let source = format!(
                "- code\n\n  ```{language}\n  fn main() {{\n    let s = \"中文é👩‍💻\"; // note\n    println!(\"{{}}\", 42);\n  }}\n  ```\n"
            );
            for width in [1, 7, 80] {
                let rendered = markdown(&source, width, false).unwrap();
                assert!(rendered.text.contains("中文é👩‍💻"));
                assert!(!rendered.text.contains(language));
                for line in &rendered.lines {
                    let display = line.line.to_string();
                    for span in &line.mapping {
                        if span.exact {
                            assert_eq!(
                                &display[span.display.clone()],
                                &source[span.source.clone()]
                            );
                        }
                    }
                }
                if width == 80 {
                    let code = rendered
                        .lines
                        .iter()
                        .find(|line| line.line.to_string().contains("let s"))
                        .unwrap();
                    let colors: std::collections::HashSet<_> = code
                        .line
                        .spans
                        .iter()
                        .filter(|span| {
                            !span.content.trim().is_empty()
                                && span.style.fg != Some(crate::theme::Palette::default().border)
                        })
                        .map(|span| span.style.fg)
                        .collect();
                    assert_eq!(colors.len() > 1, language == "rust");
                }
            }
        }
    }
}
