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

//! User-activated client navigation; Host file access retains its original scope.

use super::{Owner, execute};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::{attachment::ATTACHMENT_RESOURCE_PREFIX, read::ResourceAddress};
use nsh_core::element::{JsHost, JsIn, JsOwned, PropError, TsTypes};
use nsh_core::prelude::*;
use std::sync::Arc;
use url::Url;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinkAnchor {
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
}

enum Destination {
    Browser(Url),
    Disk(Vec<u8>, LinkAnchor),
    Attachment(String),
}

fn parse_fragment_anchor(fragment: &str) -> LinkAnchor {
    let trimmed = fragment.trim();
    let Some(rest) = trimmed
        .strip_prefix('L')
        .or_else(|| trimmed.strip_prefix('l'))
    else {
        return LinkAnchor::default();
    };
    let (first, second) = rest.split_once('-').unwrap_or((rest, ""));
    let (line, column) = parse_line_col_part(first);
    let end_line = if second.is_empty() {
        None
    } else {
        let stripped = second
            .strip_prefix('L')
            .or_else(|| second.strip_prefix('l'))
            .unwrap_or(second);
        parse_line_col_part(stripped).0
    };
    LinkAnchor {
        line,
        end_line,
        column,
    }
}

fn parse_line_col_part(part: &str) -> (Option<u32>, Option<u32>) {
    if let Some((l, c)) = part.split_once(['C', 'c', ':']) {
        let line = l.parse::<u32>().ok().filter(|v| *v >= 1).map(|v| v - 1);
        let col = c.parse::<u32>().ok().filter(|v| *v >= 1).map(|v| v - 1);
        (line, col)
    } else {
        let line = part.parse::<u32>().ok().filter(|v| *v >= 1).map(|v| v - 1);
        (line, None)
    }
}

fn split_colon_suffix(raw_path: &str) -> (&str, LinkAnchor) {
    // Support `src/foo.rs:42` and `src/foo.rs:42:10` on relative paths.
    let mut parts = raw_path.rsplitn(3, ':');
    let Some(last) = parts.next() else {
        return (raw_path, LinkAnchor::default());
    };
    let Ok(last_num) = last.parse::<u32>() else {
        return (raw_path, LinkAnchor::default());
    };
    if last_num == 0 {
        return (raw_path, LinkAnchor::default());
    }
    if let Some(mid) = parts.next() {
        if let Ok(mid_num) = mid.parse::<u32>()
            && mid_num >= 1
            && let Some(prefix) = parts.next()
            && !prefix.is_empty()
        {
            return (
                prefix,
                LinkAnchor {
                    line: Some(mid_num - 1),
                    end_line: None,
                    column: Some(last_num - 1),
                },
            );
        }
        let prefix_len = raw_path.len() - last.len() - 1;
        let prefix = &raw_path[..prefix_len];
        if !prefix.is_empty() {
            return (
                prefix,
                LinkAnchor {
                    line: Some(last_num - 1),
                    end_line: None,
                    column: None,
                },
            );
        }
    }
    (raw_path, LinkAnchor::default())
}

fn destination(target: &str) -> Result<Destination, String> {
    if target.is_empty() || target.chars().any(char::is_control) {
        return Err("The link is empty or contains control characters.".into());
    }
    if target.starts_with(ATTACHMENT_RESOURCE_PREFIX) || target.starts_with("attachment:") {
        let Some(ResourceAddress::Attachment(id)) = ResourceAddress::parse(target)? else {
            return Err("Invalid session image reference.".into());
        };
        return Ok(Destination::Attachment(id));
    }
    if let Some(rest) = target.strip_prefix("file://") {
        let path = rest
            .strip_prefix("localhost/")
            .map(|_| &rest["localhost".len()..])
            .unwrap_or(rest);
        if !path.starts_with('/') || path.starts_with("//") {
            return Err("A file URL must name a path on the connected Host.".into());
        }
        return disk(path);
    }
    if target
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && matches!(target.as_bytes().get(1..3), Some(b":/" | b":\\"))
    {
        return disk(target);
    }
    // Distinguish RFC 3986 URI schemes (`javascript:1`, `tel:12345`, `vscode.git:foo`, `https://...`)
    // from workspace-relative `path:line[:col]` links (`src/foo.rs:12:4`, `Cargo.toml:8`).
    let looks_like_scheme = target.split_once(':').is_some_and(|(head, tail)| {
        let valid_scheme = head.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && head
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'));
        if !valid_scheme {
            return false;
        }
        let numeric_line_tail = {
            let before_frag = tail.split(['?', '#']).next().unwrap_or_default();
            !before_frag.is_empty()
                && before_frag
                    .split(':')
                    .take(3)
                    .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
                && before_frag.split(':').count() <= 2
        };
        if !numeric_line_tail {
            return true;
        }
        // `head:digits` without `/`: treat as root-level file (`Cargo.toml:12`, `Makefile:9`)
        // only when `head` has an extension or starts uppercase; lowercase bare tokens like
        // `javascript:1` or `tel:12345` remain URI schemes and are rejected below.
        !head.contains('.') && !head.as_bytes()[0].is_ascii_uppercase()
    });
    if looks_like_scheme || target.starts_with("//") {
        let url = Url::parse(target)
            .map_err(|_| "The link is not a valid URI or workspace-relative path.")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("Only HTTP(S) links can open in the system browser.".into());
        }
        return Ok(Destination::Browser(url));
    }
    disk(target)
}

