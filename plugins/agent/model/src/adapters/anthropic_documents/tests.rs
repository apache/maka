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

use super::*;
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::source::{
    AcquireBudget, Allocate, ByteCursor, ByteSource, ChargedBuffer, IdentifiedText, ReadSource,
    SourceBytes, SourceRead, TextEncoding,
};
use maka_agent_facts::model::prompt_source::{
    NextWireDocument, WireCursor, WireMetadataCursor, WireSource,
};
use maka_provider_protocol::anthropic::prompt::prepared::DocumentMetadata;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicUsize, Ordering},
};
struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
struct Factory(Arc<AtomicUsize>);
impl SourceBudgetFactory for Factory {
    fn acquire(&self) -> AcquireBudget<'_> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(Budget) as Arc<dyn SourceBudget>)
        })
    }
}
struct IndexedDocuments {
    documents: Vec<DocumentMetadata<IdentifiedText>>,
    factory: Arc<dyn SourceBudgetFactory>,
}
impl WireSource for IndexedDocuments {
    fn budget_factory(&self) -> Option<Arc<dyn SourceBudgetFactory>> {
        Some(self.factory.clone())
    }
    fn document_count(&self) -> usize {
        self.documents.len()
    }
    fn document(&self, index: usize, _budget: Arc<dyn SourceBudget>) -> NextWireDocument<'_> {
        Box::pin(async move { Ok(self.documents.get(index).cloned()) })
    }
    fn open_metadata(&self, _: usize) -> Option<Box<dyn WireMetadataCursor>> {
        panic!("citation lookup must not scan metadata")
    }
    fn open(&self, _: usize) -> Box<dyn WireCursor> {
        panic!("citation lookup must not open a wire body")
    }
}
fn indexed_documents(
    documents: Vec<DocumentMetadata<IdentifiedText>>,
    factory: Arc<dyn SourceBudgetFactory>,
) -> Documents {
    Documents::new(Arc::new(IndexedDocuments { documents, factory }))
        .unwrap()
        .unwrap()
}
struct Blob {
    bytes: Bytes,
    opens: Arc<AtomicUsize>,
}
struct Cursor {
    bytes: Bytes,
    offset: usize,
}
impl ByteSource for Blob {
    fn len(&self) -> Option<u64> {
        Some(self.bytes.len() as u64)
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        Box::new(Cursor {
            bytes: self.bytes.clone(),
            offset: 0,
        })
    }
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            let count = 1
                .min(self.bytes.len() - self.offset)
                .min(buffer.as_mut().len());
            buffer.as_mut()[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
            self.offset += count;
            Ok(SourceRead {
                buffer,
                bytes_read: count,
                eof: self.offset == self.bytes.len(),
            })
        })
    }
}
fn text(value: &str, opens: Arc<AtomicUsize>) -> IdentifiedText {
    IdentifiedText {
        text: TextSource::new(
            SourceBytes::Source(Arc::new(Blob {
                bytes: Bytes::copy_from_slice(value.as_bytes()),
                opens,
            })),
            TextEncoding::Utf8,
        ),
        identity: [0; 32],
    }
}
#[tokio::test]
async fn only_the_emitted_document_and_needed_fields_are_read() {
    let title = Arc::new(AtomicUsize::new(0));
    let mime = Arc::new(AtomicUsize::new(0));
    let untouched = Arc::new(AtomicUsize::new(0));
    let acquired = Arc::new(AtomicUsize::new(0));
    let documents = indexed_documents(
        vec![
            DocumentMetadata {
                title: text("captured 中🚀", title.clone()),
                media_type: text("application/pdf", mime.clone()),
                filename: None,
            },
            DocumentMetadata {
                title: text("uncited", untouched.clone()),
                media_type: text("uncited", untouched.clone()),
                filename: None,
            },
        ],
        Arc::new(Factory(acquired.clone())),
    );
    assert_eq!(title.load(Ordering::SeqCst), 0);
    assert_eq!(mime.load(Ordering::SeqCst), 0);
    let extensions = Some(BTreeMap::from([(
        "anthropic".into(),
        json!({"citedText":"quoted","startPageNumber":1,"endPageNumber":2}),
    )]));
    let mut events = vec![Event::Source(Source::DeferredDocument {
        id: "id".into(),
        document_index: 0,
        title: Some("provider override".into()),
        extensions: extensions.clone(),
    })];
    documents
        .resolve(&mut events, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(acquired.load(Ordering::SeqCst), 1);
    assert_eq!(
        title.load(Ordering::SeqCst),
        0,
        "provider title override avoids captured title read"
    );
    assert_eq!(untouched.load(Ordering::SeqCst), 0);
    assert_eq!(mime.load(Ordering::SeqCst), 1);
    assert!(
        matches!(&events[0],Event::Source(Source::Document{id,title,media_type,extensions:actual,..})if id=="id"&&title=="provider override"&&media_type=="application/pdf"&&actual==&extensions)
    );
    let mut events = vec![Event::Source(Source::DeferredDocument {
        id: "id2".into(),
        document_index: 0,
        title: None,
        extensions: None,
    })];
    documents
        .resolve(&mut events, &CancellationToken::new())
        .await
        .unwrap();
    assert!(
        matches!(&events[0],Event::Source(Source::Document{title,..})if title=="captured 中🚀")
    );
}
#[tokio::test]
async fn cancelled_citation_resolution_does_not_admit_source_reads() {
    let opens = Arc::new(AtomicUsize::new(0));
    let acquired = Arc::new(AtomicUsize::new(0));
    let documents = indexed_documents(
        vec![DocumentMetadata {
            title: text("title", opens.clone()),
            media_type: text("type", opens.clone()),
            filename: None,
        }],
        Arc::new(Factory(acquired.clone())),
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let mut events = vec![Event::Source(Source::DeferredDocument {
        id: "id".into(),
        document_index: 0,
        title: None,
        extensions: None,
    })];
    assert!(matches!(
        documents.resolve(&mut events, &cancellation).await,
        Err(ModelError::Cancelled)
    ));
    assert_eq!(acquired.load(Ordering::SeqCst), 0);
    assert_eq!(opens.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn indexed_document_read_failure_is_not_treated_as_a_missing_document() {
    struct FailedIndex(Arc<dyn SourceBudgetFactory>);
    impl WireSource for FailedIndex {
        fn budget_factory(&self) -> Option<Arc<dyn SourceBudgetFactory>> {
            Some(self.0.clone())
        }
        fn document_count(&self) -> usize {
            1
        }
        fn document(&self, _: usize, _: Arc<dyn SourceBudget>) -> NextWireDocument<'_> {
            Box::pin(async { Err(ModelError::Adapter("document index read failed".into())) })
        }
        fn open(&self, _: usize) -> Box<dyn WireCursor> {
            panic!("document lookup opened body")
        }
    }
    let documents = Documents::new(Arc::new(FailedIndex(Arc::new(Factory(Arc::new(
        AtomicUsize::new(0),
    ))))))
    .unwrap()
    .unwrap();
    let mut events = vec![Event::Source(Source::DeferredDocument {
        id: "id".into(),
        document_index: 0,
        title: None,
        extensions: None,
    })];
    let error = documents
        .resolve(&mut events, &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(error,ModelError::Adapter(message)if message=="document index read failed"));
}
