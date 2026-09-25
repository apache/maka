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

//! Cache closed top-level Markdown blocks; the last block remains open to reinterpretation.
use super::layout::{self, Layout, VisualLine};
use pulldown_cmark::{Event, Parser};
use std::time::{Duration, Instant};

/// Coalesce transport bursts into a fresh full live preview at most every 33 ms.
/// There is no character backlog: a tick catches up completely, and a final
/// result bypasses the delay. Reading/copying still uses the received source.
#[derive(Default)]
pub(crate) struct Cadence {
    rendered: Option<Instant>,
    due: Option<Instant>,
}
impl Cadence {
    pub fn arrived(&mut self) {
        self.due = self.rendered.map(|at| at + Duration::from_millis(33));
    }
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        self.due
            .map(|at| at.saturating_duration_since(now))
            .filter(|wait| !wait.is_zero())
    }
    pub fn flush(&mut self) {
        self.due = None;
    }
    pub fn rendered(&mut self, now: Instant) {
        self.rendered = Some(now);
        self.due = None;
    }
}

#[derive(Default)]
pub struct Markdown {
    code: layout::syntax::Cache,
    source: usize,
    lines: usize,
    bytes: usize,
    text: usize,
    gap: Option<usize>,
    #[cfg(test)]
    parsed: usize,
}
impl Markdown {
    pub fn syntax_bytes(&self) -> usize {
        self.code.bytes()
    }
    /// Reusing a previous layout requires unchanged width/options; reset this cache
    /// first when the source changes other than by appending.
    pub fn render(
        &mut self,
        text: &str,
        width: u16,
        ascii: bool,
        previous: Option<Layout>,
        colors: crate::theme::Palette,
    ) -> Result<Layout, &'static str> {
        if previous.is_none() {
            *self = Self::default();
        }
        // A later reference definition can change any earlier link. Keep full-document parsing
        // for bracket-bearing documents until reference dependencies can be tracked precisely.
        if text.contains('[') {
            self.code.colors = colors;
            return layout::markdown_part(text, width, ascii, true, &mut self.code);
        }
        let mut output = if let Some(mut previous) = previous {
            previous.lines.truncate(self.lines);
            previous.bytes = self.bytes;
            previous.text.truncate(self.text);
            if previous.text.len() < self.text {
                previous
                    .text
                    .extend(std::iter::repeat_n('\n', self.text - previous.text.len()));
            }
            previous
        } else {
            Layout {
                lines: vec![],
                bytes: 0,
                text: String::new(),
            }
        };
        self.code.colors = colors;
        let tail = text
            .get(self.source..)
            .ok_or("Markdown checkpoint outside source")?;
        #[cfg(test)]
        {
            self.parsed += tail.len();
        }
        let cut = closed_prefix(tail);
        if cut > 0 {
            let prefix = layout::markdown_part(&tail[..cut], width, ascii, false, &mut self.code)?;
            #[cfg(test)]
            {
                self.parsed += cut;
            }
            if prefix.lines.iter().any(|line| !line.line.spans.is_empty()) {
                add_gap(&mut output, self.gap)?;
                append(&mut output, prefix, self.source)?;
                while output
                    .lines
                    .last()
                    .is_some_and(|line| line.line.spans.is_empty())
                {
                    self.gap = output.lines.pop().map(|line| line.source);
                    output.text.pop();
                    output.bytes = output
                        .bytes
                        .saturating_sub(std::mem::size_of::<VisualLine>());
                }
            }
            self.source += cut;
            // Subsequent keys are relative to the new, unfrozen Markdown tail.
            self.code.clear();
            self.lines = output.lines.len();
            self.bytes = output.bytes;
            self.text = output.text.len();
        }
        let tail = &text[self.source..];
        #[cfg(test)]
        {
            self.parsed += tail.len();
        }
        let tail = layout::markdown_part(tail, width, ascii, true, &mut self.code)?;
        if tail.lines.iter().any(|line| !line.line.spans.is_empty()) {
            add_gap(&mut output, self.gap)?;
            append(&mut output, tail, self.source)?;
        } else if output.lines.is_empty() {
            return layout::markdown("", width, ascii);
        }
        output
            .text
            .truncate(output.text.trim_end_matches('\n').len());
        Ok(output)
    }
}
fn add_gap(output: &mut Layout, source: Option<usize>) -> Result<(), &'static str> {
    if let Some(source) = source
        && !output.lines.is_empty()
    {
        append(
            output,
            Layout {
                lines: vec![VisualLine {
                    line: Default::default(),
                    source,
                    mapping: vec![],
                }],
                bytes: std::mem::size_of::<VisualLine>() + 1,
                text: "\n".into(),
            },
            0,
        )?;
    }
    Ok(())
}

