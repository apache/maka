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

//! What the Files face decides without the Host or a window: which
//! Artifacts a person sees and may delete, what a row says, the filter, the
//! list's keys, names made safe for the disk, formats told from bytes, the
//! language of a file's source, UTF-8 read in pieces, and the tool results
//! that announce new files. No GPUI, no I/O.

use host_protocol::{ArtifactKind, ArtifactProjection, ArtifactSource};
use serde_json::Value;
use transcript_model::{TurnItem, TurnView};

/// The most of a text file the preview reads: past it, Save As has the
/// rest. Desktop shows 256 KB; the kit's editor holds about 50,000 lines.
pub const TEXT_PREVIEW_CEILING: u64 = 2 * 1024 * 1024;
/// The largest image drawn in the face: Desktop's
/// `ARTIFACT_IMAGE_PREVIEW_MAX_BYTES` (`packages/core/src/artifacts.ts`).
pub const IMAGE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// The most text Copy puts on the clipboard.
pub const COPY_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// The largest HTML page the preview renders; a larger one shows as
/// source. Desktop's `TEXT_DISPLAY_LIMIT_BYTES`, past which its
/// `HtmlPreview` shows the source instead of the page
/// (`apps/desktop/src/renderer/features/workbar/tools/artifacts/artifact-preview.tsx`).
pub const HTML_RENDER_MAX_BYTES: u64 = 256 * 1024;

/// Desktop's `isArtifactUserVisible` (`packages/core/src/artifacts.ts`):
/// a subagent's writeback and a Deep Research report, and a tool's own
/// result only when it is HTML, a deliverable written directly. Uploads,
/// projections, archives, session effects, every other tool result and a
/// source this client does not know stay hidden.
pub fn is_user_visible(artifact: &ArtifactProjection) -> bool {
    match artifact.source {
        ArtifactSource::SubagentWriteback | ArtifactSource::DeepResearch => true,
        ArtifactSource::ToolResult => artifact.kind == ArtifactKind::Html,
        _ => false,
    }
}

/// Desktop's `canUserDeleteArtifact`: what a tool produced or a person
/// uploaded. The Host answers `operation_conflict` for runtime-owned
/// evidence (`deleteUserArtifactInSession` in
/// `packages/storage/src/artifact-store.ts`). Among the visible files, only
/// a tool's HTML.
pub fn is_user_deletable(artifact: &ArtifactProjection) -> bool {
    matches!(artifact.source, ArtifactSource::ToolResult | ArtifactSource::UserUpload)
}

/// A row's second line: the summary's first line, unless it has none or
/// is an upload's digest (`sha256:…`, what `artifact.ingest` records).
pub fn row_summary(artifact: &ArtifactProjection) -> Option<&str> {
    let summary = artifact.summary.as_deref()?.trim();
    if summary.is_empty() || summary.starts_with("sha256:") {
        return None;
    }
    summary.lines().map(str::trim).find(|line| !line.is_empty())
}

/// Whether `name` holds `query`, ignoring case; an empty query matches
/// everything.
pub fn matches_filter(name: &str, query: &str) -> bool {
    let query = query.trim();
    query.is_empty() || name.to_lowercase().contains(&query.to_lowercase())
}

/// A key pressed in the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKey {
    Up,
    Down,
    Home,
    End,
    /// Enter or Space.
    Activate,
    Escape,
}

/// What a key does to the list (Desktop's `ArtifactListAction`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListAction<'a> {
    Select(&'a str),
    Activate(&'a str),
    Dismiss,
    None,
}

/// Desktop's `nextArtifactListAction`
/// (`features/workbar/tools/artifacts/artifact-list-keyboard.ts`): Up and
/// Down move the selection and wrap, Home and End jump to the ends, Enter
/// or Space opens the selected file (the first when none is), Escape
/// dismisses. An empty list does nothing.
pub fn list_action<'a>(selected: Option<&str>, ids: &[&'a str], key: ListKey) -> ListAction<'a> {
    if ids.is_empty() {
        return ListAction::None;
    }
    let current = selected.and_then(|selected| ids.iter().position(|id| *id == selected));
    let last = ids.len() - 1;
    match key {
        ListKey::Escape => ListAction::Dismiss,
        ListKey::Activate => ListAction::Activate(ids[current.unwrap_or(0)]),
        ListKey::Down => ListAction::Select(ids[current.map_or(0, |ix| (ix + 1) % ids.len())]),
        ListKey::Up => {
            ListAction::Select(ids[current.map_or(last, |ix| if ix == 0 { last } else { ix - 1 })])
        }
        ListKey::Home => ListAction::Select(ids[0]),
        ListKey::End => ListAction::Select(ids[last]),
    }
}

