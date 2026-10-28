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
    JsonSource {
        bytes: SourceBytes::Source(Arc::new(Native(bytes.into()))),
    }
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
fn one_long_token_does_not_materialize_its_value() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let text = "中\\\"😀".repeat(20_000);
        let encoded = serde_json::json!({"body": text, "after": u64::MAX}).to_string();
        let values = fields(
            &source(Bytes::from(encoded)),
            &["body", "after"],
            budget.clone(),
        )
        .await
        .unwrap();
        assert!(
            text_eq(
                &values[0].as_ref().unwrap().text().unwrap(),
                &text,
                budget.clone()
            )
            .await
            .unwrap()
        );
        assert_eq!(
            u64_value(&values[1].as_ref().unwrap().source, budget)
                .await
                .unwrap(),
            u64::MAX
        );
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
fn object_iteration_keeps_insertion_order_and_decoded_key_identity() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let value = source(Bytes::from_static(
            r#"{"z":1,"\u0061":2,"尾":3}"#.as_bytes(),
        ));
        let mut cursor = ObjectCursor::open(value, budget.clone()).await.unwrap();
        for (name, number) in [("z", 1), ("a", 2), ("尾", 3)] {
            let field = cursor.next().await.unwrap().unwrap();
            assert!(text_eq(&field.key, name, budget.clone()).await.unwrap());
            assert_eq!(
                u64_value(&field.value.source, budget.clone())
                    .await
                    .unwrap(),
                number
            );
        }
        assert!(cursor.next().await.unwrap().is_none());
    });
}

#[test]
fn closed_field_lookup_on_scalar_options_is_absent() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let scalar = source(Bytes::from_static(b"false"));
        assert_eq!(kind(&scalar, budget.clone()).await.unwrap(), JsonKind::Bool);
        assert!(
            field(&scalar, &["provider"], budget)
                .await
                .unwrap()
                .is_none()
        );
    });
}

#[test]
fn decoded_key_digest_and_equality_agree_across_encodings() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let escaped = TextSource {
            bytes: source(Bytes::from_static(br#""a\ud83d\ude00""#)).bytes,
            encoding: TextEncoding::JsonString,
        };
        let literal = TextSource {
            bytes: SourceBytes::Inline(Bytes::from_static("a😀".as_bytes())),
            encoding: TextEncoding::Utf8,
        };
        assert!(
            text_source_eq(&escaped, &literal, budget.clone())
                .await
                .unwrap()
        );
        assert_eq!(
            text_digest(&escaped, budget.clone()).await.unwrap(),
            text_digest(&literal, budget).await.unwrap()
        );
    });
}

#[test]
fn decoded_stream_validation_needs_no_random_access_capability() {
    struct Decoded(Native);
    impl ByteSource for Decoded {
        fn len(&self) -> Option<u64> {
            self.0.len()
        }
        fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            self.0.open(budget)
        }
    }
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let bytes = SourceBytes::Source(Arc::new(Decoded(Native(Bytes::from_static(
            br#"[1,{"x":"\u0061"}]"#,
        )))));
        assert_eq!(
            validate_bytes(&bytes, budget.clone()).await.unwrap(),
            JsonKind::Array
        );
        assert_eq!(
            inspect(&JsonSource { bytes }, budget)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
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
fn object_spans_reopen_exact_native_value_ranges() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let parent = source(Bytes::from_static(
            r#" { "a" : ["🧩",{"x":true}], "b" : "tail" } "#.as_bytes(),
        ));
        let mut cursor = ObjectCursor::open(parent.clone(), budget.clone())
            .await
            .unwrap();
        let first = cursor.next_spans().await.unwrap().unwrap();
        assert_eq!(first.kind, JsonKind::Array);
        let key = TextSource {
            bytes: parent.bytes.slice(first.key_range).unwrap(),
            encoding: TextEncoding::JsonString,
        };
        assert!(text_eq(&key, "a", budget.clone()).await.unwrap());
        let value = parent.slice(first.value_range).unwrap();
        let mut array = ArrayCursor::open(value.clone(), budget.clone())
            .await
            .unwrap();
        let element = array.next_span().await.unwrap().unwrap();
        let text = inspect(&value.slice(element.value_range).unwrap(), budget.clone())
            .await
            .unwrap();
        assert!(
            text_eq(&text.text().unwrap(), "🧩", budget.clone())
                .await
                .unwrap()
        );
        let second = cursor.next_spans().await.unwrap().unwrap();
        let tail = inspect(&parent.slice(second.value_range).unwrap(), budget.clone())
            .await
            .unwrap();
        assert!(
            text_eq(&tail.text().unwrap(), "tail", budget)
                .await
                .unwrap()
        );
        assert!(cursor.next_spans().await.unwrap().is_none());
    });
}

