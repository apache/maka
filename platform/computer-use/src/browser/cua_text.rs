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

//! Rich CUA text uses the existing Markdown dependency and virtual clipboard.

use super::*;
use crate::browser_clipboard::{Entry, Item, Items, Payload, PresentationStyle};

fn whitespace(value: char) -> bool {
    matches!(value,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn whitespace_html(value: char) -> &'static str {
    if matches!(value, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
        "<br>"
    } else {
        "&nbsp;"
    }
}
fn edges(value: &str) -> (String, String) {
    let first = value
        .chars()
        .take_while(|value| whitespace(*value))
        .map(whitespace_html)
        .collect::<String>();
    let mut last = value
        .chars()
        .rev()
        .take_while(|value| whitespace(*value))
        .map(whitespace_html)
        .collect::<Vec<_>>();
    last.reverse();
    (first, last.concat())
}

fn soft_breaks(value: &str, options: &markdown::ParseOptions) -> Result<String, ToolError> {
    let tree = markdown::to_mdast(value, options).map_err(failed)?;
    let mut pending = vec![&tree];
    let mut breaks = std::collections::BTreeSet::new();
    while let Some(node) = pending.pop() {
        if let markdown::mdast::Node::Text(text) = node
            && text.value.contains('\n')
            && let Some(position) = &text.position
        {
            let source = value
                .get(position.start.offset..position.end.offset)
                .ok_or_else(|| failed("Markdown source position is not a UTF-8 range"))?;
            for (index, byte) in source.bytes().enumerate() {
                if byte == b'\n' {
                    breaks.insert(position.start.offset + index);
                }
            }
        }
        if let Some(children) = node.children() {
            pending.extend(children);
        }
    }
    let mut result = String::with_capacity(value.len() + breaks.len());
    let mut start = 0;
    for position in breaks {
        result.push_str(&value[start..position]);
        result.push('\\');
        start = position;
    }
    result.push_str(&value[start..]);
    Ok(result)
}

// The shared renderer emits XHTML empty tags. Clipboard consumers observe the
// HTML string, so normalize those known generated tags without touching titles.
fn empty_tags(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = String::with_capacity(value.len());
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let known = value[index..].starts_with("<br ")
            || value[index..].starts_with("<hr ")
            || value[index..].starts_with("<img ");
        if !known {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        let mut quote = None;
        while end < bytes.len() {
            let byte = bytes[end];
            if quote == Some(byte) {
                quote = None;
            } else if quote.is_none() {
                if matches!(byte, b'\'' | b'"') {
                    quote = Some(byte);
                } else if byte == b'>' {
                    break;
                }
            }
            end += 1;
        }
        if end < bytes.len() && bytes.get(end.wrapping_sub(2)..end) == Some(b" /") {
            result.push_str(&value[start..end - 2]);
            result.push('>');
            start = end + 1;
        }
        index = end.saturating_add(1);
    }
    result.push_str(&value[start..]);
    result
}

fn clipboard_html(value: &str) -> String {
    let mut value = empty_tags(value)
        .replace("<del>", "<s>")
        .replace("</del>", "</s>");
    for tag in ["th", "td"] {
        for alignment in ["left", "right", "center"] {
            value = value.replace(
                &format!("<{tag} align=\"{alignment}\">"),
                &format!("<{tag} style=\"text-align:{alignment}\">"),
            );
        }
    }
    value
}

fn html(value: &str) -> Result<String, ToolError> {
    if value.trim_matches(whitespace).is_empty() {
        return Ok(value.chars().map(whitespace_html).collect());
    }
    let normalized = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "\u{fffd}");
    let options = markdown::Options {
        parse: markdown::ParseOptions {
            constructs: markdown::Constructs {
                html_flow: false,
                html_text: false,
                gfm_strikethrough: true,
                gfm_table: true,
                ..markdown::Constructs::default()
            },
            gfm_strikethrough_single_tilde: false,
            ..markdown::ParseOptions::default()
        },
        ..markdown::Options::default()
    };
    let source = soft_breaks(&normalized, &options.parse)?;
    let rendered = markdown::to_html_with_options(&source, &options).map_err(failed)?;
    let rendered = clipboard_html(rendered.trim_matches(whitespace));
    let body = if let Some(paragraph) = rendered
        .strip_prefix("<p>")
        .and_then(|value| value.strip_suffix("</p>"))
        && !paragraph.contains("<p>")
    {
        paragraph
    } else {
        rendered.as_str()
    };
    let (before, after) = edges(value);
    Ok(before + body + &after)
}

