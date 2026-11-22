use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    JsonValue,
    element::{CallbackHandle, ClassInstance, JsRaw},
    geometry::px,
};
use serde_json::json;

use super::*;
use crate::dock::{DockLayout, PanelKeys, PanelState};

/// A JS host over JSON values (`None`: `undefined`), as the core's tests
/// convert values: enough to read and make what a layout holds.
#[derive(Default)]
struct JsonHost {
    values: RefCell<Vec<Option<JsonValue>>>,
}

impl JsonHost {
    fn put(&self, v: Option<JsonValue>) -> JsRaw {
        let mut values = self.values.borrow_mut();
        values.push(v);
        JsRaw([(values.len() - 1) as u64, 0])
    }

    fn get(&self, v: JsRaw) -> Option<JsonValue> {
        self.values.borrow()[v.0[0] as usize].clone()
    }
}

impl JsHost for JsonHost {
    fn kind(&self, v: JsRaw) -> JsKind {
        match self.get(v) {
            None => JsKind::Undefined,
            Some(JsonValue::Null) => JsKind::Null,
            Some(JsonValue::Bool(_)) => JsKind::Bool,
            Some(JsonValue::Number(_)) => JsKind::Number,
            Some(JsonValue::String(_)) => JsKind::String,
            Some(JsonValue::Array(_)) => JsKind::Array,
            Some(JsonValue::Object(_)) => JsKind::Object,
        }
    }

    fn bool(&self, v: JsRaw) -> Option<bool> {
        self.get(v)?.as_bool()
    }

    fn number(&self, v: JsRaw) -> Option<f64> {
        self.get(v)?.as_f64()
    }

    fn string(&self, v: JsRaw) -> Option<String> {
        self.get(v)?.as_str().map(str::to_owned)
    }

    fn bytes(&self, _v: JsRaw) -> Option<Vec<u8>> {
        None
    }

    fn len(&self, v: JsRaw) -> Result<Option<usize>, PropError> {
        Ok(self.get(v).and_then(|j| j.as_array().map(Vec::len)))
    }

    fn index(&self, v: JsRaw, i: usize) -> Result<JsRaw, PropError> {
        Ok(self.put(self.get(v).and_then(|j| j.get(i).cloned())))
    }

    fn field(&self, v: JsRaw, key: &str) -> Result<JsRaw, PropError> {
        Ok(self.put(self.get(v).and_then(|j| j.get(key).cloned())))
    }

    fn keys(&self, v: JsRaw) -> Result<Vec<String>, PropError> {
        Ok(match self.get(v) {
            Some(JsonValue::Object(map)) => map.keys().cloned().collect(),
            _ => Vec::new(),
        })
    }

    fn date(&self, _v: JsRaw) -> Option<f64> {
        None
    }

    fn to_json(&self, v: JsRaw) -> Result<JsonValue, PropError> {
        Ok(self.get(v).unwrap_or(JsonValue::Null))
    }

    fn describe(&self, v: JsRaw) -> String {
        self.get(v)
            .map_or_else(|| "undefined".to_owned(), |j| j.to_string())
    }

    fn style(&self, _v: JsRaw) -> Result<nsh_core::StylePatch, PropError> {
        Ok(Default::default())
    }

    fn node(&self, _v: JsRaw) -> Option<nsh_core::NodeId> {
        None
    }

    fn node_value(&self, _id: nsh_core::NodeId) -> JsRaw {
        self.null()
    }

    fn instance(&self, _v: JsRaw) -> Option<Rc<dyn ClassInstance>> {
        None
    }

    fn callback(&self, _v: JsRaw) -> Option<Rc<dyn CallbackHandle>> {
        None
    }

    fn free(&self, _v: JsRaw) {}

    fn undefined(&self) -> JsRaw {
        self.put(None)
    }

    fn null(&self) -> JsRaw {
        self.put(Some(JsonValue::Null))
    }

    fn new_bool(&self, b: bool) -> JsRaw {
        self.put(Some(JsonValue::Bool(b)))
    }

    /// A whole number reads as an integer, as `JSON.stringify` writes it.
    fn new_number(&self, n: f64) -> JsRaw {
        if n.fract() == 0.0 && n.abs() < 2f64.powi(53) {
            return self.put(Some(json!(n as i64)));
        }
        self.put(Some(json!(n)))
    }

    fn new_string(&self, s: &str) -> Result<JsRaw, PropError> {
        Ok(self.put(Some(JsonValue::String(s.to_owned()))))
    }

