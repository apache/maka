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

fn fixture() -> View {
    serde_json::from_str(include_str!(
        "../../../../../packages/plugin-sdk/tests/fixtures/terminal-boundary.json"
    ))
    .unwrap()
}

#[test]
fn boundary_rust_and_js_share_a_view_with_an_input_and_bottom_action() {
    let view = View {
        version: VERSION,
        title: "Review".into(),
        revision: "r1".into(),
        fields: vec![area("note", "Hello", 4096)],
        actions: vec![Action {
            fields: vec!["note".into()],
            ..action("save", "Save")
        }],
        root: boundary("review", input("note", "note", "Note"))
            .bottom(row(
                "meta",
                vec![
                    text("status", "中文 🦀", Tone::Muted),
                    button("save", "save", Role::Primary),
                ],
            ))
            .padding(1, 0)
            .emphasis(Emphasis::Accent)
            .activity(Activity::Busy)
            .into(),
    };
    assert_eq!(view, fixture(), "one wire fixture is consumed by both SDKs");
    view.validate().unwrap();
    assert_eq!(
        view.root
            .children()
            .iter()
            .map(|node| node.key())
            .collect::<Vec<_>>(),
        ["note", "meta"]
    );
    let fields = BTreeMap::from([("note".into(), json!("Updated\n中文"))]);
    let request = view
        .submission(json!(null), "save", fields.clone(), "zh-CN".into())
        .unwrap();
    assert!(
        matches!(request, Request::Submit { revision, action, fields: submitted, .. }
        if revision == "r1" && action == "save" && submitted == fields)
    );
    assert!(
        view.submission(json!(null), "save", BTreeMap::new(), "en".into())
            .is_err()
    );
    let restored: View = serde_json::from_value(serde_json::to_value(&view).unwrap()).unwrap();
    assert_eq!(restored, view);
}

#[test]
fn boundary_bottom_only_accepts_single_line_content_and_declared_actions() {
    let rejected = |node| {
        let mut view = fixture();
        if let Node::Boundary { bottom, .. } = &mut view.root {
            *bottom = Some(Box::new(node));
        }
        assert!(view.validate().is_err(), "{view:?}");
    };
    for node in [
        input("other", "note", "Note"),
        column("meta", vec![text("line", "Text", Tone::Normal)]),
        scroll("meta", 1, text("line", "Text", Tone::Normal)),
        boundary("meta", text("line", "Text", Tone::Normal)).into(),
        text("meta", "two\nlines", Tone::Normal),
        row("meta", vec![text("nested", "tab\tvalue", Tone::Normal)]),
        row("meta", vec![button("missing", "missing", Role::Normal)]),
        text("note", "duplicate body key", Tone::Normal),
    ] {
        rejected(node);
    }
    let mut view = fixture();
    if let Node::Boundary { bottom, .. } = &mut view.root {
        *bottom = Some(Box::new(row(
            "meta",
            vec![row(
                "nested",
                vec![
                    button("save", "save", Role::Normal),
                    button("again", "save", Role::Normal),
                ],
            )],
        )));
    }
    view.validate().unwrap();
    view.root = column("outer", vec![view.root, input("duplicate", "note", "Note")]);
    assert!(
        view.validate().is_err(),
        "a field inside a boundary is still mounted only once"
    );
}

#[test]
fn boundary_children_share_tree_depth_node_byte_and_padding_budgets() {
    for padding in [
        Padding {
            horizontal: 5,
            vertical: 0,
        },
        Padding {
            horizontal: 0,
            vertical: 5,
        },
    ] {
        let mut view = fixture();
        if let Node::Boundary { padding: value, .. } = &mut view.root {
            *value = padding;
        }
        assert!(view.validate().is_err());
    }
    let mut view = fixture();
    view.root = boundary(
        "limit",
        column(
            "body",
            (0..MAX_NODES - 3).map(|n| rule(format!("r{n}"))).collect(),
        ),
    )
    .bottom(text("bottom", "At node limit", Tone::Normal))
    .padding(4, 4)
    .into();
    view.validate().unwrap();
    if let Node::Boundary { body, .. } = &mut view.root
        && let Node::Column { children, .. } = body.as_mut()
    {
        children.push(rule("overflow"));
    }
    assert!(
        view.validate().is_err(),
        "bottom counts against the same node budget"
    );
    let mut deep = text("leaf", "Deep", Tone::Normal);
    for n in 0..MAX_DEPTH {
        deep = row(format!("r{n}"), vec![deep]);
    }
    view.root = boundary("depth", rule("body")).bottom(deep).into();
    assert!(
        view.validate().is_err(),
        "nested bottom rows share the depth budget"
    );
    view.root = boundary(
        "bytes",
        text("body", "a".repeat(MAX_BYTES / 2), Tone::Normal),
    )
    .bottom(text("bottom", "b".repeat(MAX_BYTES / 2), Tone::Normal))
    .into();
    assert!(
        view.validate().is_err(),
        "body and bottom share the serialized byte budget"
    );
}

#[test]
fn boundary_wire_defaults_are_closed_and_versioned() {
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["root"] =
        json!({"kind":"boundary", "key":"minimal", "body":{"kind":"rule", "key":"body"}});
    let view: View = serde_json::from_value(value.clone()).unwrap();
    view.validate().unwrap();
    assert!(matches!(
        view.root,
        Node::Boundary {
            bottom: None,
            padding: Padding {
                horizontal: 0,
                vertical: 0
            },
            emphasis: Emphasis::Normal,
            activity: Activity::Idle,
            ..
        }
    ));
    for (name, invalid) in [
        ("activity", json!("spin")),
        ("emphasis", json!("red")),
        ("padding", json!({"left":1})),
        ("execute", json!("save")),
    ] {
        let mut invalid_value = value.clone();
        invalid_value["root"][name] = invalid;
        assert!(serde_json::from_value::<View>(invalid_value).is_err());
    }
    value["version"] = json!(VERSION - 1);
    assert!(
        serde_json::from_value::<View>(value)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn boundary_view_schema_carries_closed_options_and_padding_bounds() {
    let schema = serde_json::to_value(schemars::schema_for!(View)).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let value = serde_json::to_value(fixture()).unwrap();
    validator.validate(&value).unwrap();
    for (field, replacement) in [
        ("emphasis", json!("red")),
        ("activity", json!("flash")),
        ("padding", json!({"horizontal": 5})),
        ("padding", json!({"vertical": 5})),
        ("padding", json!({"left": 1})),
    ] {
        let mut invalid = value.clone();
        invalid["root"][field] = replacement;
        assert!(!validator.is_valid(&invalid));
    }
    let mut old = value;
    old["version"] = json!(VERSION - 1);
    assert!(!validator.is_valid(&old));
}
