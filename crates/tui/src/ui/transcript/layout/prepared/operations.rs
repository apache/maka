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

#[derive(Clone)]
pub(in super::super) struct Run {
    pub text: String,
    pub source: Range<usize>,
    pub exact: bool,
    pub semantic: bool,
    pub word_wrap: bool,
    pub style: Style,
    pub indent: usize,
}
#[derive(Clone)]
pub(in super::super) enum Operation {
    Write(Run),
    Boundary,
    Gap,
    Flush,
    Logical(String),
    FenceStart {
        info: Arc<str>,
        start: usize,
        indent: usize,
        ascii: bool,
    },
    FenceEnd,
    DiffStart {
        marker: &'static str,
        color: Color,
        base: Style,
    },
    DiffEnd,
    Table(Arc<tables::Table>),
}
impl Operation {
    pub(in super::super) fn bytes(&self) -> usize {
        match self {
            Self::Write(run) => run.text.capacity(),
            Self::Logical(text) => text.capacity(),
            Self::Table(table) => table.bytes(),
            Self::FenceStart { info, .. } => info.len(),
            _ => 0,
        }
    }
}
pub(in super::super) fn record(
    writer: &mut Writer,
    text: &str,
    source: Range<usize>,
    exact: bool,
    semantic: bool,
) -> Result<(), &'static str> {
    for grapheme in text.graphemes(true) {
        if grapheme.len() > MAX_GRAPHEME_BYTES {
            return Err("Transcript grapheme exceeds 16 KiB local capacity");
        }
        if semantic {
            if matches!(grapheme, "\n" | "\r\n") {
                writer.append_logical("\n");
            } else if grapheme == "\t" {
                writer.append_logical("\t");
            } else {
                writer.append_logical(&crate::view::safe(grapheme));
            }
        } else if !matches!(grapheme, "\n" | "\r\n") {
            writer.logical_line = true;
        }
    }
    let operations = writer.recording.as_mut().expect("recording writer");
    // The scalar code paths intentionally have no word lookahead across calls.
    if !writer.word_wrap
        && let Some(Operation::Write(last)) = operations.last_mut()
        && !last.word_wrap
        && last.style == writer.style
        && last.indent == writer.indent
        && last.exact == exact
        && last.semantic == semantic
        && ((exact && last.source.end == source.start) || (!exact && last.source == source))
    {
        let previous = last.text.capacity();
        last.text.push_str(text);
        writer.bytes += last.text.capacity() - previous;
        last.source.end = source.end;
    } else {
        writer.bytes += std::mem::size_of::<Operation>() + text.len();
        operations.push(Operation::Write(Run {
            text: text.into(),
            source,
            exact,
            semantic,
            word_wrap: writer.word_wrap,
            style: writer.style,
            indent: writer.indent,
        }));
    }
    if writer.bytes > MAX_BYTES {
        return Err("Prepared transcript exceeds local capacity");
    }
    Ok(())
}

#[derive(Clone)]
pub(in super::super) struct Band {
    pub outer_width: usize,
    pub outer_indent: usize,
    pub first: usize,
    pub anchor: usize,
    pub kind: BandKind,
}
#[derive(Clone)]
pub(in super::super) enum BandKind {
    Fence {
        base: Style,
        bar: &'static str,
        bar_style: Style,
    },
    Diff {
        base: Style,
        marker: &'static str,
        color: Color,
        gutter: usize,
    },
}
impl Band {
    pub(in super::super) fn apply(&self, line: &mut VisualLine, row: usize, width: usize) -> usize {
        let used = line.line.width();
        let (prefix, style, indent, padding, base) = match self.kind {
            BandKind::Fence {
                base,
                bar,
                bar_style,
            } => {
                for span in &mut line.line.spans {
                    span.style = base.patch(span.style);
                }
                (
                    bar,
                    bar_style,
                    self.outer_indent,
                    width.saturating_sub(used) + 2 - bar.width(),
                    base,
                )
            }
            BandKind::Diff {
                base,
                marker,
                color,
                gutter,
            } => (
                if gutter == 0 {
                    ""
                } else if row == self.first {
                    marker
                } else {
                    "  "
                },
                Style::default().fg(color),
                0,
                width.saturating_sub(used),
                base,
            ),
        };
        if matches!(self.kind, BandKind::Fence { .. }) || padding > 0 {
            line.line
                .spans
                .push(Span::styled(" ".repeat(padding), base));
        }
        if !prefix.is_empty() {
            line.line.spans.insert(0, Span::styled(prefix, style));
        }
        if indent > 0 {
            line.line.spans.insert(0, Span::raw(" ".repeat(indent)));
        }
        for span in &mut line.mapping {
            span.display.start += indent + prefix.len();
            span.display.end += indent + prefix.len();
        }
        indent + prefix.len() + padding + 3 * std::mem::size_of::<Span<'static>>()
    }
}

pub(in super::super) fn prepare_fence<'a>(
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
    let info: Arc<str> = match kind {
        CodeBlockKind::Fenced(info) => info.as_ref().into(),
        CodeBlockKind::Indented => "".into(),
    };
    writer.push_operation(Operation::FenceStart {
        info: info.clone(),
        start,
        indent: writer.indent,
        ascii,
    })?;
    let mut body = String::new();
    let mut parts = Vec::new();
    for (event, range) in events.by_ref() {
        match event {
            Event::End(TagEnd::CodeBlock) => break,
            Event::Text(value) => {
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
            let mapped = exact.map_or_else(
                || range.clone(),
                |at| at + local..at + local + grapheme.len(),
            );
            writer.scalar_text(grapheme, mapped, exact.is_some())?;
        }
        offset += value.len();
    }
    if body.is_empty() {
        writer.logical("\n");
    }
    writer.push_operation(Operation::FenceEnd)?;
    writer.boundary()?;
    writer.style = style;
    writer.gap()
}