    fn new_bytes(&self, _bytes: &[u8]) -> Result<JsRaw, PropError> {
        Err(PropError("no bytes here".into()))
    }

    fn new_date(&self, _millis: f64) -> Result<JsRaw, PropError> {
        Err(PropError("no dates here".into()))
    }

    fn new_array(&self, items: Vec<JsRaw>) -> Result<JsRaw, PropError> {
        let items = items
            .into_iter()
            .map(|i| self.get(i).unwrap_or(JsonValue::Null))
            .collect();
        Ok(self.put(Some(JsonValue::Array(items))))
    }

    fn new_object(&self) -> Result<JsRaw, PropError> {
        Ok(self.put(Some(JsonValue::Object(Default::default()))))
    }

    fn set_field(&self, obj: JsRaw, key: &str, value: JsRaw) -> Result<(), PropError> {
        let Some(value) = self.get(value) else {
            return Ok(());
        };
        if let Some(JsonValue::Object(map)) = &mut self.values.borrow_mut()[obj.0[0] as usize] {
            map.insert(key.to_owned(), value);
        }
        Ok(())
    }

    fn json(&self, v: &JsonValue) -> Result<JsRaw, PropError> {
        Ok(self.put(Some(v.clone())))
    }

    fn wrap(&self, _instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        Err(PropError("no classes here".into()))
    }

    fn arg(&self, _i: usize) -> JsRaw {
        self.undefined()
    }

    fn this(&self) -> JsRaw {
        self.undefined()
    }

    fn construct(&self, _instance: Rc<dyn ClassInstance>) -> Result<JsRaw, PropError> {
        Err(PropError("no classes here".into()))
    }
}

fn from_js<T: JsValue>(json: JsonValue) -> Result<T, PropError> {
    let host = JsonHost::default();
    let raw = host.put(Some(json));
    T::from_js(JsIn::new(&host, raw))
}

fn to_js<T: JsValue>(value: &T) -> JsonValue {
    let host = JsonHost::default();
    let owned = value.to_js(&host).expect("the value converts");
    host.get(owned.into_raw()).expect("a value, not undefined")
}

fn id(raw: u64) -> Option<NodeId> {
    Some(NodeId::from_u64(raw))
}

#[test]
fn a_node_reads_from_js() {
    let node: DockNode = from_js(json!({
        "type": "split",
        "axis": "vertical",
        "children": [
            { "type": "tabs", "id": 7, "panels": ["files", "outline"], "activeIndex": 1 },
            { "type": "tabs", "panels": ["editor"] },
        ],
        "sizes": [240, null],
    }))
    .unwrap();

    assert_eq!(
        node,
        DockNode::Split {
            id: None,
            axis: Axis::Vertical,
            children: vec![
                DockNode::Tabs {
                    id: id(7),
                    panels: vec!["files".into(), "outline".into()],
                    active_index: 1,
                },
                DockNode::Tabs {
                    id: None,
                    panels: vec!["editor".into()],
                    active_index: 0,
                },
            ],
            sizes: vec![Some(px(240.)), None],
        }
    );
}

#[test]
fn a_node_writes_to_js_with_every_field() {
    let node = DockNode::Split {
        id: id(1),
        axis: Axis::Horizontal,
        children: vec![DockNode::Tabs {
            id: id(2),
            panels: vec!["files".into()],
            active_index: 0,
        }],
        sizes: vec![Some(px(120.5))],
    };

    assert_eq!(
        to_js(&node),
        json!({
            "type": "split",
            "id": 1,
            "axis": "horizontal",
            "children": [{ "type": "tabs", "id": 2, "panels": ["files"], "activeIndex": 0 }],
            "sizes": [120.5],
        })
    );
    assert_eq!(from_js::<DockNode>(to_js(&node)).unwrap(), node);
}

#[test]
fn a_bad_node_says_where_it_is_wrong() {
    let err = |json| from_js::<DockNode>(json).unwrap_err().0;

    assert_eq!(
        err(json!({ "type": "grid" })),
        "`type`: expected \"split\" or \"tabs\", got \"grid\""
    );
    assert_eq!(err(json!({ "panels": [] })), "`type` is missing");
    assert!(
        err(json!({ "type": "split", "axis": "diagonal", "children": [] })).starts_with("`axis`: "),
        "a bad axis names its field"
    );
    assert_eq!(
        err(json!({
            "type": "split",
            "axis": "horizontal",
            "children": [{ "type": "tabs", "panels": [1] }],
        })),
        "`children`: [0]: `panels`: [0]: expected a string, got 1"
    );
    assert_eq!(
        err(json!({ "type": "tabs", "id": 1.5, "panels": [] })),
        "`id`: expected an integer that fits u64, got 1.5"
    );
    assert!(err(json!("tabs")).starts_with("expected a DockNode"));
}

