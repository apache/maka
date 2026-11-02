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
use crate::output::{Event, Stop};
use serde_json::json;

#[test]
fn done_stops_current_batch_and_finish_is_idempotent() {
    let wire = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"before\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"after\"}}]}\n\n"
    );
    let mut stream = Stream::new("vendor".into());
    let mut id = || "id".into();
    let events = stream.push(wire.as_bytes(), &mut id).unwrap();
    assert!(stream.terminal());
    let texts = events
        .iter()
        .filter_map(|v| {
            if let Event::TextDelta { text, .. } = v {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(texts, ["before"]);
    assert!(stream.push(wire.as_bytes(), &mut id).unwrap().is_empty());
    let finish = stream.finish(&mut id).unwrap();
    assert!(matches!(&finish[..],[Event::TextEnd{..},Event::Finish(v)] if v.reason==Stop::Stop));
    assert!(stream.finish(&mut id).unwrap().is_empty());
}
#[test]
fn fragment_boundaries_preserve_late_tool_names_and_reused_indices() {
    let records = [
        json!({"id":"response","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"x\":"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":1,"id":"same","function":{"name":"first","arguments":"1}"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":1,"id":"same","function":{"name":"second","arguments":"{\"x\":2}"}}]},"finish_reason":"tool_calls"}]}),
    ];
    let wire = records
        .iter()
        .map(|r| format!("data: {r}\n\n"))
        .collect::<String>();
    let mut stream = Stream::new("vendor".into());
    let mut id = || "same".into();
    let mut events = vec![];
    for byte in wire.bytes() {
        events.extend(stream.push(&[byte], &mut id).unwrap());
    }
    events.extend(stream.finish(&mut id).unwrap());
    let calls = events
        .iter()
        .filter_map(|e| {
            if let Event::ToolCall(c) = e {
                Some((c.id.as_str(), c.name.as_str(), c.input.as_str()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        [
            ("same", "first", "{\"x\":1}"),
            ("same-1", "second", "{\"x\":2}")
        ]
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::Response { .. }))
            .count(),
        1
    );
}
#[test]
fn invalid_frames_do_not_fabricate_successful_completion() {
    let mut stream = Stream::new("vendor".into()).with_raw_records(true);
    let mut id = || "id".into();
    let events = stream
        .push(
            b"data: {\"choices\":[{\"delta\":{\"role\":\"user\"}}]}\n\n",
            &mut id,
        )
        .unwrap();
    assert!(matches!(&events[..], [Event::Raw(_), Event::Error(_)]));
    assert!(
        matches!(&stream.finish(&mut id).unwrap()[..],[Event::Finish(v)] if v.reason==Stop::Error)
    );
    let mut stream = Stream::new("vendor".into());
    assert!(
        matches!(&stream.finish(&mut id).unwrap()[..],[Event::Error(_),Event::Finish(v)] if v.reason==Stop::Error)
    );
}
