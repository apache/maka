//! A schema and builders the model's tests share: ProseMirror's basic schema
//! with lists, in the shape of `prosemirror-test-builder`.

use serde_json::json;

use super::*;

pub(crate) fn schema() -> Schema {
    SchemaSpec::from_json(&json!({
        "nodes": [
            ["doc", {"content": "block+"}],
            ["paragraph", {"content": "inline*", "group": "block"}],
            ["blockquote", {"content": "block+", "group": "block", "defining": true}],
            ["horizontal_rule", {"group": "block"}],
            ["heading", {"content": "inline*", "group": "block", "defining": true,
                "attrs": {"level": {"default": 1, "validate": "number"}}}],
            ["code_block", {"content": "text*", "marks": "", "group": "block", "code": true}],
            ["text", {"group": "inline"}],
            ["image", {"inline": true, "group": "inline", "attrs": {"src": {"validate": "string"}, "alt": {"default": null}}}],
            ["hard_break", {"inline": true, "group": "inline", "selectable": false}],
            ["bullet_list", {"content": "list_item+", "group": "block"}],
            ["ordered_list", {"content": "list_item+", "group": "block", "attrs": {"order": {"default": 1}}}],
            ["list_item", {"content": "paragraph block*", "defining": true}]
        ],
        "marks": [
            ["link", {"attrs": {"href": {}}, "inclusive": false}],
            ["em", {}],
            ["strong", {}],
            ["code", {}]
        ]
    }))
    .unwrap()
}

pub(crate) fn n(s: &Schema, name: &str, content: Vec<Node>) -> Node {
    s.node(name, None, Fragment::from(content), vec![]).unwrap()
}

pub(crate) fn t(s: &Schema, text: &str) -> Node {
    s.text(text, vec![])
}

pub(crate) fn tm(s: &Schema, text: &str, marks: &[&str]) -> Node {
    let mut set = Vec::new();
    for m in marks {
        set = s.mark(m, None).unwrap().add_to_set(&set);
    }
    s.text(text, set)
}

pub(crate) fn p(s: &Schema, content: Vec<Node>) -> Node {
    n(s, "paragraph", content)
}

pub(crate) fn doc(s: &Schema, content: Vec<Node>) -> Node {
    n(s, "doc", content)
}