#[test]
fn a_node_nested_too_deep_is_refused() {
    let mut json = json!({ "type": "tabs", "panels": ["deep"] });
    for _ in 0..=MAX_DEPTH {
        json = json!({ "type": "split", "axis": "horizontal", "children": [json] });
    }

    let err = from_js::<DockNode>(json).unwrap_err().0;
    assert!(
        err.ends_with(&format!("a DockNode nested deeper than {MAX_DEPTH}")),
        "{err}"
    );
}

#[test]
fn the_declaration_names_the_union_once() {
    let mut types = TsTypes::default();
    assert_eq!(DockNode::ts_type(&mut types), "DockNode");
    assert_eq!(DockNode::ts_type(&mut types), "DockNode");

    let mut types = TsTypes::default();
    assert_eq!(DockAreaLayout::ts_type(&mut types), "DockAreaLayout");
    let declared = format!("{types:?}");
    for name in ["DockAreaLayout", "DockRegion", "DockNode"] {
        assert!(
            declared.contains(&format!("export type {name}"))
                || declared.contains(&format!("export interface {name}")),
            "{name} is declared"
        );
    }
    assert!(
        declared.contains("children: DockNode[]"),
        "the union names itself"
    );
}

#[test]
fn a_layout_reads_from_js_with_its_docks() {
    let layout: DockAreaLayout = from_js(json!({
        "center": { "type": "tabs", "panels": ["editor"] },
        "left": { "layout": { "type": "tabs", "panels": ["files"] }, "size": 240 },
        "bottom": { "layout": { "type": "tabs", "panels": ["terminal"] }, "open": false },
    }))
    .unwrap();

    assert_eq!(layout.left.as_ref().unwrap().size, Some(px(240.)));
    assert!(layout.right.is_none());
    let bottom = layout.bottom.as_ref().unwrap().to_dock();
    assert!(!bottom.is_open());
    assert_eq!(bottom.size(), Dock::DEFAULT_SIZE);

    assert_eq!(
        from_js::<DockAreaLayout>(json!({})).unwrap_err().0,
        "`center` is missing"
    );
}

#[test]
fn a_reported_layout_writes_every_id_and_dock_field() {
    let layout = DockAreaLayout::new(DockLayout::tabs().panel("editor"))
        .with_dock(
            DockPlacement::Left,
            DockRegion::new(DockLayout::tabs().panel("files")),
        )
        .normalized();
    let json = to_js(&layout);

    assert_eq!(
        json["center"]["type"], "split",
        "the center's root is a split"
    );
    assert!(json["center"]["id"].is_u64());
    assert!(json["center"]["children"][0]["id"].is_u64());
    assert_eq!(json["left"]["size"], 200);
    assert_eq!(json["left"]["open"], true);
    assert_eq!(json["left"]["collapsible"], true);
    assert_eq!(json["left"]["layout"]["panels"], json!(["files"]));
    assert!(json.get("right").is_none(), "a missing dock stays missing");

    assert_eq!(from_js::<DockAreaLayout>(json).unwrap(), layout);
}

#[test]
fn missing_ids_are_assigned_and_then_stable() {
    let written = DockNode::Split {
        id: None,
        axis: Axis::Horizontal,
        children: vec![
            DockNode::Tabs {
                id: None,
                panels: vec!["files".into()],
                active_index: 0,
            },
            DockNode::Tabs {
                id: None,
                panels: vec!["editor".into()],
                active_index: 0,
            },
        ],
        sizes: vec![Some(px(240.))],
    };

    let tree = PaneTree::from_node(&written, RootKind::Split);
    let reported = tree.to_node();
    let again = PaneTree::from_node(&reported, RootKind::Split);

    assert_eq!(again, tree, "the reported layout installs as the same tree");
    assert_eq!(again.node_ids(), tree.node_ids());
    let PaneRef::Split { sizes, .. } = tree.root().kind() else {
        panic!("expected a split root");
    };
    assert_eq!(
        sizes,
        &[Some(px(240.)), None],
        "sizes are fitted to the children"
    );
}