/// Whether `id` is a canonical Artifact or Session id
/// (`isCanonicalArtifactEntityId`: 1 to 128 of `A-Z a-z 0-9 _ -`), safe
/// as a path component.
pub fn is_canonical_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// An Artifact's name as a file name Save As suggests. The Host replaces
/// only control characters, so a name may hold `/`, `\` and `..`: the last
/// part after either slash, without control characters, the characters
/// Finder and Windows reserve, or leading and trailing dots and spaces,
/// at most 200 bytes; `file` when nothing is left.
pub fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).find(|part| !part.trim().is_empty()).unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*') { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let mut end = trimmed.len().min(200);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    let bounded = trimmed[..end].trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if bounded.is_empty() { "file".to_owned() } else { bounded.to_owned() }
}

/// An image's format, told from its first bytes (the Host's
/// `sniffAllowedBinaryMime` ignores `mimeType` too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageType {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
    Tiff,
    Ico,
    Svg,
    Avif,
    Heic,
}

impl ImageType {
    /// The format of `bytes`, if they are an image this client knows.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        let starts = |signature: &[u8]| bytes.starts_with(signature);
        if starts(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            return Some(Self::Png);
        }
        if starts(&[0xff, 0xd8, 0xff]) {
            return Some(Self::Jpeg);
        }
        if starts(b"GIF87a") || starts(b"GIF89a") {
            return Some(Self::Gif);
        }
        if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            return Some(Self::Webp);
        }
        if starts(b"BM") && bytes.get(6..10) == Some(&[0; 4]) {
            return Some(Self::Bmp);
        }
        if starts(b"II*\0") || starts(b"MM\0*") {
            return Some(Self::Tiff);
        }
        if starts(&[0, 0, 1, 0]) && bytes.len() > 6 {
            return Some(Self::Ico);
        }
        if bytes.get(4..8) == Some(b"ftyp") {
            return match bytes.get(8..12) {
                Some(b"avif" | b"avis") => Some(Self::Avif),
                Some(b"heic" | b"heix" | b"mif1" | b"msf1" | b"heim" | b"heis") => Some(Self::Heic),
                _ => None,
            };
        }
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
        let head = head.trim_start_matches('\u{feff}').trim_start();
        let lower = head.to_ascii_lowercase();
        let svg = lower.starts_with("<svg")
            && lower[4..].starts_with(|c: char| c.is_whitespace() || c == '>');
        if svg || (lower.starts_with("<?xml") && lower.contains("<svg")) {
            return Some(Self::Svg);
        }
        None
    }

    /// The extension a copy of it is written with.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Tiff => "tiff",
            Self::Ico => "ico",
            Self::Svg => "svg",
            Self::Avif => "avif",
            Self::Heic => "heic",
        }
    }

    /// Whether the window can draw it (GPUI's decoders: no AVIF or HEIC).
    pub fn is_drawable(self) -> bool {
        !matches!(self, Self::Avif | Self::Heic)
    }

    /// Whether a copy of it may go to the default app: raster formats
    /// only. An SVG opened by a browser runs its scripts.
    pub fn is_openable(self) -> bool {
        self != Self::Svg
    }
}

/// Whether `bytes` start a PDF (`%PDF-` in the first kilobyte, as
/// `sniffAttachmentMimeType` looks for it).
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)].windows(5).any(|window| window == b"%PDF-")
}

/// The extension of `name`, lowercase, when it has one.
fn extension(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let (stem, extension) = base.rsplit_once('.')?;
    (!stem.is_empty() && !extension.is_empty()).then(|| extension.to_ascii_lowercase())
}

