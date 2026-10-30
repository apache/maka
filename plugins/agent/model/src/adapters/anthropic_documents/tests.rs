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
use maka_agent_facts::model::prompt_source::{
    NativeCitationDocument, NativeCitationDocuments, WireCursor,
};
use serde_json::json;
use std::collections::BTreeMap;

struct Catalog;
impl NativeCitationDocuments for Catalog {
    fn len(&self) -> usize {
        2
    }
    fn document(&self, index: usize) -> Option<NativeCitationDocument> {
        [NativeCitationDocument::Text, NativeCitationDocument::Pdf]
            .get(index)
            .copied()
    }
}
struct SourceWithCatalog;
impl WireSource for SourceWithCatalog {
    fn citation_documents(&self) -> Option<Arc<dyn NativeCitationDocuments>> {
        Some(Arc::new(Catalog))
    }
    fn open(&self, _: usize) -> Box<dyn WireCursor> {
        panic!("citation lookup must not open wire")
    }
}
fn deferred(index: usize, title: Option<&str>) -> Event {
    Event::Source(Source::DeferredDocument {
        id: format!("source-{index}"),
        document_index: index,
        title: title.map(str::to_owned),
        extensions: Some(BTreeMap::from([(
            "anthropic".into(),
            json!({"citedText":"quoted"}),
        )])),
    })
}
#[tokio::test]
async fn independent_catalog_resolves_ordinals_and_preserves_response_title() {
    let source = Arc::new(SourceWithCatalog);
    let weak = Arc::downgrade(&source);
    let documents = Documents::new(source.as_ref()).unwrap();
    drop(source);
    assert!(
        weak.upgrade().is_none(),
        "decoder must release its wire source"
    );
    let mut events = vec![deferred(0, None), deferred(1, Some("provider title"))];
    documents
        .resolve(&mut events, &CancellationToken::new())
        .await
        .unwrap();
    assert!(
        matches!(&events[0], Event::Source(Source::Document { id, media_type, title, filename: None, extensions: Some(extensions) })
        if id == "source-0" && media_type == "text/plain" && title == "Untitled Document" && extensions["anthropic"]["citedText"] == "quoted")
    );
    assert!(
        matches!(&events[1], Event::Source(Source::Document { id, media_type, title, filename: None, .. })
        if id == "source-1" && media_type == "application/pdf" && title == "provider title")
    );
}
#[tokio::test]
async fn invalid_document_index_is_an_error_and_cancellation_does_not_resolve() {
    let documents = Documents::new(&SourceWithCatalog).unwrap();
    let mut events = vec![deferred(2, None)];
    assert!(
        matches!(documents.resolve(&mut events, &CancellationToken::new()).await, Err(ModelError::Adapter(message)) if message.contains("outside its frozen request"))
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let mut events = vec![deferred(0, None)];
    assert!(matches!(
        documents.resolve(&mut events, &cancellation).await,
        Err(ModelError::Cancelled)
    ));
    assert!(matches!(
        events[0],
        Event::Source(Source::DeferredDocument { .. })
    ));
}
