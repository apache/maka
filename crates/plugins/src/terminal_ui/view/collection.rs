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

use super::{build::*, *};
use serde_json::json;

fn view() -> View {
    View {
        version: VERSION,
        title: "Tasks".into(),
        revision: "one".into(),
        fields: ["item", "group", "before"]
            .into_iter()
            .map(|id| line(id, "", 128))
            .collect(),
        actions: vec![Action {
            fields: vec!["item".into(), "group".into(), "before".into()],
            ..action("move", "Move")
        }],
        root: Node::Collection {
            key: "tasks".into(),
            ratio: 60,
            initial: None,
            filter: None,
            groups: ["todo", "done"]
                .into_iter()
                .map(|id| CollectionGroup {
                    key: id.into(),
                    label: id.into(),
                })
                .collect(),
            items: ["a", "b"]
                .into_iter()
                .map(|id| CollectionItem {
                    key: id.into(),
                    group: "todo".into(),
                    title: id.into(),
                    summary: String::new(),
                    panel: Some(Box::new(slot("detail", "details", json!({"id":id})))),
                })
                .collect(),
            movement: Some(Box::new(CollectionMovement {
                action: "move".into(),
                item_field: "item".into(),
                group_field: "group".into(),
                before_field: "before".into(),
            })),
        },
    }
}
#[test]
fn collection_binds_closed_moves_and_keys_panels_by_item() {
    let view = view();
    view.validate().unwrap();
    assert!(
        matches!(view.node_at("tasks/a/detail"), Some(Node::Slot { context, .. }) if context["id"] == "a")
    );
    for (item, group, before, accepted) in [
        ("a", "done", "", true),
        ("a", "todo", "b", true),
        ("a", "done", "b", false),
        ("a", "todo", "a", false),
        ("gone", "todo", "", false),
        ("a", "missing", "", false),
    ] {
        let fields = BTreeMap::from([
            ("item".into(), json!(item)),
            ("group".into(), json!(group)),
            ("before".into(), json!(before)),
        ]);
        assert_eq!(
            view.submission(Value::Null, "move", fields, "en".into())
                .is_ok(),
            accepted
        );
    }
    let mut disabled = view.clone();
    disabled.fields[0].enabled = false;
    assert!(disabled.movement("tasks", "a", "done", "").is_err());
    let edits: [fn(&mut View); 6] = [
        |view: &mut View| {
            if let Node::Collection { items, .. } = &mut view.root {
                items[1].key = "a".into();
            }
        },
        |view: &mut View| {
            if let Node::Collection { items, .. } = &mut view.root {
                items[0].group = "missing".into();
            }
        },
        |view: &mut View| {
            if let Node::Collection {
                movement: Some(binding),
                ..
            } = &mut view.root
            {
                binding.group_field = "item".into();
            }
        },
        |view: &mut View| {
            view.actions[0].fields.pop();
        },
        |view: &mut View| {
            if let Node::Collection { items, .. } = &mut view.root {
                items[0].panel = Some(Box::new(input("input", "item", "Item")));
            }
        },
        |view: &mut View| {
            if let Node::Collection { items, .. } = &mut view.root {
                items[0].summary = "x".repeat(MAX_BYTES);
            }
        },
    ];
    for edit in edits {
        let mut invalid = view.clone();
        edit(&mut invalid);
        assert!(invalid.validate().is_err());
    }
    let mut payload = serde_json::to_value(view).unwrap();
    payload["root"]["movement"]["callback"] = json!("arbitrary");
    assert!(serde_json::from_value::<View>(payload).is_err());
}
