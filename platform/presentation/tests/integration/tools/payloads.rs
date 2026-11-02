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
use maka_agent_facts::tool_output::ToolOutput;
use maka_presentation::ProjectionError;

fn boundary(output: &ToolOutput) -> (InvocationView, StoredEvent) {
    let mut facts = vec![opening()];
    step(&mut facts, "first", false, false);
    facts.push(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "first:raw".into(),
        call: ToolCallIdentity::provider("first".into(), "raw".into()),
        name: "exec".into(),
        input: json!({"code":"Read()"}),
    });
    facts.push(Fact::ToolSettled {
        operation_id: "first:raw".into(),
        outcome: success(output),
    });
    let mut events = stored(facts);
    let result = events.pop().unwrap();
    let mut view = InvocationView::new();
    for event in events {
        view.push(&event).unwrap();
    }
    (view, result)
}

#[test]
fn successful_boundary_requires_raw_and_other_facts_reject_it() {
    let raw = ToolOutput::Text("original".into());
    let (mut view, event) = boundary(&raw);
    assert!(matches!(
        view.push(&event),
        Err(ProjectionError::Invalid(_))
    ));
    assert!(
        view.push_with_tool_output(&event, Some(&raw)).is_err(),
        "invalid input poisons the projection"
    );
    let mut view = InvocationView::new();
    let opening = stored(vec![opening()]).remove(0);
    assert!(matches!(
        view.push_with_tool_output(&opening, Some(&raw)),
        Err(ProjectionError::Invalid(_))
    ));
}

#[test]
fn raw_results_preserve_complete_content_and_row_metadata() {
    let text = "x".repeat(16 * 1024 * 1024 + 1);
    let raw = ToolOutput::Text(text.clone());
    let (mut view, event) = boundary(&raw);
    let row = view
        .push_with_tool_output(&event, Some(&raw))
        .unwrap()
        .remove(0);
    assert!(
        matches!(&row.message.content,maka_presentation::Content::ToolResult {content:maka_presentation::ToolContent::Text {text:actual},..} if actual == &text),
        "complete raw result changed"
    );
}