/// Whether the file is Markdown: by its name, as Desktop tells
/// (`.md`, `.markdown`), or by its media type.
pub fn is_markdown(artifact: &ArtifactProjection) -> bool {
    matches!(extension(&artifact.name).as_deref(), Some("md" | "markdown"))
        || artifact.mime_type.as_deref().is_some_and(|mime| mime.starts_with("text/markdown"))
}

/// Whether the file is an HTML page: kind `html`, or a `file` whose source
/// language is HTML by its name or media type ([`source_language`]).
pub fn is_html(artifact: &ArtifactProjection) -> bool {
    match artifact.kind {
        ArtifactKind::Html => true,
        ArtifactKind::File => source_language(artifact) == Some("html"),
        _ => false,
    }
}

/// Whether the file is an Office document, which reads as noise as text
/// (Desktop's `isUnsupportedOfficeFile`).
pub fn is_office_document(name: &str) -> bool {
    matches!(extension(name).as_deref(), Some("docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt"))
}

/// A page as gpui-kit's HTML view should read it: without the elements a
/// browser never draws the content of (`script`, `style`, `title`,
/// `template`). The kit drops `script` and `style` only where a block
/// stands, so inside a table cell or a paragraph their code showed as
/// text, and it draws the `title` as the page's first line. Each ends at
/// its first closing tag, as the HTML parser ends these raw-text elements;
/// one never closed takes the rest of the page, as in a browser.
pub fn renderable_html(html: &str) -> String {
    const HIDDEN: [&str; 4] = ["script", "style", "title", "template"];
    // ASCII lowercasing keeps every byte offset.
    let lower = html.to_ascii_lowercase();
    let opens = |from: usize| {
        HIDDEN
            .iter()
            .filter_map(|name| {
                let tag = format!("<{name}");
                let mut search = from;
                while let Some(found) = lower[search..].find(&tag) {
                    let at = search + found;
                    let next = lower[at + tag.len()..].chars().next();
                    if next.is_none_or(|c| c == '>' || c == '/' || c.is_ascii_whitespace()) {
                        return Some((at, *name));
                    }
                    search = at + tag.len();
                }
                None
            })
            .min()
    };
    let mut kept = String::with_capacity(html.len());
    let mut at = 0;
    while let Some((start, name)) = opens(at) {
        kept.push_str(&html[at..start]);
        at = lower[start..]
            .find(&format!("</{name}"))
            .and_then(|close| lower[start + close..].find('>').map(|end| start + close + end + 1))
            .unwrap_or(html.len());
    }
    kept.push_str(&html[at..]);
    kept
}

/// Whether text read from a file is binary: a NUL in its first 8 KB.
pub fn looks_binary(text: &str) -> bool {
    text.as_bytes()[..text.len().min(8192)].contains(&0)
}

/// The language the kit's highlighter knows the source by, from the
/// file's extension, else its media type; `None` for plain text. HTML
/// files are `html` whatever their name.
pub fn source_language(artifact: &ArtifactProjection) -> Option<&'static str> {
    if artifact.kind == ArtifactKind::Html {
        return Some("html");
    }
    if artifact.kind == ArtifactKind::Diff {
        return Some("diff");
    }
    let by_extension = extension(&artifact.name).and_then(|extension| {
        Some(match extension.as_str() {
            "rs" => "rust",
            "py" | "pyi" => "python",
            "js" | "mjs" | "cjs" | "jsx" => "javascript",
            "ts" | "mts" | "cts" => "typescript",
            "tsx" => "tsx",
            "json" | "jsonc" => "json",
            "md" | "markdown" => "markdown",
            "html" | "htm" | "xhtml" => "html",
            "css" | "scss" => "css",
            "sh" | "bash" | "zsh" => "bash",
            "toml" => "toml",
            "yaml" | "yml" => "yaml",
            "go" => "go",
            "c" | "h" => "c",
            "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
            "cs" => "csharp",
            "java" => "java",
            "kt" | "kts" => "kotlin",
            "rb" => "ruby",
            "php" => "php",
            "sql" => "sql",
            "swift" => "swift",
            "lua" => "lua",
            "scala" => "scala",
            "zig" => "zig",
            "ex" | "exs" => "elixir",
            "graphql" | "gql" => "graphql",
            "proto" => "proto",
            "diff" | "patch" => "diff",
            _ => return None,
        })
    });
    by_extension.or_else(|| {
        let mime = artifact.mime_type.as_deref()?.split(';').next()?.trim().to_ascii_lowercase();
        Some(match mime.as_str() {
            "text/html" => "html",
            "application/json" => "json",
            "text/markdown" => "markdown",
            "text/css" => "css",
            "text/javascript" | "application/javascript" => "javascript",
            "text/x-python" => "python",
            "application/toml" => "toml",
            "application/yaml" | "text/yaml" => "yaml",
            "text/x-diff" | "text/x-patch" => "diff",
            _ => return None,
        })
    })
}

