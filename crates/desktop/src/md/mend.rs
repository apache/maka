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

//! Closes what a streaming reply has opened but not yet closed, in a copy
//! used only for display, so `**bo` shows as bold "bo" rather than as `**bo`.
//! Only the last paragraph is touched and only by trimming or appending at
//! its end, so every earlier byte keeps its source offset. Code is never
//! mended: an open fence already renders as code.

use std::borrow::Cow;

#[derive(Clone, Copy, PartialEq)]
enum Open {
    Strong,
    Emphasis,
    Strike,
}

impl Open {
    fn marker(self) -> &'static str {
        match self {
            Self::Strong => "**",
            Self::Emphasis => "*",
            Self::Strike => "~~",
        }
    }
}

pub fn mend(source: &str) -> Cow<'_, str> {
    let Some(start) = last_paragraph(source) else {
        return source.into();
    };
    let paragraph = &source[start..];
    if let Some(underline) = setext_underline(paragraph) {
        return source[..start + underline].trim_end().to_owned().into();
    }
    let bytes = paragraph.as_bytes();
    let mut stack: Vec<(Open, usize)> = Vec::new();
    let mut code: Option<(usize, usize)> = None;
    let mut url = false;
    let mut partial = None;
    let mut ix = 0;
    while ix < bytes.len() {
        let byte = bytes[ix];
        if byte == b'\\' {
            ix += 2;
            continue;
        }
        let run = bytes[ix..].iter().take_while(|next| **next == byte).count();
        if byte == b'`' {
            code = match code {
                Some((ticks, _)) if ticks == run => None,
                Some(open) => Some(open),
                None => Some((run, ix)),
            };
            ix += run;
            continue;
        }
        if code.is_some() {
            ix += run;
            continue;
        }
        match byte {
            b'*' | b'~' => {
                let line_start = ix == 0 || bytes[ix - 1] == b'\n';
                let next = bytes.get(ix + run).copied();
                let before = ix.checked_sub(1).map(|at| bytes[at]);
                // A list bullet, or a lone marker between spaces, is not emphasis.
                let bullet = byte == b'*' && run == 1 && line_start && next == Some(b' ');
                let can_open = next.is_some_and(|next| !next.is_ascii_whitespace());
                let can_close = before.is_some_and(|before| !before.is_ascii_whitespace());
                let wanted: &[Open] = match (byte, run) {
                    (b'*', 1) => &[Open::Emphasis],
                    (b'*', 2) => &[Open::Strong],
                    (b'*', 3) => &[Open::Strong, Open::Emphasis],
                    (b'~', 2) => &[Open::Strike],
                    _ => &[],
                };
                // Half of a `~~` still arriving.
                if byte == b'~' && run == 1 && next.is_none() {
                    partial = Some(ix);
                }
                if !bullet {
                    for open in wanted {
                        match stack.iter().rposition(|(kind, _)| kind == open) {
                            Some(at) if can_close => {
                                stack.truncate(at);
                            }
                            _ if can_open || next.is_none() => stack.push((*open, ix)),
                            _ => {}
                        }
                    }
                }
                ix += run;
            }
            b']' if bytes.get(ix + 1) == Some(&b'(') => {
                url = true;
                ix += 2;
            }
            b')' if url => {
                url = false;
                ix += 1;
            }
            _ => ix += run,
        }
    }
    if stack.is_empty() && code.is_none() && !url && partial.is_none() {
        return source.into();
    }
    let mut mended = String::with_capacity(source.len() + 8);
    // A marker with nothing after it yet is dropped rather than closed.
    let cut = stack
        .iter()
        .chain(code.map(|(_, at)| (Open::Strong, at)).as_ref())
        .filter(|(_, at)| {
            paragraph[*at..]
                .trim_start_matches(['*', '~', '`'])
                .trim()
                .is_empty()
        })
        .map(|(_, at)| *at)
        .chain(partial)
        .min()
        .unwrap_or(paragraph.len());
    mended.push_str(source[..start + cut].trim_end());
    if let Some((ticks, at)) = code
        && at < cut
    {
        mended.push_str(&"`".repeat(ticks));
    }
    if url && code.is_none() {
        mended.push(')');
    }
    for (open, at) in stack.iter().rev() {
        if *at < cut {
            mended.push_str(open.marker());
        }
    }
    mended.into()
}