#[test]
fn an_app_written_id_is_never_allocated_again() {
    let big = NodeId::from_u64(1 << 40);
    let tree = PaneTree::from_node(
        &DockNode::Tabs {
            id: Some(big),
            panels: vec!["a".into()],
            active_index: 0,
        },
        RootKind::Split,
    );

    assert!(
        tree.root().id() > big,
        "the wrapping split is allocated above it"
    );
    assert!(PaneTree::new(RootKind::Any).root().id() > big);
}

#[test]
fn a_repeated_id_or_panel_is_repaired() {
    let node = DockNode::Split {
        id: None,
        axis: Axis::Horizontal,
        children: vec![
            DockNode::Tabs {
                id: id(1 << 41),
                panels: vec!["a".into(), "b".into()],
                active_index: 0,
            },
            DockNode::Tabs {
                id: id(1 << 41),
                panels: vec!["b".into(), "c".into()],
                active_index: 0,
            },
        ],
        sizes: vec![],
    };

    let tree = PaneTree::from_node(&node, RootKind::Split);
    let ids = tree.node_ids();
    assert_eq!(
        ids.iter().collect::<HashSet<_>>().len(),
        ids.len(),
        "every id is unique"
    );
    assert_eq!(
        tree.panels().collect::<Vec<_>>(),
        vec![PanelId::from("a"), PanelId::from("b"), PanelId::from("c")]
    );
}

#[test]
fn a_panel_lives_in_one_region_of_an_area() {
    let layout = DockAreaLayout::new(DockLayout::tabs().panel("editor").panel("files")).with_dock(
        DockPlacement::Left,
        DockRegion::new(DockLayout::tabs().panel("files").panel("outline")),
    );

    let (center, docks) = layout.to_trees();
    assert!(center.contains_panel("files"), "the center comes first");
    let (placement, left, _) = &docks[0];
    assert_eq!(*placement, DockPlacement::Left);
    assert_eq!(
        left.panels().collect::<Vec<_>>(),
        vec![PanelId::from("outline")]
    );
}

#[test]
fn a_region_converts_to_a_tree_and_a_dock() {
    let region = DockRegion {
        layout: DockLayout::tabs().panel("files").into(),
        size: Some(px(10.)),
        open: Some(false),
        collapsible: Some(false),
    };

    let dock = region.to_dock();
    assert_eq!(
        dock.size(),
        crate::dock::PANEL_MIN_SIZE,
        "never below the minimum"
    );
    assert!(!dock.is_open());
    assert!(!dock.is_collapsible());

    let tree = region.to_tree();
    assert!(
        matches!(tree.root().kind(), PaneRef::Tabs { .. }),
        "a dock's root collapses"
    );
    assert_eq!(DockRegion::from_tree(&tree, &dock).layout, tree.to_node());
}

#[test]
fn a_layout_round_trips_through_the_persisted_format() {
    let layout = DockAreaLayout::new(
        DockLayout::h_split()
            .child(DockLayout::tabs().panel("files"), Some(px(240.)))
            .child(
                DockLayout::tabs()
                    .panel("editor")
                    .panel("preview")
                    .active_index(1),
                None,
            ),
    )
    .with_dock(
        DockPlacement::Bottom,
        DockRegion::new(DockLayout::tabs().panel("terminal")),
    )
    .normalized();

    let state = layout.to_state(&PanelKeys);
    assert_eq!(state.center.panel_name, "StackPanel");
    let bottom = state.bottom_dock.as_ref().unwrap();
    assert_eq!(bottom.placement(), DockPlacement::Bottom);
    assert_eq!(bottom.size(), Dock::DEFAULT_SIZE);
    assert!(state.left_dock.is_none());

    let back = DockAreaLayout::from_state(&state, &mut PanelKeys);
    assert_eq!(back.to_state(&PanelKeys), state, "the same layout, new ids");
    let json = serde_json::to_value(&state).unwrap();
    let reread: DockAreaState = serde_json::from_value(json).unwrap();
    assert_eq!(reread, state);
}

#[test]
fn the_shipped_fixture_reads_into_a_layout() {
    let state: DockAreaState =
        serde_json::from_str(include_str!("../fixtures/layout.json")).unwrap();
    let mut n = 0;
    let layout = DockAreaLayout::from_state(&state, &mut |_: &PanelState| {
        n += 1;
        PanelId::new(format!("story-{n}"))
    });

    assert!(layout.left.is_some() && layout.right.is_some() && layout.bottom.is_some());
    assert_eq!(layout.left.as_ref().unwrap().size, Some(px(350.)));
    assert_eq!(layout.right.as_ref().unwrap().size, Some(px(320.)));
    let (center, _) = layout.to_trees();
    assert!(center.panels().count() > 0);
}
