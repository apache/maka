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

//! Composes authorized user-tab reads without acquiring the tab for automation.

use super::*;
use cua_driver_core::browser::{BrowserUserTabRead, BrowserWorkspaceExportFormat};

const PAGE_READ_ERROR: &str = "Unable to read tab context for the authorized page";
const CHANGED_PAGE_ERROR: &str = "The selected tab changed while being read";
const EXPORT_SIZE_ERROR: &str = "Google Workspace export is too large for in-memory tab context";
/// The selected Original service accepts titles up to 4096 UTF-16 code units.
const MAX_TITLE_UNITS: usize = 4096;

/// A reader retains the captured URL, Host authority and provider call scope.
/// Each implementation must check current authority and exact URL on every read.
pub(super) trait UserTabReader: Sync {
    fn read(
        &self,
        request: BrowserUserTabRead,
    ) -> impl std::future::Future<Output = Result<Value, ToolError>> + Send;
}

#[derive(Debug, Deserialize)]
struct Page {
    url: String,
    title: String,
    text: String,
    truncated: bool,
}
#[derive(Debug, Deserialize)]
struct SelectedText {
    text: String,
    truncated: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    page_url: String,
    text: String,
    truncated: bool,
}

/// The optional library service runs before this fixed text/document fallback.
/// All binary results contain the actual exported response body.
pub(super) async fn read_context(
    reader: &impl UserTabReader,
    expected_url: &str,
) -> Result<Value, ToolError> {
    let page: Page = serde_json::from_value(reader.read(BrowserUserTabRead::Page).await?)
        .map_err(|_| failed(PAGE_READ_ERROR))?;
    if page.url != expected_url || page.title.encode_utf16().count() > MAX_TITLE_UNITS {
        return Err(failed(PAGE_READ_ERROR));
    }
    if let Some(export) = workspace_context(reader, &page).await? {
        return Ok(export);
    }
    let youtube = youtube_video_id(&page.url).is_some();
    let selection = if youtube {
        None
    } else {
        reader
            .read(BrowserUserTabRead::Selection)
            .await
            .ok()
            .and_then(|value| serde_json::from_value::<SelectedText>(value).ok())
            .filter(|selection| js_trim(&selection.text) != js_trim(&page.text))
    };
    if youtube {
        let transcript = reader
            .read(BrowserUserTabRead::YoutubeTranscript)
            .await
            .ok()
            .and_then(|value| serde_json::from_value::<Transcript>(value).ok())
            .filter(|transcript| transcript.page_url == expected_url);
        if let Some(transcript) = transcript {
            return Ok(json!({
                "kind":"text", "url":page.url, "title":page.title,
                "text":format!("{}\n\n<browser__youtube_transcript>\n{}\n</browser__youtube_transcript>", page.text, transcript.text),
                "truncated":page.truncated || transcript.truncated,
            }));
        }
    }
    if let Some(selection) = selection {
        return Ok(json!({
            "kind":"text", "url":page.url, "title":page.title,
            "text":format!("<user__selection>\n{}\n</user__selection>\n\n<browser__document__content>\n{}\n</browser__document__content>", selection.text, page.text),
            "truncated":page.truncated || selection.truncated,
        }));
    }
    Ok(json!({"kind":"text", "url":page.url, "title":page.title,
        "text":page.text, "truncated":page.truncated}))
}

async fn workspace_context(
    reader: &impl UserTabReader,
    page: &Page,
) -> Result<Option<Value>, ToolError> {
    let Some(formats) = workspace_formats(&page.url) else {
        return Ok(None);
    };
    for &format in formats {
        let value = match reader
            .read(BrowserUserTabRead::GoogleWorkspaceExport { format })
            .await
        {
            Ok(value) => value,
            Err(error) if error_message(&error) == CHANGED_PAGE_ERROR => return Err(error),
            Err(_) => continue,
        };
        if let Some(message) = value.get("errorMessage").and_then(Value::as_str) {
            if message == EXPORT_SIZE_ERROR {
                return Err(failed(EXPORT_SIZE_ERROR));
            }
            continue;
        }
        if value.get("redirectUrl").is_some_and(Value::is_string) {
            continue;
        }
        let Some(encoded) = value
            .get("base64")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if format == BrowserWorkspaceExportFormat::Markdown {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| failed("Unable to decode exported tab context"))?;
            let decoded = String::from_utf8_lossy(&bytes);
            let text =
                clean_workspace_markdown(decoded.strip_prefix('\u{feff}').unwrap_or(&decoded));
            return Ok(Some(
                json!({"kind":"text", "url":page.url, "title":page.title,
                "text":text, "truncated":value.get("truncated") == Some(&Value::Bool(true))}),
            ));
        }
        let (extension, mime_type) = match format {
            BrowserWorkspaceExportFormat::Pdf => ("pdf", "application/pdf"),
            BrowserWorkspaceExportFormat::Xlsx => (
                "xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            _ => return Err(failed("Unsupported Google Workspace export")),
        };
        return Ok(Some(
            json!({"kind":"document", "url":page.url, "title":page.title,
            "fileName":format!("{}.{}", export_name(&page.title), extension),
            "mimeType":mime_type,"dataBase64":encoded}),
        ));
    }
    Ok(None)
}

