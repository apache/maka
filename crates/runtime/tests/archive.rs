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

use maka_runtime::{
    archive::{
        ArchiveIdentity, ArchivedPlaceholder, MAX_ARCHIVE_BYTES, encode_projection,
        outcome_projection, projection_digest,
    },
    artifact::content_digest,
    attachment::StorageRef,
    event::ToolOutcome,
    tool_output::{
        DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE, DurableToolProjection as Projection, ImageOutput,
        ProjectionPart, RawToolResultRef,
    },
};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Command, Stdio},
};

fn identity() -> ArchiveIdentity {
    ArchiveIdentity {
        runtime_event_id: "event 空😀!~*'()".into(),
        tool_call_id: "call/1".into(),
        tool_name: "Read".into(),
        source_projection_digest: content_digest(b"source"),
        body_sha256: content_digest(b"body")[7..].into(),
        original_bytes: 4,
    }
}
#[test]
fn frozen_body_and_source_hash_match_typescript_serializers() {
    let cases = [
        Projection::Text {
            text: "quotes \" newline\n😀\0".into(),
        },
        Projection::Json {
            value: json!({"10":10,"2":2,"__proto__":{"safe":true},
            "😀":1e-7,"\u{e000}":1e21,"nested":[-0.0,1.0,9007199254740993_u64]}),
        },
        Projection::Failure,
        Projection::Content {
            parts: vec![
                ProjectionPart::Text {
                    text: "hello".into(),
                },
                ProjectionPart::Artifact {
                    image: ImageOutput {
                        detail: None,
                        mime_type: "image/png".into(),
                        reference: StorageRef::SessionFile {
                            session_id: "session".into(),
                            relative_path: "artifact-1".into(),
                        },
                    },
                },
            ],
        },
    ];
    let wire: Vec<Value> = cases
        .iter()
        .map(|p| serde_json::to_value(p).unwrap())
        .collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node").args(["--input-type=module", "-e", r#"
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root = process.argv[1];
const {serializeToolResultProjectionV1} = await import(pathToFileURL(root+'/packages/runtime/src/tool-result-archive-encoding.ts'));
const {stableJsonStringify} = await import(pathToFileURL(root+'/packages/core/src/tool-args-identity.ts'));
const cases = JSON.parse(readFileSync(0,'utf8'));
const hash = value => 'sha256:'+createHash('sha256').update(stableJsonStringify(value)).digest('hex');
process.stdout.write(JSON.stringify(cases.map(p => {
  const ts = p.kind==='failure' ? {...p,message:'The tool completed, but its model-visible result could not be projected safely.'}
    : p.kind==='content' ? {...p,parts:p.parts.map(x=>x.kind==='artifact'
      ? {kind:'artifact',mediaType:x.image.mimeType,ref:{kind:'session_file',relativePath:x.image.ref.relativePath}} : x)} : p;
  return [serializeToolResultProjectionV1(ts),hash(p)];
})));
"#]).arg(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    serde_json::to_writer(child.stdin.take().unwrap(), &wire).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<(String, String)> = serde_json::from_slice(&output.stdout).unwrap();
    for (projection, (body, digest)) in cases.iter().zip(expected) {
        assert_eq!(encode_projection(projection).unwrap(), body.as_bytes());
        assert_eq!(projection_digest(projection).unwrap(), digest);
    }
}

