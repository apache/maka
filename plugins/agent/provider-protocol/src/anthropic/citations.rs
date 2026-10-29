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

use crate::{field::Field, input::Extensions, output};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct Document {
    pub title: String,
    pub filename: Option<String>,
    pub media_type: String,
}
/// Source-backed request documents occupy an ordinal range without per-document allocation.
#[derive(Debug, Clone)]
pub struct DocumentReferences {
    request: RequestDocuments,
    received: Vec<Document>,
}
#[derive(Debug, Clone)]
enum RequestDocuments {
    Owned(Vec<Document>),
    Deferred(usize),
}
#[derive(Debug, Clone, Copy)]
enum DocumentReference<'a> {
    Owned(&'a Document),
    Deferred { index: usize },
}
impl Default for DocumentReferences {
    fn default() -> Self {
        Vec::new().into()
    }
}
impl From<Vec<Document>> for DocumentReferences {
    fn from(request: Vec<Document>) -> Self {
        Self {
            request: RequestDocuments::Owned(request),
            received: Vec::new(),
        }
    }
}
impl DocumentReferences {
    pub fn deferred(count: usize) -> Self {
        Self {
            request: RequestDocuments::Deferred(count),
            received: Vec::new(),
        }
    }
    pub(crate) fn push(&mut self, document: Document) {
        self.received.push(document)
    }
    fn get(&self, index: usize) -> Option<DocumentReference<'_>> {
        let count = match &self.request {
            RequestDocuments::Owned(documents) => documents.len(),
            RequestDocuments::Deferred(count) => *count,
        };
        if index < count {
            return match &self.request {
                RequestDocuments::Owned(documents) => {
                    documents.get(index).map(DocumentReference::Owned)
                }
                RequestDocuments::Deferred(_) => Some(DocumentReference::Deferred { index }),
            };
        }
        self.received
            .get(index - count)
            .map(DocumentReference::Owned)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Citation {
    WebSearchResultLocation {
        cited_text: String,
        url: String,
        title: Option<String>,
        encrypted_index: String,
    },
    SearchResultLocation {
        cited_text: String,
        search_result_index: u64,
        source: String,
        title: Option<String>,
        start_block_index: u64,
        end_block_index: u64,
    },
    PageLocation {
        #[serde(flatten)]
        document: Location,
        start_page_number: u64,
        end_page_number: u64,
    },
    CharLocation {
        #[serde(flatten)]
        document: Location,
        start_char_index: u64,
        end_char_index: u64,
    },
    ContentBlockLocation {
        #[serde(flatten)]
        document: Location,
        start_block_index: u64,
        end_block_index: u64,
    },
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Location {
    pub cited_text: String,
    pub document_index: usize,
    pub document_title: Option<String>,
    #[serde(default, skip_serializing_if = "Field::is_missing")]
    pub file_id: Field<String>,
}
pub(super) fn metadata(value: Value) -> Extensions {
    Some(BTreeMap::from([("anthropic".into(), value)]))
}
impl Citation {
    pub fn is_web_search(&self) -> bool {
        matches!(self, Self::WebSearchResultLocation { .. })
    }
    pub fn attachment(&self, documents: &DocumentReferences) -> output::Citation {
        let extensions = metadata(serde_json::to_value(self).expect("citation is JSON"));
        let (source, text) = match self {
            Self::WebSearchResultLocation {
                cited_text,
                url,
                title,
                ..
            }
            | Self::SearchResultLocation {
                cited_text,
                source: url,
                title,
                ..
            } => (
                output::Source::Url {
                    id: url.clone(),
                    url: url.clone(),
                    title: title.clone(),
                    extensions,
                },
                cited_text.clone(),
            ),
            Self::PageLocation { document, .. }
            | Self::CharLocation { document, .. }
            | Self::ContentBlockLocation { document, .. } => {
                let reference = documents.get(document.document_index);
                if let Some(DocumentReference::Deferred { index }) = reference {
                    return output::Citation {
                        source: output::Source::DeferredDocument {
                            id: document
                                .file_id
                                .value()
                                .cloned()
                                .unwrap_or_else(|| document.document_index.to_string()),
                            document_index: index,
                            title: document.document_title.clone(),
                            extensions,
                        },
                        text: document.cited_text.clone(),
                    };
                }
                let info = reference.and_then(|reference| match reference {
                    DocumentReference::Owned(document) => Some(document),
                    DocumentReference::Deferred { .. } => None,
                });
                (
                    output::Source::Document {
                        id: document
                            .file_id
                            .value()
                            .cloned()
                            .unwrap_or_else(|| document.document_index.to_string()),
                        media_type: info
                            .map(|v| v.media_type.clone())
                            .unwrap_or_else(|| "text/plain".into()),
                        title: document
                            .document_title
                            .clone()
                            .or_else(|| info.map(|v| v.title.clone()))
                            .unwrap_or_else(|| format!("Document {}", document.document_index)),
                        filename: info.and_then(|v| v.filename.clone()),
                        extensions,
                    },
                    document.cited_text.clone(),
                )
            }
        };
        output::Citation { source, text }
    }
    /// Standalone source IDs belong to the caller. Ignored citations must not
    /// consume an ID, and attachment identity never consumes generated IDs.
    pub fn source(
        &self,
        documents: &DocumentReferences,
        next_id: &mut dyn FnMut() -> String,
    ) -> Option<output::Source> {
        match self {
            Self::WebSearchResultLocation { cited_text, url, title, encrypted_index } => Some(output::Source::Url {
                id: next_id(), url: url.clone(), title: title.clone(),
                extensions: metadata(json!({"citedText":cited_text,"encryptedIndex":encrypted_index})),
            }),
            Self::PageLocation { document, start_page_number, end_page_number } => {
                self.document_source(document, documents, next_id, json!({"citedText":document.cited_text,"startPageNumber":start_page_number,"endPageNumber":end_page_number}))
            }
            Self::CharLocation { document, start_char_index, end_char_index } => {
                self.document_source(document, documents, next_id, json!({"citedText":document.cited_text,"startCharIndex":start_char_index,"endCharIndex":end_char_index}))
            }
            _ => None,
        }
    }
    fn document_source(
        &self,
        location: &Location,
        documents: &DocumentReferences,
        next_id: &mut dyn FnMut() -> String,
        details: Value,
    ) -> Option<output::Source> {
        let reference = documents.get(location.document_index)?;
        let document = match reference {
            DocumentReference::Owned(document) => document,
            DocumentReference::Deferred { index } => {
                return Some(output::Source::DeferredDocument {
                    id: next_id(),
                    document_index: index,
                    title: location.document_title.clone(),
                    extensions: metadata(details),
                });
            }
        };
        Some(output::Source::Document {
            id: next_id(),
            media_type: document.media_type.clone(),
            title: location
                .document_title
                .clone()
                .unwrap_or_else(|| document.title.clone()),
            filename: document.filename.clone(),
            extensions: metadata(details),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_request_ordinals_and_received_documents_share_the_original_index_space() {
        let count = 1_000_000;
        let mut documents = DocumentReferences::deferred(count);
        let citation = |document_index| Citation::PageLocation {
            document: Location {
                cited_text: "quote".into(),
                document_index,
                document_title: None,
                file_id: Field::Missing,
            },
            start_page_number: 1,
            end_page_number: 2,
        };
        let source = citation(count - 1)
            .source(&documents, &mut || "source".into())
            .unwrap();
        assert!(
            matches!(source,output::Source::DeferredDocument{document_index,..}if document_index==count-1)
        );
        documents.push(Document {
            title: "received".into(),
            filename: None,
            media_type: "text/plain".into(),
        });
        let source = citation(count)
            .source(&documents, &mut || "next".into())
            .unwrap();
        assert!(
            matches!(source,output::Source::Document{title,media_type,..}if title=="received"&&media_type=="text/plain")
        );
    }
}