fn closed_prefix(text: &str) -> usize {
    let mut depth = 0usize;
    let mut last = 0;
    for (event, range) in Parser::new_ext(text, layout::options()).into_offset_iter() {
        match event {
            Event::Start(_) => {
                if depth == 0 && text[range.start..].contains('\n') {
                    last = range.start;
                }
                depth += 1;
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Rule if depth == 0 && text[range.start..].contains('\n') => last = range.start,
            _ => {}
        }
    }
    // An incomplete first line can still merge into the preceding table/list as more bytes
    // arrive. Only a block with a complete first line can certify the preceding boundary.
    // Include that block's original indentation, not only its first semantic token.
    text[..last].rfind('\n').map_or(0, |newline| newline + 1)
}
fn append(output: &mut Layout, mut part: Layout, source: usize) -> Result<(), &'static str> {
    if output.lines.len() + part.lines.len() > layout::MAX_LINES
        || output.bytes + part.bytes > layout::MAX_BYTES
    {
        return Err("Transcript layout exceeds local capacity");
    }
    for line in &mut part.lines {
        line.source += source;
        for span in &mut line.mapping {
            span.source.start += source;
            span.source.end += source;
            span.logical.start += output.text.len();
            span.logical.end += output.text.len();
        }
    }
    output.bytes += part.bytes;
    output.text.push_str(&part.text);
    output.lines.append(&mut part.lines);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn burst_coalescing_never_postpones_the_deadline_and_final_results_flush() {
        let now = Instant::now();
        let mut cadence = Cadence::default();
        cadence.arrived();
        assert!(cadence.wait(now).is_none(), "first text is immediate");
        cadence.rendered(now);
        for _ in 0..100 {
            cadence.arrived();
        }
        assert_eq!(
            cadence.wait(now + Duration::from_millis(20)),
            Some(Duration::from_millis(13))
        );
        assert!(cadence.wait(now + Duration::from_millis(33)).is_none());
        cadence.rendered(now + Duration::from_millis(33));
        cadence.arrived();
        cadence.flush();
        assert!(cadence.wait(now + Duration::from_millis(34)).is_none());
    }
    #[test]
    fn every_stream_prefix_matches_full_render_including_references_and_open_containers() {
        let cases = [
            "# Heading\n\n中文 **bold**\n\n- one\n\n  continued\n  - nested\n\nnext\n---\n\nend",
            "before\n\n```rust\nlet x = 1;\n```\n\nafter\n\n> quote\n> continued\n\nlast",
            "lead\n\n| Name | Value |\n|:---|---:|\n| 中文🦀 | 1 |\n| other | 123456789 |\n\nafter",
            "[ref] and [late]\n\nparagraph\n\n[late]: https://example.test\n[ref]: /first\n",
            "paragraph\n\n<div>\nraw html\n</div>\n\nnext\n\n    indented\n    code\n\nlast",
            "start\n\n- one\n\n  continuation\n\n- two\n\n1. numbered\n\nend\n",
            "start\n\n> quote\n\n> next quote\n\nend\n\n```\n```\n\nlast\n",
            "start\n\n<script>\nnot **markdown**\n</script>\n\nlast\n",
            "start\n\n**中文🦀** &amp; `` `x\ny` ``\n\nend\n",
            "```rust\r\n/* 中文\r\n * comment */\r\nlet x = [1, 2];\r\n```\r\n\r\n```json\r\n{\"name\": \"🦀\"}\r\n```",
            "- code\n\n  ```python\n  def greet():\n      return '中文'\n  ```\n\n  continued\n",
        ];
        for source in cases {
            for width in [5, 24, 80] {
                let mut cache = Markdown::default();
                let mut previous = None;
                for end in source
                    .char_indices()
                    .map(|(offset, _)| offset)
                    .chain([source.len()])
                {
                    let text = &source[..end];
                    let actual = cache
                        .render(
                            text,
                            width,
                            false,
                            previous,
                            crate::theme::Palette::default(),
                        )
                        .unwrap();
                    assert_eq!(
                        actual.lines,
                        layout::markdown(text, width, false).unwrap().lines,
                        "stream/full mismatch at width {width}, source {text:?}"
                    );
                    assert_eq!(
                        actual.text,
                        layout::markdown(text, width, false).unwrap().text,
                        "semantic stream/full mismatch: {text:?}"
                    );
                    previous = Some(actual);
                }
            }
        }
        let mut cache = Markdown::default();
        let mut previous = None;
        let mut source = String::new();
        for n in 0..100 {
            source.push_str(&format!("Paragraph {n}: 中文 plain text.\n\n"));
            previous = Some(
                cache
                    .render(
                        &source,
                        40,
                        false,
                        previous,
                        crate::theme::Palette::default(),
                    )
                    .unwrap(),
            );
        }
        assert!(cache.source > source.len() * 9 / 10);
        assert!(
            cache.parsed < source.len() * 6,
            "closed history must not be parsed on each append"
        );
        let changed = "replacement\n\nnot an append";
        let reset = cache
            .render(changed, 20, true, None, crate::theme::Palette::default())
            .unwrap();
        assert_eq!(
            reset.lines,
            layout::markdown(changed, 20, true).unwrap().lines
        );
    }
}
