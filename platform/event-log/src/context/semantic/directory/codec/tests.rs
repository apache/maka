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
use maka_agent_facts::{
    history::{RowPosition, semantic::directory::*},
    model::{
        TextKind,
        prompt_source::source::{DecodedTextMeasure, RawJsonMeasure},
    },
};
fn text(seed: u64) -> TextSpan {
    TextSpan {
        range: ByteRange {
            start: u64::MAX - seed,
            len: seed,
        },
        measure: DecodedTextMeasure {
            bytes: u64::MAX - seed * 2,
            sha256: std::array::from_fn(|index| (index as u8).wrapping_mul(seed as u8)),
        },
    }
}
fn json(seed: u64, kind: ValueKind) -> JsonSpan {
    JsonSpan {
        range: ByteRange {
            start: seed,
            len: u64::MAX - seed,
        },
        measure: RawJsonMeasure {
            bytes: u64::MAX - seed,
            sha256: std::array::from_fn(|index| (index as u8).wrapping_add(seed as u8)),
        },
        kind,
    }
}
macro_rules! assert_roundtrip {
    ($value:expr,$ty:ty) => {{
        let value = $value;
        let encoded = encode(&value).unwrap();
        let decoded = decode::<$ty>(&encoded).unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(value).unwrap()
        );
        for length in 0..encoded.len() {
            assert!(
                decode::<$ty>(&encoded[..length]).is_err(),
                "accepted truncated descriptor at {length}/{}",
                encoded.len()
            );
        }
        let mut trailing = encoded;
        trailing.push(0);
        assert!(
            decode::<$ty>(&trailing).is_err(),
            "accepted descriptor with an unconsumed suffix"
        );
    }};
}
#[test]
fn every_row_kind_preserves_positions_measures_and_independent_flags() {
    let position = RowPosition {
        source_sequence: 9007199254740991,
        item_index: 47,
    };
    for value in [
        RowDirectory::User {
            payload: position,
            steering: true,
        },
        RowDirectory::User {
            payload: position,
            steering: false,
        },
        RowDirectory::ImportedUser { payload: position },
        RowDirectory::ImportedAssistant { payload: position },
        RowDirectory::ExecutorText { payload: position },
        RowDirectory::AssistantPart {
            model_id: text(3),
            route_identity: text(7),
            payload: PartSource::Complete(position),
        },
        RowDirectory::ToolResult {
            payload: position,
            call_id: text(11),
            name: text(13),
            custom: true,
            is_error: false,
            archived: false,
        },
        RowDirectory::ToolResult {
            payload: position,
            call_id: text(17),
            name: text(19),
            custom: false,
            is_error: true,
            archived: false,
        },
        RowDirectory::ToolResult {
            payload: position,
            call_id: text(23),
            name: text(29),
            custom: false,
            is_error: false,
            archived: true,
        },
        RowDirectory::Notification {
            payload: position,
            call_id: text(31),
            custom: true,
        },
        RowDirectory::UnknownTool {
            call_id: text(37),
            name: text(41),
            custom: false,
        },
    ] {
        assert_roundtrip!(value, RowDirectory);
    }
}
#[test]
fn every_payload_kind_preserves_optional_tokens_and_u64_boundaries() {
    for kind in [
        ValueKind::Null,
        ValueKind::Bool,
        ValueKind::Number,
        ValueKind::String,
        ValueKind::Array,
        ValueKind::Object,
    ] {
        assert_roundtrip!(
            PayloadDirectory::Tool(ToolDirectory::Json(json(3, kind))),
            PayloadDirectory
        );
    }
    for value in [
        PayloadDirectory::User {
            text: text(5),
            quotes: u64::MAX,
            attachments: 7,
            directory_references: Some(json(11, ValueKind::Array)),
        },
        PayloadDirectory::User {
            text: text(13),
            quotes: 0,
            attachments: u64::MAX,
            directory_references: None,
        },
        PayloadDirectory::Text(text(17)),
        PayloadDirectory::Part(PartDirectory::Source),
        PayloadDirectory::Part(PartDirectory::Text {
            text_kind: TextKind::Thinking,
            text: text(19),
            provider_options: Some(json(23, ValueKind::Object)),
        }),
        PayloadDirectory::Part(PartDirectory::Text {
            text_kind: TextKind::Text,
            text: text(29),
            provider_options: None,
        }),
        PayloadDirectory::Part(PartDirectory::ToolCall {
            id: text(31),
            name: text(37),
            input: InputDirectory::Json(json(41, ValueKind::Array)),
            provider_executed: true,
            provider_options: None,
        }),
        PayloadDirectory::Part(PartDirectory::ToolCall {
            id: text(43),
            name: text(47),
            input: InputDirectory::Text(text(53)),
            provider_executed: false,
            provider_options: Some(json(59, ValueKind::Number)),
        }),
        PayloadDirectory::Part(PartDirectory::ToolResult {
            id: text(61),
            name: text(67),
            output: json(71, ValueKind::Object),
            is_error: true,
            provider_options: None,
        }),
        PayloadDirectory::Part(PartDirectory::ToolResult {
            id: text(73),
            name: text(79),
            output: json(83, ValueKind::String),
            is_error: false,
            provider_options: Some(json(89, ValueKind::Null)),
        }),
        PayloadDirectory::Tool(ToolDirectory::Text(text(97))),
        PayloadDirectory::Tool(ToolDirectory::Content { parts: u64::MAX }),
        PayloadDirectory::Tool(ToolDirectory::Failure),
    ] {
        assert_roundtrip!(value, PayloadDirectory);
    }
}
#[test]
fn every_child_and_storage_kind_preserves_its_complete_descriptor() {
    let references = [
        StorageDirectory::SessionFile {
            session_id: text(3),
            relative_path: text(5),
        },
        StorageDirectory::WorkspaceFile {
            relative_path: text(7),
        },
        StorageDirectory::ExternalFile {
            absolute_path: text(11),
        },
        StorageDirectory::SessionContext {
            session_id: text(13),
            ref_id: text(17),
        },
    ];
    for reference in references {
        for image in [false, true] {
            assert_roundtrip!(
                ChildDirectory::Attachment(AttachmentDirectory {
                    image,
                    name: text(19),
                    mime_type: text(23),
                    reference
                }),
                ChildDirectory
            );
        }
        for detail in [None, Some(text(29))] {
            let media = MediaDirectory {
                reference,
                mime_type: text(31),
                detail,
            };
            assert_roundtrip!(
                ChildDirectory::ToolPart(ToolPartDirectory::Artifact(media)),
                ChildDirectory
            );
            assert_roundtrip!(
                ChildDirectory::ToolPart(ToolPartDirectory::Audio(media)),
                ChildDirectory
            );
        }
    }
    for label in [None, Some(text(37))] {
        for source in [None, Some(json(41, ValueKind::Array))] {
            assert_roundtrip!(
                ChildDirectory::Quote {
                    label,
                    source,
                    text: text(43)
                },
                ChildDirectory
            );
        }
    }
    assert_roundtrip!(
        ChildDirectory::ToolPart(ToolPartDirectory::Text(text(47))),
        ChildDirectory
    );
}

