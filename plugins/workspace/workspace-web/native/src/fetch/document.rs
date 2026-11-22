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

use super::{Error, Format, Page};
use dom_smoothie::{Config, Readability, TextMode};
use encoding_rs::Encoding;
use tokio::sync::Semaphore;
use url::Url;

// A cancelled spawn_blocking job keeps its permit until it actually exits.
// Plugin reload must not turn timed-out parses into unbounded CPU work.
static PARSERS: Semaphore = Semaphore::const_new(2);

#[derive(Clone, Copy)]
pub(super) enum Media {
    Html,
    Markdown,
    Text,
}

pub(super) fn media_type(content_type: &str) -> Result<Media, Error> {
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match media.as_str() {
        "text/html" | "application/xhtml+xml" => Ok(Media::Html),
        "text/markdown" | "text/x-markdown" | "application/markdown" => Ok(Media::Markdown),
        "application/json" | "application/xml" => Ok(Media::Text),
        _ if media.starts_with("text/") => Ok(Media::Text),
        _ => Err(Error::ContentType(media)),
    }
}

pub(super) async fn extract(
    url: Url,
    bytes: Vec<u8>,
    content_type: &str,
    media: Media,
) -> Result<Page, Error> {
    let encoding = content_type
        .split(';')
        .skip(1)
        .find_map(|parameter| {
            let (key, value) = parameter.split_once('=')?;
            key.trim()
                .eq_ignore_ascii_case("charset")
                .then(|| Encoding::for_label(value.trim().trim_matches(['"', '\'']).as_bytes()))
                .flatten()
        })
        .unwrap_or(encoding_rs::UTF_8);
    let permit = PARSERS
        .acquire()
        .await
        .map_err(|error| Error::Document(error.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (text, _, _) = encoding.decode(&bytes);
        render(url, text.into_owned(), media)
    })
    .await
    .map_err(|error| Error::Document(error.to_string()))?
}

fn render(url: Url, text: String, media: Media) -> Result<Page, Error> {
    let (title, content, format) = match media {
        Media::Html => {
            let config = Config {
                disable_json_ld: true,
                text_mode: TextMode::Markdown,
                ..Config::default()
            };
            let original = text.clone();
            let mut reader = Readability::new(text, Some(url.as_str()), Some(config))
                .map_err(|error| Error::Document(error.to_string()))?;
            // Check actual HTML tree depth, not '<' counts or a regex approximation.
            // Readability/Markdown traversal must not recurse over hostile depth.
            let mut nodes = vec![(reader.doc.root(), 0)];
            while let Some((node, depth)) = nodes.pop() {
                if depth > 128 {
                    // Readability/Markdown uses recursive dependency walkers.
                    // Preserve the complete original rather than reject or recurse
                    // through a shape outside this adapter's supported stack bound.
                    return Ok(Page {
                        url: url.into(),
                        title: None,
                        content: original,
                        format: Format::Text,
                    });
                }
                nodes.extend(node.children_it(false).map(|child| (child, depth + 1)));
            }
            let article = match reader.parse() {
                Ok(article) => article,
                Err(_) => {
                    return Ok(Page {
                        url: url.into(),
                        title: None,
                        content: original,
                        format: Format::Text,
                    });
                }
            };
            let title = (!article.title.is_empty()).then_some(article.title);
            (title, article.text_content.to_string(), Format::Markdown)
        }
        Media::Markdown => (None, text, Format::Markdown),
        Media::Text => (None, text, Format::Text),
    };
    if content.trim().is_empty() {
        return Err(Error::Empty);
    }
    Ok(Page {
        url: url.into(),
        title,
        content,
        format,
    })
}
