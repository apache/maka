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
use maka_agent_api::contract::WorkspacePath;
use nsh_core::element::{JsHost, JsIn, JsOwned, PropError, TsTypes};
use nsh_core::prelude::*;
use std::sync::Arc;
use url::Url;

/// Exact relative selectors and optional zero-based line/column anchor for the file reader.
#[derive(Clone, JsObject)]
pub struct WorkspaceLink {
    pub path: String,
    pub parent: Option<String>,
    #[prop(skip_none)]
    pub line: Option<u32>,
    #[prop(skip_none)]
    pub end_line: Option<u32>,
    #[prop(skip_none)]
    pub column: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinkAnchor {
    line: Option<u32>,
    end_line: Option<u32>,
    column: Option<u32>,
}

enum Destination {
    Browser(Url),
    Workspace(WorkspacePath, Option<WorkspacePath>, LinkAnchor),
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
    if target.starts_with('/') {
        return Err("A file link must be workspace-relative.".into());
    }
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
    let mut parts = Vec::new();
    for part in bytes.split(|byte| *byte == b'/') {
        match part {
            b"." => {}
            b".." => {
                parts
                    .pop()
                    .ok_or("The file link leaves the conversation workspace.")?;
            }
            b"" => return Err("The file link contains an empty path component.".into()),
            part => parts.push(part),
        }
    }
    let bytes = parts.join(&b'/');
    let path = WorkspacePath::from_bytes(&bytes)
        .map_err(|_| "The file link is not a valid workspace-relative path.")?;
    let parent = bytes
        .iter()
        .rposition(|byte| *byte == b'/')
        .map(|end| WorkspacePath::from_bytes(&bytes[..end]))
        .transpose()
        .map_err(|_| "The file link has no valid workspace-relative parent.")?;
    Ok(Destination::Workspace(path, parent, anchor))
}

/// An image selector, without reading a file or activating a browser.
pub enum MarkdownImageSource {
    Workspace { path: String },
    Remote { uri: String },
}

impl JsValue for MarkdownImageSource {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("MarkdownImageSource", |_| {
            "export type MarkdownImageSource = { kind: 'workspace'; path: string } | { kind: 'remote'; uri: string };".into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("a Markdown image source resolved by the native binding"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Workspace { path } => serde_json::json!({"kind":"workspace","path":path}),
            Self::Remote { uri } => serde_json::json!({"kind":"remote","uri":uri}),
        }
        .to_js(host)
    }
}

pub(super) fn markdown_image(target: &str) -> Result<MarkdownImageSource, String> {
    match destination(target)? {
        Destination::Workspace(path, _, _) => Ok(MarkdownImageSource::Workspace {
            path: path.bytes_base64,
        }),
        Destination::Browser(url) => Ok(MarkdownImageSource::Remote {
            uri: url.to_string(),
        }),
    }
}

pub(super) async fn open(
    owner: Arc<Owner>,
    target: String,
) -> Result<Option<WorkspaceLink>, String> {
    let destination = destination(&target)?;
    execute(owner, async move {
        match destination {
            Destination::Workspace(path, parent, anchor) => Ok(Some(WorkspaceLink {
                path: path.bytes_base64,
                parent: parent.map(|path| path.bytes_base64),
                line: anchor.line,
                end_line: anchor.end_line,
                column: anchor.column,
            })),
            Destination::Browser(url) => {
                // Accept the OS handoff; do not make terminal shutdown wait for
                // the user to close a browser launched by a blocking handler.
                tokio::task::spawn_blocking(move || open::that_detached(url.as_str()))
                    .await
                    .map_err(|error| format!("The system browser worker failed: {error}"))?
                    .map_err(|error| format!("The system could not open the link: {error}"))?;
                Ok(None)
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    #[test]
    fn navigation_preserves_urls_and_scoped_file_bytes_without_launching_programs() {
        let Destination::Browser(url) = destination("https://example.test/a?q=中文#part").unwrap()
        else {
            panic!("expected browser URL")
        };
        assert_eq!(
            url.as_str(),
            "https://example.test/a?q=%E4%B8%AD%E6%96%87#part"
        );
        let Destination::Workspace(path, parent, anchor) =
            destination("./目录/../报告%20%E4%BD%A0%E5%A5%BD.txt").unwrap()
        else {
            panic!("expected Host workspace path")
        };
        assert_eq!(anchor, LinkAnchor::default());
        assert_eq!(
            STANDARD.decode(path.bytes_base64).unwrap(),
            "报告 你好.txt".as_bytes()
        );
        assert!(parent.is_none());
        let Destination::Workspace(path, parent, anchor) =
            destination("docs/报告%20你好.txt#L20-L35").unwrap()
        else {
            panic!("expected nested file")
        };
        assert_eq!(
            anchor,
            LinkAnchor {
                line: Some(19),
                end_line: Some(34),
                column: None,
            }
        );
        assert_eq!(
            STANDARD.decode(path.bytes_base64).unwrap(),
            "docs/报告 你好.txt".as_bytes()
        );
        assert_eq!(
            STANDARD.decode(parent.unwrap().bytes_base64).unwrap(),
            b"docs"
        );
        let Destination::Workspace(colon_path, _, colon_anchor) =
            destination("src/main.rs:12:5").unwrap()
        else {
            panic!("expected colon line/column link")
        };
        assert_eq!(
            STANDARD.decode(colon_path.bytes_base64).unwrap(),
            b"src/main.rs"
        );
        assert_eq!(
            colon_anchor,
            LinkAnchor {
                line: Some(11),
                end_line: None,
                column: Some(4),
            }
        );
        let Destination::Browser(url) = destination("https://user:password@example.test/").unwrap()
        else {
            panic!("expected browser URL")
        };
        assert_eq!(url.as_str(), "https://user:password@example.test/");
        let MarkdownImageSource::Remote { uri } =
            markdown_image("HTTPS://example.test/image 你好.png?q=中文#part").unwrap()
        else {
            panic!("expected native HTTP(S) image URI")
        };
        assert_eq!(
            uri,
            "https://example.test/image%20%E4%BD%A0%E5%A5%BD.png?q=%E4%B8%AD%E6%96%87#part"
        );
        let MarkdownImageSource::Workspace { path } =
            markdown_image("docs/image%20你好.png").unwrap()
        else {
            panic!("expected original Host workspace image selector")
        };
        assert_eq!(
            STANDARD.decode(path).unwrap(),
            "docs/image 你好.png".as_bytes()
        );
        for target in ["a.txt#L4", "a.txt?download=1#L4"] {
            let Destination::Workspace(path, _, anchor) = destination(target).unwrap() else {
                panic!("expected file component")
            };
            assert_eq!(STANDARD.decode(path.bytes_base64).unwrap(), b"a.txt");
            assert_eq!(anchor.line, Some(3));
        }
        let Destination::Workspace(path, _, _) = destination("a%23b.txt#L4").unwrap() else {
            panic!("expected encoded filename")
        };
        assert_eq!(STANDARD.decode(path.bytes_base64).unwrap(), b"a#b.txt");
        for invalid in [
            "javascript:alert(1)",
            "javascript:1",
            "tel:12345",
            "vscode.git:clone",
            "C:/Users/example/a.rs",
            "data:text/plain,body",
            "file:///tmp/a",
            "//example.test/a",
            "../outside",
            "%2e%2e/outside",
            "/absolute",
            "a/.git/config",
            "a%00b",
            "#heading",
            "https://example.test/\n",
        ] {
            assert!(destination(invalid).is_err(), "accepted {invalid:?}");
            assert!(
                markdown_image(invalid).is_err(),
                "accepted image {invalid:?}"
            );
        }
    }
}