// Frozen records from the real Root fixture: decoding and encoding must retain
// their existing bytes when the Rust descriptor declarations change.
fn stored_fixture<T: serde::Serialize + serde::de::DeserializeOwned>(
    encoded: &str,
    expected: &str,
) {
    let bytes = hex::decode(encoded).unwrap();
    let decoded = decode::<T>(&bytes).unwrap();
    assert_eq!(
        serde_json::to_value(&decoded).unwrap(),
        serde_json::from_str::<serde_json::Value>(expected).unwrap()
    );
    assert_eq!(encode(&decoded).unwrap(), bytes);
}

#[test]
fn frozen_rowdirectory_bytes_keep_their_meaning() {
    stored_fixture::<RowDirectory>(
        "04f90106049f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08910249479f447b1b473d359884f2b8541a1ad0b7d194ed59b79e8eee48047ec4830564fd000400",
        r#"{"AssistantPart":{"model_id":{"range":{"start":249,"len":6},"measure":{"bytes":4,"sha256":[159,134,208,129,136,76,125,101,154,47,234,160,197,90,208,21,163,191,79,27,43,11,130,44,209,93,108,21,176,240,10,8]}},"route_identity":{"range":{"start":273,"len":73},"measure":{"bytes":71,"sha256":[159,68,123,27,71,61,53,152,132,242,184,84,26,26,208,183,209,148,237,89,183,158,142,238,72,4,126,196,131,5,100,253]}},"payload":{"Complete":{"sourceSequence":4,"itemIndex":0}}}}"#,
    );
}

#[test]
fn frozen_payloaddirectory_bytes_keep_their_meaning() {
    stored_fixture::<PayloadDirectory>(
        "0202210806e9c8871e2ef30b1e62c50b20c4b6402d9729353e677240d2eeb211241918315a3106049b9a8d05a7ec353bda84f9c1bb3178c299de3001b5e970508ddc889c487f92ca00561212a882010639b4186ec8f8988815fa25bd56d926099aec3096bb5b073f799d83e8050000",
        r#"{"Part":{"ToolCall":{"id":{"range":{"start":33,"len":8},"measure":{"bytes":6,"sha256":[233,200,135,30,46,243,11,30,98,197,11,32,196,182,64,45,151,41,53,62,103,114,64,210,238,178,17,36,25,24,49,90]}},"name":{"range":{"start":49,"len":6},"measure":{"bytes":4,"sha256":[155,154,141,5,167,236,53,59,218,132,249,193,187,49,120,194,153,222,48,1,181,233,112,80,141,220,136,156,72,127,146,202]}},"input":{"Json":{"range":{"start":86,"len":18},"measure":{"bytes":18,"sha256":[168,130,1,6,57,180,24,110,200,248,152,136,21,250,37,189,86,217,38,9,154,236,48,150,187,91,7,63,121,157,131,232]},"kind":"Object"}},"provider_executed":false,"provider_options":null}}}"#,
    );
}

#[test]
fn frozen_childdirectory_bytes_keep_their_meaning() {
    stored_fixture::<ChildDirectory>(
        "020031f809b30806e91925212eb903733201aaca81d91041147cbfdc01bde65b3967c34cc6cfb5",
        r#"{"ToolPart":{"Text":{"range":{"start":49,"len":1272},"measure":{"bytes":1075,"sha256":[6,233,25,37,33,46,185,3,115,50,1,170,202,129,217,16,65,20,124,191,220,1,189,230,91,57,103,195,76,198,207,181]}}}}"#,
    );
}