#[test]
fn result_locators_are_canonical_and_do_not_accept_client_supplied_evidence() {
    use maka_runtime::archive::ToolResultAddress;
    let identity = identity();
    let short = identity.short_ref().unwrap();
    let event_path = ToolResultAddress::event_path(&identity.runtime_event_id).unwrap();
    for path in [&short, &event_path] {
        assert_eq!(
            ToolResultAddress::parse(path).unwrap().event_id(),
            identity.runtime_event_id
        );
        for bad in [
            format!("{path}?forged=1"),
            format!("{path}#x"),
            format!("{path}%41"),
        ] {
            assert!(ToolResultAddress::parse(&bad).is_err(), "{bad}");
        }
    }
    for bad in [
        "archive:%65vent",
        "archive:",
        "archive:%FF",
        "maka://runtime/tool-results/%65vent",
        "maka://archive-ledger/v1/anything",
    ] {
        assert!(ToolResultAddress::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn execution_failure_and_projection_failure_do_not_reveal_raw_or_collapse_categories() {
    let failed = ToolOutcome::Failed {
        message: "effect failed".into(),
    };
    assert_eq!(
        encode_projection(&outcome_projection(&failed)).unwrap(),
        b"\"effect failed\""
    );
    let succeeded = ToolOutcome::Succeeded {
        raw: RawToolResultRef {
            bytes: 64 * 1024 * 1024,
            digest: content_digest(b"unavailable raw"),
        },
        model_projection: Projection::Failure,
        artifacts: Vec::new(),
    };
    assert_eq!(
        encode_projection(&outcome_projection(&succeeded)).unwrap(),
        serde_json::to_vec(DURABLE_TOOL_PROJECTION_FAILURE_MESSAGE).unwrap()
    );
    assert!(matches!(succeeded, ToolOutcome::Succeeded { .. }));
    assert!(
        encode_projection(&Projection::Text {
            text: "x".repeat(MAX_ARCHIVE_BYTES)
        })
        .is_err()
    );
    let mut deep = json!(0);
    for _ in 0..40 {
        deep = json!([deep]);
    }
    assert!(projection_digest(&Projection::Json { value: deep }).is_err());
}

#[test]
fn pruning_freezes_a_bounded_first_page_with_lossless_read_continuation() {
    use maka_runtime::read::{MAX_PAGE_CHARS, ReadInput};
    let prepare = |projection: &Projection| {
        ArchivedPlaceholder::prepare("event".into(), "call".into(), "Read".into(), projection)
            .unwrap()
    };
    assert!(
        prepare(&Projection::Text {
            text: "x".repeat(MAX_PAGE_CHARS - 2)
        })
        .is_none()
    );
    assert!(
        prepare(&Projection::Text {
            text: "x".repeat(MAX_PAGE_CHARS - 1)
        })
        .is_some()
    );
    for text in [
        "中😀\"\\\t".repeat(3_000),
        (0..1600)
            .map(|n| format!("line-{n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    ] {
        let projection = Projection::Json {
            value: json!({"content":text}),
        };
        let body = String::from_utf8(encode_projection(&projection).unwrap()).unwrap();
        let placeholder = prepare(&projection).unwrap();
        let Projection::Json { value: model } = placeholder.to_model_projection().unwrap() else {
            panic!()
        };
        assert!(model.to_string().encode_utf16().count() <= MAX_PAGE_CHARS);
        assert_eq!(model["resourceRef"], "archive:event");
        assert!(model.get("bodySha256").is_none());
        let roundtrip: ArchivedPlaceholder =
            serde_json::from_value(serde_json::to_value(&placeholder).unwrap()).unwrap();
        assert_eq!(roundtrip, placeholder);
        let mut page = placeholder.page;
        let mut actual = String::new();
        let mut offset = 0;
        loop {
            assert_eq!(page.offset, offset);
            actual.push_str(&page.content);
            offset += page.returned_lines;
            let Some(next) = page.next else { break };
            assert!(!page.content.is_empty());
            // A whole-line cut omits the delimiter; a partial-line cut does not.
            if !page.partial_line {
                actual.push('\n');
            }
            page = next
                .resolve()
                .unwrap()
                .tool_result_page("Read", &body)
                .unwrap();
        }
        assert_eq!(actual, text);
        let read: ReadInput =
            serde_json::from_value(json!({"path":"archive:event","offset":1,"limit":2})).unwrap();
        assert_eq!(
            read.resolve()
                .unwrap()
                .tool_result_page("Read", &body)
                .unwrap()
                .content,
            text.split('\n')
                .skip(1)
                .take(2)
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    assert!(
        prepare(&Projection::Content {
            parts: vec![
                ProjectionPart::Text {
                    text: "x".repeat(10_000)
                },
                ProjectionPart::Artifact {
                    image: ImageOutput {
                        detail: None,
                        mime_type: "image/png".into(),
                        reference: StorageRef::SessionFile {
                            session_id: "session".into(),
                            relative_path: "image".into()
                        }
                    }
                },
            ]
        })
        .is_none()
    );
}