fn error_message(error: &ToolError) -> &str {
    match error {
        ToolError::Failed(message) => message,
        _ => "",
    }
}

fn workspace_formats(url: &str) -> Option<&'static [BrowserWorkspaceExportFormat]> {
    let url = reqwest::Url::parse(url).ok()?;
    if url.host_str() != Some("docs.google.com") || url.port().is_some() {
        return None;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.last() == Some(&"pub") {
        return None;
    }
    let id_index = segments
        .iter()
        .skip(1)
        .position(|segment| *segment == "d")?
        + 2;
    if segments.get(id_index).is_none_or(|id| id.is_empty()) {
        return None;
    }
    use BrowserWorkspaceExportFormat::{Markdown, Pdf, Xlsx};
    match segments.first().copied()? {
        "document" => Some(&[Markdown, Pdf]),
        "presentation" => Some(&[Pdf]),
        "spreadsheets" => Some(&[Xlsx, Pdf]),
        _ => None,
    }
}

fn youtube_video_id(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("www.youtube.com" | "youtube.com"))
        || url.path() != "/watch"
    {
        return None;
    }
    let id = url.query_pairs().find(|(key, _)| key == "v")?.1;
    (id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
    .then(|| id.into_owned())
}

fn export_name(title: &str) -> String {
    let mut parts: Vec<_> = title.split(" - ").collect();
    if parts.len() > 1 && parts.last().is_some_and(|part| part.starts_with("Google")) {
        parts.pop();
    }
    let name: String = parts
        .join(" - ")
        .chars()
        .map(|character| {
            if matches!(
                character,
                '/' | '\\' | '?' | '%' | '*' | '|' | '"' | '<' | '>' | ':'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let name = js_trim(&name);
    if name.is_empty() {
        "ExportedContent".to_owned()
    } else {
        name.to_owned()
    }
}

fn clean_workspace_markdown(markdown: &str) -> String {
    // Workspace embeds inline image bytes in reference definitions. Retain all
    // ordinary references, including references whose URL merely contains data:.
    let mut result = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while !rest.is_empty() {
        let candidate = rest.trim_start_matches(js_whitespace);
        let removable = candidate
            .strip_prefix('[')
            .and_then(|tail| {
                let index = tail.find(']')?;
                (index > 0).then_some(&tail[index..])?.strip_prefix("]:")
            })
            .map(|value| value.trim_start_matches(js_whitespace))
            .and_then(|tail| tail.strip_prefix("<data:"))
            .and_then(|tail| tail.find('>').map(|index| &tail[index + 1..]));
        if let Some(after) = removable {
            rest = after.trim_start_matches(js_whitespace);
            continue;
        }
        // A long whitespace-only export must be scanned once, rather than
        // rescanning all remaining blank lines after each failed definition.
        let whitespace = rest.len() - candidate.len();
        result.push_str(&rest[..whitespace]);
        rest = candidate;
        let end = rest.find('\n').map_or(rest.len(), |index| index + 1);
        result.push_str(&rest[..end]);
        rest = &rest[end..];
    }
    js_trim(&result).to_owned()
}

/// Keep binary data directly usable while publishing its actual immutable bytes
/// into the existing Host Session file scope. Only the Host chooses paths.
pub(super) async fn publish_document(
    mut context: Value,
    files: &dyn crate::browser_files::BrowserAssetFiles,
    cancellation: &CancellationToken,
) -> Result<Value, ToolError> {
    if context.get("kind").and_then(Value::as_str) != Some("document") {
        return Ok(context);
    }
    let name = context
        .get("fileName")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("document context lacks its file name"))?
        .to_owned();
    let encoded = context
        .get("dataBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("document context lacks its actual body"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| failed("Unable to decode exported tab context"))?;
    let resource = files.snapshot(name.clone(), bytes)?;
    let mut directory = files.begin(cancellation.clone()).await?;
    let path = match directory.write(name, resource, cancellation.clone()).await {
        Ok(path) => path,
        Err(error) => {
            directory.abort().await?;
            return Err(error);
        }
    };
    if let Err(error) = directory.commit(cancellation.clone()).await {
        directory.abort().await?;
        return Err(error);
    }
    context["path"] = json!(path);
    Ok(context)
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct ScriptedReader(
        Mutex<std::collections::VecDeque<(BrowserUserTabRead, Result<Value, ToolError>)>>,
    );
    impl UserTabReader for ScriptedReader {
        async fn read(&self, read: BrowserUserTabRead) -> Result<Value, ToolError> {
            let (expected, result) = self
                .0
                .lock()
                .expect("reader fixture mutex poisoned")
                .pop_front()
                .expect("unexpected read");
            assert_eq!(read, expected, "context used a different fixed read");
            result
        }
    }
    fn page(url: &str, text: &str) -> Value {
        json!({"url":url,"title":"A - Google Docs","text":text,"truncated":false})
    }
    fn reader(rows: Vec<(BrowserUserTabRead, Result<Value, ToolError>)>) -> ScriptedReader {
        ScriptedReader(Mutex::new(rows.into()))
    }
    #[tokio::test]
    async fn selection_is_composed_without_changing_page_identity() {
        let url = "https://example.test/page";
        let reader = reader(vec![
            (BrowserUserTabRead::Page, Ok(page(url, "Body"))),
            (
                BrowserUserTabRead::Selection,
                Ok(json!({"text":"Choice","truncated":true})),
            ),
        ]);
        let actual = read_context(&reader, url).await.expect("read context");
        assert_eq!(
            actual["text"],
            "<user__selection>\nChoice\n</user__selection>\n\n<browser__document__content>\nBody\n</browser__document__content>"
        );
        assert_eq!(actual["truncated"], true);
        assert_eq!(actual["url"], url);
    }
    #[tokio::test]
    async fn changed_page_during_workspace_export_is_not_an_export_fallback() {
        let url = "https://docs.google.com/document/d/123/edit";
        let reader = reader(vec![
            (BrowserUserTabRead::Page, Ok(page(url, "Body"))),
            (
                BrowserUserTabRead::GoogleWorkspaceExport {
                    format: BrowserWorkspaceExportFormat::Markdown,
                },
                Err(failed(CHANGED_PAGE_ERROR)),
            ),
        ]);
        let error = read_context(&reader, url)
            .await
            .expect_err("race must propagate");
        assert_eq!(error_message(&error), CHANGED_PAGE_ERROR);
    }
    #[tokio::test]
    async fn export_error_falls_back_to_actual_pdf_bytes() {
        let url = "https://docs.google.com/document/d/123/edit";
        let reader = reader(vec![
            (BrowserUserTabRead::Page, Ok(page(url, "Body"))),
            (
                BrowserUserTabRead::GoogleWorkspaceExport {
                    format: BrowserWorkspaceExportFormat::Markdown,
                },
                Ok(json!({"redirectUrl":"https://accounts.google.com/"})),
            ),
            (
                BrowserUserTabRead::GoogleWorkspaceExport {
                    format: BrowserWorkspaceExportFormat::Pdf,
                },
                Ok(json!({"base64":"JVBERi0x"})),
            ),
        ]);
        let result = read_context(&reader, url).await.expect("pdf fallback");
        assert_eq!(result["kind"], "document");
        assert_eq!(result["dataBase64"], "JVBERi0x");
        assert_eq!(result["fileName"], "A.pdf");
    }
    #[tokio::test]
    async fn page_identity_is_checked_before_optional_reads() {
        let reader = reader(vec![(
            BrowserUserTabRead::Page,
            Ok(page("https://other.test/", "secret")),
        )]);
        assert_eq!(
            error_message(
                &read_context(&reader, "https://example.test/")
                    .await
                    .expect_err("URL mismatch")
            ),
            PAGE_READ_ERROR
        );
    }
    #[test]
    fn only_workspace_embedded_image_definitions_are_removed() {
        assert_eq!(
            clean_workspace_markdown(
                "# Title\n\n[x]: <data:image/png;base64,a>\n\n[y]: <https://a.test/data:x>\nText"
            ),
            "# Title\n[y]: <https://a.test/data:x>\nText"
        );
        assert!(workspace_formats("https://docs.google.com/document/d/x/pub").is_none());
        assert_eq!(export_name("A/B - Google Docs"), "A_B");
    }
}
