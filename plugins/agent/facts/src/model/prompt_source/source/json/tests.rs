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
use crate::model::prompt_source::source::{Allocate, ByteSource, ReadSource, SourceRead};
use bytes::Bytes;
use std::{
    future::Future,
    ops::Range,
    task::{Context, Poll, Waker},
};

struct Budget;
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(ChargedBuffer::new(vec![0; minimum], ())) })
    }
}
struct Native(Bytes);
struct Cursor {
    bytes: Bytes,
    at: usize,
}
impl ByteSource for Native {
    fn len(&self) -> Option<u64> {
        Some(self.0.len() as u64)
    }
    fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            bytes: self.0.clone(),
            at: 0,
        })
    }
    fn slice(&self, range: Range<u64>) -> io::Result<Arc<dyn ByteSource>> {
        let start = usize::try_from(range.start).map_err(|_| invalid("test range"))?;
        let end = usize::try_from(range.end).map_err(|_| invalid("test range"))?;
        if start > end || end > self.0.len() {
            return Err(invalid("test range"));
        }
        Ok(Arc::new(Self(self.0.slice(start..end))))
    }
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            // Every lexical token, Unicode sequence and escape crosses reads.
            let count = usize::from(self.at < self.bytes.len());
            if count != 0 {
                buffer.as_mut()[0] = self.bytes[self.at];
                self.at += 1;
            }
            Ok(SourceRead {
                buffer,
                bytes_read: count,
                eof: self.at == self.bytes.len(),
            })
        })
    }
}
fn source(bytes: impl Into<Bytes>) -> JsonSource {
    JsonSource::new(SourceBytes::Source(Arc::new(Native(bytes.into()))))
}
fn run<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    match std::pin::pin!(future).poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixture source must be immediately ready"),
    }
}

#[test]
fn escaped_keys_unicode_and_nested_value_ranges_remain_sources() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let value = source(Bytes::from_static(r#" {"\u006bey":"literal 中文 😀 and \ud83d\ude00\n\\\"","items":[true,null,-12.5e+3,{"sig":"opaque"}]} "#.as_bytes()));
        let located = fields(&value, &["items", "key", "missing"], budget.clone())
            .await
            .unwrap();
        assert!(located[2].is_none());
        assert!(
            text_eq(
                &located[1].as_ref().unwrap().text().unwrap(),
                "literal 中文 😀 and 😀\n\\\"",
                budget.clone()
            )
            .await
            .unwrap()
        );
        let mut items =
            ArrayCursor::open(located[0].as_ref().unwrap().source.clone(), budget.clone())
                .await
                .unwrap();
        let first = items.next().await.unwrap().unwrap();
        assert!(bool_value(&first.source, budget.clone()).await.unwrap());
        assert_eq!(items.next().await.unwrap().unwrap().kind, JsonKind::Null);
        assert_eq!(items.next().await.unwrap().unwrap().kind, JsonKind::Number);
        let object = items.next().await.unwrap().unwrap();
        let sig = field(&object.source, &["sig"], budget.clone())
            .await
            .unwrap()
            .unwrap();
        assert!(
            text_eq(&sig.text().unwrap(), "opaque", budget)
                .await
                .unwrap()
        );
        assert!(items.next().await.unwrap().is_none());
    });
}

#[test]
fn field_selection_matches_decoded_keys_and_last_duplicate_without_token_storage() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let long_key = "中😀ab".repeat(8192);
        let input = format!(
            r#"{{"":1,"a":2,"ab":3,"\u0061":4,"中😀":5,"\u4e2d\ud83d\ude00":6,"\u0000":7,{}:8}}"#,
            serde_json::to_string(&long_key).unwrap()
        );
        let expected: serde_json::Value = serde_json::from_str(&input).unwrap();
        let names = ["", "a", "ab", "abc", "中😀", "a", "\0", &long_key];
        let values = fields(&source(Bytes::from(input)), &names, budget.clone())
            .await
            .unwrap();
        for (name, value) in names.into_iter().zip(values) {
            match (expected.get(name), value) {
                (Some(expected), Some(value)) => assert_eq!(
                    u64_value(&value.source, budget.clone()).await.unwrap(),
                    expected.as_u64().unwrap(),
                    "selected field {name:?}"
                ),
                (None, None) => {}
                (_, value) => panic!("field selection disagrees with serde: {name:?}, {value:?}"),
            }
        }
    });
}

