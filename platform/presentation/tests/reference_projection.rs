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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::input::MessageInput;
use maka_presentation::InvocationView;
use serde_json::json;

#[test]
fn complete_reference_text_survives_presentation() {
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for (field, references) in [
        (
            "attachments",
            json!([{"kind":"other","name":"😀".repeat(33),"mimeType":"x","bytes":0,
            "ref":{"kind":"session_file","sessionId":"session","relativePath":"artifact"}}]),
        ),
        ("quotes", json!([{"text":"short","label":"😀".repeat(33)}])),
        (
            "directory_references",
            json!([{"hostId":"root","path":format!("/{}", "x".repeat(128))}]),
        ),
        (
            "inline_references",
            json!([{"kind":"workspace_file","value":"@file","label":"x".repeat(129),"start":0}]),
        ),
    ] {
        let mut input = json!({"text":"@file","display_text":null});
        input[field] = references.clone();
        let input: MessageInput = serde_json::from_value(input).unwrap();
        let event = StoredEvent {
            sequence: 1,
            event: RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: input,
                        request_fingerprint: None,
                    },
                },
            ),
        };
        let mut view = InvocationView::new();
        let rows = view.push(&event).unwrap();
        let content = serde_json::to_value(&rows[0].message.content).unwrap();
        let output_field = match field {
            "directory_references" => "directoryReferences",
            "inline_references" => "inlineReferences",
            other => other,
        };
        assert_eq!(
            content[output_field], references,
            "complete {field} changed"
        );
    }
}