#[test]
fn structure_measurement_counts_duplicates_and_not_opaque_leaf_bytes() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let nested = source(Bytes::from_static(br#"{"a":[1,{"b":"text"}],"a":null}"#));
        assert_eq!(
            measure(&nested, budget.clone()).await.unwrap(),
            JsonCounts {
                objects: 2,
                arrays: 1,
                members: 3,
                elements: 2,
                leaves: 3
            }
        );
        let long = serde_json::json!({"x":"😀".repeat(40_000)}).to_string();
        assert_eq!(
            measure(&source(Bytes::from(long)), budget).await.unwrap(),
            JsonCounts {
                objects: 1,
                members: 1,
                leaves: 1,
                ..JsonCounts::default()
            }
        );
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
        let source = JsonSource {
            bytes: SourceBytes::Source(Arc::new(Observed {
                bytes: Bytes::from(raw),
                read: read.clone(),
            })),
        };
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

#[test]
fn embedded_value_validation_matches_serde_depth_and_unknown_numbers() {
    run(async {
        let budget: Arc<dyn SourceBudget> = Arc::new(Budget);
        let mut inputs = vec![
            r#"{"error_code":"marker","ignored":1e400}"#.to_owned(),
            r#"{"ignored":{"nested":-1e400},"error_code":"marker"}"#.to_owned(),
            r#"{"ignored":1.7976931348623157e308,"error_code":"ok"}"#.to_owned(),
            r#"{"ignored":0e999999999999999999999,"error_code":"ok"}"#.to_owned(),
            r#"{"ignored":1e-999999999999999999999,"error_code":"ok"}"#.to_owned(),
            r#"{"error_code":"1e400"}"#.to_owned(),
            format!("{{\"ignored\":1{}e-2000}}", "0".repeat(2000)),
        ];
        for depth in [126, 127, 128, 129] {
            inputs.push(format!("{}0{}", "[".repeat(depth), "]".repeat(depth)));
            inputs.push(format!(
                "{{\"error_code\":\"marker\",\"ignored\":{}0{}}}",
                "[".repeat(depth),
                "]".repeat(depth)
            ));
        }
        for input in inputs {
            let expected = serde_json::from_str::<serde_json::Value>(&input).is_ok();
            let source = source(Bytes::from(input.clone()));
            let result = validate_value_bytes(&source.bytes, budget.clone()).await;
            assert_eq!(
                result.is_ok(),
                expected,
                "legacy parse boundary differs for {input}"
            );
            if let Err(error) = result {
                assert!(
                    is_syntax_error(&error),
                    "local Value rejection must be distinguishable from IO: {error}"
                );
            }
        }
        let syntax_only = source(Bytes::from_static(br#"{"ignored":1e400}"#));
        assert!(
            validate_bytes(&syntax_only.bytes, budget).await.is_ok(),
            "ordinary canonical syntax scanning must not acquire the embedded Value policy"
        );
    });
}

#[test]
fn embedded_numeric_validation_keeps_mid_token_storage_errors() {
    struct Broken;
    struct BrokenCursor(bool);
    impl ByteSource for Broken {
        fn len(&self) -> Option<u64> {
            None
        }
        fn open(&self, _budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
            Box::new(BrokenCursor(false))
        }
    }
    impl ByteCursor for BrokenCursor {
        fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
            Box::pin(async move {
                if self.0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "numeric source checksum failure",
                    ));
                }
                self.0 = true;
                buffer.as_mut()[..2].copy_from_slice(b"1e");
                Ok(SourceRead {
                    buffer,
                    bytes_read: 2,
                    eof: false,
                })
            })
        }
    }
    run(async {
        let bytes = SourceBytes::Source(Arc::new(Broken));
        let error = validate_value_bytes(&bytes, Arc::new(Budget))
            .await
            .unwrap_err();
        assert!(!is_syntax_error(&error));
        assert_eq!(error.to_string(), "numeric source checksum failure");
    });
}