/// Where the last paragraph starts; `None` when the source ends inside a
/// code fence or with one, since code is never mended.
fn last_paragraph(source: &str) -> Option<usize> {
    let mut fence: Option<(u8, usize)> = None;
    let mut start = 0;
    let mut after_fence = false;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        let end = offset + line.len();
        let content = line.trim_start_matches([' ', '>']);
        let marker = fence_marker(content);
        match (fence, marker) {
            (Some((open, len)), Some((first, run)))
                if open == first && run >= len && content[run..].trim().is_empty() =>
            {
                fence = None;
                start = end;
                after_fence = true;
            }
            (Some(_), _) => {}
            (None, Some((first, run))) => fence = Some((first, run)),
            (None, None) if content.trim().is_empty() => start = end,
            (None, None) => after_fence = false,
        }
        offset = end;
    }
    (fence.is_none() && !after_fence).then_some(start)
}

fn fence_marker(line: &str) -> Option<(u8, usize)> {
    let first = *line.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let run = line.bytes().take_while(|byte| *byte == first).count();
    (run >= 3).then_some((first, run))
}

/// A trailing line of only `-` or `=` under text would turn the paragraph
/// into a heading until the next byte arrives; returns where that line starts.
fn setext_underline(paragraph: &str) -> Option<usize> {
    let line_start = paragraph.trim_end_matches('\n').rfind('\n')? + 1;
    if paragraph[..line_start].trim().is_empty() {
        return None;
    }
    let line = paragraph[line_start..].trim();
    let first = line.chars().next()?;
    (matches!(first, '-' | '=') && line.chars().all(|c| c == first)).then_some(line_start)
}

#[cfg(test)]
mod tests {
    use super::mend;
    use crate::md::parse::parse;

    fn rendered(source: &str) -> String {
        parse(source, 0)
            .blocks
            .iter()
            .flat_map(|block| block.texts.iter().map(|text| text.text.clone()))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn closes_what_the_tail_left_open() {
        assert_eq!(mend("Hello **bol"), "Hello **bol**");
        assert_eq!(mend("a *b **c"), "a *b **c***");
        assert_eq!(mend("run `cargo te"), "run `cargo te`");
        assert_eq!(
            mend("see [docs](https://x.y/pa"),
            "see [docs](https://x.y/pa)"
        );
        assert_eq!(mend("gone ~~old"), "gone ~~old~~");
    }

    #[test]
    fn drops_a_marker_with_nothing_after_it() {
        assert_eq!(mend("Hello **"), "Hello");
        assert_eq!(mend("Hello `"), "Hello");
        assert_eq!(mend("Hello **bold** and *"), "Hello **bold** and");
    }

    #[test]
    fn leaves_code_bullets_and_closed_text_alone() {
        assert_eq!(mend("```rust\nlet a = **b"), "```rust\nlet a = **b");
        assert_eq!(mend("* item"), "* item");
        assert_eq!(mend("2 * 3 = 6"), "2 * 3 = 6");
        assert_eq!(mend("done **now**."), "done **now**.");
        assert_eq!(mend("`a*b`"), "`a*b`");
        assert_eq!(mend("**old**\n\nnew"), "**old**\n\nnew");
    }

    #[test]
    fn a_reply_ending_with_code_is_left_alone() {
        let closed = "```py\ndef f():\n\ndef g(*args):\n    pass\n```";
        assert_eq!(mend(closed), closed);
        assert_eq!(mend("~~~\nf(**kw)\n~~~\n"), "~~~\nf(**kw)\n~~~\n");
        assert_eq!(mend("> ```\n> a `b"), "> ```\n> a `b");
        assert_eq!(
            mend("```\ncode\n```\n\nnow **bo"),
            "```\ncode\n```\n\nnow **bo**"
        );
    }

    #[test]
    fn an_underline_still_arriving_is_not_a_heading() {
        assert_eq!(mend("Steps:\n-"), "Steps:");
        assert_eq!(mend("Title\n=="), "Title");
        assert_eq!(mend("---"), "---");
        assert_eq!(mend("a\n\n-"), "a\n\n-");
    }

    #[test]
    fn mending_twice_changes_nothing() {
        for source in ["Hello **bol", "a *b **c", "run `x", "[a](b", "x ~~y"] {
            let once = mend(source).into_owned();
            assert_eq!(mend(&once), once, "{source}");
        }
    }

    #[test]
    fn no_prefix_of_a_reply_shows_a_marker() {
        let reply = "Use **cargo test** to run `the suite`, then *read* the ~~old~~ [notes](https://n.example).";
        for end in (1..=reply.len()).filter(|end| reply.is_char_boundary(*end)) {
            let shown = rendered(&mend(&reply[..end]));
            assert!(
                !shown.contains(['*', '`', '~']) && !shown.contains("]("),
                "{:?} shows {shown:?}",
                &reply[..end]
            );
        }
    }
}