#[test]
fn malformed_or_truncated_values_fail_at_their_boundary() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        for bytes in [
            "[1,]",
            "{\"x\":1,}",
            "[1}",
            "\"\\ud800x\"",
            "\"\\udc00\"",
            "01",
            "1e",
            "false x",
            "{\"x\":",
        ] {
            assert!(
                inspect(
                    &source(Bytes::copy_from_slice(bytes.as_bytes())),
                    budget.clone()
                )
                .await
                .is_err(),
                "accepted {bytes}"
            );
        }
        let invalid_utf8 = source(Bytes::from_static(b"\"\xf0\x80\x80\x80\""));
        assert!(inspect(&invalid_utf8, budget.clone()).await.is_err());
        assert!(
            u64_value(&source(Bytes::from_static(b"18446744073709551616")), budget)
                .await
                .is_err()
        );
    });
}

#[test]
fn syntax_rejection_does_not_mask_storage_invalid_data() {
    struct Failed;
    impl ByteSource for Failed {
        fn len(&self) -> Option<u64> {
            None
        }
        fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(Failed)
        }
    }
    impl ByteCursor for Failed {
        fn read_chunk(&mut self, _buffer: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "storage checksum failure",
                ))
            })
        }
    }
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let malformed = source(Bytes::from_static(b"[1,"));
        assert!(is_syntax_error(
            &validate_bytes(&malformed.bytes, budget.clone())
                .await
                .unwrap_err()
        ));
        let failed = SourceBytes::Source(Arc::new(Failed));
        let error = validate_bytes(&failed, budget).await.unwrap_err();
        assert!(!is_syntax_error(&error));
        assert_eq!(error.to_string(), "storage checksum failure");
    });
}

#[test]
fn structure_walk_visits_nested_giant_leaf_only_once() {
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Observed {
        bytes: Bytes,
        read: Arc<AtomicU64>,
    }
    struct ObservedCursor {
        bytes: Bytes,
        at: usize,
        read: Arc<AtomicU64>,
    }
    impl ByteSource for Observed {
        fn len(&self) -> Option<u64> {
            Some(self.bytes.len() as u64)
        }
        fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(ObservedCursor {
                bytes: self.bytes.clone(),
                at: 0,
                read: self.read.clone(),
            })
        }
    }
    impl ByteCursor for ObservedCursor {
        fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async move {
                let count = (self.bytes.len() - self.at).min(buffer.as_ref().len());
                buffer.as_mut()[..count].copy_from_slice(&self.bytes[self.at..self.at + count]);
                self.at += count;
                self.read.fetch_add(count as u64, Ordering::SeqCst);
                Ok(SourceRead {
                    buffer,
                    bytes_read: count,
                    eof: self.at == self.bytes.len(),
                })
            })
        }
    }
    run(async {
        let depth = 48;
        let raw = format!(
            "{}\"{}\"{}",
            "{\"x\":".repeat(depth),
            "q".repeat(400_000),
            "}".repeat(depth)
        );
        let length = raw.len() as u64;
        let read = Arc::new(AtomicU64::new(0));
        let source = JsonSource::new(SourceBytes::Source(Arc::new(Observed {
            bytes: Bytes::from(raw),
            read: read.clone(),
        })));
        let mut cursor = StructureCursor::open(source, Arc::new(Budget))
            .await
            .unwrap();
        let mut values = 0;
        let mut ends = 0;
        while let Some(event) = cursor.next().await.unwrap() {
            match event {
                JsonStructureEvent::Value(value) => {
                    assert_eq!(value.ordinal, values);
                    values += 1;
                }
                JsonStructureEvent::End { .. } => ends += 1,
            }
        }
        assert_eq!(values, depth as u64 + 1);
        assert_eq!(ends, depth);
        assert_eq!(
            read.load(Ordering::SeqCst),
            length,
            "nesting must not rescan the leaf"
        );
    });
}
