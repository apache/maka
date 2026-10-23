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
use nsh_core::ui::prelude::*;
use nsh_core::ui::{JsHost, JsIn, JsOwned, PropError, TsTypes};
use std::sync::Arc;
use url::Url;

/// Exact relative selectors for the existing file reader and its parent watch.
#[derive(Clone, JsObject)]
pub struct WorkspaceLink {
    pub path: String,
    pub parent: Option<String>,
}

enum Destination {
    Browser(Url),
    Workspace(WorkspacePath, Option<WorkspacePath>),
}

fn destination(target: &str) -> Result<Destination, String> {
    if target.is_empty() || target.chars().any(char::is_control) {
        return Err("The link is empty or contains control characters.".into());
    }
    match Url::parse(target) {
        Ok(url) => {
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("Only HTTP(S) links can open in the system browser.".into());
            }
            Ok(Destination::Browser(url))
        }
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            if target.starts_with('/') {
                return Err("A file link must be workspace-relative.".into());
            }
            // URI query/fragment delimiters are separated before percent decoding:
            // `%23` names a file character, while `#L20` refers to that file.
            // CurrentFile has no external line/heading seek; still open the file.
            let path = target.split(['?', '#']).next().unwrap_or_default();
            if path.is_empty() {
                return Err("Links to a message heading are not yet supported.".into());
            }
            let bytes = percent_encoding::percent_decode_str(path).collect::<Vec<_>>();
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
            Ok(Destination::Workspace(path, parent))
        }
        Err(_) => Err("The link is not a valid URI or workspace-relative path.".into()),
    }
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
        Destination::Workspace(path, _) => Ok(MarkdownImageSource::Workspace {
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
            Destination::Workspace(path, parent) => Ok(Some(WorkspaceLink {
                path: path.bytes_base64,
                parent: parent.map(|path| path.bytes_base64),
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
        let Destination::Workspace(path, parent) =
            destination("./目录/../报告%20%E4%BD%A0%E5%A5%BD.txt").unwrap()
        else {
            panic!("expected Host workspace path")
        };
        assert_eq!(
            STANDARD.decode(path.bytes_base64).unwrap(),
            "报告 你好.txt".as_bytes()
        );
        assert!(parent.is_none());
        let Destination::Workspace(path, parent) = destination("docs/报告%20你好.txt#L20").unwrap()
        else {
            panic!("expected nested file")
        };
        assert_eq!(
            STANDARD.decode(path.bytes_base64).unwrap(),
            "docs/报告 你好.txt".as_bytes()
        );
        assert_eq!(
            STANDARD.decode(parent.unwrap().bytes_base64).unwrap(),
            b"docs"
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
            let Destination::Workspace(path, _) = destination(target).unwrap() else {
                panic!("expected file component")
            };
            assert_eq!(STANDARD.decode(path.bytes_base64).unwrap(), b"a.txt");
        }
        let Destination::Workspace(path, _) = destination("a%23b.txt#L4").unwrap() else {
            panic!("expected encoded filename")
        };
        assert_eq!(STANDARD.decode(path.bytes_base64).unwrap(), b"a#b.txt");
        for invalid in [
            "javascript:alert(1)",
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