pub(super) fn rich_for_url(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_none_or(|url| {
        url.host_str() != Some("docs.google.com")
            || url.port().is_some()
            || url.path().split('/').find(|part| !part.is_empty()) != Some("spreadsheets")
    })
}
pub(super) fn items(value: String, rich: bool) -> Result<Items, ToolError> {
    let mut entries = vec![
        Entry::new(
            "text/plain".into(),
            Payload::Text {
                text: value.clone(),
            },
        )
        .map_err(failed)?,
    ];
    if rich {
        entries.push(
            Entry::new(
                "text/html".into(),
                Payload::Text {
                    text: html(&value)?,
                },
            )
            .map_err(failed)?,
        );
    }
    Items::new(vec![
        Item::new(entries, Some(PresentationStyle::Unspecified)).map_err(failed)?,
    ])
    .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enabled_markdown_strikethrough_and_table_alignment_use_selected_clipboard_tags() {
        assert_eq!(html("~~old~~").unwrap(), "<s>old</s>");
        let table = html("| L | R |\n| :--- | ---: |\n| a | b |").unwrap();
        assert!(table.contains("<th style=\"text-align:left\">L</th>"));
        assert!(table.contains("<td style=\"text-align:right\">b</td>"));
        assert!(!table.contains(" align="));
        assert_eq!(html("<del>x</del>").unwrap(), "&lt;del&gt;x&lt;/del&gt;");
    }
    #[test]
    fn text_items_preserve_plain_and_rendered_whitespace_and_soft_line_breaks() {
        let items = items(" **Café日本語**\nnext \t".into(), true).unwrap();
        let value = serde_json::to_value(items).unwrap();
        assert_eq!(value[0]["entries"][0]["text"], " **Café日本語**\nnext \t");
        assert_eq!(
            value[0]["entries"][1]["text"],
            "&nbsp;<strong>Café日本語</strong><br>\nnext&nbsp;&nbsp;"
        );
    }
    #[test]
    fn code_line_breaks_do_not_become_html_breaks_and_raw_html_is_text() {
        assert_eq!(
            html("```\na\nb\n```").unwrap(),
            "<pre><code>a\nb\n</code></pre>"
        );
        assert_eq!(html("a <b>bold</b>").unwrap(), "a &lt;b&gt;bold&lt;/b&gt;");
        assert_eq!(
            html("http://example.test/").unwrap(),
            "http://example.test/"
        );
    }
    #[test]
    fn all_whitespace_uses_the_selected_javascript_whitespace_set() {
        assert_eq!(
            html(" \r\n\t\u{feff}").unwrap(),
            "&nbsp;<br><br>&nbsp;&nbsp;"
        );
        assert!(!whitespace('\u{0085}'));
    }
    #[test]
    fn sheets_has_plain_text_only_without_broad_host_or_path_matching() {
        for url in [
            "https://docs.google.com/spreadsheets/d/a/edit",
            "https://docs.google.com:443/spreadsheets/d/a",
        ] {
            assert!(!rich_for_url(url));
        }
        for url in [
            "https://docs.google.com/document/d/a",
            "https://docs.google.com:444/spreadsheets/d/a",
            "https://docs.google.com.evil.test/spreadsheets/d/a",
            "about:blank",
        ] {
            assert!(rich_for_url(url));
        }
        let value = serde_json::to_value(items("**raw**".into(), false).unwrap()).unwrap();
        assert_eq!(value[0]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value[0]["entries"][0]["text"], "**raw**");
    }
    #[test]
    fn empty_tag_normalization_never_changes_an_attribute_value() {
        assert_eq!(
            empty_tags("<img src=\"x\" title=\"keep />\" /><br />"),
            "<img src=\"x\" title=\"keep />\"><br>"
        );
    }
}
