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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Removed,
    Added,
    Context,
    Content,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub source: Range<usize>,
    pub kind: Kind,
    pub language: Option<&'static str>,
}

/// The diff gutter is decoration, never copied or searched as file content.
pub fn render(text: &str, rows: &[Row], width: u16, ascii: bool) -> Result<Layout, &'static str> {
    render_colored(text, rows, width, ascii, crate::theme::Palette::default())
}
pub fn render_colored(
    text: &str,
    rows: &[Row],
    width: u16,
    ascii: bool,
    colors: crate::theme::Palette,
) -> Result<Layout, &'static str> {
    let mut writer = Writer::new(width);
    let tokens = code_tokens(text, rows);
    let mut tokens = tokens.iter().peekable();
    let mut offset = 0;
    for row in rows {
        writer.text(
            &text[offset..row.source.start],
            offset..row.source.start,
            true,
        )?;
        let (marker, color) = match row.kind {
            Kind::Removed => (if ascii { "- " } else { "− " }, colors.error),
            Kind::Added => ("+ ", colors.success),
            Kind::Context | Kind::Content => ("  ", Color::Reset),
        };
        writer.boundary()?;
        let first_line = writer.lines.len();
        let gutter = if width >= 4 { 2 } else { 0 };
        writer.width = usize::from(width).max(1) - gutter;
        let base = colors.base().bg(background(colors, row.kind));
        for (local, grapheme) in text[row.source.clone()].grapheme_indices(true) {
            let start = row.source.start + local;
            while tokens.peek().is_some_and(|token| token.range.end <= start) {
                tokens.next();
            }
            writer.style = tokens
                .peek()
                .filter(|token| token.range.contains(&start))
                .map_or(base, |token| base.patch(token.style(colors)));
            writer.text(grapheme, start..start + grapheme.len(), true)?;
        }
        writer.boundary()?;
        for (index, line) in writer.lines[first_line..].iter_mut().enumerate() {
            let padding = writer.width.saturating_sub(line.line.width());
            if padding > 0 {
                line.line
                    .spans
                    .push(Span::styled(" ".repeat(padding), base));
                writer.bytes += padding + std::mem::size_of::<Span<'static>>();
            }
            if gutter > 0 {
                let prefix = if index == 0 { marker } else { "  " };
                line.line
                    .spans
                    .insert(0, Span::styled(prefix, Style::default().fg(color)));
                writer.bytes += prefix.len() + std::mem::size_of::<Span<'static>>();
                for span in &mut line.mapping {
                    span.display.start += prefix.len();
                    span.display.end += prefix.len();
                }
            }
        }
        writer.width = usize::from(width).max(1);
        writer.style = Style::default();
        offset = row.source.end;
    }
    writer.text(&text[offset..], offset..text.len(), true)?;
    let mut layout = writer.finish(true)?;
    layout.bytes += std::mem::size_of_val(rows);
    Ok(layout)
}

fn background(colors: crate::theme::Palette, kind: Kind) -> Color {
    let tint = match kind {
        Kind::Removed => colors.error,
        Kind::Added => colors.success,
        Kind::Context | Kind::Content => return colors.surface,
    };
    match (colors.background, tint) {
        (Color::Rgb(r, g, b), Color::Rgb(tr, tg, tb)) => {
            let mix = |base, tint| ((u16::from(base) * 7 + u16::from(tint)) / 8) as u8;
            Color::Rgb(mix(r, tr), mix(g, tg), mix(b, tb))
        }
        _ => colors.surface,
    }
}

/// Parse each side independently: a removed opening comment/string must not
/// leak into the added side. Headers/hunk separators reset both parsers because
/// the omitted file context is unknown. Context uses the after-side styling.
fn code_tokens(text: &str, rows: &[Row]) -> Vec<syntax::Token> {
    let mut result = Vec::new();
    for group in rows.chunk_by(|a, b| a.language == b.language && a.source.end == b.source.start) {
        let Some(language) = group[0].language else {
            continue;
        };
        for before in [true, false] {
            let mut body = String::new();
            let mut parts = Vec::new();
            for row in group.iter().filter(|row| {
                if before {
                    matches!(row.kind, Kind::Removed | Kind::Context)
                } else {
                    row.kind != Kind::Removed
                }
            }) {
                let start = body.len();
                body.push_str(&text[row.source.clone()]);
                parts.push((row, start..body.len()));
            }
            let Some(tokens) = syntax::Cache::default().highlight(0, language, &body) else {
                continue;
            };
            for (row, range) in parts {
                if before && row.kind != Kind::Removed {
                    continue;
                }
                let first = tokens.partition_point(|token| token.range.end <= range.start);
                for token in tokens[first..]
                    .iter()
                    .take_while(|token| token.range.start < range.end)
                {
                    let mut token = token.clone();
                    token.range = row.source.start + token.range.start.max(range.start)
                        - range.start
                        ..row.source.start + token.range.end.min(range.end) - range.start;
                    result.push(token);
                }
            }
        }
    }
    result.sort_unstable_by_key(|token| token.range.start);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_gutters_never_enter_copy_or_source_mapping_and_wrapping_stays_safe() {
        let text = "Requested replacement\n-old 中文🦀é\n+new\t👩‍💻\n\u{1b}[31m\nResult\n";
        let start = text.find("-old").unwrap();
        let middle = text.find("+new").unwrap();
        let end = text.find("Result").unwrap();
        let rows = [
            Row {
                source: start..middle,
                kind: Kind::Removed,
                language: Some("Rust"),
            },
            Row {
                source: middle..end,
                kind: Kind::Added,
                language: Some("Rust"),
            },
        ];
        let expected = plain(text, 80).unwrap().text;
        for width in [1, 4, 8, 80] {
            for ascii in [true, false] {
                let layout = render(text, &rows, width, ascii).unwrap();
                assert_eq!(
                    layout.text, expected,
                    "copy is semantic, not decorated/wrapped"
                );
                for line in &layout.lines {
                    let display = line.line.to_string();
                    assert!(line.line.width() <= usize::from(width));
                    assert!(!display.contains('\u{1b}'));
                    for span in &line.mapping {
                        assert!(layout.text.get(span.logical.clone()).is_some());
                        if span.exact {
                            assert_eq!(&display[span.display.clone()], &text[span.source.clone()]);
                        }
                    }
                }
                if width == 80 {
                    let line = &layout.lines[1];
                    assert!(line.line.to_string().starts_with(if ascii {
                        "- -old"
                    } else {
                        "− -old"
                    }));
                    assert!(
                        line.mapping
                            .iter()
                            .all(|span| span.display.start >= if ascii { 2 } else { 4 })
                    );
                    assert_eq!(
                        line.line.spans[0].style.bg, None,
                        "gutter stays outside the tint"
                    );
                    assert!(line.line.spans.iter().skip(1).all(|span| span.style.bg
                        == Some(background(crate::theme::Palette::default(), Kind::Removed))));
                    assert!(
                        line.line
                            .spans
                            .iter()
                            .any(|span| span.style.fg
                                == Some(crate::theme::Palette::default().error))
                    );
                }
            }
        }
    }
}