fn disk(target: &str) -> Result<Destination, String> {
    // URI query/fragment delimiters are separated before percent decoding:
    // `%23` names a file character, while `#L20` refers to that file.
    let fragment = target.split_once('#').map(|(_, frag)| frag).unwrap_or("");
    let raw_before_query = target.split(['?', '#']).next().unwrap_or_default();
    if raw_before_query.is_empty() {
        return Err("Links to a message heading are not yet supported.".into());
    }
    let frag_anchor = parse_fragment_anchor(fragment);
    let (path_slice, colon_anchor) = if frag_anchor.line.is_none() {
        split_colon_suffix(raw_before_query)
    } else {
        (raw_before_query, LinkAnchor::default())
    };
    let anchor = if frag_anchor.line.is_some() {
        frag_anchor
    } else {
        colon_anchor
    };
    let bytes = percent_encoding::percent_decode_str(path_slice).collect::<Vec<_>>();
    if bytes.is_empty() || bytes.contains(&0) {
        return Err("Invalid file path.".into());
    }
    Ok(Destination::Disk(bytes, anchor))
}

pub struct MarkdownLink(Destination);

impl JsValue for MarkdownLink {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("MarkdownLink", |_| {
            "export type MarkdownLink = { kind: 'disk'; pathBytes: string; line: number | null; endLine: number | null; column: number | null } | { kind: 'remote'; uri: string } | { kind: 'attachment'; id: string };".into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("a Markdown link from the native binding"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match &self.0 {
            Destination::Disk(path, anchor) => serde_json::json!({
                "kind": "disk",
                "pathBytes": STANDARD.encode(path),
                "line": anchor.line,
                "endLine": anchor.end_line,
                "column": anchor.column,
            }),
            Destination::Browser(url) => serde_json::json!({"kind":"remote","uri":url.as_str()}),
            Destination::Attachment(id) => serde_json::json!({"kind":"attachment","id":id}),
        }
        .to_js(host)
    }
}

pub(super) fn markdown_link(target: &str) -> Result<MarkdownLink, String> {
    destination(target).map(MarkdownLink)
}

pub(super) async fn open_browser(owner: Arc<Owner>, target: String) -> Result<(), String> {
    let Destination::Browser(url) = destination(&target)? else {
        return Err("Only HTTP(S) links can open in the system browser.".into());
    };
    execute(owner, async move {
        tokio::task::spawn_blocking(move || open::that_detached(url.as_str()))
            .await
            .map_err(|error| format!("The system browser worker failed: {error}"))?
            .map_err(|error| format!("The system could not open the link: {error}"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_preserves_host_paths_and_anchors() {
        for (link, bytes, line, end, col) in [
            (
                "docs/报告%20你好.txt#L20-L35",
                "docs/报告 你好.txt",
                Some(19),
                Some(34),
                None,
            ),
            ("file:///tmp/a%23b.png", "/tmp/a#b.png", None, None, None),
            ("file://localhost/tmp/a.png", "/tmp/a.png", None, None, None),
            (
                "file:///C:/Users/a%20b.png#L12",
                "/C:/Users/a b.png",
                Some(11),
                None,
                None,
            ),
            ("C:/Users/a.png", "C:/Users/a.png", None, None, None),
            ("src/main.rs:12:5", "src/main.rs", Some(11), None, Some(4)),
            ("a%23b.txt#L4", "a#b.txt", Some(3), None, None),
            ("a.txt?download=1#L4", "a.txt", Some(3), None, None),
        ] {
            let Destination::Disk(path, anchor) = destination(link).unwrap() else {
                panic!("expected Host file")
            };
            assert_eq!(path, bytes.as_bytes());
            assert_eq!(
                anchor,
                LinkAnchor {
                    line,
                    end_line: end,
                    column: col
                }
            );
        }
        let Destination::Browser(url) =
            destination("HTTPS://example.test/image 你好.png?q=中文#part").unwrap()
        else {
            panic!("expected HTTP URL")
        };
        assert_eq!(
            url.as_str(),
            "https://example.test/image%20%E4%BD%A0%E5%A5%BD.png?q=%E4%B8%AD%E6%96%87#part"
        );
        assert!(
            matches!(destination("maka://runtime/attachments/tool-1"),Ok(Destination::Attachment(id)) if id=="tool-1")
        );
        for invalid in [
            "javascript:alert(1)",
            "javascript:1",
            "tel:12345",
            "vscode.git:clone",
            "data:text/plain,body",
            "file://example.test/a",
            "//example.test/a",
            "a%00b",
            "#heading",
            "https://example.test/\n",
            "maka://runtime/attachments/../another",
        ] {
            assert!(destination(invalid).is_err(), "accepted {invalid:?}");
        }
    }
}
