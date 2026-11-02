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
use maka_agent_facts::model::prompt_source::source::{
    Allocate, ChargedBuffer, NextRecipe, ReadSource,
};

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
struct List<T>(Arc<[T]>);
struct ListCursor<T> {
    items: Arc<[T]>,
    index: usize,
}
impl<T: Clone + Send + Sync + 'static> RecipeSource<T> for List<T> {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<T>> {
        Box::new(ListCursor {
            items: self.0.clone(),
            index: start,
        })
    }
}
impl<T: Clone + Send + Sync> RecipeCursor<T> for ListCursor<T> {
    fn next(&mut self) -> NextRecipe<'_, T> {
        Box::pin(async move {
            let item = self.items.get(self.index).cloned();
            self.index += usize::from(item.is_some());
            Ok(item)
        })
    }
}
fn list<T: Clone + Send + Sync + 'static>(values: Vec<T>) -> Arc<dyn RecipeSource<T>> {
    Arc::new(List(values.into()))
}
fn opts() -> StreamOptions {
    StreamOptions {
        send_reasoning: true,
        cache_namespace: "anthropic".into(),
        tool_names: Default::default(),
        toolsets: Default::default(),
    }
}
fn raw(value: &str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::copy_from_slice(value.as_bytes())),
        TextEncoding::Utf8,
    )
}
async fn bytes(item: &SourceItem) -> Vec<u8> {
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
    let mut result = Vec::new();
    for fragment in item.fragments.iter() {
        let mut cursor = FragmentCursor::new(fragment.clone());
        while let Some(bytes) = cursor.next(budget.clone()).await.unwrap() {
            result.extend_from_slice(&bytes)
        }
    }
    result
}
#[tokio::test]
async fn message_cursor_emits_one_part_before_opening_later_bodies() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct FailedSource(Arc<AtomicUsize>);
    struct FailedCursor(Arc<AtomicUsize>);
    impl ByteSource for FailedSource {
        fn len(&self) -> Option<u64> {
            Some(8)
        }
        fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(FailedCursor(self.0.clone()))
        }
    }
    impl ByteCursor for FailedCursor {
        fn read_chunk(&mut self, _: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async move {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("later body unavailable"))
            })
        }
    }
    let reads = Arc::new(AtomicUsize::new(0));
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    let mut cursor = compiler
        .open(
            MessageRecipe::User {
                content: list(vec![
                    ContentRecipe::Text {
                        text: raw("first"),
                        provider_options: None,
                    },
                    ContentRecipe::Text {
                        text: TextSource::new(
                            SourceBytes::Source(Arc::new(FailedSource(reads.clone()))),
                            TextEncoding::Utf8,
                        ),
                        provider_options: None,
                    },
                ]),
                provider_options: None,
            },
            Arc::new(Budget),
        )
        .await
        .unwrap();
    let first = cursor.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes(&first).await).unwrap()["text"],
        "first"
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "planning the first part never opens a later body"
    );
    assert!(cursor.next().await.is_err());
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn summary_media_allocation_bound_never_opens_blob_bodies() {
    struct NoBlob;
    impl ByteSource for NoBlob {
        fn len(&self) -> Option<u64> {
            None
        }
        fn open(&self, _: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            panic!("allocation-only fit bound opened a blob")
        }
    }
    let compiler = Compiler::new(Arc::new(opts()), Language::En);
    for mime in ["image/*", "application/*", "audio/unknown"] {
        let bound = compiler
            .count_user_part_bound(
                ContentRecipe::Media {
                    media: MediaSource {
                        bytes: SourceBytes::Source(Arc::new(NoBlob)),
                        media_type: raw(mime),
                        detail: None,
                    },
                    provider_options: None,
                },
                Arc::new(Budget),
            )
            .await
            .unwrap();
        assert!(bound.retained > 0);
        assert_eq!(bound.documents, usize::from(!mime.starts_with("audio/")));
    }
}