/// Text decoded from UTF-8 that arrives in pieces: a piece may end inside
/// a character, whose bytes wait for the next piece. Invalid bytes become
/// U+FFFD, as the Host's own decoding does.
#[derive(Debug, Clone, Default)]
pub struct Utf8Pieces {
    text: String,
    tail: Vec<u8>,
    bytes: u64,
}

impl Utf8Pieces {
    pub fn new() -> Self {
        Self::default()
    }

    /// Text that arrived whole (a `read_text`).
    pub fn whole(text: String) -> Self {
        let bytes = text.len() as u64;
        Self { text, tail: Vec::new(), bytes }
    }

    /// Decodes the next piece.
    pub fn push(&mut self, piece: &[u8]) {
        self.bytes += piece.len() as u64;
        let mut pending = std::mem::take(&mut self.tail);
        pending.extend_from_slice(piece);
        let mut rest = pending.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    self.text.push_str(valid);
                    return;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    // Valid by construction.
                    self.text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            self.text.push('\u{fffd}');
                            rest = &after[len..];
                        }
                        None => {
                            self.tail = after.to_vec();
                            return;
                        }
                    }
                }
            }
        }
    }

    /// The end of the file: bytes still waiting become U+FFFD.
    pub fn finish(&mut self) {
        if !self.tail.is_empty() {
            self.tail.clear();
            self.text.push('\u{fffd}');
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The bytes decoded so far, the waiting ones included.
    pub fn byte_count(&self) -> u64 {
        self.bytes
    }
}

/// How many files the tool results of `turn` say a subagent wrote back:
/// the `artifactIds` of `subagent` and `agent_swarm` results
/// (`ToolResultContent` in `packages/core/src/events.ts`). When the count
/// grows the list is read again: writebacks land while the turn runs.
pub fn artifact_mentions(turn: &TurnView) -> usize {
    turn.items
        .iter()
        .filter_map(|item| match item {
            TurnItem::Tool(tool) => tool.result.as_ref(),
            _ => None,
        })
        .map(result_mentions)
        .sum()
}

/// The files one tool result says a subagent wrote back.
pub fn result_mentions(result: &Value) -> usize {
    let ids = |value: &Value| value["artifactIds"].as_array().map_or(0, Vec::len);
    match result["kind"].as_str() {
        Some("subagent") => ids(result),
        Some("agent_swarm") => {
            result["items"].as_array().map_or(0, |items| items.iter().map(ids).sum())
        }
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn artifact(name: &str, kind: &str, source: &str) -> ArtifactProjection {
        serde_json::from_value(json!({
            "id": "a1", "sessionId": "s1", "turnId": "t1", "createdAt": 1, "name": name,
            "kind": kind, "sizeBytes": 3, "source": source
        }))
        .expect("artifact")
    }

    #[test]
    fn visibility_and_deletion_follow_desktops_source_policy() {
        let cases = [
            ("subagent_writeback", "file", true, false),
            ("deep_research", "file", true, false),
            ("tool_result", "html", true, true),
            ("tool_result", "file", false, true),
            ("tool_result", "diff", false, true),
            ("user_upload", "file", false, true),
            ("tool_result_projection", "html", false, false),
            ("tool_result_archive", "file", false, false),
            ("session_effect", "file", false, false),
            ("a_future_source", "file", false, false),
        ];
        for (source, kind, visible, deletable) in cases {
            let artifact = artifact("x", kind, source);
            assert_eq!(is_user_visible(&artifact), visible, "{source} {kind}");
            assert_eq!(is_user_deletable(&artifact), deletable, "{source} {kind}");
        }
    }

    #[test]
    fn a_rows_summary_is_its_first_line_and_never_a_digest() {
        let mut row = artifact("x", "file", "subagent_writeback");
        assert_eq!(row_summary(&row), None);
        row.summary = Some("\n  The plan, revised  \nand more".into());
        assert_eq!(row_summary(&row), Some("The plan, revised"));
        row.summary = Some(format!("sha256:{}", "0".repeat(64)));
        assert_eq!(row_summary(&row), None);
        row.summary = Some("   ".into());
        assert_eq!(row_summary(&row), None);
    }

    #[test]
    fn the_filter_matches_a_substring_of_the_name_in_any_case() {
        assert!(matches_filter("Report.MD", "report"));
        assert!(matches_filter("报告.md", "报告"));
        assert!(matches_filter("a.txt", "  "));
        assert!(!matches_filter("a.txt", "b"));
    }

    #[test]
    fn the_list_keys_move_wrap_and_open_as_desktops() {
        let ids = ["a", "b", "c"];
        assert_eq!(list_action(None, &ids, ListKey::Down), ListAction::Select("a"));
        assert_eq!(list_action(None, &ids, ListKey::Up), ListAction::Select("c"));
        assert_eq!(list_action(Some("c"), &ids, ListKey::Down), ListAction::Select("a"));
        assert_eq!(list_action(Some("a"), &ids, ListKey::Up), ListAction::Select("c"));
        assert_eq!(list_action(Some("b"), &ids, ListKey::Home), ListAction::Select("a"));
        assert_eq!(list_action(Some("b"), &ids, ListKey::End), ListAction::Select("c"));
        assert_eq!(list_action(Some("b"), &ids, ListKey::Activate), ListAction::Activate("b"));
        assert_eq!(list_action(Some("gone"), &ids, ListKey::Activate), ListAction::Activate("a"));
        assert_eq!(list_action(Some("b"), &ids, ListKey::Escape), ListAction::Dismiss);
        assert_eq!(list_action(None, &[], ListKey::Escape), ListAction::None);
    }

    #[test]
    fn names_become_safe_file_names() {
        assert_eq!(safe_file_name("report.md"), "report.md");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("dir\\sub\\notes.txt"), "notes.txt");
        assert_eq!(safe_file_name(".."), "file");
        assert_eq!(safe_file_name("a/b/"), "b");
        assert_eq!(safe_file_name(" .hidden. "), "hidden");
        assert_eq!(safe_file_name("we:ird*na?me"), "we-ird-na-me");
        assert_eq!(safe_file_name("tab\there"), "tabhere");
        let long = "长".repeat(100);
        let safe = safe_file_name(&long);
        assert!(safe.len() <= 200 && safe.chars().all(|c| c == '长'));
        assert!(is_canonical_id("attachment-2046_ab"));
        assert!(!is_canonical_id("../x") && !is_canonical_id("") && !is_canonical_id("a.b"));
    }

    #[test]
    fn images_are_told_by_their_bytes() {
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0];
        assert_eq!(ImageType::sniff(&png), Some(ImageType::Png));
        assert_eq!(ImageType::sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(ImageType::Jpeg));
        assert_eq!(ImageType::sniff(b"GIF89a.."), Some(ImageType::Gif));
        assert_eq!(ImageType::sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageType::Webp));
        assert_eq!(ImageType::sniff(b"\0\0\0\x1cftypavif\0\0"), Some(ImageType::Avif));
        assert_eq!(ImageType::sniff(b"\0\0\0\x18ftypheic"), Some(ImageType::Heic));
        assert_eq!(ImageType::sniff(b"  <svg xmlns='x'>"), Some(ImageType::Svg));
        assert_eq!(ImageType::sniff(b"<?xml version='1.0'?>\n<svg>"), Some(ImageType::Svg));
        assert_eq!(ImageType::sniff(b"<svgx"), None);
        assert_eq!(ImageType::sniff(b"hello"), None);
        assert!(!ImageType::Avif.is_drawable() && ImageType::Avif.is_openable());
        assert!(ImageType::Svg.is_drawable() && !ImageType::Svg.is_openable());
        assert!(is_pdf(b"\n%PDF-1.7") && !is_pdf(b"%PD"));
    }

    #[test]
    fn the_source_language_follows_the_extension_then_the_media_type() {
        let mut file = artifact("main.rs", "file", "subagent_writeback");
        assert_eq!(source_language(&file), Some("rust"));
        file.name = "notes".into();
        file.mime_type = Some("application/json; charset=utf-8".into());
        assert_eq!(source_language(&file), Some("json"));
        file.mime_type = None;
        assert_eq!(source_language(&file), None);
        assert_eq!(source_language(&artifact("page.txt", "html", "tool_result")), Some("html"));
        assert!(is_markdown(&artifact("README.MD", "file", "deep_research")));
        assert!(is_html(&artifact("page.txt", "html", "tool_result")));
        assert!(is_html(&artifact("Report.HTM", "file", "subagent_writeback")));
        let mut typed = artifact("report", "file", "deep_research");
        typed.mime_type = Some("text/html; charset=utf-8".into());
        assert!(is_html(&typed));
        assert!(!is_html(&artifact("notes.md", "file", "deep_research")));
        assert!(!is_html(&artifact("page.html", "diff", "subagent_writeback")));
        assert!(!is_markdown(&artifact(".md", "file", "deep_research")));
        assert!(is_office_document("plan.docx") && !is_office_document("plan.md"));
        assert!(looks_binary("PK\u{3}\u{4}\0\0") && !looks_binary("plain"));
    }

    #[test]
    fn hidden_elements_leave_the_page_before_it_renders() {
        let page = "<html><head><TITLE>Report</TITLE><style>p{color:red}</style></head>\
                    <body><h1>毛利</h1><table><tr><td>a<script type='x'>if (a<b) go()</SCRIPT>\
                    </td></tr></table><template><p>later</p></template><styles>kept</styles>\
                    <p>end</p></body></html>";
        assert_eq!(
            renderable_html(page),
            "<html><head></head><body><h1>毛利</h1><table><tr><td>a</td></tr></table>\
             <styles>kept</styles><p>end</p></body></html>"
        );
        assert_eq!(renderable_html("<p>a</p><script>never closed"), "<p>a</p>");
        assert_eq!(renderable_html("<p>plain</p>"), "<p>plain</p>");
    }

    #[test]
    fn subagent_results_count_the_files_they_wrote_back() {
        let one = json!({"kind": "subagent", "agentName": "a", "artifactIds": ["x", "y"]});
        assert_eq!(result_mentions(&one), 2);
        let swarm = json!({"kind": "agent_swarm", "items": [
            {"artifactIds": ["a"]}, {"artifactIds": []}, {"artifactIds": ["b", "c"]}
        ]});
        assert_eq!(result_mentions(&swarm), 3);
        assert_eq!(result_mentions(&json!({"kind": "text", "artifactIds": ["z"]})), 0);
    }

    #[test]
    fn utf8_split_inside_a_character_waits_for_the_next_piece() {
        let text = "a中文b😀";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut pieces = Utf8Pieces::new();
            pieces.push(&bytes[..cut]);
            pieces.push(&bytes[cut..]);
            pieces.finish();
            assert_eq!(pieces.text(), text, "cut at {cut}");
            assert_eq!(pieces.byte_count(), bytes.len() as u64);
        }
        let mut broken = Utf8Pieces::new();
        broken.push(b"a\xffb\xe4\xb8");
        assert_eq!(broken.text(), "a\u{fffd}b");
        broken.finish();
        assert_eq!(broken.text(), "a\u{fffd}b\u{fffd}");
    }
}
