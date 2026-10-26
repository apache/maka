use std::cell::Cell;

use super::*;
use crate::{
    Color, EventKind, IMAGE_SCALES, ImageScales, StyleValue,
    animation::{AnimationOp, AnimationProp},
    geometry::{point, px},
};

/// 8pt per char, 16pt per line, wraps at `max_width`. Counts calls.
#[derive(Default)]
struct FakeEngine {
    prepares: Cell<u32>,
    measures: Cell<u32>,
    layouts: Cell<u32>,
}

/// [`FakeEngine`]'s layout: the characters laid out and where its
/// attachments go.
struct FakeLayout {
    chars: usize,
    width: f32,
    points: Vec<Option<Point<Points>>>,
}

impl TextEngine for FakeEngine {
    /// Characters and attachment offsets.
    type Prepared = (usize, Vec<u32>);

    fn prepare(&self, text: &AttributedText) -> (usize, Vec<u32>) {
        self.prepares.set(self.prepares.get() + 1);
        (
            text.text.chars().count(),
            text.attachments.iter().map(|a| a.index).collect(),
        )
    }

    fn measure(&self, &(chars, _): &(usize, Vec<u32>), max_width: Option<Points>) -> Size<Points> {
        self.measures.set(self.measures.get() + 1);
        let w = chars as f32 * 8.0;
        match max_width.map(|m| m.0) {
            Some(max) if w > max && max > 0.0 => size_pt(max, (w / max).ceil() * 16.0),
            _ => size_pt(w, 16.0),
        }
    }

    fn layout(&self, (chars, attachments): &(usize, Vec<u32>), size: Size<Points>) -> TextLayout {
        self.layouts.set(self.layouts.get() + 1);
        // One line; the third attachment on is cut off.
        let points: Vec<Option<Point<Points>>> = attachments
            .iter()
            .enumerate()
            .map(|(i, &at)| {
                (i < 2).then_some(crate::geometry::point(Points(at as f32 * 8.0), Points(2.0)))
            })
            .collect();
        TextLayout(Arc::new(FakeLayout {
            chars: *chars,
            width: size.width.0,
            points,
        }))
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout
            .downcast::<FakeLayout>()
            .map(|l| l.points.clone())
            .unwrap_or_default()
    }

    fn lines(&self, layout: &TextLayout) -> Vec<crate::TextLine> {
        let layout = layout.downcast::<FakeLayout>().unwrap();
        let columns = (layout.width / 8.0).floor().max(1.0) as usize;
        (0..layout.chars)
            .step_by(columns)
            .enumerate()
            .map(|(row, start)| crate::TextLine {
                start: start as u32,
                end: (start + columns).min(layout.chars) as u32,
                y: px(row as f32 * 16.0),
                height: px(16.0),
                ..crate::TextLine::default()
            })
            .collect()
    }
}

/// What the core hands JS, with Rust components' events, lazy children and
/// calls' results as the native events JS once heard (`$children`,
/// `$return` with `{ c, v }` or `{ c, e }`), their data as JSON.
fn js_events<M: TextEngine>(c: &mut Core<M>) -> Vec<(NodeId, EventKind, EventPayload)> {
    use crate::ui::{JsEvent, json_host};
    let mut events = Vec::new();
    c.take_events(&mut events);
    let native = |id, name: &str, data| {
        (
            id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        )
    };
    events
        .into_iter()
        .map(|e| match e {
            JsEvent::Event(id, kind, payload) => (id, kind, payload),
            JsEvent::Component { host, event } => native(
                host,
                event.name(),
                json_host::event_data(&*event).unwrap_or(crate::JsonValue::Null),
            ),
            JsEvent::Children { host, wanted } => {
                native(host, "$children", crate::JsonValue::Bool(wanted))
            }
            JsEvent::Render {
                host,
                prop,
                key,
                value,
            } => native(
                host,
                "$render",
                serde_json::json!({
                    "prop": prop,
                    "key": key.as_str(),
                    "value": json_host::render_value(&*value),
                }),
            ),
            JsEvent::Unrender { host, prop, key } => native(
                host,
                "$unrender",
                serde_json::json!({ "prop": prop, "key": key.as_str() }),
            ),
            JsEvent::Reply { call, result } => native(
                ROOT_ID,
                "$return",
                match json_host::result(result) {
                    Ok(v) => serde_json::json!({ "c": call, "v": v }),
                    Err(e) => serde_json::json!({ "c": call, "e": e }),
                },
            ),
        })
        .collect()
}

/// Prop `name` of a Rust component of props `P`, from JS value `value`
/// (converted as JS's assignment does).
fn rust_prop<P: crate::ui::Props>(name: &'static str, value: Option<crate::JsonValue>) -> Prop {
    let specs = P::spec(&mut crate::ui::TsTypes::default());
    let decode = specs
        .iter()
        .find(|p| p.name == name)
        .and_then(|p| p.decode)
        .expect("a value prop");
    Prop::RustProp(
        name,
        value.map(|v| crate::ui::json_host::decode(decode, v).expect("the value converts")),
    )
}

#[test]
fn calls_into_rust_settle_their_promises_whatever_happens() {
    use crate::ui::{RustCall, RustOp, ToJs};
    let op = |call, run| Op::Rust(RustOp { call, run });
    let mut c = core();
    // Run: its value.
    c.apply(op(
        1,
        RustCall::Op(Box::new(|_| Ok(Box::new(42.0f64) as Box<dyn ToJs>))),
    ))
    .unwrap();
    // A panic: its message.
    c.apply(op(2, RustCall::Op(Box::new(|_| panic!("op boom")))))
        .unwrap();
    // A method of a node that hosts no component.
    c.apply(op(3, RustCall::Method(40, Box::new(|_| None))))
        .unwrap();
    // Not applied (the script stopped): rejected.
    c.discard_ops(vec![op(
        4,
        RustCall::Op(Box::new(|_| Ok(Box::new(1.0f64) as Box<dyn ToJs>))),
    )]);
    // Call 0 (an op or method returning `()`: JS waits for nothing): run,
    // failed or discarded, no reply.
    c.apply(op(
        0,
        RustCall::Op(Box::new(|_| Ok(Box::new(()) as Box<dyn ToJs>))),
    ))
    .unwrap();
    c.apply(op(0, RustCall::Op(Box::new(|_| panic!("quiet boom")))))
        .unwrap();
    c.apply(op(0, RustCall::Method(40, Box::new(|_| None))))
        .unwrap();
    c.discard_ops(vec![op(
        0,
        RustCall::Op(Box::new(|_| Ok(Box::new(()) as Box<dyn ToJs>))),
    )]);
    let replies: Vec<_> = js_events(&mut c)
        .into_iter()
        .map(|(_, _, payload)| match payload {
            EventPayload::Native { data, .. } => data,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        replies,
        [
            serde_json::json!({ "c": 1, "v": 42 }),
            serde_json::json!({ "c": 2, "e": "op boom" }),
            serde_json::json!({ "c": 3, "e": "node 40 hosts no Rust component" }),
            serde_json::json!({ "c": 4, "e": "the script stopped before the call ran" }),
        ]
    );
}

#[test]
fn values_of_calls_into_rust_that_panic_as_they_drop_stay_in_the_core() {
    use crate::ui::{JsHost, JsOwned, JsValue, PropError, RustCall, RustOp, ToJs, TsTypes};
    /// Panics as it drops.
    struct Grenade;
    impl Drop for Grenade {
        fn drop(&mut self) {
            panic!("grenade");
        }
    }
    impl JsValue for Grenade {
        fn ts_type(_: &mut TsTypes) -> String {
            "null".into()
        }
        fn from_js(_: crate::ui::JsIn<'_>) -> Result<Self, PropError> {
            Ok(Grenade)
        }
        fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
            Ok(JsOwned::new(host, host.null()))
        }
    }
    let mut c = core();
    // A result nobody waits for.
    c.apply(Op::Rust(RustOp {
        call: 0,
        run: RustCall::Op(Box::new(|_| Ok(Box::new(Grenade) as Box<dyn ToJs>))),
    }))
    .unwrap();
    // A method's arguments when no component takes them.
    let grenade = Grenade;
    c.apply(Op::Rust(RustOp {
        call: 0,
        run: RustCall::Method(
            40,
            Box::new(move |_| {
                let _ = &grenade;
                None
            }),
        ),
    }))
    .unwrap();
    // A call's arguments when the script stopped.
    let grenade = Grenade;
    c.discard_ops(vec![Op::Rust(RustOp {
        call: 0,
        run: RustCall::Op(Box::new(move |_| {
            let _ = &grenade;
            Err(String::new().into())
        })),
    })]);
    assert!(js_events(&mut c).is_empty());
}

fn core() -> Core<FakeEngine> {
    let mut c = Core::new(FakeEngine::default(), size_pt(320.0, 480.0));
    c.set_tokens(crate::ui::tokens::sample());
    c
}

#[test]
fn pan_permission_filters_native_values_and_events_without_losing_them() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::PanValues(None, Some(7)),
            },
            Op::Listen {
                id: 2,
                event: EventKind::PanEnd,
                enabled: true,
            },
            Op::Listen {
                id: 2,
                event: EventKind::Press,
                enabled: true,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::PanEnabled(false),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::Events { id: 2, events } if events.contains(EventKind::Press) && !events.contains(EventKind::PanEnd)
    )));
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::Gestures { id: 2, values } if values.pan_y.is_none()
    )));
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::PanEnabled(true),
        }],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::Events { id: 2, events } if events.contains(EventKind::PanEnd) && events.contains(EventKind::Press)
    )));
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::Gestures { id: 2, values } if values.pan_y == Some(7)
    )));
}

/// The tokens of a theme file of the tests' own format, `{ "key":
/// "#rrggbb", … }` over the sample's (`None`: the sample's): the core reads
/// `uiTheme` with what a UI set brings.
fn test_tokens(json: Option<&str>) -> Result<crate::ui::Tokens, String> {
    let mut tokens = crate::ui::tokens::sample();
    let Some(json) = json else {
        return Ok(tokens);
    };
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    for (key, value) in value.as_object().ok_or("not an object")? {
        let color = value.as_str().and_then(Color::parse).ok_or("not a color")?;
        tokens.set_color(key, color.into());
    }
    Ok(tokens)
}

/// Tokens with just `colors`.
fn tokens_with(colors: &[(&str, crate::ui::AdaptiveColor)]) -> crate::ui::Tokens {
    let mut tokens = crate::ui::Tokens::default();
    for (key, color) in colors {
        tokens.set_color(key, *color);
    }
    tokens
}

/// Color token `key` of the tokens apps have.
fn token(key: &str) -> crate::ui::AdaptiveColor {
    crate::ui::tokens::sample().color(key).unwrap()
}

fn style(props: &[(&str, StyleValue<'_>)]) -> Box<Style> {
    let mut s = Style::default();
    for &(k, v) in props {
        s.set(k, v).unwrap();
    }
    Box::new(s)
}

fn style_op(id: NodeId, props: &[(&str, StyleValue<'_>)]) -> Op {
    let mut style = Box::<Style>::default();
    let mut patch = StylePatch::default();
    for &(k, v) in props {
        patch.set(&mut style, k, v).unwrap();
    }
    Op::SetStyle { id, style, patch }
}

fn apply<M: TextEngine>(core: &mut Core<M>, ops: Vec<Op>) {
    for op in ops {
        core.apply(op).unwrap();
    }
}

fn frame_of(batch: &MountBatch, id: NodeId) -> Option<Bounds<Points>> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::Frame { id: i, frame } if *i == id => Some(*frame),
        _ => None,
    })
}

#[test]
fn mounts_subtree_built_detached() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Create {
                id: 3,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 4,
                text: "hello".into(),
            },
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            style_op(2, &[("padding", StyleValue::Number(10.0))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let creates: Vec<_> = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Create { id, kind } => Some((*id, *kind)),
            _ => None,
        })
        .collect();
    // Raw text never becomes a native view.
    assert_eq!(creates, vec![(2, ViewKind::View), (3, ViewKind::Text)]);
    let text = batch.items.iter().find_map(|i| match i {
        MountItem::Text { id: 3, text, .. } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(text.unwrap().text, "hello");
    assert_eq!(frame_of(&batch, 2), Some(rect(0.0, 0.0, 320.0, 36.0)));
    assert_eq!(frame_of(&batch, 3), Some(rect(10.0, 10.0, 300.0, 16.0)));
    assert!(c.commit().is_none(), "second commit is a no-op");
}

#[test]
fn a_spans_test_id_is_in_its_blocks_text() {
    let mut c = core();
    let text_of = |c: &mut Core<_>| {
        c.commit().unwrap().items.into_iter().find_map(|i| match i {
            MountItem::Text { id: 2, text, .. } => Some(text),
            _ => None,
        })
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            Op::Listen {
                id: 2,
                event: EventKind::TextLayout,
                enabled: true,
            },
            Op::CreateText {
                id: 3,
                text: "see ".into(),
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 5,
                text: "docs".into(),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    assert_eq!(text_of(&mut c).unwrap().test_ids, []);
    js_events(&mut c);
    let prepares = c.text_engine.prepares.get();
    let layouts = c.text_engine.layouts.get();
    let measures = c.text_engine.measures.get();
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 4,
            prop: Prop::TestId(Some("docs".into())),
        }],
    );
    assert_eq!(
        text_of(&mut c).unwrap().test_ids,
        [crate::SpanTestId {
            start: 4,
            end: 8,
            test_id: "docs".into(),
        }]
    );
    assert_eq!(
        c.text_engine.layouts.get(),
        layouts,
        "test IDs are metadata, not glyphs"
    );
    assert_eq!(c.text_engine.prepares.get(), prepares);
    assert_eq!(c.text_engine.measures.get(), measures);
    assert!(js_events(&mut c).is_empty(), "no onTextLayout for test IDs");
    for id in [Some("renamed"), None] {
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 4,
                prop: Prop::TestId(id.map(Into::into)),
            }],
        );
        let text = text_of(&mut c).unwrap();
        assert_eq!(text.test_ids.first().map(|s| s.test_id.as_ref()), id);
        assert_eq!(c.text_engine.layouts.get(), layouts);
        assert_eq!(c.text_engine.prepares.get(), prepares);
        assert_eq!(c.text_engine.measures.get(), measures);
        assert!(js_events(&mut c).is_empty());
    }
    // A simultaneous content change still rebuilds the native text.
    apply(
        &mut c,
        vec![
            Op::SetText {
                id: 5,
                text: "updated docs".into(),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::TestId(Some("updated".into())),
            },
        ],
    );
    let text = text_of(&mut c).unwrap();
    assert_eq!(text.text, "see updated docs");
    assert_eq!(text.test_ids[0].test_id.as_ref(), "updated");
    assert!(c.text_engine.layouts.get() > layouts);
    assert!(
        js_events(&mut c)
            .iter()
            .any(|e| e.1 == EventKind::TextLayout)
    );
}

#[test]
fn text_update_emits_only_text_and_frames() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 3,
                text: "a".into(),
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit().unwrap();
    c.apply(Op::SetText {
        id: 3,
        text: "abc".into(),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(matches!(&batch.items[0], MountItem::Text { id: 2, text, .. } if text.text == "abc"));
    // Text blocks stretch to the column width, so only the content changes.
    assert_eq!(batch.items.len(), 1);
}

#[test]
fn text_out_of_the_layout_shows_no_glyphs() {
    // `display: none` leaves a text no box, and a platform that does not
    // clip text to its box (a browser) would draw what was laid out in it:
    // a checkbox's hidden check over its shown dash.
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 5,
                text: "✓".into(),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            class_op(4, "hidden"),
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    // The text and how many of its characters are laid out.
    let text_of = |batch: &MountBatch| {
        batch.items.iter().find_map(|i| match i {
            MountItem::Text {
                id: 4,
                text,
                layout,
                ..
            } => Some((
                text.text.clone(),
                layout.downcast::<FakeLayout>().unwrap().chars,
            )),
            _ => None,
        })
    };
    // The text stays what it is (tests and screen readers read it); none of
    // it is laid out.
    let hidden = Some(("✓".to_owned(), 0));
    let shown = Some(("✓".to_owned(), 1));
    assert_eq!(text_of(&c.commit().unwrap()), hidden);
    let mut toggle = |id, classes, expected: &Option<(String, usize)>| {
        c.apply(class_op(id, classes)).unwrap();
        assert_eq!(&text_of(&c.commit().unwrap()), expected, "{id}: {classes}");
    };
    toggle(4, "flex", &shown);
    // Hidden by its own class, then by its parent's.
    toggle(4, "hidden", &hidden);
    toggle(4, "flex", &shown);
    toggle(2, "hidden", &hidden);
    toggle(2, "flex", &shown);
    // New text while hidden: sent, still laid out empty.
    apply(
        &mut c,
        vec![
            class_op(2, "hidden"),
            Op::SetText {
                id: 5,
                text: "–".into(),
            },
        ],
    );
    assert_eq!(text_of(&c.commit().unwrap()), Some(("–".to_owned(), 0)));
}

#[test]
fn flex_text_in_a_row_shrinks_and_wraps() {
    // Yoga has no automatic minimum size: `flex: 1` text takes the space
    // left in the row and wraps, however long its natural width.
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            style_op(2, &[("flexDirection", StyleValue::Str("row"))]),
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            style_op(
                3,
                &[
                    ("width", StyleValue::Number(120.0)),
                    ("height", StyleValue::Number(10.0)),
                ],
            ),
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            style_op(4, &[("flex", StyleValue::Number(1.0))]),
            Op::CreateText {
                id: 5,
                text: "x".repeat(50),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // 400pt of text in 200pt: two lines.
    assert_eq!(frame_of(&batch, 4), Some(rect(120.0, 0.0, 200.0, 32.0)));
}

#[test]
fn nested_spans_merge_with_styles() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 3,
                text: "Count: ".into(),
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            style_op(4, &[("fontWeight", StyleValue::Str("bold"))]),
            Op::CreateText {
                id: 5,
                text: "1".into(),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let text = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text.text, "Count: 1");
    assert_eq!(text.spans.len(), 2);
    assert_eq!(text.spans[1].style.font_weight, 700);
    // The span has no native view.
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Create { id: 4, .. }))
    );
}

/// The attributed text of the first `Text` item in `batch`.
fn text_item(batch: &MountBatch) -> Option<Arc<AttributedText>> {
    batch.items.iter().find_map(|i| match i {
        MountItem::Text { text, .. } => Some(text.clone()),
        _ => None,
    })
}

#[test]
fn span_backgrounds_style_their_characters() {
    // <Text>a <Text bg r=4>b<Text bold>c</Text></Text> d</Text>
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            style_op(2, &[("backgroundColor", StyleValue::Str("#00ff00"))]),
            Op::CreateText {
                id: 3,
                text: "a ".into(),
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            style_op(
                4,
                &[
                    ("backgroundColor", StyleValue::Str("#ff0000")),
                    ("borderRadius", StyleValue::Number(4.0)),
                ],
            ),
            Op::CreateText {
                id: 5,
                text: "b".into(),
            },
            Op::Create {
                id: 6,
                tag: Tag::Text,
            },
            style_op(6, &[("fontWeight", StyleValue::Str("bold"))]),
            Op::CreateText {
                id: 7,
                text: "c".into(),
            },
            Op::CreateText {
                id: 8,
                text: " d".into(),
            },
            Op::Insert {
                parent: 6,
                child: 7,
                before: None,
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Insert {
                parent: 4,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 8,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let text = text_item(&batch).unwrap();
    assert_eq!(text.text, "a bc d");
    let backgrounds: Vec<_> = text.spans.iter().map(|s| s.style.background).collect();
    let red = Some(crate::text::TextBackground {
        color: Color(0xff00_00ff),
        radius: Points(4.0),
        node: 4,
    });
    // The block's own background is its view's; the bold span inside the
    // red one keeps the red one's.
    assert_eq!(backgrounds, [None, red, red, None]);
    assert!(text.has_backgrounds());
    // The view draws the block's background.
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0x00ff_00ff)
    );

    // A new color draws again without measuring again.
    apply(
        &mut c,
        vec![style_op(
            4,
            &[("backgroundColor", StyleValue::Str("#0000ff"))],
        )],
    );
    let batch = c.commit().unwrap();
    let text = text_item(&batch).unwrap();
    assert_eq!(
        text.spans[1].style.background.map(|b| (b.color, b.radius)),
        Some((Color(0x0000_ffff), Points(0.0)))
    );
    assert!(frame_of(&batch, 2).is_none());

    // Transparent is none.
    apply(
        &mut c,
        vec![style_op(
            4,
            &[("backgroundColor", StyleValue::Str("transparent"))],
        )],
    );
    let text = text_item(&c.commit().unwrap()).unwrap();
    assert!(!text.has_backgrounds());
}

#[test]
fn background_boxes_join_pieces_of_one_span() {
    let mut t = AttributedText::default();
    let plain = ResolvedTextStyle::default();
    let bg = |node| crate::text::TextBackground {
        color: Color(0xff00_00ff),
        radius: Points(3.0),
        node,
    };
    let code = ResolvedTextStyle {
        background: Some(bg(4)),
        ..plain
    };
    let bold = ResolvedTextStyle {
        font_weight: 700,
        ..code
    };
    // "a " "bc" (one background, two runs) "d" " e" (a span of its own,
    // looking the same) " "
    t.push("a ", plain);
    t.push("b", code);
    t.push("c", bold);
    t.push(
        "d",
        ResolvedTextStyle {
            background: Some(bg(6)),
            ..plain
        },
    );
    t.push(" e ", plain);
    let piece = |i: u32, ascent: f32| crate::text::LinePiece {
        x: Points(i as f32 * 10.0),
        width: Points(10.0),
        background: t.background_at(i),
        ascent: Points(ascent),
        descent: Points(2.0),
    };
    let pieces = (0..7).map(|i| piece(i, if i == 3 { 12.0 } else { 10.0 }));
    let mut boxes = Vec::new();
    crate::text::BackgroundBox::join(pieces, (Points(0.0), Points(70.0)), |b| boxes.push(b));
    assert_eq!(boxes.len(), 2);
    assert_eq!((boxes[0].x.0, boxes[0].width.0), (20.0, 20.0));
    assert_eq!((boxes[0].ascent.0, boxes[0].descent.0), (12.0, 2.0));
    assert_eq!(boxes[0].background.node, 4);
    assert_eq!((boxes[1].x.0, boxes[1].width.0), (40.0, 10.0));
    assert_eq!(boxes[1].background.node, 6);
    // At most half its height.
    assert_eq!(boxes[0].radius(), Points(3.0));
    assert_eq!(
        crate::text::BackgroundBox {
            ascent: Points(2.0),
            descent: Points(1.0),
            ..boxes[0]
        }
        .radius(),
        Points(1.5)
    );
    // Cut to the line.
    let mut boxes = Vec::new();
    crate::text::BackgroundBox::join(
        (0..7).map(|i| piece(i, 10.0)),
        (Points(0.0), Points(25.0)),
        |b| boxes.push(b),
    );
    assert_eq!(boxes.len(), 1);
    assert_eq!((boxes[0].x.0, boxes[0].width.0), (20.0, 5.0));
}

#[test]
fn placeholder_text_outside_text_is_ignored() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::CreateText {
                id: 3,
                text: String::new(),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 3,
                before: Some(2),
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 4,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let inserts: Vec<_> = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert { child, before, .. } => Some((*child, *before)),
            _ => None,
        })
        .collect();
    assert_eq!(inserts, vec![(2, None), (4, None)]);
}

#[test]
fn remove_reinsert_and_release() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 3,
                before: None,
            },
        ],
    );
    c.commit().unwrap();

    // Move 3 before 2: a single insert, no remove.
    c.apply(Op::Insert {
        parent: ROOT_ID,
        child: 3,
        before: Some(2),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(matches!(
        batch.items[0],
        MountItem::Insert {
            child: 3,
            before: Some(2),
            ..
        }
    ));
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { .. }))
    );

    c.apply(Op::Remove {
        parent: ROOT_ID,
        child: 2,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(matches!(batch.items[0], MountItem::Remove { id: 2 }));

    // Reinserting a detached, already-created view does not recreate it.
    c.apply(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Create { .. }))
    );

    c.apply(Op::Release { id: 2 }).unwrap();
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Delete { id: 2 }))
    );
    assert_eq!(c.node_count(), 2);
    assert_eq!(
        c.apply(Op::SetText {
            id: 2,
            text: String::new()
        }),
        Err(ApplyError::UnknownNode(2))
    );
}

#[test]
fn events_and_errors() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::Listen {
                id: 2,
                event: EventKind::Press,
                enabled: true,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::Events { id: 2, events } if events.contains(EventKind::Press))
    ));
    assert_eq!(
        c.apply(Op::Create {
            id: 2,
            tag: Tag::View
        }),
        Err(ApplyError::DuplicateNode(2))
    );
    assert_eq!(
        c.apply(Op::Insert {
            parent: 2,
            child: ROOT_ID,
            before: None
        }),
        Err(ApplyError::Cycle(1))
    );
}

#[test]
fn color_change_skips_layout_and_identical_texts_share_measurements() {
    let mut c = core();
    let mut ops = Vec::new();
    for i in 0..3u32 {
        let (block, raw) = (10 + i * 2, 11 + i * 2);
        ops.extend([
            Op::Create {
                id: block,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: raw,
                text: "same".into(),
            },
            Op::Insert {
                parent: block,
                child: raw,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: block,
                before: None,
            },
        ]);
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    // Three identical texts: measured once per distinct constraint.
    let first_measures = c.text_engine.measures.get();
    assert!(first_measures <= 2, "measured {first_measures} times");
    assert_eq!(c.text_engine.layouts.get(), 3);
    let content = batch.items.iter().find_map(|i| match i {
        MountItem::Text {
            id: 10, content, ..
        } => Some(*content),
        _ => None,
    });
    assert_eq!(content, Some(rect(0.0, 0.0, 320.0, 16.0)));

    c.apply(style_op(10, &[("color", StyleValue::Str("red"))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(
        batch.items.len(),
        1,
        "only the new text layout: {:?}",
        batch.items
    );
    assert!(matches!(&batch.items[0], MountItem::Text { id: 10, .. }));
    assert_eq!(
        c.text_engine.measures.get(),
        first_measures,
        "no re-measure"
    );
    assert_eq!(c.text_engine.layouts.get(), 4);
}

#[test]
fn image_uses_natural_size_and_aspect_ratio() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Image,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Source(Some(ImageSource {
                    uri: "asset:/logo.png".into(),
                    size: Some(size_pt(200.0, 100.0)),
                    scales: ImageScales::NONE,
                    data: None,
                })),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::Create {
                id: 3,
                tag: Tag::Image,
            },
            style_op(
                3,
                &[
                    ("width", StyleValue::Number(50.0)),
                    ("alignSelf", StyleValue::Str("flex-start")),
                ],
            ),
            Op::SetProp {
                id: 3,
                prop: Prop::Source(Some(ImageSource {
                    uri: "asset:/logo.png".into(),
                    size: Some(size_pt(200.0, 100.0)),
                    scales: ImageScales::NONE,
                    data: None,
                })),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Create {
            id: 2,
            kind: ViewKind::Image
        }
    )));
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Image {
            id: 2,
            source: Some(_),
            ..
        }
    )));
    // Stretched to the column width, height from the aspect ratio.
    assert_eq!(
        frame_of(&batch, 2).map(|f| (f.size.width.0, f.size.height.0)),
        Some((320.0, 160.0))
    );
    assert_eq!(
        frame_of(&batch, 3).map(|f| (f.size.width.0, f.size.height.0)),
        Some((50.0, 25.0))
    );
}

#[test]
fn object_position_reaches_the_image_item_only() {
    let mut c = core();
    let mut ops = image_ops(2, asset("asset:/a.png", &[]), None);
    ops.push(style_op(2, &[("objectPosition", StyleValue::Str("top"))]));
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let position = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Image { id: 2, options, .. } => Some(options.position),
            _ => None,
        })
    };
    let top = crate::style::ObjectPosition::parse("top").unwrap();
    assert_eq!(position(&batch), Some(top));
    // A change sends the image again, and no view style.
    apply(
        &mut c,
        vec![style_op(
            2,
            &[("objectPosition", StyleValue::Str("right 10px bottom 0"))],
        )],
    );
    let batch = c.commit().unwrap();
    assert_eq!(
        position(&batch),
        crate::style::ObjectPosition::parse("right 10px bottom 0")
    );
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::ViewStyle { .. })),
        "{:?}",
        batch.items
    );
    // An invalid value is rejected, not misread.
    let mut style = crate::Style::default();
    assert!(
        style
            .set("objectPosition", StyleValue::Str("left 10px top"))
            .is_err()
    );
}

#[test]
fn resize_modes_fit_at_their_position() {
    use crate::{ResizeMode, geometry::size_pt, style::ObjectPosition};
    let tall = size_pt(100.0, 300.0);
    let square = size_pt(100.0, 100.0);
    let at = |mode: ResizeMode, p: &str| {
        let b = mode.fit(tall, square, ObjectPosition::parse(p).unwrap());
        (b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0)
    };
    assert_eq!(at(ResizeMode::Cover, "center"), (0.0, -100.0, 100.0, 300.0));
    assert_eq!(at(ResizeMode::Cover, "top"), (0.0, 0.0, 100.0, 300.0));
    assert_eq!(at(ResizeMode::Cover, "bottom"), (0.0, -200.0, 100.0, 300.0));
    let half = |p: &str| {
        let b = ResizeMode::Contain.fit(
            size_pt(50.0, 100.0),
            square,
            ObjectPosition::parse(p).unwrap(),
        );
        (b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0)
    };
    assert_eq!(half("left"), (0.0, 0.0, 50.0, 100.0));
    assert_eq!(half("right"), (50.0, 0.0, 50.0, 100.0));
    assert_eq!(half("25%"), (12.5, 0.0, 50.0, 100.0));
    assert_eq!(
        at(ResizeMode::Stretch, "left top"),
        (0.0, 0.0, 100.0, 100.0)
    );
    // CSS's `object-fit: none` keeps the natural size, cropped where
    // larger; `scale-down` shrinks what does not fit. Both keep the
    // natural size of what fits, at the position.
    assert_eq!(
        at(ResizeMode::Center, "center"),
        (0.0, -100.0, 100.0, 300.0)
    );
    assert_eq!(at(ResizeMode::Center, "top"), (0.0, 0.0, 100.0, 300.0));
    let shrunk = ResizeMode::ScaleDown.fit(size_pt(200.0, 400.0), square, ObjectPosition::CENTER);
    assert_eq!(
        (
            shrunk.origin.x.0,
            shrunk.origin.y.0,
            shrunk.size.width.0,
            shrunk.size.height.0
        ),
        (25.0, 0.0, 50.0, 100.0)
    );
    for mode in [ResizeMode::Center, ResizeMode::ScaleDown] {
        let small = mode.fit(size_pt(20.0, 10.0), square, ObjectPosition::CENTER);
        assert_eq!(
            (small.origin.x.0, small.origin.y.0, small.size.width.0),
            (40.0, 45.0, 20.0)
        );
        let corner = mode.fit(
            size_pt(20.0, 10.0),
            square,
            ObjectPosition::parse("right bottom").unwrap(),
        );
        assert_eq!((corner.origin.x.0, corner.origin.y.0), (80.0, 90.0));
    }
}

#[test]
fn native_components_get_their_name_props_and_size() {
    let mut c = core();
    let prop = |name: &str, value: Option<crate::JsonValue>| Op::SetProp {
        id: 2,
        prop: Prop::ComponentProp(name.into(), value),
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Native,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Component("com.example.map".into()),
            },
            prop("zoom", Some(serde_json::json!(3))),
            prop("center", Some(serde_json::json!({ "lat": 1.5, "lng": 2 }))),
            style_op(2, &[("alignSelf", StyleValue::Str("flex-start"))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let at = |pred: &dyn Fn(&MountItem) -> bool| batch.items.iter().position(pred);
    let create = at(&|i| {
        matches!(
            i,
            MountItem::Create {
                id: 2,
                kind: ViewKind::Native
            }
        )
    })
    .unwrap();
    let component =
        at(&|i| matches!(i, MountItem::Component { id: 2, name } if &**name == "com.example.map"))
            .unwrap();
    let props = batch
        .items
        .iter()
        .position(|i| matches!(i, MountItem::ComponentProps { id: 2, .. }))
        .unwrap();
    assert!(create < component && component < props);
    let MountItem::ComponentProps { props: all, .. } = &batch.items[props] else {
        unreachable!()
    };
    assert_eq!(all.len(), 2);
    assert!(all.contains(&(
        "center".into(),
        Some(serde_json::json!({ "lat": 1.5, "lng": 2 }))
    )));
    // No size of its own yet.
    assert_eq!(
        frame_of(&batch, 2).map(|f| (f.size.width.0, f.size.height.0)),
        Some((0.0, 0.0))
    );

    // Only what changed; removals as `None`.
    apply(
        &mut c,
        vec![
            prop("zoom", Some(serde_json::json!(4))),
            prop("center", None),
        ],
    );
    let batch = c.commit().unwrap();
    let changed: Vec<_> = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ComponentProps { id: 2, props } => Some(props.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        changed,
        [vec![
            ("zoom".into(), Some(serde_json::json!(4))),
            ("center".into(), None)
        ]]
    );

    // The size it reports lays it out.
    c.set_component_size(2, size_pt(120.0, 40.0));
    let batch = c.commit().unwrap();
    assert_eq!(
        frame_of(&batch, 2).map(|f| (f.size.width.0, f.size.height.0)),
        Some((120.0, 40.0))
    );
}

#[test]
fn scroll_reports_content_size() {
    let mut c = core();
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        style_op(2, &[("height", StyleValue::Number(200.0))]),
        Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        },
    ];
    for i in 0..5u32 {
        ops.push(Op::Create {
            id: 10 + i,
            tag: Tag::View,
        });
        ops.push(style_op(10 + i, &[("height", StyleValue::Number(100.0))]));
        ops.push(Op::Insert {
            parent: 2,
            child: 10 + i,
            before: None,
        });
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let content = batch.items.iter().find_map(|i| match i {
        MountItem::ScrollContent { id: 2, size } => Some(*size),
        _ => None,
    });
    assert_eq!(content, Some(size_pt(320.0, 500.0)));
    // Children are not shrunk to the scroll view's height.
    assert_eq!(
        frame_of(&batch, 14).map(|f| (f.origin.y.0, f.size.height.0)),
        Some((400.0, 100.0))
    );
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::ScrollConfig {
            id: 2,
            horizontal: false,
            ..
        }
    )));
}

/// `overflow: "hidden"` clips in layout as well as in paint: what a box
/// clips away must not grow an ancestor scroll view's content size. A
/// preview laid out at its design width and scaled down by a transform
/// (transforms do not affect layout) otherwise leaves a vertical scroll
/// view scrollable sideways.
#[test]
fn clipped_overflow_does_not_grow_scroll_content() {
    /// The content width of a 320pt-wide vertical scroll view holding a
    /// 300pt box, itself holding a 400pt-wide absolute child.
    fn content_width(clips: bool) -> f32 {
        let mut c = core();
        let mut boxed = vec![
            ("width", StyleValue::Number(300.0)),
            ("height", StyleValue::Number(100.0)),
        ];
        if clips {
            boxed.push(("overflow", StyleValue::Str("hidden")));
        }
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::Scroll,
                },
                style_op(2, &[("height", StyleValue::Number(200.0))]),
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                Op::Create {
                    id: 3,
                    tag: Tag::View,
                },
                style_op(3, &boxed),
                Op::Insert {
                    parent: 2,
                    child: 3,
                    before: None,
                },
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                style_op(
                    4,
                    &[
                        ("position", StyleValue::Str("absolute")),
                        ("left", StyleValue::Number(0.0)),
                        ("top", StyleValue::Number(0.0)),
                        ("width", StyleValue::Number(400.0)),
                        ("height", StyleValue::Number(50.0)),
                    ],
                ),
                Op::Insert {
                    parent: 3,
                    child: 4,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ScrollContent { id: 2, size } => Some(size.width.0),
                _ => None,
            })
            .expect("scroll content size")
    }
    // Visible: the 400pt child reaches the scroll view, which scrolls to it.
    assert_eq!(content_width(false), 400.0);
    // Clipped: the scroll view keeps its own width, so it does not scroll
    // sideways at all.
    assert_eq!(content_width(true), 320.0);
}

/// A scroll view's content size set twice in one batch (a row relaid in
/// two passes) reaches the platform once, with the last size: a transient
/// smaller size would clamp the offset before the content grows back.
#[test]
fn scroll_content_is_sent_once_per_batch() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Scroll,
            },
            style_op(2, &[("height", StyleValue::Number(200.0))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    let key = c.key(2).unwrap();
    c.set_scroll_content(key, size_pt(320.0, 277.0));
    c.set_scroll_content(key, size_pt(320.0, 909.0));
    let sizes: Vec<_> = c
        .mount
        .iter()
        .filter_map(|i| match i {
            MountItem::ScrollContent { id: 2, size } => Some(size.height.0),
            _ => None,
        })
        .collect();
    assert_eq!(sizes, [909.0]);
    // The next batch sends its own.
    c.mount.clear();
    c.batches += 1;
    c.set_scroll_content(key, size_pt(320.0, 300.0));
    assert!(matches!(
        c.mount[..],
        [MountItem::ScrollContent { id: 2, .. }]
    ));
}

/// A native consumer with no focused view: apply each batch's immediate
/// detach requests before answering them, then collect the resulting tree
/// changes. Focused-native interleavings belong to the platform tests.
fn commit_with_native_retirement(c: &mut Core<FakeEngine>) -> Option<MountBatch> {
    let mut batch = c.commit()?;
    let mut consumed = 0;
    loop {
        let mut retired = false;
        for item in &batch.items[consumed..] {
            if let MountItem::RetireListCell { id, request, .. } = *item {
                c.retire_list_cell(id, request, true);
                retired = true;
            }
        }
        if !retired {
            break;
        }
        consumed = batch.items.len();
        let Some(mut next) = c.commit() else { break };
        batch.items.append(&mut next.items);
    }
    Some(batch)
}

/// Plays JS: creates a cell per new slot, renders a fixed-height
/// row for each bind and confirms the index; the overscan too, as an
/// engine with time to spare does.
fn render_binds(
    c: &mut Core<FakeEngine>,
    next_id: &mut u32,
    cells: &mut Vec<u32>,
    row_height: f32,
) -> usize {
    render_list_binds(c, next_id, cells, row_height, usize::MAX)
}

/// [`render_binds`] with at most `paced` of the overscan's waiting binds,
/// as an engine short of time.
fn render_list_binds(
    c: &mut Core<FakeEngine>,
    next_id: &mut u32,
    cells: &mut Vec<u32>,
    row_height: f32,
    paced: usize,
) -> usize {
    let mut binds = Vec::new();
    c.take_list_binds(&mut binds);
    c.take_paced_list_binds(paced, &mut binds);
    let mut count = 0;
    for bind in binds {
        for (slot, index) in bind.binds {
            if !c.current_list_bind(bind.list, slot, index) {
                continue;
            }
            count += 1;
            while cells.len() <= slot as usize {
                let id = *next_id;
                *next_id += 1;
                apply(
                    c,
                    vec![
                        Op::Create { id, tag: Tag::Cell },
                        Op::SetProp {
                            id,
                            prop: Prop::Slot(CellSlot::Item(cells.len() as u32)),
                        },
                        Op::Insert {
                            parent: bind.list,
                            child: id,
                            before: None,
                        },
                    ],
                );
                cells.push(id);
            }
            // New content for the item, then the confirmation, as the
            // runtime does.
            let cell = cells[slot as usize];
            c.apply(style_op(
                cell,
                &[("height", StyleValue::Number(row_height))],
            ))
            .unwrap();
            c.apply(Op::SetProp {
                id: cell,
                prop: Prop::CellIndex(index),
            })
            .unwrap();
        }
    }
    count
}

#[test]
fn list_renders_window_and_recycles_cells() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(1000),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    commit_with_native_retirement(&mut c);
    let (mut next_id, mut cells) = (100, Vec::new());
    // Estimated 50 pt rows: viewport + one screen of overscan = 17 rows.
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 100.0), 17);
    let batch = commit_with_native_retirement(&mut c).unwrap();
    // Rows are really 100 pt: positioned by measured sizes.
    assert_eq!(
        frame_of(&batch, cells[3]),
        Some(rect(0.0, 300.0, 320.0, 100.0))
    );
    let content = batch.items.iter().rev().find_map(|i| match i {
        MountItem::ScrollContent { id: 2, size } => Some(size.height.0),
        _ => None,
    });
    assert_eq!(content, Some(17.0 * 100.0 + 983.0 * 50.0));

    // The new window needs 25 rows while native may still target the old
    // nine measured rows. The eight detached overscan cells can be reused;
    // the nine native owners wait for their detach confirmations.
    c.set_scroll_offset(2, point(px(0.0), px(10_000.0)), u32::MAX);
    commit_with_native_retirement(&mut c);
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 25);
    assert_eq!(cells.len(), 34);
    commit_with_native_retirement(&mut c);
    // Two disjoint 25-row windows fill the overlap working set. Once
    // native consumes each batch, later jumps reuse those same owners.
    c.set_scroll_offset(2, point(px(0.0), px(20_000.0)), u32::MAX);
    commit_with_native_retirement(&mut c);
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 25);
    assert_eq!(cells.len(), 50);
    commit_with_native_retirement(&mut c);
    for y in [30_000.0, 40_000.0, 20_000.0, 10_000.0, 30_000.0] {
        c.set_scroll_offset(2, point(px(0.0), px(y)), u32::MAX);
        commit_with_native_retirement(&mut c);
        assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 25);
        assert_eq!(cells.len(), 50);
        commit_with_native_retirement(&mut c);
    }
    assert_eq!(c.node_count(), 2 + cells.len());
}

#[test]
fn list_keeps_visible_content_anchored() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(100),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    // Jump into the middle before anything above was measured.
    c.set_scroll_offset(2, point(px(0.0), px(2000.0)), u32::MAX);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    c.commit();
    // Scroll back up so rows above the old position get rendered at 80 pt.
    c.set_scroll_offset(2, point(px(0.0), px(1200.0)), u32::MAX);
    c.commit();
    render_binds(&mut c, &mut next_id, &mut cells, 80.0);
    let batch = c.commit().unwrap();
    let shift: f32 = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ScrollBy { id: 2, dy, .. } => Some(dy.0),
            _ => None,
        })
        .sum();
    assert!(
        shift > 0.0,
        "rows above the viewport grew; content must be shifted down"
    );

    // One message can itself be larger than the viewport. Its item top
    // remains zero while earlier source fragments arrive inside that item.
    source_reading_survives_prepend_and_rich_replacement(false);
}

/// Whether `batch` last hid view `id` from sight (`visibility: hidden`)
/// and from screen readers, if it sent either.
fn hidden_in(batch: &MountBatch, id: NodeId) -> (Option<bool>, Option<bool>) {
    let style = batch.items.iter().rev().find_map(|i| match i {
        MountItem::ViewStyle { id: i, style } if *i == id => Some(style.hidden),
        _ => None,
    });
    let props = batch.items.iter().rev().find_map(|i| match i {
        MountItem::ViewProps { id: i, props } if *i == id => Some(props.accessibility.hidden),
        _ => None,
    });
    (style, props)
}

/// A list of 1000 rows estimated at 50 pt in a 400 pt viewport.
fn thousand_rows(c: &mut Core<FakeEngine>) {
    apply(
        c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(1000),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
}

#[test]
fn spare_list_cells_are_hidden_until_placed_again() {
    let mut c = core();
    thousand_rows(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 17);
    let batch = c.commit().unwrap();
    for &cell in &cells {
        assert_eq!(
            hidden_in(&batch, cell),
            (None, None),
            "cell {cell} shows its row"
        );
    }

    // The data shrinks: the cells left without a row still show their
    // last one, so they are hidden as well as moved out of sight.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(3),
        }],
    );
    // A deleted row stays quarantined until native confirms its detach.
    let batch = commit_with_native_retirement(&mut c).unwrap();
    for &cell in &cells[..3] {
        assert_eq!(
            hidden_in(&batch, cell),
            (None, None),
            "cell {cell} keeps its row"
        );
    }
    for (row, &cell) in cells.iter().enumerate().skip(3) {
        assert_eq!(
            hidden_in(&batch, cell),
            (Some(true), Some(true)),
            "spare cell {cell}"
        );
        // Those in the render window (to 800 pt) move out of sight too.
        let moved = (row < 16).then_some(-1.0e6);
        assert_eq!(
            frame_of(&batch, cell).map(|f| f.origin.y.0),
            moved,
            "spare cell {cell}"
        );
    }

    // It grows again: the cells come back with their new rows.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(1000),
        }],
    );
    c.commit();
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 14);
    let batch = c.commit().unwrap();
    let mut rows: Vec<f32> = cells[3..]
        .iter()
        .map(|&cell| {
            assert_eq!(
                hidden_in(&batch, cell),
                (Some(false), Some(false)),
                "cell {cell}"
            );
            frame_of(&batch, cell).expect("placed").origin.y.0
        })
        .collect();
    rows.sort_by(f32::total_cmp);
    assert_eq!(
        rows,
        (3..17).map(|row| 50.0 * row as f32).collect::<Vec<_>>()
    );

    // Far down, the window needs 25 rows. Native ownership can grow
    // the pool before detach acknowledgements arrive; back at the top,
    // cells not needed for its 17 rows keep their old offscreen frames.
    c.set_scroll_offset(2, point(px(0.0), px(10_000.0)), u32::MAX);
    commit_with_native_retirement(&mut c);
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 25);
    commit_with_native_retirement(&mut c);
    c.set_scroll_offset(2, point(px(0.0), px(0.0)), u32::MAX);
    let pending = commit_with_native_retirement(&mut c);
    // The detached old top rows can be reused only after binding. Unlike
    // upstream's smaller pool, they still overlap this returning window,
    // so they must be hidden and moved away before their new content lands.
    let mut hidden = Vec::new();
    if let Some(batch) = &pending {
        for item in &batch.items {
            match item {
                MountItem::RetireListCell { .. } | MountItem::ListCellRetired { .. } => {}
                MountItem::ViewStyle { id, style } => {
                    assert!(cells[..17].contains(id) && style.hidden);
                    hidden.push(*id);
                }
                MountItem::ViewProps { id, props } => {
                    assert!(cells[..17].contains(id) && props.accessibility.hidden);
                }
                MountItem::Frame { id, frame, .. } => {
                    assert!(cells[..17].contains(id));
                    assert_eq!(frame.origin.y.0, -1.0e6);
                }
                other => panic!("unexpected update before binding: {other:?}"),
            }
        }
        for &cell in &hidden {
            assert_eq!(hidden_in(batch, cell), (Some(true), Some(true)));
            assert_eq!(frame_of(batch, cell).unwrap().origin.y.0, -1.0e6);
        }
    }
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 17);
    let placed = c.commit().unwrap();
    let mut spare = Vec::new();
    for &cell in &cells {
        let shown = hidden.contains(&cell).then_some(false);
        assert_eq!(hidden_in(&placed, cell), (shown, shown), "cell {cell}");
        match frame_of(&placed, cell) {
            Some(frame) => assert!(frame.origin.y.0 <= 800.0, "cell {cell} at {frame:?}"),
            None => spare.push(cell),
        }
    }
    assert_eq!(spare.len(), cells.len() - 17);
    // Once the items change, the rows they show may be gone: hidden.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(999),
        }],
    );
    let batch = c.commit().unwrap();
    for &cell in &cells {
        let hidden = if spare.contains(&cell) {
            Some(true)
        } else {
            None
        };
        assert_eq!(hidden_in(&batch, cell), (hidden, hidden), "cell {cell}");
        assert_eq!(frame_of(&batch, cell), None, "cell {cell}");
    }
}

#[test]
fn scrolling_on_hides_no_cells() {
    let mut c = core();
    thousand_rows(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    // 70 pt rows estimated at 50: the cells made for the rows that do
    // not fit after all are hidden.
    let mut hidden = Vec::new();
    for _ in 0..2 {
        render_binds(&mut c, &mut next_id, &mut cells, 70.0);
        let Some(batch) = c.commit() else { continue };
        for &cell in &cells {
            match hidden_in(&batch, cell).0 {
                Some(true) => hidden.push(cell),
                Some(false) => hidden.retain(|&h| h != cell),
                None => {}
            }
        }
    }
    assert!(!hidden.is_empty());
    // Then the window loses a row at one end before it gains one at the
    // other (1200 pt is no multiple of 70), which takes the cell left
    // behind: no cell is hidden, those hidden are shown once reused.
    let mut at = 0.0;
    while at < 3000.0 {
        at += 10.0;
        c.set_scroll_offset(2, point(px(0.0), px(at)), u32::MAX);
        let mut batches: Vec<MountBatch> = c.commit().into_iter().collect();
        render_binds(&mut c, &mut next_id, &mut cells, 70.0);
        batches.extend(c.commit());
        for batch in &batches {
            for &cell in &cells {
                match hidden_in(batch, cell).0 {
                    None => {}
                    Some(false) if hidden.contains(&cell) => hidden.retain(|&h| h != cell),
                    other => panic!("cell {cell} at {at}: {other:?}"),
                }
            }
        }
    }
    assert!(hidden.is_empty(), "{hidden:?}");
}

#[test]
fn list_cells_unbound_before_they_are_placed_are_hidden() {
    let mut c = core();
    thousand_rows(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 17);
    // The data shrinks before the new cells were placed: those without a
    // row show the content made for it, with no frame to move them away.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(3),
        }],
    );
    let batch = c.commit().unwrap();
    for (row, &cell) in cells.iter().enumerate() {
        if row < 3 {
            assert_eq!(hidden_in(&batch, cell), (None, None), "cell {cell}");
            assert!(frame_of(&batch, cell).is_some());
        } else {
            assert_eq!(
                hidden_in(&batch, cell),
                (Some(true), Some(true)),
                "cell {cell}"
            );
            assert_eq!(frame_of(&batch, cell), None, "cell {cell} was never placed");
        }
    }
}

#[test]
fn spare_list_cells_waiting_for_a_paced_bind_show_when_it_lands() {
    let mut c = core();
    thousand_rows(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 17);
    c.commit();
    // Shrunk to 3 rows, the other 14 cells are hidden; grown back, the
    // viewport's rows bind at once and the overscan's wait.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(3),
        }],
    );
    // A deleted row stays quarantined until native confirms its detach.
    commit_with_native_retirement(&mut c);
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Count(1000),
        }],
    );
    c.commit();
    assert_eq!(
        render_list_binds(&mut c, &mut next_id, &mut cells, 50.0, 0),
        5
    );
    assert!(c.has_paced_list_binds());
    let batch = c.commit().unwrap();
    let mut waiting = Vec::new();
    for &cell in &cells[3..] {
        match hidden_in(&batch, cell) {
            (Some(false), Some(false)) => {
                assert!(frame_of(&batch, cell).is_some(), "cell {cell}")
            }
            // Still hidden, out of sight, until its bind lands.
            (None, None) => {
                assert_eq!(frame_of(&batch, cell), None, "cell {cell}");
                waiting.push(cell);
            }
            other => panic!("cell {cell}: {other:?}"),
        }
    }
    assert_eq!(waiting.len(), 9);
    // The paced binds land: those cells show, at their rows.
    assert_eq!(render_binds(&mut c, &mut next_id, &mut cells, 50.0), 9);
    assert!(!c.has_paced_list_binds());
    let batch = c.commit().unwrap();
    let mut rows: Vec<f32> = waiting
        .iter()
        .map(|&cell| {
            assert_eq!(
                hidden_in(&batch, cell),
                (Some(false), Some(false)),
                "cell {cell}"
            );
            frame_of(&batch, cell).expect("placed").origin.y.0
        })
        .collect();
    rows.sort_by(f32::total_cmp);
    assert_eq!(
        rows,
        (8..17).map(|row| 50.0 * row as f32).collect::<Vec<_>>()
    );
}

#[test]
fn source_reading_survives_delayed_cell_acknowledgment() {
    source_reading_survives_prepend_and_rich_replacement(true);
}

#[test]
fn source_reading_waits_for_its_virtualized_row_without_capturing_another_document() {
    for finish in [
        "ready",
        "isolated",
        "following",
        "closed",
        "deleted",
        "wheel",
        "removed",
    ] {
        let mut c = core();
        let put_text = |c: &mut Core<FakeEngine>, id, parent, source: &str, offset, chars| {
            add(c, id, Tag::Text, parent, &[]);
            apply(
                c,
                vec![
                    Op::SetProp {
                        id,
                        prop: Prop::TextSource(Some(Arc::new(crate::TextSource::Literal {
                            id: source.into(),
                            offset,
                        }))),
                    },
                    Op::CreateText {
                        id: id + 1,
                        text: "R".repeat(chars),
                    },
                    Op::Insert {
                        parent: id,
                        child: id + 1,
                        before: None,
                    },
                ],
            );
        };
        let source_point = crate::text_source::SourcePoint {
            id: "session/message/body".into(),
            byte: 3360,
        };
        add(
            &mut c,
            2,
            Tag::List,
            ROOT_ID,
            &[("height", StyleValue::Number(416.0))],
        );
        c.apply(Op::SetProp {
            id: 2,
            prop: Prop::Count(1),
        })
        .unwrap();
        c.commit();
        add(&mut c, 100, Tag::Cell, 2, &[]);
        c.apply(Op::SetProp {
            id: 100,
            prop: Prop::Slot(CellSlot::Item(0)),
        })
        .unwrap();
        put_text(
            &mut c,
            10,
            100,
            "session/message/body",
            3320,
            if finish == "following" { 1160 } else { 2000 },
        );
        c.apply(Op::SetProp {
            id: 100,
            prop: Prop::CellIndex(0),
        })
        .unwrap();
        c.commit();
        // Forty bytes per shaped line: this user step puts byte 3360 at
        // the viewport top before the raw history fragment becomes rich.
        c.set_scroll_offset(2, point(px(0.0), px(16.0)), u32::MAX);
        c.commit();
        let owner = c.key(2).unwrap();
        assert_eq!(
            c.nodes[owner as usize]
                .list
                .as_ref()
                .unwrap()
                .reading_point(),
            Some(&source_point)
        );
        if finish == "following" {
            // Twenty-nine raw lines leave this established source reading
            // exactly 32pt from the end. Enabling append-follow must not
            // replace that intent, including before the rich tree exists.
            c.apply(Op::SetProp {
                id: 2,
                prop: Prop::FollowEnd(Some(px(32.0))),
            })
            .unwrap();
            c.commit();
            assert_eq!(
                c.nodes[owner as usize]
                    .list
                    .as_ref()
                    .unwrap()
                    .reading_point(),
                Some(&source_point)
            );
        }

        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: 100,
                    child: 10,
                },
                Op::Release { id: 11 },
                Op::Release { id: 10 },
            ],
        );
        // Another document has a visible line while the old document's
        // target row does not exist. It must not acquire the old reading pin.
        put_text(&mut c, 20, 100, "another/document", 0, 80);
        if finish == "isolated" {
            // An overlay is a separate native root, outside this cell's
            // layout. Its same-id provider stays behind the current source;
            // it must not mask the provider in the actual reading subtree.
            add(
                &mut c,
                30,
                Tag::Overlay,
                100,
                &[
                    ("width", StyleValue::Number(320.0)),
                    ("height", StyleValue::Number(416.0)),
                ],
            );
            add(&mut c, 34, Tag::List, 30, &[]);
            apply(
                &mut c,
                vec![
                    Op::SetProp {
                        id: 34,
                        prop: Prop::ListViewport(crate::ListViewport::Parent),
                    },
                    Op::SetProp {
                        id: 34,
                        prop: Prop::Count(20),
                    },
                    Op::SetProp {
                        id: 34,
                        prop: Prop::EstimatedItemSize(px(50.0)),
                    },
                    Op::SetProp {
                        id: 34,
                        prop: Prop::ListSourceRows(Some(Arc::new(crate::ListSourceRows {
                            id: "session/message/body".into(),
                            source_len: 16000,
                            projection_len: 3200,
                            rows: (0..20)
                                .map(|row| std::iter::once(row * 160..(row + 1) * 160).collect())
                                .collect::<Vec<_>>()
                                .into(),
                            ..Default::default()
                        }))),
                    },
                ],
            );
        }
        add(&mut c, 4, Tag::List, 100, &[]);
        apply(
            &mut c,
            vec![
                Op::SetProp {
                    id: 4,
                    prop: Prop::ListViewport(crate::ListViewport::Parent),
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::Count(20),
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::EstimatedItemSize(px(50.0)),
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::ListSourceRows(Some(Arc::new(crate::ListSourceRows {
                        id: "session/message/body".into(),
                        source_len: 16000,
                        projection_len: 3200,
                        rows: (0..20)
                            .map(|row| std::iter::once(row * 160..(row + 1) * 160).collect())
                            .collect::<Vec<_>>()
                            .into(),
                        ..Default::default()
                    }))),
                },
            ],
        );
        // Keep a viewport of source-free content after the provider. When
        // that provider leaves, the user's 16pt offset is still legal, so a
        // native content clamp cannot masquerade as source compensation.
        add(
            &mut c,
            40,
            Tag::View,
            100,
            &[("height", StyleValue::Number(416.0))],
        );
        c.commit();
        // The newest source is complete, but this native projection only
        // covers its first 3200 bytes. Byte 3360 is pending, not the EOF of
        // the short projection, and no row for it exists yet.
        let reader = c.nodes[owner as usize].list.as_ref().unwrap();
        assert_eq!(
            reader.reading_point(),
            Some(&source_point),
            "{finish}: a short projection closed the pending source point"
        );
        if finish != "following" {
            assert_eq!(reader.offset, 16.0);
        }
        assert_eq!(
            reader
                .source_geometry
                .first_visible(reader.offset, reader.offset + 416.0)
                .unwrap()
                .0
                .id
                .as_ref(),
            "another/document"
        );
        let replacement = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
        assert_eq!(
            replacement
                .slots
                .iter()
                .filter_map(|slot| slot.ready())
                .collect::<Vec<_>>(),
            Vec::<u32>::new()
        );
        // Only the ordinary viewport is wanted: neither an absent target
        // row 21 nor the prefix's last row 19 substitutes for this point.
        assert_eq!(bound_items(&c, 4), (0..=16).collect::<Vec<_>>());
        let mut prefix_binds = Vec::new();
        c.take_list_binds(&mut prefix_binds);
        c.take_paced_list_binds(usize::MAX, &mut prefix_binds);
        assert!(
            prefix_binds
                .iter()
                .any(|bind| bind.list == 4 && bind.binds.iter().any(|&(_, index)| index == 0))
        );
        assert!(
            !prefix_binds
                .iter()
                .any(|bind| bind.list == 4 && bind.binds.iter().any(|&(_, index)| index == 21))
        );

        // The same provider publishes the full projection. Its actual row
        // 21 must now be materialized through the ordinary binding path.
        apply(
            &mut c,
            vec![
                Op::SetProp {
                    id: 4,
                    prop: Prop::Count(100),
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::ListSourceRows(Some(Arc::new(crate::ListSourceRows {
                        id: "session/message/body".into(),
                        source_len: 16000,
                        projection_len: 16000,
                        rows: (0..100)
                            .map(|row| std::iter::once(row * 160..(row + 1) * 160).collect())
                            .collect::<Vec<_>>()
                            .into(),
                        ..Default::default()
                    }))),
                },
            ],
        );
        c.commit();
        let reader = c.nodes[owner as usize].list.as_ref().unwrap();
        assert_eq!(
            reader.reading_point(),
            Some(&source_point),
            "{finish}: an empty replacement recaptured another document"
        );
        if finish != "following" {
            assert_eq!(reader.offset, 16.0);
        }
        let replacement = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
        assert_eq!(
            replacement
                .slots
                .iter()
                .filter_map(|slot| slot.ready())
                .collect::<Vec<_>>(),
            Vec::<u32>::new()
        );
        let prepare = |c: &mut Core<FakeEngine>, index, source: bool, queued_slot: Option<u32>| {
            // The cell answers an actual binding; the fixture does not
            // manufacture a source-to-slot assignment of its own.
            let slot = queued_slot.unwrap_or_else(|| bound_slot(c, 4, index));
            if queued_slot.is_none() {
                assert!(c.current_list_bind(4, slot, index));
            }
            let cell = 200 + slot * 4;
            add(
                c,
                cell,
                Tag::Cell,
                4,
                &[("height", StyleValue::Number(50.0))],
            );
            c.apply(Op::SetProp {
                id: cell,
                prop: Prop::Slot(CellSlot::Item(slot)),
            })
            .unwrap();
            if source {
                put_text(
                    c,
                    cell + 1,
                    cell,
                    "session/message/body",
                    u64::from(index) * 160,
                    40,
                );
            }
            cell
        };
        let put_row = |c: &mut Core<FakeEngine>, index, source, queued_slot| {
            let cell = prepare(c, index, source, queued_slot);
            c.apply(Op::SetProp {
                id: cell,
                prop: Prop::CellIndex(index),
            })
            .unwrap();
            cell
        };
        let mut binds = Vec::new();
        c.take_list_binds(&mut binds);
        c.take_paced_list_binds(usize::MAX, &mut binds);
        assert!(
            binds
                .iter()
                .any(|bind| bind.list == 4 && bind.binds.iter().any(|&(_, index)| index == 21))
        );
        assert!(
            !bound_items(&c, 4).contains(&99),
            "source materialization must not mount the full document"
        );

        // Phase one: just row 0 is ready, alongside the unrelated document.
        put_row(&mut c, 0, true, None);
        c.commit();
        let reader = c.nodes[owner as usize].list.as_ref().unwrap();
        assert_eq!(
            reader.reading_point(),
            Some(&source_point),
            "{finish}: first ready row replaced the source pin"
        );
        if finish != "following" {
            assert_eq!(reader.offset, 16.0);
        }
        assert!(
            reader
                .source_geometry
                .position(&crate::text_source::SourcePoint {
                    id: "another/document".into(),
                    byte: 40,
                })
                .is_some()
        );

        // Phase two: the ordinary viewport and overscan are ready. The
        // target row must remain wanted even though it lies beyond them.
        for index in 1..=16 {
            put_row(&mut c, index, false, None);
        }
        c.commit();
        let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
        let mut ready: Vec<_> = list.slots.iter().filter_map(|slot| slot.ready()).collect();
        ready.sort_unstable();
        assert_eq!(ready, (0..=16).collect::<Vec<_>>());
        assert!(c.current_list_bind(4, bound_slot(&c, 4, 21), 21));
        let reader = c.nodes[owner as usize].list.as_ref().unwrap();
        assert_eq!(
            reader.reading_point(),
            Some(&source_point),
            "{finish}: overscan completion closed a pending target"
        );
        if finish != "following" {
            assert_eq!(reader.offset, 16.0);
        }

        let target_slot = bound_slot(&c, 4, 21);
        if finish == "deleted" {
            // Logical rows and their canonical source disappear together,
            // while the same provider node remains in the reader's tree.
            apply(
                &mut c,
                vec![
                    Op::SetProp {
                        id: 4,
                        prop: Prop::Splice(0, 100, 0),
                    },
                    Op::SetProp {
                        id: 4,
                        prop: Prop::ListSourceRows(Some(Arc::new(crate::ListSourceRows {
                            id: "session/message/body".into(),
                            rows: Vec::new().into(),
                            ..Default::default()
                        }))),
                    },
                ],
            );
            c.commit();
            assert_ne!(
                c.nodes[owner as usize]
                    .list
                    .as_ref()
                    .unwrap()
                    .reading_point(),
                Some(&source_point)
            );
        } else if finish == "wheel" {
            c.set_scroll_offset(2, point(px(0.0), px(32.0)), u32::MAX);
            c.commit();
            assert_ne!(
                c.nodes[owner as usize]
                    .list
                    .as_ref()
                    .unwrap()
                    .reading_point(),
                Some(&source_point)
            );
        } else if finish == "removed" {
            c.apply(Op::Remove {
                parent: 100,
                child: 4,
            })
            .unwrap();
            c.commit();
            assert_ne!(
                c.nodes[owner as usize]
                    .list
                    .as_ref()
                    .unwrap()
                    .reading_point(),
                Some(&source_point)
            );
        }

        // Phase three: only now does the target settle. Its actual shaped
        // source line restores the reader; a row with no glyph closes the
        // intent. A late ACK cannot undo removal or a wheel step.
        if finish == "ready" {
            // The body and its exact estimated-size layout can finish before
            // the actual CellIndex ACK. Only readiness changes in the next
            // commit: no new source, row metadata, tree or extent change.
            let target = prepare(&mut c, 21, true, Some(target_slot));
            let prepared = c.commit();
            assert!(
                prepared
                    .as_ref()
                    .is_none_or(|batch| page_scrolls(batch).is_empty())
            );
            let layout = c.nodes[c.key(target).unwrap() as usize].layout.unwrap();
            assert!(!c.layout.dirty(layout));
            let measured = c.rounded_layout(layout).size.height;
            assert_eq!(measured, 50.0);
            let parent = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
            assert!(!parent.slots.iter().any(|slot| slot.ready() == Some(21)));
            assert!(parent.source_row_matches_layout(21, measured));
            assert_eq!(parent.content_len(), 100.0 * 50.0);
            assert_eq!(
                c.reading_position(owner, &source_point),
                crate::text_source::SourcePosition::Pending
            );
            c.apply(Op::SetProp {
                id: target,
                prop: Prop::CellIndex(21),
            })
            .unwrap();
        } else {
            put_row(&mut c, 21, finish != "closed", Some(target_slot));
        }
        let batch = c.commit();
        if finish == "ready" {
            let cached = c.nodes[owner as usize]
                .list
                .as_ref()
                .unwrap()
                .source_geometry
                .position(&source_point);
            let ready = c.reading_position(owner, &source_point);
            assert_eq!(ready, crate::text_source::SourcePosition::Ready(1082.0));
            assert_eq!(
                cached,
                Some(1082.0),
                "a Parent-only readiness ACK was not published to the reader: cached {cached:?}, ready {ready:?}"
            );
        }
        let reader = c.nodes[owner as usize].list.as_ref().unwrap();
        if finish == "ready" || finish == "isolated" || finish == "following" {
            assert_eq!(reader.reading_point(), Some(&source_point));
            assert_eq!(
                reader.source_geometry.position(&source_point).unwrap() - reader.offset,
                0.0
            );
            assert_eq!(reader.offset, 1082.0);
            if finish == "ready" || finish == "isolated" {
                assert_eq!(page_scrolls(batch.as_ref().unwrap()), [(false, 1066.0)]);
            }
            assert!(
                !batch.as_ref().unwrap().items.iter().any(|item| matches!(
                    item,
                    MountItem::Command {
                        id: 4,
                        command: Command::ScrollTo { .. }
                    } | MountItem::ScrollBy { id: 4, .. }
                )),
                "the parent list must not become another scroll owner"
            );
            assert!(
                c.commit()
                    .is_none_or(|batch| page_scrolls(&batch).is_empty()),
                "settling the same source line must not compensate twice"
            );
            let reader = c.nodes[owner as usize].list.as_ref().unwrap();
            assert_eq!(reader.reading_point(), Some(&source_point));
            assert_eq!(
                reader.source_geometry.position(&source_point).unwrap() - reader.offset,
                0.0
            );
        } else {
            assert_ne!(reader.reading_point(), Some(&source_point));
            assert!(
                batch
                    .as_ref()
                    .is_none_or(|batch| page_scrolls(batch).is_empty()),
                "{finish}: {:?}",
                batch.as_ref().map(page_scrolls).unwrap_or_default()
            );
            if finish == "wheel" {
                assert_eq!(reader.offset, 32.0);
            } else if finish == "removed" {
                // The same detached provider can return with its late cell;
                // an absent source lifetime must not revive the old intent.
                c.apply(Op::Insert {
                    parent: 100,
                    child: 4,
                    before: None,
                })
                .unwrap();
                c.commit();
                assert_ne!(
                    c.nodes[owner as usize]
                        .list
                        .as_ref()
                        .unwrap()
                        .reading_point(),
                    Some(&source_point)
                );
            }
        }
    }
}

fn source_reading_survives_prepend_and_rich_replacement(delayed_ready: bool) {
    let mut c = core();
    let source = |offset| {
        Prop::TextSource(Some(Arc::new(crate::TextSource::Literal {
            id: "session/message/body".into(),
            offset,
        })))
    };
    let shift = |batch: Option<MountBatch>| -> f32 {
        batch.map_or(0.0, |batch| {
            batch
                .items
                .iter()
                .filter_map(|item| match item {
                    MountItem::ScrollBy { id: 2, dy, .. } => Some(dy.0),
                    _ => None,
                })
                .sum()
        })
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::Count(1),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 100,
                tag: Tag::Cell,
            },
            Op::SetProp {
                id: 100,
                prop: Prop::Slot(CellSlot::Item(0)),
            },
            Op::Insert {
                parent: 2,
                child: 100,
                before: None,
            },
            Op::Create {
                id: 10,
                tag: Tag::Text,
            },
            style_op(10, &[("display", StyleValue::Str("none"))]),
            Op::SetProp {
                id: 10,
                prop: source(2560),
            },
            Op::CreateText {
                id: 11,
                text: "R".repeat(2000),
            },
            Op::Insert {
                parent: 10,
                child: 11,
                before: None,
            },
            Op::Insert {
                parent: 100,
                child: 10,
                before: None,
            },
        ],
    );
    if !delayed_ready {
        c.apply(Op::SetProp {
            id: 100,
            prop: Prop::CellIndex(0),
        })
        .unwrap();
    }
    c.commit();
    // Visibility alone makes unchanged source text eligible for anchoring.
    c.apply(style_op(10, &[("display", StyleValue::Str("flex"))]))
        .unwrap();
    assert_eq!(shift(c.commit()), 0.0);
    if delayed_ready {
        // Source geometry can exist before the cell is acknowledged. Becoming
        // ready must index it even when the previous list index was empty.
        c.apply(Op::SetProp {
            id: 100,
            prop: Prop::CellIndex(0),
        })
        .unwrap();
        assert_eq!(shift(c.commit()), 0.0);
    }
    c.set_scroll_offset(2, point(px(0.0), px(320.0)), 0);
    assert_eq!(shift(c.commit()), 0.0);

    // 40 characters per shaped line: the source at byte 3360 was at the
    // viewport top. Adding 1280 earlier bytes moves it down exactly 512pt.
    let prefix = format!("{}\n", "*".repeat(1279));
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 10,
                prop: source(1280),
            },
            Op::SetText {
                id: 11,
                text: format!("{prefix}{}", "R".repeat(2000)),
            },
        ],
    );
    assert_eq!(shift(c.commit()), 512.0);

    // A wheel move wins even before that correction has been acknowledged.
    // A whole earlier item (estimated 50pt), the wheel report and the raw
    // prefix arrive in one turn. Replay includes the pending +512; capture
    // the user's old visual source before either kind of new prefix moves it.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Splice(0, 0, 1),
    })
    .unwrap();
    c.set_scroll_offset(2, point(px(0.0), px(336.5)), 0);
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 10,
                prop: source(0),
            },
            Op::SetText {
                id: 11,
                text: format!("{prefix}{prefix}{}", "R".repeat(2000)),
            },
        ],
    );
    assert_eq!(shift(c.commit()), 562.0);
    // An older native receipt is not another user displacement.
    c.set_scroll_offset(2, point(px(0.0), px(336.5)), 0);
    assert_eq!(shift(c.commit()), 0.0);

    // Rich rendering replaces the raw Text with two rule blocks and a
    // large verbatim code Text. A disabled vertical Scroll around wrapped
    // code is not an independent reader and must remain eligible.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: 100,
                child: 10,
            },
            Op::Release { id: 11 },
            Op::Release { id: 10 },
            Op::Create {
                id: 12,
                tag: Tag::View,
            },
            style_op(12, &[("height", StyleValue::Number(16.0))]),
            Op::Insert {
                parent: 100,
                child: 12,
                before: None,
            },
            Op::Create {
                id: 14,
                tag: Tag::View,
            },
            style_op(14, &[("height", StyleValue::Number(16.0))]),
            Op::Insert {
                parent: 100,
                child: 14,
                before: None,
            },
            Op::Create {
                id: 16,
                tag: Tag::Scroll,
            },
            Op::SetProp {
                id: 16,
                prop: Prop::Native(NativeProp::Scrollable(false)),
            },
            Op::Insert {
                parent: 100,
                child: 16,
                before: None,
            },
            Op::Create {
                id: 20,
                tag: Tag::Text,
            },
            Op::SetProp {
                id: 20,
                prop: source(2560),
            },
            Op::CreateText {
                id: 21,
                text: "R".repeat(2000),
            },
            Op::Insert {
                parent: 20,
                child: 21,
                before: None,
            },
            Op::Insert {
                parent: 16,
                child: 20,
                before: None,
            },
        ],
    );
    assert_eq!(shift(c.commit()), -992.0);

    // Only width changes: ensure final text geometry before applying the
    // source correction, even before descendant frame notifications queue.
    c.set_viewport(size_pt(160.0, 480.0));
    assert_eq!(shift(c.commit()), 336.0);
    // A subpixel user step must remain effective rather than being pulled
    // back by the target pin's tolerance for animated command receipts.
    c.set_scroll_offset(2, point(px(0.0), px(754.0)), u32::MAX);
    assert_eq!(shift(c.commit()), 0.0);

    // Source identity can change without glyphs changing (recycled seats).
    // Clearing it must not preserve an anchor from the previous document.
    c.apply(Op::SetProp {
        id: 20,
        prop: Prop::TextSource(None),
    })
    .unwrap();
    assert_eq!(shift(c.commit()), 0.0);
    c.apply(Op::SetText {
        id: 21,
        text: "R".repeat(2640),
    })
    .unwrap();
    assert_eq!(shift(c.commit()), 0.0);

    // An enabled inner vertical Scroll owns its own reading position.
    // Its source-bearing text must not compensate the outer List.
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 20,
                prop: source(2560),
            },
            Op::SetProp {
                id: 16,
                prop: Prop::Native(NativeProp::Scrollable(true)),
            },
            Op::SetText {
                id: 21,
                text: "R".repeat(3280),
            },
        ],
    );
    assert_eq!(shift(c.commit()), 0.0);

    // Re-enabling outer ownership alone also rebuilds an empty index.
    c.apply(Op::SetProp {
        id: 16,
        prop: Prop::Native(NativeProp::Scrollable(false)),
    })
    .unwrap();
    assert_eq!(shift(c.commit()), 0.0);
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 20,
                prop: source(1920),
            },
            Op::SetText {
                id: 21,
                text: format!("{}{}", "*".repeat(640), "R".repeat(3280)),
            },
        ],
    );
    assert_eq!(shift(c.commit()), 512.0);

    // Explicit End and near-bottom append following retain priority over
    // source anchoring. The native end receipt completes the original To.
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 16,
                prop: Prop::Native(NativeProp::Scrollable(false)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::FollowEnd(Some(px(32.0))),
            },
            Op::Command {
                id: 2,
                command: Command::ScrollToEnd { animated: false },
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(scrolled(&batch, 1266.0), 2818.0);
    c.set_scroll_offset(2, point(px(0.0), px(2818.0)), u32::MAX);
    c.commit();
    c.apply(Op::SetText {
        id: 21,
        text: format!("{}{}", "*".repeat(640), "R".repeat(3320)),
    })
    .unwrap();
    assert_eq!(shift(c.commit()), 32.0);

    // End following had no Reading pin. Leaving it and receiving earlier
    // source in the same turn still captures the old visible source first.
    c.set_scroll_offset(2, point(px(0.0), px(2750.0)), u32::MAX);
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 20,
                prop: source(1280),
            },
            Op::SetText {
                id: 21,
                text: format!("{}{}", "*".repeat(1280), "R".repeat(3320)),
            },
        ],
    );
    assert_eq!(shift(c.commit()), 512.0);
}

/// A list of 100 rows estimated at 50 pt in a 400 pt viewport.
fn estimated_list(c: &mut Core<FakeEngine>) {
    apply(
        c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(100),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
}

/// Where list 2 is after `batch`: from `start`, its `ScrollTo` commands
/// and `ScrollBy` items in order.
fn scrolled(batch: &MountBatch, start: f32) -> f32 {
    batch.items.iter().fold(start, |at, item| match item {
        MountItem::Command {
            id: 2,
            command: Command::ScrollTo { y, .. },
        } => y.0,
        MountItem::ScrollBy { id: 2, dy, .. } => at + dy.0,
        _ => at,
    })
}

#[test]
fn automatic_list_targets_wait_for_native_idle_and_resume_only_the_latest() {
    use crate::tailwind::state::{FOCUS_WITHIN, FOCUSED, HOVERED};
    let mut c = core();
    estimated_list(&mut c);
    // Real focus owners in this list: class-derived focus-within is not
    // the list's direct native interaction snapshot.
    add(&mut c, 4, Tag::View, 2, &[]);
    add(&mut c, 6, Tag::View, 2, &[]);
    c.commit();
    let request = |c: &mut Core<FakeEngine>, index, automatic| {
        c.apply(Op::Command {
            id: 2,
            command: Command::ScrollToIndex {
                index,
                animated: false,
                automatic,
                view_position: crate::geometry::Percentage(0.5),
                view_offset: px(0.0),
            },
        })
        .unwrap();
        c.commit().map_or(0.0, |batch| scrolled(&batch, 0.0))
    };
    // The first request must wait for the native snapshot, including a
    // pointer which was already here before tracking was enabled.
    assert_eq!(request(&mut c, 20, true), 0.0);
    c.set_states(2, HOVERED);
    assert_eq!(c.commit().map_or(0.0, |b| scrolled(&b, 0.0)), 0.0);
    assert_eq!(request(&mut c, 40, true), 0.0);
    assert_eq!(request(&mut c, 60, true), 0.0);
    // A source splice invalidates the previous index pin. The caller can
    // refresh the same active index instead of needing an index change.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Splice(90, 1, 1),
    })
    .unwrap();
    c.commit();
    assert_eq!(request(&mut c, 60, true), 0.0);
    c.set_states(2, 0);
    assert_eq!(scrolled(&c.commit().unwrap(), 0.0), 2825.0);
    // After automatic following completed, user scrolling still preserves
    // that latest intent. Leaving resumes without another active request.
    c.set_states(2, HOVERED);
    c.commit();
    c.set_scroll_offset(2, point(px(0.0), px(1000.0)), u32::MAX);
    assert_eq!(c.commit().map_or(1000.0, |b| scrolled(&b, 1000.0)), 1000.0);
    c.set_states(2, 0);
    assert_eq!(scrolled(&c.commit().unwrap(), 1000.0), 2825.0);
    // Focus transfer between rows does not pass through native List idle,
    // even if a commit observes the intermediate child Blur.
    c.set_states(2, FOCUS_WITHIN);
    c.set_states(4, FOCUSED);
    assert_eq!(request(&mut c, 30, true), 0.0);
    c.set_states(4, 0);
    assert_eq!(c.commit().map_or(0.0, |b| scrolled(&b, 0.0)), 0.0);
    c.set_states(6, FOCUSED);
    assert_eq!(c.commit().map_or(0.0, |b| scrolled(&b, 0.0)), 0.0);
    c.set_states(2, 0);
    assert_eq!(scrolled(&c.commit().unwrap(), 0.0), 1325.0);
    // Explicit navigation retains its ordinary immediate semantics.
    c.set_states(2, HOVERED | FOCUS_WITHIN);
    assert_eq!(request(&mut c, 10, false), 325.0);
}

#[test]
fn scroll_commands_follow_their_target_as_rows_are_measured() {
    let mut c = core();
    estimated_list(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    c.commit();
    // The rows are really 80 pt: the end of the estimated content is too
    // early, and the list follows the end once the last rows measure.
    c.apply(Op::Command {
        id: 2,
        command: Command::ScrollToEnd { animated: false },
    })
    .unwrap();
    let mut at = scrolled(&c.commit().unwrap(), 0.0);
    for _ in 0..4 {
        render_binds(&mut c, &mut next_id, &mut cells, 80.0);
        if let Some(batch) = c.commit() {
            at = scrolled(&batch, at);
        }
    }
    let key = c.key(2).unwrap();
    let content = c.nodes[key as usize]
        .scroll
        .as_ref()
        .unwrap()
        .content
        .unwrap();
    assert_eq!(at, (content.height - Points(400.0)).0);

    // Item 50 in the middle of the viewport.
    c.apply(Op::Command {
        id: 2,
        command: Command::ScrollToIndex {
            index: 50,
            animated: false,
            automatic: false,
            view_position: crate::geometry::Percentage(0.5),
            view_offset: px(0.0),
        },
    })
    .unwrap();
    at = scrolled(&c.commit().unwrap(), at);
    for _ in 0..4 {
        render_binds(&mut c, &mut next_id, &mut cells, 80.0);
        if let Some(batch) = c.commit() {
            at = scrolled(&batch, at);
        }
    }
    let list = c.nodes[key as usize].list.as_ref().unwrap();
    assert_eq!(list.item_at(50) + 40.0 - at, 200.0);
    assert!(!list.pinned(), "settled");

    // Scrolled by the user, the list stays where it is put.
    c.set_scroll_offset(2, point(px(0.0), px(at - 600.0)), u32::MAX);
    c.commit();
    assert!(render_binds(&mut c, &mut next_id, &mut cells, 120.0) > 0);
    let batch = c.commit().unwrap();
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Command { id: 2, .. })),
        "no scroll command after the user scrolled"
    );
}

#[test]
fn animated_scroll_commands_retarget_while_rows_are_measured() {
    let mut c = core();
    estimated_list(&mut c);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 80.0);
    c.commit();
    c.apply(Op::Command {
        id: 2,
        command: Command::ScrollToEnd { animated: true },
    })
    .unwrap();
    let first = scrolled(&c.commit().unwrap(), 0.0);
    let mut target = first;
    // The platform starts the animation; the window follows it to the
    // end, whose rows are measured: the animation is retargeted.
    c.set_scroll_offset(2, point(px(0.0), px(1000.0)), 1);
    c.commit();
    c.set_scroll_offset(2, point(px(0.0), px(first - 10.0)), 1);
    c.commit();
    let mut issued = 1;
    for _ in 0..4 {
        render_binds(&mut c, &mut next_id, &mut cells, 80.0);
        if let Some(batch) = c.commit() {
            for item in &batch.items {
                if let MountItem::Command {
                    id: 2,
                    command: Command::ScrollTo { y, animated, .. },
                } = item
                {
                    assert!(animated);
                    target = y.0;
                    issued += 1;
                }
            }
        }
    }
    assert!(issued > 1 && target > first, "retargeted");
    let key = c.key(2).unwrap();
    let content = c.nodes[key as usize]
        .scroll
        .as_ref()
        .unwrap()
        .content
        .unwrap();
    assert_eq!(target, (content.height - Points(400.0)).0);
}

#[test]
fn animated_background_colors_replace_gradients() {
    let mut c = core();
    let mut s = Style::default();
    s.set_background_images(vec![crate::effects::Gradient {
        kind: crate::effects::GradientKind::Linear {
            angle: crate::geometry::deg(180.0),
        },
        stops: Vec::new(),
        repeating: false,
    }]);
    s.animated.push((AnimationProp::BackgroundColor, 7));
    apply(
        &mut c,
        vec![
            Op::Animation(AnimationOp::CreateValue {
                node: 7,
                value: 1.0,
            }),
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 2,
                style: Box::new(s),
                patch: StylePatch::default(),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(view_style_of(&batch, 2).is_none_or(|s| s.effects.is_none()));
}

#[test]
fn animation_ops_and_bindings_are_forwarded_in_order() {
    let mut c = core();
    let mut s = Style::default();
    s.animated.push((AnimationProp::Opacity, 7));
    apply(
        &mut c,
        vec![
            Op::Animation(AnimationOp::CreateValue {
                node: 7,
                value: 1.0,
            }),
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 2,
                style: Box::new(s),
                patch: StylePatch::default(),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let animation = batch.items.iter().position(|i| {
        matches!(
            i,
            MountItem::Animation(AnimationOp::CreateValue { node: 7, .. })
        )
    });
    let bind = batch
        .items
        .iter()
        .position(|i| matches!(i, MountItem::AnimationBindings { id: 2, .. }));
    assert!(
        animation.unwrap() < bind.unwrap(),
        "values exist before views bind them"
    );
}

#[test]
fn leaf_styles_are_resolved() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            // Text with padding: the frame wraps the measured text.
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            style_op(2, &[("padding", StyleValue::Number(10.0))]),
            Op::CreateText {
                id: 3,
                text: "abc".into(),
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            // Empty leaf view: min size and aspect ratio still apply.
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            style_op(
                4,
                &[
                    ("width", StyleValue::Number(100.0)),
                    ("aspectRatio", StyleValue::Number(2.0)),
                    ("alignSelf", StyleValue::Str("flex-start")),
                ],
            ),
            Op::Insert {
                parent: ROOT_ID,
                child: 4,
                before: None,
            },
            Op::Create {
                id: 5,
                tag: Tag::View,
            },
            style_op(5, &[("minHeight", StyleValue::Number(80.0))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 5,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(
        frame_of(&batch, 2).map(|f| f.size.height.0),
        Some(16.0 + 20.0)
    );
    let content = batch.items.iter().find_map(|i| match i {
        MountItem::Text { id: 2, content, .. } => Some(*content),
        _ => None,
    });
    assert_eq!(content, Some(rect(10.0, 10.0, 300.0, 16.0)));
    assert_eq!(
        frame_of(&batch, 4).map(|f| (f.size.width.0, f.size.height.0)),
        Some((100.0, 50.0))
    );
    assert_eq!(frame_of(&batch, 5).map(|f| f.size.height.0), Some(80.0));
}

/// `cargo test --release -p nsh-core bench_row_relayout -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_row_relayout() {
    let mut c = core();
    // A gallery-like row: [image] [title / author] in a list cell.
    let row = |s: &[(&str, StyleValue<'_>)]| style(s);
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 2,
                style: row(&[
                    ("flexDirection", StyleValue::Str("row")),
                    ("alignItems", StyleValue::Str("center")),
                    ("gap", StyleValue::Number(12.0)),
                    ("padding", StyleValue::Number(8.0)),
                ]),
                patch: StylePatch::default(),
            },
            Op::Create {
                id: 3,
                tag: Tag::Image,
            },
            Op::SetStyle {
                id: 3,
                style: row(&[
                    ("width", StyleValue::Number(48.0)),
                    ("height", StyleValue::Number(48.0)),
                ]),
                patch: StylePatch::default(),
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 4,
                style: row(&[("flex", StyleValue::Number(1.0))]),
                patch: StylePatch::default(),
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Create {
                id: 5,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 6,
                text: "Photo #1".into(),
            },
            Op::Insert {
                parent: 5,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Create {
                id: 7,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 8,
                text: "by Ada".into(),
            },
            Op::Insert {
                parent: 7,
                child: 8,
                before: None,
            },
            Op::Insert {
                parent: 4,
                child: 7,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    let n = 2000;
    let start = std::time::Instant::now();
    for i in 0..n {
        c.apply(Op::SetText {
            id: 6,
            text: format!("Photo #{i}"),
        })
        .unwrap();
        c.apply(Op::SetText {
            id: 8,
            text: format!("by {}", ["Ada", "Ken"][i % 2]),
        })
        .unwrap();
        c.commit();
    }
    eprintln!("row relayout: {:?} per commit", start.elapsed() / n as u32);
}

/// `cargo test --release -p nsh-core bench_cell_relayout -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_cell_relayout() {
    let mut c = Core::new(crate::ApproxTextEngine, size_pt(390.0, 800.0));
    let s = |p: &[(&str, StyleValue<'_>)]| style(p);
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::List,
        },
        Op::SetStyle {
            id: 2,
            style: s(&[("flex", StyleValue::Number(1.0))]),
            patch: StylePatch::default(),
        },
        Op::SetProp {
            id: 2,
            prop: Prop::EstimatedItemSize(px(64.0)),
        },
        Op::SetProp {
            id: 2,
            prop: Prop::Count(1000),
        },
        Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        },
    ];
    for op in std::mem::take(&mut ops) {
        c.apply(op).unwrap();
    }
    c.commit();
    let mut binds = Vec::new();
    c.take_list_binds(&mut binds);
    // One cell with a gallery row.
    for op in [
        Op::Create {
            id: 10,
            tag: Tag::Cell,
        },
        Op::SetProp {
            id: 10,
            prop: Prop::Slot(CellSlot::Item(0)),
        },
        Op::Insert {
            parent: 2,
            child: 10,
            before: None,
        },
        Op::Create {
            id: 11,
            tag: Tag::View,
        },
        Op::SetStyle {
            id: 11,
            style: s(&[
                ("flexDirection", StyleValue::Str("row")),
                ("alignItems", StyleValue::Str("center")),
                ("gap", StyleValue::Number(12.0)),
                ("paddingHorizontal", StyleValue::Number(16.0)),
                ("paddingVertical", StyleValue::Number(8.0)),
            ]),
            patch: StylePatch::default(),
        },
        Op::Insert {
            parent: 10,
            child: 11,
            before: None,
        },
        Op::Create {
            id: 12,
            tag: Tag::Image,
        },
        Op::SetStyle {
            id: 12,
            style: s(&[
                ("width", StyleValue::Number(48.0)),
                ("height", StyleValue::Number(48.0)),
            ]),
            patch: StylePatch::default(),
        },
        Op::Insert {
            parent: 11,
            child: 12,
            before: None,
        },
        Op::Create {
            id: 13,
            tag: Tag::View,
        },
        Op::SetStyle {
            id: 13,
            style: s(&[
                ("flex", StyleValue::Number(1.0)),
                ("gap", StyleValue::Number(2.0)),
            ]),
            patch: StylePatch::default(),
        },
        Op::Insert {
            parent: 11,
            child: 13,
            before: None,
        },
        Op::Create {
            id: 14,
            tag: Tag::Text,
        },
        Op::CreateText {
            id: 15,
            text: "Photo #1".into(),
        },
        Op::Insert {
            parent: 14,
            child: 15,
            before: None,
        },
        Op::Insert {
            parent: 13,
            child: 14,
            before: None,
        },
        Op::Create {
            id: 16,
            tag: Tag::Text,
        },
        Op::CreateText {
            id: 17,
            text: "by Ada".into(),
        },
        Op::Insert {
            parent: 16,
            child: 17,
            before: None,
        },
        Op::Insert {
            parent: 13,
            child: 16,
            before: None,
        },
        Op::SetProp {
            id: 10,
            prop: Prop::CellIndex(0),
        },
    ] {
        c.apply(op).unwrap();
    }
    c.commit();
    for idle in [0u64, 10] {
        let n = if idle == 0 { 2000 } else { 100 };
        let mut total = std::time::Duration::ZERO;
        for i in 0..n {
            std::thread::sleep(std::time::Duration::from_millis(idle));
            let start = std::time::Instant::now();
            c.apply(Op::SetText {
                id: 15,
                text: format!("Photo #{i}"),
            })
            .unwrap();
            c.apply(Op::SetText {
                id: 17,
                text: format!("by {}", ["Ada", "Ken"][i % 2]),
            })
            .unwrap();
            c.commit();
            total += start.elapsed();
        }
        eprintln!(
            "cell relayout ({idle} ms idle between frames): {:?} per commit",
            total / n as u32
        );
    }
}

fn input_core() -> Core<FakeEngine> {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Input,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Placeholder("Name".into()),
            },
            style_op(2, &[("padding", StyleValue::Number(6.0))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c
}

#[test]
fn input_measures_its_placeholder_and_reports_its_content_box() {
    let mut c = input_core();
    let batch = c.commit().unwrap();
    // One line of text (16pt) plus padding, stretched across the root.
    assert_eq!(frame_of(&batch, 2).map(|f| f.size.height.0), Some(28.0));
    assert!(batch.items.iter().any(|i| matches!(i,
        MountItem::Input { id: 2, config } if config.placeholder == "Name" && !config.multiline)));
    assert!(batch.items.iter().any(|i| matches!(i,
        MountItem::InputContent { id: 2, content } if *content == rect(6.0, 6.0, 308.0, 16.0))));
    // No text yet: nothing to send.
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::InputValue { .. }))
    );
}

#[test]
fn inputs_resolve_what_return_does() {
    use crate::{SubmitBehavior as S, mount::InputConfig};
    let config = |multiline, blur_on_submit, submit_behavior| InputConfig {
        multiline,
        blur_on_submit,
        submit_behavior,
        ..InputConfig::default()
    };
    // React Native's defaults: one line submits and unfocuses, several
    // lines take line breaks; `blur_on_submit` false keeps the focus.
    assert_eq!(config(false, true, None).submit(), S::BlurAndSubmit);
    assert_eq!(config(false, false, None).submit(), S::Submit);
    assert_eq!(config(true, true, None).submit(), S::Newline);
    // `submitBehavior` wins; one line never takes line breaks.
    assert_eq!(config(true, true, Some(S::Submit)).submit(), S::Submit);
    assert_eq!(
        config(false, false, Some(S::BlurAndSubmit)).submit(),
        S::BlurAndSubmit
    );
    assert_eq!(
        config(false, true, Some(S::Newline)).submit(),
        S::BlurAndSubmit
    );
}

#[test]
fn inputs_take_their_submit_behavior() {
    let mut c = input_core();
    c.commit().unwrap();
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::Multiline(true),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::SubmitBehavior(Some(crate::SubmitBehavior::Submit)),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(i,
        MountItem::Input { id: 2, config } if config.submit() == crate::SubmitBehavior::Submit)));
}

#[test]
fn input_values_from_js_and_native_edits() {
    let mut c = input_core();
    c.commit();
    // The user types; JS echoes the same text: nothing goes back.
    c.input_changed(2, "ab", 2);
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Value("ab".into()),
    })
    .unwrap();
    assert!(c.commit().is_none());
    // JS transforms the text: it is sent with the edit count it is based on.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Value("AB".into()),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(i,
        MountItem::InputValue { id: 2, text, count: 2 } if text == "AB")));
    // `defaultValue` no longer applies once a value was set.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::DefaultValue("x".into()),
    })
    .unwrap();
    assert!(c.commit().is_none());
    c.apply(Op::Command {
        id: 2,
        command: crate::Command::ReplaceRange {
            range: 0..2,
            text: "replacement".into(),
            expected_text: "AB".into(),
            expected_selection: 2..2,
            count: 0,
        },
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::Command { id: 2, command: crate::Command::ReplaceRange { count: 2, text, .. } }
        if text == "replacement")));
}

#[test]
fn multiline_inputs_grow_with_their_text() {
    let mut c = input_core();
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Multiline(true),
    })
    .unwrap();
    c.commit();
    // 50 characters at 8pt in 308pt: two lines.
    c.input_changed(2, &"x".repeat(50), 1);
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 2).map(|f| f.size.height.0), Some(44.0));
    // A trailing line break starts an empty line that still takes space.
    c.input_changed(2, "x\n", 2);
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 2).map(|f| f.size.height.0), Some(28.0));
}

#[test]
fn commands_reach_created_views_only() {
    let mut c = input_core();
    c.apply(Op::Command {
        id: 2,
        command: crate::Command::Focus,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(matches!(
        batch.items.last(),
        Some(MountItem::Command {
            id: 2,
            command: crate::Command::Focus
        })
    ));
    c.apply(Op::Create {
        id: 3,
        tag: Tag::Input,
    })
    .unwrap();
    c.apply(Op::Command {
        id: 3,
        command: crate::Command::Focus,
    })
    .unwrap();
    assert!(c.commit().is_none());
}

fn insert_items(batch: &MountBatch) -> Vec<(NodeId, NodeId, Option<NodeId>)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert {
                parent,
                child,
                before,
            } => Some((*parent, *child, *before)),
            _ => None,
        })
        .collect()
}

#[test]
fn z_index_orders_native_views() {
    let mut c = core();
    let z = |v: f32| style(&[("zIndex", StyleValue::Number(v))]);
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 2,
                style: z(5.0),
                patch: StylePatch::default(),
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
            Op::Insert {
                parent: 1,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // 3 (z 0) goes below 2 (z 5) although it comes later in the tree.
    assert_eq!(insert_items(&batch), vec![(1, 2, None), (1, 3, Some(2))]);
    // Raising 3 above 2 moves it to the top.
    apply(
        &mut c,
        vec![Op::SetStyle {
            id: 3,
            style: z(9.0),
            patch: StylePatch::default(),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(insert_items(&batch), vec![(1, 3, None)]);
    // A new child with the default z index goes below both.
    apply(
        &mut c,
        vec![Op::Insert {
            parent: 1,
            child: 4,
            before: None,
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(insert_items(&batch), vec![(1, 4, Some(2))]);
}

#[test]
fn layout_events_carry_frames_and_late_listeners_get_one() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            style_op(2, &[("height", StyleValue::Number(40.0))]),
            Op::Listen {
                id: 2,
                event: EventKind::Layout,
                enabled: true,
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit().unwrap();
    let events = js_events(&mut c);
    assert_eq!(
        events,
        vec![(
            2,
            EventKind::Layout,
            EventPayload::Layout(rect(0.0, 0.0, 320.0, 40.0))
        )]
    );
    // Unchanged frames report nothing; a listener added later learns the
    // current frame.
    apply(
        &mut c,
        vec![
            Op::Listen {
                id: 2,
                event: EventKind::Layout,
                enabled: false,
            },
            Op::Listen {
                id: 2,
                event: EventKind::Layout,
                enabled: true,
            },
        ],
    );
    c.commit();
    let events = js_events(&mut c);
    assert_eq!(events.len(), 1);
}

#[test]
fn font_scale_scales_text_that_allows_it() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 3,
                text: "abc".into(),
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 5,
                text: "abc".into(),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::AllowFontScaling(false),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Insert {
                parent: 1,
                child: 4,
                before: None,
            },
        ],
    );
    c.commit().unwrap();
    c.set_font_scale(2.0);
    let batch = c.commit().unwrap();
    let size = |id| {
        batch.items.iter().find_map(|i| match i {
            MountItem::Text { id: i, text, .. } if *i == id => {
                Some(text.spans[0].style.font_size.0)
            }
            _ => None,
        })
    };
    assert_eq!(size(2), Some(28.0));
    assert_eq!(size(4), None, "text without font scaling is unchanged");
}

#[test]
fn layout_animation_leads_the_batch() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
            Op::Command {
                id: 1,
                command: Command::LayoutAnimation(crate::LayoutAnimation {
                    create: None,
                    update: None,
                    delete: None,
                }),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(
        matches!(batch.items[0], MountItem::LayoutAnimation(_)),
        "{:?}",
        batch.items
    );
}

#[test]
fn view_props_and_gestures_reach_the_platform() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::HitSlop(crate::EdgeInsets::all(px(10.0))),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::PinchValue(Some(7)),
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ViewProps { id: 2, props } if props.hit_slop.top == px(10.0))
    ));
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Gestures { id: 2, values } if values.pinch == Some(7)))
    );
}

/// A label that follows app state goes alone, not with all the view's
/// props; any other change (or the first props) sends them all.
#[test]
fn a_changing_label_is_sent_alone() {
    use crate::props::AccessibilityProp;
    let label = |v: &str| Op::SetProp {
        id: 2,
        prop: Prop::Accessibility(AccessibilityProp::Label(Some(v.into()))),
    };
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            label("0 items"),
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(i, MountItem::ViewProps { id: 2, props } if props.accessibility.label.as_deref() == Some("0 items"))));
    apply(&mut c, vec![label("1 item")]);
    let batch = c.commit().unwrap();
    assert_eq!(batch.items.len(), 1, "{:?}", batch.items);
    assert!(
        matches!(&batch.items[0], MountItem::AccessibilityLabel { id: 2, label: Some(l) } if &**l == "1 item")
    );
    // With another prop in the same commit, everything goes once.
    apply(
        &mut c,
        vec![
            label("2 items"),
            Op::SetProp {
                id: 2,
                prop: Prop::TestId(Some("counter".into())),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(batch.items.len(), 1, "{:?}", batch.items);
    assert!(
        matches!(&batch.items[0], MountItem::ViewProps { id: 2, props } if props.accessibility.label.as_deref() == Some("2 items"))
    );
}

#[test]
fn screens_fill_their_stack_below_the_header() {
    let mut c = core();
    c.set_safe_area(crate::EdgeInsets {
        top: px(20.0),
        ..Default::default()
    });
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Stack,
            },
            style_op(2, &[("flex", StyleValue::Number(1.0))]),
            Op::Create {
                id: 3,
                tag: Tag::Screen,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            style_op(4, &[("flex", StyleValue::Number(1.0))]),
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // The screen fills the stack; its content starts below the status bar
    // and the 44pt bar.
    assert_eq!(frame_of(&batch, 3), Some(rect(0.0, 0.0, 320.0, 480.0)));
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 64.0, 320.0, 416.0)));
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ScreenConfig { id: 3, config } if config.header_height == px(64.0))
    ));
    // The header the platform measured replaces the estimate (Catalyst
    // can show its bar in the window's title bar).
    c.set_screen_header(3, Some(px(52.0)));
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 52.0, 320.0, 428.0)));
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ScreenConfig { id: 3, config } if config.header_height == px(52.0))
    ));
    // Without a header, the content starts at the top.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 3,
            prop: Prop::Screen(crate::ScreenProp::HeaderVisible(false)),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 0.0, 320.0, 480.0)));
}

#[test]
fn modals_lay_out_at_the_reported_size() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Modal,
            },
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            style_op(3, &[("flex", StyleValue::Number(1.0))]),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 1,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // The viewport until the platform reports the presented size.
    assert_eq!(frame_of(&batch, 3).map(|f| f.size.height.0), Some(480.0));
    c.set_root_size(2, size_pt(320.0, 400.0), crate::EdgeInsets::default());
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 3).map(|f| f.size.height.0), Some(400.0));
}

#[test]
fn right_to_left_layouts() {
    let mut c = core();
    let n = |v: f32| StyleValue::Number(v);
    let s = |v: &'static str| StyleValue::Str(v);
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::View,
        },
        style_op(
            2,
            &[
                ("flexDirection", s("row")),
                ("width", n(300.0)),
                ("height", n(50.0)),
            ],
        ),
    ];
    // Two boxes in a row: the first with `marginStart`, the second with
    // `marginLeft` (swapped right to left, as in React Native).
    for (id, key) in [(3, "marginStart"), (4, "marginLeft")] {
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(Op::SetStyle {
            id,
            style: style(&[("width", n(50.0)), ("height", n(50.0)), (key, n(10.0))]),
            patch: StylePatch::default(),
        });
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 3).map(|f| f.origin.x.0), Some(10.0));
    assert_eq!(frame_of(&batch, 4).map(|f| f.origin.x.0), Some(70.0));

    // The surface turns right to left: the row runs from the right.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(true),
        }],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::LayoutDirection { rtl: true }))
    );
    assert_eq!(
        frame_of(&batch, 3).map(|f| f.origin.x.0),
        Some(300.0 - 10.0 - 50.0)
    );
    assert_eq!(
        frame_of(&batch, 4).map(|f| f.origin.x.0),
        Some(300.0 - 60.0 - 10.0 - 50.0)
    );

    // A subtree built detached and inserted takes the direction too; an
    // explicit `direction` overrides it.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 5,
                tag: Tag::View,
            },
            style_op(
                5,
                &[
                    ("flexDirection", s("row")),
                    ("direction", s("ltr")),
                    ("height", n(20.0)),
                ],
            ),
            Op::Create {
                id: 6,
                tag: Tag::View,
            },
            style_op(
                6,
                &[
                    ("width", n(20.0)),
                    ("start", n(5.0)),
                    ("position", s("absolute")),
                ],
            ),
            Op::Insert {
                parent: 5,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 5,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 6).map(|f| f.origin.x.0), Some(5.0));

    // Back to left to right.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(false),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 3).map(|f| f.origin.x.0), Some(10.0));
    assert_eq!(frame_of(&batch, 4).map(|f| f.origin.x.0), Some(70.0));
}

#[test]
fn right_to_left_classes_stay_physical() {
    let mut c = core();
    // The surface is right to left before anything is made.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(true),
        }],
    );
    view_with_classes(&mut c, 2, "flex-row w-[300px] h-[50px]");
    let n = |v: f32| StyleValue::Number(v);
    let mut ops = Vec::new();
    // `ml-*` is the left margin right to left too (CSS); `ms-*` the start,
    // and an inline `marginLeft` keeps React Native's meaning, the start.
    for (id, classes) in [
        (3, "w-[50px] h-[50px] ml-[10px]"),
        (4, "w-[50px] h-[50px] ms-[10px]"),
        (5, "w-[50px] h-[50px]"),
        (
            6,
            "absolute left-[5px] w-[20px] h-[20px] border-l-4 border-l-red-500 rounded-tl-lg",
        ),
    ] {
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(class_op(id, classes));
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    ops.push(style_op(5, &[("marginLeft", n(10.0))]));
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let x = |batch: &MountBatch, id| frame_of(batch, id).map(|f| f.origin.x.0);
    // The row runs from the right: 3 is the first, at the right edge, with
    // its margin on its left; 4 has its start margin on its right.
    assert_eq!(x(&batch, 3), Some(300.0 - 50.0));
    assert_eq!(x(&batch, 4), Some(300.0 - 60.0 - 10.0 - 50.0));
    assert_eq!(x(&batch, 5), Some(300.0 - 60.0 - 60.0 - 10.0 - 50.0));
    assert_eq!(x(&batch, 6), Some(5.0));
    let v = view_style_of(&batch, 6).unwrap();
    assert_eq!(v.borders.widths.left, px(4.0));
    assert_eq!(v.borders.widths.right, px(0.0));
    assert_eq!(v.borders.colors[3], Color(0xfb2c_36ff));
    assert_eq!(v.corner_radius.top_left, Some(px(8.0)));
    assert_eq!(v.corner_radius.top_right, None);
    // Back to left to right, the same.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(false),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(x(&batch, 3), Some(10.0));
    assert_eq!(x(&batch, 4), Some(60.0 + 10.0));
    // Where it was: no new frame.
    assert_eq!(x(&batch, 6), None);
    let v = view_style_of(&batch, 6).unwrap();
    assert_eq!(v.borders.widths.left, px(4.0));
    assert_eq!(v.corner_radius.top_left, Some(px(8.0)));
}

#[test]
fn right_to_left_text_alignment_classes_stay_physical() {
    let mut c = core();
    apply(
        &mut c,
        vec![Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(true),
        }],
    );
    let mut ops = Vec::new();
    for (id, classes) in [(2, "text-left"), (4, "text-end"), (6, "text-right")] {
        ops.extend([
            Op::Create { id, tag: Tag::Text },
            class_op(id, classes),
            Op::CreateText {
                id: id + 1,
                text: "hello".into(),
            },
            Op::Insert {
                parent: id,
                child: id + 1,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
        ]);
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let align = |id| {
        batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text { id: i, text, .. } if *i == id => Some(text.align),
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(align(2), TextAlign::Left);
    assert_eq!(align(4), TextAlign::Left);
    assert_eq!(align(6), TextAlign::Right);
}

#[test]
fn a_child_moved_between_space_parents_takes_the_new_margin() {
    let mut c = core();
    view_with_classes(&mut c, 2, "flex-row space-x-2 w-[300px] h-[20px]");
    view_with_classes(&mut c, 3, "flex-row space-x-8 w-[300px] h-[20px]");
    let mut ops = Vec::new();
    for (id, parent) in [(4, 2), (5, 2), (6, 3), (7, 3)] {
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(class_op(id, "size-[20px]"));
        ops.push(Op::Insert {
            parent,
            child: id,
            before: None,
        });
    }
    apply(&mut c, ops);
    c.commit().unwrap();
    // 4 leaves `space-x-2` for `space-x-8`, before 7: 8 * 4 after it.
    c.apply(Op::Remove {
        parent: 2,
        child: 4,
    })
    .unwrap();
    apply(
        &mut c,
        vec![Op::Insert {
            parent: 3,
            child: 4,
            before: Some(7),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 7).map(|f| f.origin.x.0), Some(104.0));
}

#[test]
fn space_classes_give_children_but_the_last_margins() {
    let mut c = core();
    view_with_classes(&mut c, 2, "flex-row space-x-4 w-[300px] h-[20px]");
    let mut ops = Vec::new();
    for (id, classes) in [
        (3, "size-[20px]"),
        (4, "size-[20px] mr-1"),
        (5, "size-[20px]"),
    ] {
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(class_op(id, classes));
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    // A child with no classes gets it too.
    ops.push(Op::Create {
        id: 6,
        tag: Tag::View,
    });
    ops.push(style_op(
        6,
        &[
            ("width", StyleValue::Number(20.0)),
            ("height", StyleValue::Number(20.0)),
        ],
    ));
    ops.push(Op::Insert {
        parent: 2,
        child: 6,
        before: Some(5),
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let x = |batch: &MountBatch, id| frame_of(batch, id).map(|f| f.origin.x.0);
    // 3: 16 after it; 4: its own `mr-1` wins (4); 6: 16; 5 is last.
    assert_eq!(x(&batch, 3), Some(0.0));
    assert_eq!(x(&batch, 4), Some(36.0));
    assert_eq!(x(&batch, 6), Some(60.0));
    assert_eq!(x(&batch, 5), Some(96.0));
    // Appended: the last before gets its margin, the new one has none.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 7,
                tag: Tag::View,
            },
            class_op(7, "size-[20px]"),
            Op::Insert {
                parent: 2,
                child: 7,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(x(&batch, 7), Some(132.0));
    // The last one gone, the one before it is last again.
    c.apply(Op::Remove {
        parent: 2,
        child: 7,
    })
    .unwrap();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 8,
                tag: Tag::View,
            },
            class_op(8, "size-[20px]"),
        ],
    );
    apply(
        &mut c,
        vec![Op::Insert {
            parent: 2,
            child: 8,
            before: None,
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(x(&batch, 8), Some(132.0));
    // Reversed, the margin is on the start side; without the class, none.
    c.apply(class_op(
        2,
        "flex-row space-x-4 space-x-reverse w-[300px] h-[20px]",
    ))
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(x(&batch, 3), Some(16.0));
    c.apply(class_op(2, "flex-row w-[300px] h-[20px]")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(x(&batch, 3), Some(0.0));
    assert_eq!(x(&batch, 6), Some(44.0));
}

#[test]
fn borders_and_rings_without_a_color_are_the_inherited_text_color() {
    let mut c = core();
    view_with_classes(&mut c, 2, "text-white");
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            class_op(4, "border-2 ring"),
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            // Built apart, then inserted: the color reaches it through 3.
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Create {
                id: 5,
                tag: Tag::View,
            },
            style_op(5, &[("borderWidth", StyleValue::Number(1.0))]),
            Op::Insert {
                parent: 2,
                child: 5,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let v = view_style_of(&batch, 4).unwrap();
    assert_eq!(v.borders.colors, [Color(0xffff_ffff); 4]);
    assert_eq!(
        v.effects.as_ref().unwrap().box_shadows[0].color,
        Color(0xffff_ffff)
    );
    // An inline style's border keeps React Native's black.
    assert_eq!(
        view_style_of(&batch, 5).unwrap().borders.colors[0],
        Color::BLACK
    );
    // The ancestor's color changes: so does the border's.
    c.apply(class_op(2, "text-red-500")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 4).unwrap().borders.colors[0],
        Color(0xfb2c_36ff)
    );
    // Moved under a view of no color: black.
    apply(
        &mut c,
        vec![Op::Insert {
            parent: ROOT_ID,
            child: 4,
            before: None,
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 4).unwrap().borders.colors[0],
        Color::BLACK
    );
}

#[test]
fn right_to_left_horizontal_scrolls() {
    let mut c = core();
    let n = |v: f32| StyleValue::Number(v);
    let mut ops = vec![
        Op::SetProp {
            id: ROOT_ID,
            prop: Prop::LayoutDirection(true),
        },
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        Op::SetProp {
            id: 2,
            prop: Prop::Horizontal(true),
        },
        style_op(
            2,
            &[
                ("width", n(150.0)),
                ("height", n(50.0)),
                ("paddingStart", n(10.0)),
            ],
        ),
    ];
    for id in [3, 4] {
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(Op::SetStyle {
            id,
            style: style(&[("width", n(100.0)), ("height", n(50.0))]),
            patch: StylePatch::default(),
        });
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    // Content: 10 (start padding) + 200; the first child at the right end.
    assert_eq!(
        frame_of(&batch, 3).map(|f| f.origin.x.0),
        Some(210.0 - 10.0 - 100.0)
    );
    assert_eq!(frame_of(&batch, 4).map(|f| f.origin.x.0), Some(0.0));
    // It starts scrolled to its right end.
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Command {
            id: 2,
            command: Command::ScrollTo { x, .. }
        } if x.0 == 60.0
    )));
}

fn class_op(id: NodeId, classes: &str) -> Op {
    Op::SetProp {
        id,
        prop: Prop::Class(classes.into()),
    }
}

fn view_style_of(batch: &MountBatch, id: NodeId) -> Option<ViewStyle> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::ViewStyle { id: i, style } if *i == id => Some((**style).clone()),
        _ => None,
    })
}

fn view_with_classes(c: &mut Core<FakeEngine>, id: NodeId, classes: &str) {
    apply(
        c,
        vec![
            Op::Create { id, tag: Tag::View },
            class_op(id, classes),
            Op::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
        ],
    );
}

#[test]
fn backdrop_material_survives_restyling_and_resets() {
    use crate::{BackdropMaterial, js::host::HostProps};

    let mut c = core();
    // A material alone still reaches the platform on first mount.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::BackdropMaterial(BackdropMaterial::Regular),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    assert_eq!(
        view_style_of(&c.commit().unwrap(), 2)
            .unwrap()
            .backdrop_material,
        BackdropMaterial::Regular
    );
    // Restyling must preserve the platform prop.
    c.apply(style_op(
        2,
        &[("backdropFilter", StyleValue::Str("blur(30px)"))],
    ))
    .unwrap();
    assert_eq!(
        view_style_of(&c.commit().unwrap(), 2)
            .unwrap()
            .backdrop_material,
        BackdropMaterial::Regular
    );
    for material in [
        BackdropMaterial::Thin,
        BackdropMaterial::Thick,
        BackdropMaterial::Chrome,
    ] {
        c.apply(Op::SetProp {
            id: 2,
            prop: Prop::BackdropMaterial(material),
        })
        .unwrap();
        assert_eq!(
            view_style_of(&c.commit().unwrap(), 2)
                .unwrap()
                .backdrop_material,
            material
        );
    }
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::BackdropMaterial(BackdropMaterial::Chrome),
    })
    .unwrap();
    assert!(c.commit().is_none());
    // The renderer uses the generated reset when the iOS prop is removed.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::BackdropMaterial(BackdropMaterial::Chrome)
            .reset()
            .unwrap(),
    })
    .unwrap();
    let mounted = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(mounted.backdrop_material, BackdropMaterial::UltraThin);
    assert!(!mounted.effects.unwrap().backdrop_filters.is_empty());
}

#[test]
fn classes_style_views_and_inline_styles_win() {
    let mut c = core();
    view_with_classes(&mut c, 2, "w-20 h-10 p-2 bg-blue-500 rounded-lg");
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 2).unwrap().size.width.0, 80.0);
    let v = view_style_of(&batch, 2).unwrap();
    assert_eq!(v.background_color, Color(0x2b7f_ffff));
    assert_eq!(v.border_radius, px(8.0));
    // The inline style applies over the classes, and survives a class change.
    c.apply(style_op(
        2,
        &[("backgroundColor", StyleValue::Str("#ff0000"))],
    ))
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0xff00_00ff)
    );
    c.apply(class_op(2, "w-24 h-10 bg-green-500")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 2).unwrap().size.width.0, 96.0);
    let v = view_style_of(&batch, 2).unwrap();
    assert_eq!(v.background_color, Color(0xff00_00ff));
    assert_eq!(v.border_radius, px(0.0));
    // Same classes again: nothing to do.
    c.apply(class_op(2, "w-24 h-10 bg-green-500")).unwrap();
    assert!(c.commit().is_none());
}

/// Display toggles must update native visibility even when the empty
/// view's layout frame stays unchanged. Visibility remains independently set.
#[test]
fn display_none_reaches_native_views_without_a_frame_change() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            style_op(
                2,
                &[
                    ("width", StyleValue::Number(0.0)),
                    ("height", StyleValue::Number(0.0)),
                    ("display", StyleValue::Str("none")),
                ],
            ),
        ],
    );
    // Flush while detached: mounting later must restore the effective
    // native style even after the original dirty flags were consumed.
    let _ = c.commit();
    c.apply(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    })
    .unwrap();
    let first = c.commit().unwrap();
    assert_eq!(frame_of(&first, 2).unwrap().size, size_pt(0.0, 0.0));
    assert!(view_style_of(&first, 2).unwrap().hidden);
    for (display, visibility, hidden) in [
        ("flex", "visible", false),
        ("none", "visible", true),
        ("none", "hidden", true),
        ("flex", "hidden", true),
        ("flex", "visible", false),
    ] {
        c.apply(style_op(
            2,
            &[
                ("width", StyleValue::Number(0.0)),
                ("height", StyleValue::Number(0.0)),
                ("display", StyleValue::Str(display)),
                ("visibility", StyleValue::Str(visibility)),
            ],
        ))
        .unwrap();
        let batch = c.commit().expect("native visibility update");
        assert_eq!(view_style_of(&batch, 2).unwrap().hidden, hidden);
        assert!(frame_of(&batch, 2).is_none(), "{display}/{visibility}");
    }
}

#[test]
fn important_classes_win_over_inline_styles() {
    let mut c = core();
    view_with_classes(
        &mut c,
        2,
        "!bg-blue-500 translate-x-2 !scale-150 opacity-50",
    );
    c.apply(style_op(
        2,
        &[
            ("backgroundColor", StyleValue::Str("#ff0000")),
            ("opacity", StyleValue::Number(0.8)),
        ],
    ))
    .unwrap();
    let v = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(v.background_color, Color(0x2b7f_ffff));
    // Not important: the inline style wins.
    assert_eq!(v.opacity, 0.8);
    // The important scale still composes with the plain translation.
    let mut expected = crate::Transform::default();
    let _ = expected.push(crate::TransformKind::TranslateX, 8.0);
    let _ = expected.push(crate::TransformKind::Scale, 1.5);
    assert_eq!(v.transform, expected);
}

#[test]
fn inline_styles_resolve_longhands_whatever_their_order() {
    use crate::effects::Keyframes;
    let mut c = core();
    view_with_classes(&mut c, 2, "border-t-4 outline-2 animate-spin");
    // The inline style applies over the classes: its shorthand wins over a
    // class's longhand, its `none` over a class's width, its duration
    // changes the class's animation.
    c.apply(style_op(
        2,
        &[
            ("borderWidth", StyleValue::Number(1.0)),
            ("outlineStyle", StyleValue::Str("none")),
            ("animationDuration", StyleValue::Number(500.0)),
        ],
    ))
    .unwrap();
    let v = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(v.borders.widths.to_array().map(|w| w.0), [1.0; 4]);
    assert!(!v.outline.is_visible());
    let a = v.animation.unwrap();
    assert_eq!((a.keyframes, a.duration), (Keyframes::Spin, 500.0));
    // In one object the longhand wins, also when the classes change.
    c.apply(style_op(
        2,
        &[
            ("borderTopWidth", StyleValue::Number(5.0)),
            ("borderWidth", StyleValue::Number(2.0)),
            ("animationIterationCount", StyleValue::Number(2.0)),
            ("animationName", StyleValue::Str("pulse")),
        ],
    ))
    .unwrap();
    let v = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(
        v.borders.widths.to_array().map(|w| w.0),
        [5.0, 2.0, 2.0, 2.0]
    );
    assert_eq!(v.outline.width, px(2.0));
    c.apply(class_op(2, "border-t-8")).unwrap();
    let v = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(
        v.borders.widths.to_array().map(|w| w.0),
        [5.0, 2.0, 2.0, 2.0]
    );
    assert!(!v.outline.is_visible());
    let a = v.animation.unwrap();
    assert_eq!((a.keyframes, a.iterations), (Keyframes::Pulse, Some(2)));
    // A longhand left out: the shorthand shows again.
    c.apply(style_op(2, &[("borderWidth", StyleValue::Number(2.0))]))
        .unwrap();
    let v = view_style_of(&c.commit().unwrap(), 2).unwrap();
    assert_eq!(v.borders.widths.to_array().map(|w| w.0), [2.0; 4]);
    assert_eq!(v.animation, None);
}

#[test]
fn the_apps_appearance_wins_over_the_systems() {
    use crate::platform::Appearance;
    let mut c = core();
    view_with_classes(&mut c, 2, "bg-white dark:bg-black");
    let background = |batch: &MountBatch| view_style_of(batch, 2).map(|s| s.background_color);
    assert_eq!(background(&c.commit().unwrap()), Some(Color(0xffff_ffff)));
    let appearance = |c: &mut Core<FakeEngine>, a| {
        apply(
            c,
            vec![Op::SetProp {
                id: ROOT_ID,
                prop: Prop::Appearance(a),
            }],
        )
    };
    appearance(&mut c, Appearance::Dark);
    let batch = c.commit().unwrap();
    assert_eq!(background(&batch), Some(Color(0x0000_00ff)));
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Appearance {
            appearance: Appearance::Dark
        }
    )));
    // The system turning light changes nothing; following it again does.
    c.set_class_environment(crate::tailwind::ClassEnvironment::default());
    assert!(c.commit().is_none_or(|b| background(&b).is_none()));
    c.set_class_environment(crate::tailwind::ClassEnvironment {
        dark: true,
        ..Default::default()
    });
    appearance(&mut c, Appearance::Light);
    assert_eq!(background(&c.commit().unwrap()), Some(Color(0xffff_ffff)));
    appearance(&mut c, Appearance::System);
    assert_eq!(background(&c.commit().unwrap()), Some(Color(0x0000_00ff)));
}

#[test]
fn dark_mode_and_breakpoints_restyle_natively() {
    let mut c = core();
    view_with_classes(&mut c, 2, "bg-white dark:bg-black p-2 md:p-8");
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0xffff_ffff)
    );
    c.set_class_environment(crate::tailwind::ClassEnvironment {
        dark: true,
        ..Default::default()
    });
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0x0000_00ff)
    );
    // A wide window crosses `md`: the padding changes, the child moves.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            style_op(3, &[("height", StyleValue::Number(5.0))]),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 3).unwrap().origin.x.0, 8.0);
    c.set_viewport(size_pt(1024.0, 768.0));
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 3).unwrap().origin.x.0, 32.0);
}

#[test]
fn press_and_group_states() {
    let mut c = core();
    view_with_classes(&mut c, 2, "group bg-white active:bg-zinc-200");
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "h-4 opacity-100 group-active:opacity-50"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // The platform is asked to report the group's presses.
    assert!(batch.items.iter().any(|i| matches!(i, MountItem::TrackStates { id: 2, states } if states & crate::tailwind::state::PRESSED != 0)));
    c.set_states(2, crate::tailwind::state::PRESSED);
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0xe4e4_e7ff)
    );
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 0.5);
    c.set_states(2, 0);
    let batch = c.commit().unwrap();
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 1.0);
}

#[test]
fn a_node_joining_a_group_in_a_state_reads_it() {
    let mut c = core();
    view_with_classes(&mut c, 2, "group");
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Native(NativeProp::Disabled(true)),
        }],
    );
    c.commit().unwrap();
    // A row inserted into the group after it was disabled reads its state.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "h-4 opacity-100 group-disabled:opacity-40"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 0.4);
    // Moved out of the group, it drops it.
    apply(
        &mut c,
        vec![Op::Insert {
            parent: ROOT_ID,
            child: 3,
            before: None,
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 1.0);
}

#[test]
fn untracked_states_are_forgotten() {
    use crate::tailwind::state::{HOVERED, PRESSED};
    // A sidebar row: `hover:` while not selected, plain once selected.
    let mut c = core();
    view_with_classes(&mut c, 2, "bg-white hover:bg-zinc-200");
    c.commit().unwrap();
    c.set_states(2, HOVERED | PRESSED);
    c.commit().unwrap();
    // Selected: nothing reads the states, so the platform stops reporting
    // them and the pointer leaves unreported.
    apply(&mut c, vec![class_op(2, "bg-zinc-500")]);
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::TrackStates { id: 2, states: 0 }))
    );
    // Not selected again: no stale hover.
    apply(&mut c, vec![class_op(2, "bg-white hover:bg-zinc-200")]);
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0xffff_ffff)
    );
}

#[test]
fn text_inherits_from_views_and_classes_set_props() {
    let mut c = core();
    view_with_classes(&mut c, 2, "text-white text-lg text-center");
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::Text,
            },
            class_op(3, "line-clamp-2 font-bold"),
            Op::CreateText {
                id: 4,
                text: "hello".into(),
            },
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let text = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { id: 3, text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text.spans[0].style.color, Color(0xffff_ffff));
    assert_eq!(text.spans[0].style.font_size, Points(18.0));
    assert_eq!(text.spans[0].style.font_weight, 700);
    assert_eq!(text.align, TextAlign::Center);
    assert_eq!(text.max_lines, 2);
    // A container's text style change reaches the text inside.
    c.apply(class_op(2, "text-black text-lg")).unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(i, MountItem::Text { id: 3, text, .. } if text.spans[0].style.color == Color(0x0000_00ff))));
}

#[test]
fn texts_inherit_white_space_and_user_select_from_views() {
    let mut c = core();
    view_with_classes(&mut c, 2, "whitespace-nowrap select-text");
    let mut ops = Vec::new();
    for (id, classes) in [
        (3, ""),
        (5, "select-none whitespace-normal"),
        (7, "select-none md:select-auto"),
    ] {
        ops.extend([
            Op::Create { id, tag: Tag::Text },
            class_op(id, classes),
            Op::CreateText {
                id: id + 1,
                text: "hello".into(),
            },
            Op::Insert {
                parent: id,
                child: id + 1,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: id,
                before: None,
            },
        ]);
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let text = |batch: &MountBatch, id| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Text { id: i, text, .. } if *i == id => {
                Some((text.no_wrap, text.selectable))
            }
            _ => None,
        })
    };
    // As CSS's `white-space` and `user-select: auto`, a view's reach the
    // texts in it; a text's own win.
    assert_eq!(text(&batch, 3), Some((true, Some(true))));
    assert_eq!(text(&batch, 5), Some((false, Some(false))));
    assert_eq!(text(&batch, 7), Some((true, Some(false))));
    // `select-auto` takes the view's again (the window is 320 wide; at md
    // it applies).
    c.set_viewport(size_pt(800.0, 480.0));
    let batch = c.commit().unwrap();
    assert_eq!(text(&batch, 7), Some((true, Some(true))));
    // The view's change reaches them.
    c.apply(class_op(2, "truncate")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(text(&batch, 3), Some((true, None)));
}

#[test]
fn selection_classes_reach_the_texts_inside() {
    let mut c = core();
    view_with_classes(&mut c, 2, "selection:bg-red-500");
    let mut ops = Vec::new();
    for (id, classes) in [(3, "select-text"), (5, "select-text selection:bg-blue-500")] {
        ops.extend([
            Op::Create { id, tag: Tag::Text },
            class_op(id, classes),
            Op::CreateText {
                id: id + 1,
                text: "hello".into(),
            },
            Op::Insert {
                parent: id,
                child: id + 1,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: id,
                before: None,
            },
        ]);
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let highlight = |batch: &MountBatch, id| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Text { id: i, text, .. } if *i == id => Some(text.selection_color),
            _ => None,
        })
    };
    // Tailwind's `& *::selection`: the view's reaches the texts in it; a
    // text's own wins.
    assert_eq!(highlight(&batch, 3), Some(Some(Color(0xfb2c_36ff))));
    assert_eq!(highlight(&batch, 5), Some(Some(Color(0x2b7f_ffff))));
    c.apply(class_op(2, "")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(highlight(&batch, 3), Some(None));
}

#[test]
fn pointer_events_classes_inherit_as_in_css() {
    use crate::props::PointerEvents as P;
    let mut c = core();
    // 2 none { 3 { 4 }, 5 auto { 6 } }
    view_with_classes(&mut c, 2, "pointer-events-none");
    let mut ops = Vec::new();
    for (id, parent, classes) in [
        (3, 2, "p-1"),
        (4, 3, "p-1"),
        (5, 2, "pointer-events-auto"),
        (6, 5, "p-1"),
    ] {
        ops.extend([
            Op::Create { id, tag: Tag::View },
            class_op(id, classes),
            Op::Insert {
                parent,
                child: id,
                before: None,
            },
        ]);
    }
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let pointer = |batch: &MountBatch, id| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id: i, props } if *i == id => Some(props.pointer_events),
            _ => None,
        })
    };
    // 2 lets touches through to 5, which takes them; 3 is no target, and
    // blocks 4.
    assert_eq!(pointer(&batch, 2), Some(P::BoxNone));
    assert_eq!(pointer(&batch, 3), Some(P::None));
    assert_eq!(pointer(&batch, 4), None);
    assert_eq!(pointer(&batch, 5), None);
    assert_eq!(pointer(&batch, 6), None);
    // Without the `auto`, 2 blocks the whole subtree.
    c.apply(class_op(5, "p-1")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(pointer(&batch, 2), Some(P::None));
    assert_eq!(pointer(&batch, 3), Some(P::Auto));
    // An `auto` moved in brings `box-none` back; moved out, `none`.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 7,
                tag: Tag::View,
            },
            class_op(7, "pointer-events-auto"),
            Op::Insert {
                parent: 4,
                child: 7,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(pointer(&batch, 2), Some(P::BoxNone));
    assert_eq!(pointer(&batch, 3), Some(P::BoxNone));
    assert_eq!(pointer(&batch, 4), Some(P::BoxNone));
    assert_eq!(pointer(&batch, 5), Some(P::None));
    c.apply(Op::Remove {
        parent: 4,
        child: 7,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(pointer(&batch, 2), Some(P::None));
    assert_eq!(pointer(&batch, 4), Some(P::Auto));
    // The `pointerEvents` prop keeps React Native's meaning, and wins.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::PointerEvents(P::BoxOnly),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(pointer(&batch, 2), Some(P::BoxOnly));
}

#[test]
fn sibling_positions() {
    let mut c = core();
    view_with_classes(&mut c, 2, "flex-row");
    for id in 3..6 {
        apply(
            &mut c,
            vec![
                Op::Create { id, tag: Tag::View },
                class_op(id, "w-2 h-2 bg-red-500 first:bg-green-500 last:bg-blue-500"),
                Op::Insert {
                    parent: 2,
                    child: id,
                    before: None,
                },
            ],
        );
    }
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 3).unwrap().background_color,
        Color(0x00c9_50ff)
    );
    assert_eq!(
        view_style_of(&batch, 4).unwrap().background_color,
        Color(0xfb2c_36ff)
    );
    assert_eq!(
        view_style_of(&batch, 5).unwrap().background_color,
        Color(0x2b7f_ffff)
    );
    // Removing the last child makes the middle one last.
    c.apply(Op::Remove {
        parent: 2,
        child: 5,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 4).unwrap().background_color,
        Color(0x2b7f_ffff)
    );
}

#[test]
fn text_inherits_a_rows_positional_classes() {
    let mut c = core();
    view_with_classes(&mut c, 2, "");
    let add_row = |c: &mut Core<FakeEngine>, row: NodeId| {
        apply(
            c,
            vec![
                Op::Create {
                    id: row,
                    tag: Tag::View,
                },
                class_op(row, "text-black last:text-white"),
                Op::Create {
                    id: row + 1,
                    tag: Tag::Text,
                },
                Op::CreateText {
                    id: row + 2,
                    text: "label".into(),
                },
                Op::Insert {
                    parent: row + 1,
                    child: row + 2,
                    before: None,
                },
                Op::Insert {
                    parent: row,
                    child: row + 1,
                    before: None,
                },
                Op::Insert {
                    parent: 2,
                    child: row,
                    before: None,
                },
            ],
        );
    };
    let color = |batch: &MountBatch, id: NodeId| {
        batch.items.iter().find_map(|i| match i {
            MountItem::Text { id: t, text, .. } if *t == id => Some(text.spans[0].style.color),
            _ => None,
        })
    };
    add_row(&mut c, 10);
    add_row(&mut c, 20);
    let batch = c.commit().unwrap();
    assert_eq!(color(&batch, 11), Some(Color(0x0000_00ff)));
    assert_eq!(color(&batch, 21), Some(Color(0xffff_ffff)));
    // A row after it: the label of the row that was last turns back.
    add_row(&mut c, 30);
    let batch = c.commit().unwrap();
    assert_eq!(color(&batch, 21), Some(Color(0x0000_00ff)));
    assert_eq!(color(&batch, 31), Some(Color(0xffff_ffff)));
}

#[test]
fn fractional_translations_follow_the_size() {
    let mut c = core();
    view_with_classes(&mut c, 2, "w-20 h-10 -translate-x-1/2 translate-y-full");
    let batch = c.commit().unwrap();
    let v = view_style_of(&batch, 2).unwrap();
    let ops = v.transform.ops();
    assert_eq!(
        (ops[0].kind, ops[0].value),
        (crate::TransformKind::TranslateX, -40.0)
    );
    assert_eq!(
        (ops[1].kind, ops[1].value),
        (crate::TransformKind::TranslateY, 40.0)
    );
    c.apply(class_op(2, "w-40 h-10 -translate-x-1/2 translate-y-full"))
        .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().transform.ops()[0].value,
        -80.0
    );
}

#[test]
fn disabled_views_take_no_presses() {
    let mut c = core();
    view_with_classes(&mut c, 2, "disabled:opacity-40");
    let press = |enabled| Op::Listen {
        id: 2,
        event: EventKind::Press,
        enabled,
    };
    let disabled = |d| Op::SetProp {
        id: 2,
        prop: Prop::Native(NativeProp::Disabled(d)),
    };
    let events_of = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Events { id: 2, events } => Some(*events),
            _ => None,
        })
    };
    apply(&mut c, vec![press(true), disabled(true)]);
    let batch = c.commit().unwrap();
    assert!(!events_of(&batch).unwrap().contains(EventKind::Press));
    assert_eq!(view_style_of(&batch, 2).unwrap().opacity, 0.4);
    apply(&mut c, vec![disabled(false)]);
    let batch = c.commit().unwrap();
    assert!(events_of(&batch).unwrap().contains(EventKind::Press));
    assert_eq!(view_style_of(&batch, 2).unwrap().opacity, 1.0);
}

/// A view that takes no presses unmounts its other listeners when it is
/// disabled too: a secondary click goes on to the listener around it.
#[test]
fn disabled_views_hear_no_context_menus_or_file_drops() {
    let mut c = core();
    view_with_classes(&mut c, 2, "disabled:opacity-40");
    let disabled = |d| Op::SetProp {
        id: 2,
        prop: Prop::Native(NativeProp::Disabled(d)),
    };
    let events_of = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Events { id: 2, events } => Some(*events),
            _ => None,
        })
    };
    apply(
        &mut c,
        [EventKind::ContextMenu, EventKind::FileDrop]
            .into_iter()
            .map(|event| Op::Listen {
                id: 2,
                event,
                enabled: true,
            })
            .collect(),
    );
    let batch = c.commit().unwrap();
    let events = events_of(&batch).unwrap();
    assert!(events.contains(EventKind::ContextMenu) && events.contains(EventKind::FileDrop));
    apply(&mut c, vec![disabled(true)]);
    let batch = c.commit().unwrap();
    assert!(events_of(&batch).unwrap().is_empty());
    apply(&mut c, vec![disabled(false)]);
    let batch = c.commit().unwrap();
    let events = events_of(&batch).unwrap();
    assert!(events.contains(EventKind::ContextMenu) && events.contains(EventKind::FileDrop));
}

/// A style patch of `decls` (`activeStyle={{ … }}`).
fn patch(decls: &[(&str, crate::StyleValue<'_>)]) -> Option<Arc<crate::StylePatch>> {
    let mut style = crate::Style::default();
    let mut patch = crate::StylePatch::default();
    for (key, value) in decls {
        patch.set(&mut style, key, *value).unwrap();
    }
    Some(Arc::new(patch))
}

#[test]
fn disabled_views_are_disabled_for_screen_readers() {
    let mut c = core();
    view_with_classes(&mut c, 2, "");
    let disabled = |d| Op::SetProp {
        id: 2,
        prop: Prop::Native(NativeProp::Disabled(d)),
    };
    let state_of = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::ViewProps { id: 2, props } => Some(props.accessibility.state.disabled),
            _ => None,
        })
    };
    apply(&mut c, vec![disabled(true)]);
    assert_eq!(state_of(&c.commit().unwrap()), Some(true));
    apply(&mut c, vec![disabled(false)]);
    assert_eq!(state_of(&c.commit().unwrap()), Some(false));
    // The app's own state stays when `disabled` is off.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Accessibility(AccessibilityProp::State(crate::AccessibilityState {
                disabled: true,
                ..Default::default()
            })),
        }],
    );
    assert_eq!(state_of(&c.commit().unwrap()), Some(true));
}

#[test]
fn active_style_applies_while_pressed_and_not_disabled() {
    use crate::{StyleValue as V, tailwind::state};
    let mut c = core();
    view_with_classes(&mut c, 2, "bg-white");
    apply(
        &mut c,
        vec![
            // The inline style is under it.
            Op::SetStyle {
                id: 2,
                style: Box::default(),
                patch: {
                    let mut s = crate::Style::default();
                    let mut p = crate::StylePatch::default();
                    p.set(&mut s, "opacity", V::Number(0.9)).unwrap();
                    p
                },
            },
            Op::SetProp {
                id: 2,
                prop: Prop::ActiveStyle(patch(&[
                    ("backgroundColor", V::Str("#dddddd")),
                    ("opacity", V::Number(0.5)),
                ])),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::DisabledStyle(patch(&[("opacity", V::Number(0.3))])),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::TrackStates { id: 2, states } if *states == state::PRESSED
    )));
    assert_eq!(view_style_of(&batch, 2).unwrap().opacity, 0.9);
    c.set_states(2, state::PRESSED);
    let batch = c.commit().unwrap();
    let style = view_style_of(&batch, 2).unwrap();
    assert_eq!(style.background_color, Color(0xdddd_ddff));
    assert_eq!(style.opacity, 0.5);
    c.set_states(2, 0);
    let batch = c.commit().unwrap();
    let style = view_style_of(&batch, 2).unwrap();
    assert_eq!(style.background_color, Color(0xffff_ffff));
    assert_eq!(style.opacity, 0.9);
    // Disabled: no active style, the disabled one.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Native(NativeProp::Disabled(true)),
        }],
    );
    c.set_states(2, state::PRESSED);
    let batch = c.commit().unwrap();
    let style = view_style_of(&batch, 2).unwrap();
    assert_eq!(style.background_color, Color(0xffff_ffff));
    assert_eq!(style.opacity, 0.3);
    // Removed: the classes alone.
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::Native(NativeProp::Disabled(false)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::ActiveStyle(None),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(
        view_style_of(&batch, 2).unwrap().background_color,
        Color(0xffff_ffff)
    );
}

#[test]
fn selected_style_follows_the_accessibility_state() {
    use crate::{AccessibilityProp, AccessibilityState, StyleValue as V};
    let mut c = core();
    view_with_classes(&mut c, 2, "bg-white selected:bg-black");
    let selected = |on| Op::SetProp {
        id: 2,
        prop: Prop::Accessibility(AccessibilityProp::State(AccessibilityState {
            selected: on,
            ..AccessibilityState::default()
        })),
    };
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::SelectedStyle(patch(&[("opacity", V::Number(0.7))])),
            },
            selected(true),
        ],
    );
    let batch = c.commit().unwrap();
    let style = view_style_of(&batch, 2).unwrap();
    assert_eq!(style.background_color, Color(0x0000_00ff));
    assert_eq!(style.opacity, 0.7);
    // The platform never tracks it.
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::TrackStates { .. }))
    );
    apply(&mut c, vec![selected(false)]);
    let batch = c.commit().unwrap();
    let style = view_style_of(&batch, 2).unwrap();
    assert_eq!(style.background_color, Color(0xffff_ffff));
    assert_eq!(style.opacity, 1.0);
}

#[test]
fn checked_style_follows_the_accessibility_state() {
    use crate::{AccessibilityProp, AccessibilityState, Checked, StyleValue as V};
    // A switch: the track by its checked state, the thumb by its group's.
    let mut c = core();
    view_with_classes(
        &mut c,
        2,
        "group bg-zinc-200 checked:bg-emerald-500 selected:opacity-50",
    );
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "h-4 w-4 group-checked:translate-x-4"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let state = |checked, selected| Op::SetProp {
        id: 2,
        prop: Prop::Accessibility(AccessibilityProp::State(AccessibilityState {
            checked,
            selected,
            ..AccessibilityState::default()
        })),
    };
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::CheckedStyle(patch(&[("opacity", V::Number(0.7))])),
            },
            state(Some(Checked::True), false),
        ],
    );
    let batch = c.commit().unwrap();
    let track = view_style_of(&batch, 2).unwrap();
    assert_eq!(track.background_color, Color(0x00bc_7dff));
    assert_eq!(track.opacity, 0.7);
    assert_eq!(
        view_style_of(&batch, 3).unwrap().transform.ops()[0].value,
        16.0
    );
    // The platform never tracks it.
    assert!(!batch.items.iter().any(|i| matches!(
        i,
        MountItem::TrackStates { id: 2, states } if states & crate::tailwind::state::CHECKED != 0
    )));
    // Mixed is not checked; selected changing with it is applied too.
    apply(&mut c, vec![state(Some(Checked::Mixed), true)]);
    let batch = c.commit().unwrap();
    let track = view_style_of(&batch, 2).unwrap();
    assert_eq!(track.background_color, Color(0xe4e4_e7ff));
    assert_eq!(track.opacity, 0.5);
    assert!(view_style_of(&batch, 3).unwrap().transform.ops().is_empty());
}

#[test]
fn indeterminate_style_follows_the_accessibility_state() {
    use crate::{AccessibilityProp, AccessibilityState, Checked, StyleValue as V};
    // A checkbox: the box by its mixed state, the mark by its group's.
    let mut c = core();
    view_with_classes(
        &mut c,
        2,
        "group bg-zinc-200 checked:bg-emerald-500 indeterminate:bg-black",
    );
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "h-4 w-4 group-indeterminate:opacity-50"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
        ],
    );
    let state = |checked| Op::SetProp {
        id: 2,
        prop: Prop::Accessibility(AccessibilityProp::State(AccessibilityState {
            checked,
            ..AccessibilityState::default()
        })),
    };
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::IndeterminateStyle(patch(&[("opacity", V::Number(0.7))])),
            },
            state(Some(Checked::Mixed)),
        ],
    );
    let batch = c.commit().unwrap();
    let mixed = view_style_of(&batch, 2).unwrap();
    assert_eq!(mixed.background_color, Color(0x0000_00ff));
    assert_eq!(mixed.opacity, 0.7);
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 0.5);
    // The platform never tracks it.
    assert!(!batch.items.iter().any(|i| matches!(
        i,
        MountItem::TrackStates { id: 2, states }
            if states & crate::tailwind::state::INDETERMINATE != 0
    )));
    // Checked is not indeterminate.
    apply(&mut c, vec![state(Some(Checked::True))]);
    let batch = c.commit().unwrap();
    let checked = view_style_of(&batch, 2).unwrap();
    assert_eq!(checked.background_color, Color(0x00bc_7dff));
    assert_eq!(checked.opacity, 1.0);
    assert_eq!(view_style_of(&batch, 3).unwrap().opacity, 1.0);
}

#[test]
fn projected_states_style_a_part_without_its_accessibility() {
    use crate::tailwind::state;
    // A switch's thumb: styled by the switch's value and disabled state,
    // with no accessibility state or listeners of its own.
    let mut c = core();
    view_with_classes(
        &mut c,
        2,
        "h-4 w-4 checked:translate-x-4 disabled:opacity-50",
    );
    let projected = |states| Op::SetProp {
        id: 2,
        prop: Prop::ProjectedStates(states),
    };
    apply(&mut c, vec![projected(state::CHECKED | state::DISABLED)]);
    let batch = c.commit().unwrap();
    let thumb = view_style_of(&batch, 2).unwrap();
    assert_eq!(thumb.transform.ops()[0].value, 16.0);
    assert_eq!(thumb.opacity, 0.5);
    assert!(
        !batch.items.iter().any(|i| matches!(
            i,
            MountItem::ViewProps { id: 2, .. } | MountItem::Events { id: 2, .. }
        )),
        "{:?}",
        batch.items
    );
    apply(&mut c, vec![projected(0)]);
    let batch = c.commit().unwrap();
    let thumb = view_style_of(&batch, 2).unwrap();
    assert!(thumb.transform.ops().is_empty());
    assert_eq!(thumb.opacity, 1.0);
}

#[test]
fn input_accessories_are_found_by_native_id() {
    let mut c = core();
    let accessory = |batch: &MountBatch| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Input { id: 2, config } => Some(config.accessory),
            _ => None,
        })
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Input,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::InputAccessoryViewId(Some("bar".into())),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(accessory(&batch), Some(None));
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::InputAccessory,
            },
            Op::SetProp {
                id: 3,
                prop: Prop::NativeId(Some("bar".into())),
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::SetStyle {
                id: 4,
                style: style(&[("height", StyleValue::Number(44.0))]),
                patch: Default::default(),
            },
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 3,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(accessory(&batch), Some(Some(3)));
    // As wide as the window, as tall as its content.
    let frame = frame_of(&batch, 3).unwrap();
    assert_eq!((frame.size.width.0, frame.size.height.0), (320.0, 44.0));
    apply(
        &mut c,
        vec![Op::Remove {
            parent: ROOT_ID,
            child: 3,
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(accessory(&batch), Some(None));
}

#[test]
fn inputs_report_their_content_size() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Input,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Multiline(true),
            },
            Op::SetStyle {
                id: 2,
                style: style(&[("width", StyleValue::Number(100.0))]),
                patch: Default::default(),
            },
            Op::Listen {
                id: 2,
                event: EventKind::ContentSizeChange,
                enabled: true,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let sizes = |c: &mut Core<FakeEngine>| {
        js_events(c)
            .into_iter()
            .filter(|(id, kind, _)| *id == 2 && *kind == EventKind::ContentSizeChange)
            .count()
    };
    c.commit().unwrap();
    assert_eq!(sizes(&mut c), 1);
    // Typing a long text wraps it: taller.
    c.input_changed(2, &"x".repeat(80), 1);
    c.commit();
    assert_eq!(sizes(&mut c), 1);
    // The same text again: no event.
    c.input_changed(2, &"x".repeat(80), 2);
    c.commit();
    assert_eq!(sizes(&mut c), 0);
}

#[test]
fn input_text_does_not_extend_its_ancestor_scroll_view() {
    for dimension in ["height", "maxHeight"] {
        let mut c = core();
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::Scroll,
                },
                style_op(
                    2,
                    &[
                        ("width", StyleValue::Number(200.0)),
                        ("height", StyleValue::Number(128.0)),
                    ],
                ),
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                Op::Create {
                    id: 3,
                    tag: Tag::Input,
                },
                Op::SetProp {
                    id: 3,
                    prop: Prop::Multiline(true),
                },
                Op::SetProp {
                    id: 3,
                    prop: Prop::Value("x".repeat(280)),
                },
                Op::Listen {
                    id: 3,
                    event: EventKind::ContentSizeChange,
                    enabled: true,
                },
                style_op(
                    3,
                    &[
                        ("width", StyleValue::Number(160.0)),
                        (dimension, StyleValue::Number(64.0)),
                        ("padding", StyleValue::Number(8.0)),
                        ("borderWidth", StyleValue::Number(2.0)),
                    ],
                ),
                Op::Insert {
                    parent: 2,
                    child: 3,
                    before: None,
                },
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                style_op(4, &[("height", StyleValue::Number(96.0))]),
                Op::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
            ],
        );
        let content = |batch: &MountBatch| {
            batch.items.iter().find_map(|item| match item {
                MountItem::ScrollContent { id: 2, size } => Some(*size),
                _ => None,
            })
        };
        let text_sizes = |c: &mut Core<FakeEngine>| {
            js_events(c)
                .into_iter()
                .filter(|(id, kind, _)| *id == 3 && *kind == EventKind::ContentSizeChange)
                .map(|(_, _, payload)| payload)
                .collect::<Vec<_>>()
        };
        let text_size = |height| {
            vec![EventPayload::Map(vec![
                ("width", PayloadValue::Number(140.0)),
                ("height", PayloadValue::Number(height)),
            ])]
        };
        let batch = c.commit().unwrap();
        assert_eq!(frame_of(&batch, 3), Some(rect(0.0, 0.0, 160.0, 64.0)));
        assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 64.0, 200.0, 96.0)));
        assert_eq!(content(&batch), Some(size_pt(200.0, 160.0)), "{dimension}");
        assert_eq!(text_sizes(&mut c), text_size(256.0));

        // Typing retains the complete editor content, while only the real
        // footer growth extends the ancestor's scrollable area.
        c.input_changed(3, &"x".repeat(560), 1);
        apply(
            &mut c,
            vec![style_op(4, &[("height", StyleValue::Number(112.0))])],
        );
        let batch = c.commit().unwrap();
        assert_eq!(c.measure(3).unwrap().frame, rect(0.0, 0.0, 160.0, 64.0));
        assert_eq!(content(&batch), Some(size_pt(200.0, 176.0)), "{dimension}");
        assert_eq!(text_sizes(&mut c), text_size(512.0));
    }
}

#[test]
fn fixed_size_inputs_report_their_content_size() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Input,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Placeholder("A much longer placeholder".into()),
            },
            Op::SetStyle {
                id: 2,
                style: style(&[
                    ("width", StyleValue::Number(200.0)),
                    ("height", StyleValue::Number(40.0)),
                ]),
                patch: Default::default(),
            },
            Op::Listen {
                id: 2,
                event: EventKind::ContentSizeChange,
                enabled: true,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let sizes = |c: &mut Core<FakeEngine>| {
        js_events(c)
            .into_iter()
            .filter(|(id, kind, _)| *id == 2 && *kind == EventKind::ContentSizeChange)
            .map(|(_, _, p)| p)
            .collect::<Vec<_>>()
    };
    let size = |width: f64, height: f64| {
        vec![EventPayload::Map(vec![
            ("width", PayloadValue::Number(width)),
            ("height", PayloadValue::Number(height)),
        ])]
    };
    let frame = |batch: &MountBatch| {
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Frame { id: 2, .. }))
    };
    // Sized by its placeholder, an empty input reports an empty line (the
    // fake engine gives its zero-width space a width).
    let batch = c.commit().unwrap();
    assert!(frame(&batch));
    assert_eq!(sizes(&mut c), size(8.0, 16.0));
    // Its frame stays as the user types; its text's size is reported.
    for (count, (text, width)) in [("ab", 16.0), ("abc", 24.0)].into_iter().enumerate() {
        c.input_changed(2, text, count as u32 + 1);
        assert!(c.commit().is_none_or(|b| !frame(&b)));
        assert_eq!(sizes(&mut c), size(width, 16.0), "{text:?}");
    }
    // A value that reads as the placeholder: its own size.
    c.input_changed(2, "A much longer placeholder", 3);
    c.commit();
    assert_eq!(sizes(&mut c), size(200.0, 16.0));
    c.input_changed(2, "", 4);
    c.commit();
    assert_eq!(sizes(&mut c), size(8.0, 16.0));
    // Nothing changed: nothing reported, nothing measured or mounted.
    c.input_changed(2, "", 5);
    assert!(c.commit().is_none());
    assert_eq!(sizes(&mut c), Vec::new());
}

#[test]
fn text_shrinks_to_fit_its_lines() {
    let mut c = Core::new(crate::text::ApproxTextEngine, size_pt(320.0, 480.0));
    let ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::Text,
        },
        Op::SetStyle {
            id: 2,
            style: style(&[
                ("width", StyleValue::Number(60.0)),
                ("fontSize", StyleValue::Number(20.0)),
            ]),
            patch: Default::default(),
        },
        Op::SetProp {
            id: 2,
            prop: Prop::NumberOfLines(1),
        },
        Op::SetProp {
            id: 2,
            prop: Prop::AdjustsFontSizeToFit(true),
        },
        Op::CreateText {
            id: 3,
            text: "Hello world".into(),
        },
        Op::Insert {
            parent: 2,
            child: 3,
            before: None,
        },
        Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        },
    ];
    for op in ops {
        c.apply(op).unwrap();
    }
    let batch = c.commit().unwrap();
    let size = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { id: 2, text, .. } => Some(text.spans[0].style.font_size.0),
            _ => None,
        })
        .unwrap();
    // 11 characters at 0.55 em in 60pt: at most ~9.9pt.
    assert!(size < 10.0 && size > 9.0, "{size}");
}

#[test]
fn views_inside_text_are_attachments() {
    let mut c = core();
    let raw = |id, text: &str| Op::CreateText {
        id,
        text: text.into(),
    };
    let insert = |parent, child| Op::Insert {
        parent,
        child,
        before: None,
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            raw(3, "ab"),
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            style_op(
                4,
                &[
                    ("width", StyleValue::Number(20.0)),
                    ("height", StyleValue::Number(10.0)),
                    ("padding", StyleValue::Number(2.0)),
                ],
            ),
            Op::Create {
                id: 5,
                tag: Tag::View,
            },
            style_op(5, &[("height", StyleValue::Number(3.0))]),
            insert(4, 5),
            // A span holding an image (inside a span still attaches to the
            // block).
            Op::Create {
                id: 6,
                tag: Tag::Text,
            },
            raw(7, "cd"),
            Op::Create {
                id: 8,
                tag: Tag::Image,
            },
            style_op(
                8,
                &[
                    ("width", StyleValue::Number(12.0)),
                    ("height", StyleValue::Number(12.0)),
                ],
            ),
            insert(6, 7),
            insert(6, 8),
            insert(2, 3),
            insert(2, 4),
            insert(2, 6),
            style_op(2, &[("padding", StyleValue::Number(5.0))]),
            insert(ROOT_ID, 2),
        ],
    );
    let batch = c.commit().unwrap();
    let text = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { id: 2, text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text.text, "ab\u{FFFC}cd\u{FFFC}");
    assert_eq!(
        text.attachments,
        vec![
            crate::TextAttachment {
                index: 2,
                width: Points(20.0),
                height: Points(10.0),
            },
            crate::TextAttachment {
                index: 5,
                width: Points(12.0),
                height: Points(12.0),
            },
        ]
    );
    // Their views go inside the text view, on their placeholders.
    let inserts: Vec<_> = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert {
                parent: 2, child, ..
            } => Some(*child),
            _ => None,
        })
        .collect();
    assert_eq!(inserts, vec![4, 8]);
    assert_eq!(
        frame_of(&batch, 4),
        Some(rect(5.0 + 16.0, 5.0 + 2.0, 20.0, 10.0))
    );
    assert_eq!(frame_of(&batch, 8).map(|f| f.origin.x.0), Some(5.0 + 40.0));
    // The attachment's own subtree is laid out inside it.
    assert_eq!(frame_of(&batch, 5), Some(rect(2.0, 2.0, 16.0, 3.0)));

    // Growing an attachment builds the text again.
    apply(
        &mut c,
        vec![style_op(
            4,
            &[
                ("width", StyleValue::Number(30.0)),
                ("height", StyleValue::Number(10.0)),
            ],
        )],
    );
    let batch = c.commit().unwrap();
    let text = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { id: 2, text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text.attachments[0].width, Points(30.0));
    assert_eq!(frame_of(&batch, 4).map(|f| f.size.width.0), Some(30.0));

    // `verticalAlign` builds the text again: the engine places it.
    let align_of = |c: &mut Core<FakeEngine>, align: &str| {
        apply(
            c,
            vec![style_op(4, &[("verticalAlign", StyleValue::Str(align))])],
        );
        let batch = c.commit()?;
        if !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Text { id: 2, .. }))
        {
            return None;
        }
        let layout = c.nodes[c.key(2).unwrap() as usize].layout.unwrap();
        let cx = c.text_cx(layout);
        Some(cx.alignments.get(cx.text.attachments[0].index))
    };
    assert_eq!(
        align_of(&mut c, "text-top"),
        Some(crate::VerticalAlign::TextTop)
    );
    assert_eq!(
        align_of(&mut c, "middle"),
        Some(crate::VerticalAlign::Middle)
    );
    // Unchanged: nothing to build.
    assert_eq!(align_of(&mut c, "middle"), None);
    assert_eq!(
        align_of(&mut c, "baseline"),
        Some(crate::VerticalAlign::Baseline)
    );

    // Taken out of the text: its view leaves the text view.
    apply(
        &mut c,
        vec![Op::Remove {
            parent: 2,
            child: 4,
        }],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id: 4 }))
    );
    let text = batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Text { id: 2, text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(text.text, "abcd\u{FFFC}");
    assert_eq!(frame_of(&batch, 8).map(|f| f.origin.x.0), Some(5.0 + 32.0));

    // The image's real placeholder represents its complete source syntax.
    // Other text in the same paragraph has no source mapping here, so only
    // that actual attachment can keep the reader's source position.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 20,
                tag: Tag::List,
            },
            style_op(20, &[("height", StyleValue::Number(100.0))]),
            Op::SetProp {
                id: 20,
                prop: Prop::Count(1),
            },
            insert(ROOT_ID, 20),
        ],
    );
    c.commit();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 22,
                tag: Tag::Cell,
            },
            Op::SetProp {
                id: 22,
                prop: Prop::Slot(CellSlot::Item(0)),
            },
            insert(20, 22),
            Op::Create {
                id: 24,
                tag: Tag::View,
            },
            style_op(24, &[("height", StyleValue::Number(400.0))]),
            insert(22, 24),
            Op::Remove {
                parent: ROOT_ID,
                child: 2,
            },
            insert(22, 2),
            Op::Create {
                id: 26,
                tag: Tag::View,
            },
            style_op(26, &[("height", StyleValue::Number(400.0))]),
            insert(22, 26),
            Op::SetProp {
                id: 6,
                prop: Prop::TextSource(Some(Arc::new(crate::TextSource::Mapped {
                    id: "message/body".into(),
                    segments: vec![crate::TextSourceSegment {
                        start: 2,
                        end: 3,
                        source_start: 100,
                        source_end: 120,
                        kind: crate::TextSourceKind::Replacement,
                    }],
                }))),
            },
            Op::SetProp {
                id: 22,
                prop: Prop::CellIndex(0),
            },
        ],
    );
    c.commit();
    let shift = |batch: Option<MountBatch>| -> f32 {
        batch.map_or(0.0, |batch| {
            batch
                .items
                .iter()
                .filter_map(|item| match item {
                    MountItem::ScrollBy { id: 20, dy, .. } => Some(dy.0),
                    _ => None,
                })
                .sum()
        })
    };
    c.set_scroll_offset(20, point(px(0.0), px(405.0)), 0);
    assert_eq!(shift(c.commit()), 0.0);
    c.apply(style_op(24, &[("height", StyleValue::Number(440.0))]))
        .unwrap();
    assert_eq!(shift(c.commit()), 40.0);

    // Removing the image removes that source seat too: no phantom caption
    // or stale attachment anchor remains to compensate later reflow.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: 6,
                child: 8,
            },
            style_op(24, &[("height", StyleValue::Number(480.0))]),
        ],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|item| matches!(item, MountItem::Text { id: 2, text, .. } if text.text == "abcd"))
    );
    assert_eq!(shift(Some(batch)), 0.0);
}

#[test]
fn node_quota_and_dense_ids() {
    let mut c = core();
    c.set_max_nodes(3);
    // The root is one node.
    for id in 2..4 {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
    }
    assert!(matches!(
        c.apply(Op::Create {
            id: 4,
            tag: Tag::View
        }),
        Err(ApplyError::TooManyNodes(3))
    ));
    let mut c = core();
    c.set_max_nodes(1000);
    // An id that would make the id table enormous.
    let err = c
        .apply(Op::Create {
            id: 4_000_000_000,
            tag: Tag::View,
        })
        .unwrap_err();
    assert!(matches!(err, ApplyError::IdOutOfRange(_)) && err.is_fatal());
}

#[test]
fn refused_urls_fail_and_send_nothing() {
    let mut c = core();
    c.set_access(Arc::new(crate::access::Access {
        declared: crate::access::Capabilities::from_json(
            &serde_json::json!({ "network": { "hosts": ["cdn.example.com"] } }),
        )
        .unwrap(),
        granted: None,
    }));
    let image = |id, uri: &str| {
        vec![
            Op::Create {
                id,
                tag: Tag::Image,
            },
            Op::Listen {
                id,
                event: EventKind::Error,
                enabled: true,
            },
            Op::SetProp {
                id,
                prop: Prop::Source(Some(ImageSource {
                    uri: uri.into(),
                    size: None,
                    scales: ImageScales::NONE,
                    data: None,
                })),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
        ]
    };
    let mut ops = image(2, "https://cdn.example.com/a.png");
    ops.extend(image(3, "https://tracker.io/pixel.gif"));
    ops.push(Op::Command {
        id: ROOT_ID,
        command: Command::StatusBar(Default::default()),
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let sources: Vec<_> = batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Image { id, source, .. } => {
                Some((*id, source.as_ref().map(|s| s.uri.to_string())))
            }
            _ => None,
        })
        .collect();
    // The refused image loads nothing.
    assert_eq!(
        sources,
        [
            (2, Some("https://cdn.example.com/a.png".to_owned())),
            (3, None)
        ]
    );
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Command { .. }))
    );
    let events = js_events(&mut c);
    assert!(matches!(
        &events[..],
        [(3, EventKind::Error, EventPayload::Error { message })] if message.contains("`tracker.io`")
    ));
}

mod components {
    use serde_json::json;

    use super::*;
    use crate::{
        Prop,
        ui::{Children, Event, Props, Registry, Slot, prelude::*},
    };

    /// Counts taps; shows `label` and the count; holds its JSX children.
    #[derive(Clone, PartialEq, Props)]
    struct TallyProps {
        #[prop(default = "Taps".into())]
        label: crate::ui::Prop<SharedString>,
        children: Children,
    }

    #[derive(Event)]
    enum TallyEvent {
        Tap { count: u32 },
    }

    #[component]
    fn Tally(props: TallyProps, cx: Scope<TallyEvent>) -> impl IntoElement {
        let taps = signal(0);
        view()
            .p_2()
            .on_press(move |_: &()| {
                taps.update(|t| *t += 1);
                cx.emit(TallyEvent::Tap {
                    count: taps.get_untracked(),
                });
            })
            .child(text(move || {
                format!("{} {}", props.label.get(), taps.get())
            }))
            .child(view().gap_1().child(props.children))
    }

    fn texts(batch: &MountBatch) -> Vec<String> {
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Text { text, .. } => Some(text.text.clone()),
                _ => None,
            })
            .collect()
    }

    /// Turns by what its ref's method says.
    #[derive(Default)]
    struct Knob;

    #[derive(Clone, PartialEq, Props)]
    struct KnobProps {}

    #[derive(Clone, Copy)]
    struct KnobApi {
        at: crate::ui::Signal<i32>,
    }

    #[crate::ui::methods]
    impl KnobApi {
        /// Turns it by `by`; where it is.
        pub(crate) fn turn(&self, by: i32) -> i32 {
            self.at.update(|at| *at += by);
            self.at.get_untracked()
        }

        /// Fails.
        pub(crate) fn stuck(&self) -> Result<(), String> {
            Err(format!("stuck at {}", self.at.get_untracked()))
        }
    }

    impl Component for Knob {
        type Props = KnobProps;
        type Event = crate::ui::NoEvent;
        const METHODS: crate::ui::Methods = crate::ui::Methods::of::<KnobApi>();

        fn view(_: KnobProps, cx: Scope<crate::ui::NoEvent>) -> impl IntoElement {
            let at = signal(0);
            cx.methods(KnobApi { at });
            text(move || format!("at {}", at.get()))
        }
    }

    #[test]
    fn methods_take_their_arguments_typed_and_answer_in_the_events() {
        use crate::ui::{RustCall, RustOp, json_host::JsonHost};
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Knob>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Knob>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        assert_eq!(texts(&c.commit().unwrap()), ["at 0"]);
        let methods = <KnobApi as crate::ui::Api>::METHODS;
        // Converted in the JS call: a value of another type fails there.
        let call = |method: usize, args| {
            let host = JsonHost::with_args(args);
            (methods[method].call)(&host)
        };
        assert!(call(0, vec![json!("x")]).is_err());
        for (n, (method, args, host)) in [
            (0, vec![json!(3)], 2),
            (1, vec![], 2),
            (0, vec![json!(1)], 40),
        ]
        .into_iter()
        .enumerate()
        {
            let Ok(run) = call(method, args) else {
                panic!("converts")
            };
            c.apply(Op::Rust(RustOp {
                call: n as u32 + 1,
                run: RustCall::Method(host, run),
            }))
            .unwrap();
        }
        assert_eq!(texts(&c.commit().unwrap()), ["at 3"]);
        let replies: Vec<_> = js_events(&mut c)
            .into_iter()
            .map(|(_, _, payload)| match payload {
                EventPayload::Native { data, .. } => data,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            replies,
            [
                json!({ "c": 1, "v": 3 }),
                json!({ "c": 2, "e": "stuck at 3" }),
                json!({ "c": 3, "e": "node 40 hosts no Rust component" }),
            ]
        );
    }

    thread_local! {
        /// The runs of `Echo`'s text binding.
        static ECHOES: Cell<usize> = const { Cell::new(0) };
    }

    /// Shows its label, counting the runs of the binding that reads it.
    #[derive(Default)]
    struct Echo;

    #[derive(Clone, PartialEq, Props)]
    struct EchoProps {
        #[prop(default)]
        label: crate::ui::Prop<SharedString>,
    }

    impl Component for Echo {
        type Props = EchoProps;
        type Event = crate::ui::NoEvent;

        fn view(props: EchoProps, _: Scope<crate::ui::NoEvent>) -> impl IntoElement {
            text(move || {
                ECHOES.with(|e| e.set(e.get() + 1));
                props.label.get()
            })
        }
    }

    #[test]
    fn a_prop_set_to_an_equal_value_runs_nothing() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Echo>();
        c.set_components(registry);
        let label = |v: &str| Op::SetProp {
            id: 2,
            prop: rust_prop::<EchoProps>("label", Some(json!(v))),
        };
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Echo>().into()),
                },
                label("a"),
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        assert_eq!(texts(&c.commit().unwrap()), ["a"]);
        let runs = ECHOES.with(Cell::get);
        // The same value again (a new decoded value, equal): nothing runs.
        apply(&mut c, vec![label("a")]);
        assert!(c.commit().is_none());
        assert_eq!(ECHOES.with(Cell::get), runs);
        apply(&mut c, vec![label("b")]);
        assert_eq!(texts(&c.commit().unwrap()), ["b"]);
        assert_eq!(ECHOES.with(Cell::get), runs + 1);
    }

    fn core_with_tally() -> Core<FakeEngine> {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Tally>();
        c.set_components(registry);
        c
    }

    /// A Rust app's root: mounted with no op from JS and no registration.
    #[test]
    fn a_rust_root_mounts_renders_and_handles_events() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Tally>(|| TallyProps {
            label: "Root".into(),
            children: Children::default(),
        }));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Root 0"]);
        let host = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: ROOT_ID,
                    child,
                    ..
                } => Some(*child),
                _ => None,
            })
            .expect("the root's host is in the root view");
        assert_eq!(host % 2, 1, "the core's own id");
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["Root 1"]);
    }

    #[test]
    fn components_render_handle_events_and_place_children() {
        let mut c = core_with_tally();
        let prop = |name: &'static str, value| Op::SetProp {
            id: 2,
            prop: rust_prop::<TallyProps>(name, Some(value)),
        };
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Tally>().into()),
                },
                prop("label", json!("Hits")),
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Hits 0"]);
        // Expanded nodes have odd ids; the JS child sits where the render
        // put `Children`, not in the host.
        let holder = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: 4, ..
                } => Some(*parent),
                _ => None,
            })
            .expect("JS child placed");
        assert!(holder % 2 == 1 && holder != 2);
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Create { id: 2, .. }))
        );

        // A press on the host goes to the component, which emits and
        // updates its text.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        let events = js_events(&mut c);
        assert_eq!(
            events,
            [(
                2,
                EventKind::NativeEvent,
                EventPayload::Native {
                    name: "tap".into(),
                    data: json!({ "count": 1 })
                }
            )]
        );
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Hits 1"]);

        // A prop change reaches what reads it; only what changed is sent.
        // Clearing a prop restores its default.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 2,
                prop: rust_prop::<TallyProps>("label", None),
            }],
        );
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Taps 1"]);
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Create { .. }))
        );
        // A value of the wrong type does not convert (JS warns and sends
        // nothing); one decoded for another type is refused (and logged),
        // nothing changes.
        let specs = <TallyProps as Props>::spec(&mut crate::ui::TsTypes::default());
        let decode = specs
            .iter()
            .find(|p| p.name == "label")
            .unwrap()
            .decode
            .unwrap();
        assert!(crate::ui::json_host::decode(decode, json!(3)).is_err());
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 2,
                prop: Prop::RustProp("label", Some(crate::ui::AnyValue::new(3.0f64))),
            }],
        );
        assert!(c.commit().is_none());

        // Unknown events on the host (no handler) are JS's.
        assert!(!c.component_event(2, EventKind::Layout, &EventPayload::None));

        // Releasing the host frees what it rendered; its JS child stays.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 2,
                },
                Op::Release { id: 2 },
            ],
        );
        let batch = c.commit().unwrap();
        let deleted: Vec<NodeId> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Delete { id } => Some(*id),
                _ => None,
            })
            .collect();
        assert!(deleted.contains(&2) && deleted.contains(&holder));
        assert!(!deleted.contains(&4));
        assert!(c.key(4).is_ok());
    }

    /// A header slot above its children.
    #[derive(Clone, Copy, PartialEq, Props)]
    struct CardProps {
        header: crate::ui::Prop<Option<Slot>>,
        children: Children,
    }

    #[component]
    fn Card(props: CardProps) -> impl IntoElement {
        let filled = move || props.header.with(Option::is_some);
        view().child(props.header.place(|h| h.h(px(44.0)))).child(
            view()
                .mt_0()
                .style_when(filled, |v| v.mt_2())
                .child(props.children),
        )
    }

    /// Children above a footer slot.
    #[derive(Clone, Copy, PartialEq, Props)]
    struct PanelProps {
        footer: crate::ui::Prop<Option<Slot>>,
        children: Children,
    }

    #[component]
    fn Panel(props: PanelProps) -> impl IntoElement {
        view()
            .child(props.children)
            .child(props.footer.place(|f| f))
    }

    /// JS children come after the view is made (lazy ones, later ones) and
    /// go before what follows their place: a region (the footer's slot)
    /// that is empty then, and its node once it fills.
    #[test]
    fn children_go_before_a_region_that_fills_later() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Panel>();
        c.set_components(registry);
        let child = |id| {
            vec![
                Op::Create { id, tag: Tag::View },
                Op::Insert {
                    parent: 2,
                    child: id,
                    before: None,
                },
            ]
        };
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Panel>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        c.commit().unwrap();
        // The footer's region is empty: the child goes at the end.
        apply(&mut c, child(8));
        let batch = c.commit().expect("a child before an empty region");
        assert!(batch.items.iter().any(|i| matches!(
            i,
            MountItem::Insert {
                parent: 2,
                child: 8,
                before: None
            }
        )));
        // The footer fills; a later child goes before its node.
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::ComponentSlot("footer".into()),
                },
                Op::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                Op::Create {
                    id: 6,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 4,
                    child: 6,
                    before: None,
                },
            ],
        );
        c.commit().expect("the footer filled");
        apply(&mut c, child(10));
        let batch = c.commit().unwrap();
        assert!(
            batch.items.iter().any(|i| matches!(
                i,
                MountItem::Insert {
                    parent: 2,
                    child: 10,
                    before: Some(4)
                }
            )),
            "{:?}",
            batch.items
        );
    }

    /// Children and a footer slot in one region, above a node of the view.
    #[component]
    fn Ledger(props: PanelProps) -> impl IntoElement {
        view()
            .child(dynamic(move || {
                vec![props.children.into_element(), props.footer.place(|f| f)]
            }))
            .child(view())
    }

    /// The ids of `parent`'s children in the core's tree, in order.
    fn child_ids(c: &Core<FakeEngine>, parent: NodeId) -> Vec<NodeId> {
        let key = c.key(parent).unwrap();
        c.nodes[key as usize]
            .children
            .iter()
            .map(|&k| c.nodes[k as usize].id)
            .collect()
    }

    /// A host of component `C` at node 2, in the root.
    fn mount_host<C: Component>() -> Core<FakeEngine> {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<C>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<C>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        c.commit().unwrap();
        c
    }

    /// JS child `id` of host 2, before its JS sibling `before`.
    fn js_child(id: NodeId, before: Option<NodeId>) -> Vec<Op> {
        vec![
            Op::Create { id, tag: Tag::View },
            Op::Insert {
                parent: 2,
                child: id,
                before,
            },
        ]
    }

    /// Fills host 2's footer slot with node 4 (holding node 6).
    fn fill_footer() -> Vec<Op> {
        vec![
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 4,
                prop: Prop::ComponentSlot("footer".into()),
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Create {
                id: 6,
                tag: Tag::View,
            },
            Op::Insert {
                parent: 4,
                child: 6,
                before: None,
            },
        ]
    }

    /// A region inside a region resolves to what follows the outer one:
    /// the JS children before it go before the view's node after both,
    /// while the inner region (the footer) is empty and once it fills.
    #[test]
    fn children_in_a_region_go_before_the_node_after_it() {
        let mut c = mount_host::<Ledger>();
        let ids = child_ids(&c, 2);
        assert_eq!(ids.len(), 1, "{ids:?}");
        let tail = ids[0];
        apply(&mut c, js_child(8, None));
        c.commit().expect("a child before an empty region");
        assert_eq!(child_ids(&c, 2), [8, tail]);
        apply(&mut c, fill_footer());
        c.commit().expect("the footer filled");
        assert_eq!(child_ids(&c, 2), [8, 4, tail]);
        apply(&mut c, js_child(10, None));
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [8, 10, 4, tail]);
    }

    /// A region that fills and empties again leaves the children before it
    /// in place, and later ones go where they would have.
    #[test]
    fn children_stay_in_place_as_a_region_fills_and_empties() {
        let mut c = mount_host::<Ledger>();
        let tail = child_ids(&c, 2)[0];
        apply(&mut c, js_child(8, None));
        apply(&mut c, fill_footer());
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [8, 4, tail]);
        apply(
            &mut c,
            vec![Op::Remove {
                parent: 2,
                child: 4,
            }],
        );
        c.commit().expect("the footer emptied");
        assert_eq!(child_ids(&c, 2), [8, tail]);
        apply(&mut c, js_child(10, None));
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [8, 10, tail]);
        apply(
            &mut c,
            vec![Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            }],
        );
        c.commit().expect("the footer filled again");
        assert_eq!(child_ids(&c, 2), [8, 10, 4, tail]);
    }

    /// A child inserted before a JS sibling goes before it, wherever the
    /// region after them is.
    #[test]
    fn children_go_before_the_sibling_js_names() {
        let mut c = mount_host::<Panel>();
        apply(&mut c, js_child(8, None));
        apply(&mut c, fill_footer());
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [8, 4]);
        apply(&mut c, js_child(10, Some(8)));
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [10, 8, 4]);
        apply(&mut c, js_child(12, None));
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [10, 8, 12, 4]);
    }

    /// A footer slot whose presses show and hide a note after it.
    #[component]
    fn Toggler(props: PanelProps) -> impl IntoElement {
        let shown = signal(false);
        view()
            .child(
                props
                    .footer
                    .place(move |f| f.on_press(move |_: &()| shown.update(|s| *s = !*s))),
            )
            .child(when(shown, || view().h(px(10.0))))
    }

    /// What a view gives a slot's node (its handlers) stays while the node
    /// is its slot, also once a region of the view runs again.
    #[test]
    fn a_slots_handlers_outlive_the_views_regions() {
        let mut c = mount_host::<Toggler>();
        apply(&mut c, fill_footer());
        c.commit().unwrap();
        assert_eq!(child_ids(&c, 2), [4]);
        let press = |c: &mut Core<FakeEngine>| {
            c.component_event(4, EventKind::Press, &EventPayload::None);
            let _ = c.commit();
        };
        press(&mut c);
        assert_eq!(child_ids(&c, 2).len(), 2, "the note shows");
        // The region ran again: the slot still hears its presses.
        press(&mut c);
        assert_eq!(child_ids(&c, 2), [4], "the note is gone");
        press(&mut c);
        assert_eq!(child_ids(&c, 2).len(), 2, "and shows again");
    }

    #[test]
    fn slots_are_the_glues_nodes_placed_by_the_render() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Card>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Card>().into()),
                },
                // The glue's node for `header`, then its JSX.
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::ComponentSlot("header".into()),
                },
                Op::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                Op::Create {
                    id: 6,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 4,
                    child: 6,
                    before: None,
                },
                // Children go before the slot's node (the anchor).
                Op::Create {
                    id: 8,
                    tag: Tag::View,
                },
                style_op(8, &[("height", StyleValue::Number(10.0))]),
                Op::Insert {
                    parent: 2,
                    child: 8,
                    before: Some(4),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        // The slot's node is the header element (in the host, 44pt tall).
        assert!(batch.items.iter().any(|i| matches!(
            i,
            MountItem::Insert {
                parent: 2,
                child: 4,
                ..
            }
        )));
        assert_eq!(frame_of(&batch, 4).map(|f| f.size.height.0), Some(44.0));
        // The children sit below it, after `mt_2` (the slot is filled).
        let holder = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent, child: 8, ..
                } => Some(*parent),
                _ => None,
            })
            .unwrap();
        assert_eq!(frame_of(&batch, holder).map(|f| f.origin.y.0), Some(52.0));

        // Emptying the slot: no header, `mt_0`.
        apply(
            &mut c,
            vec![Op::Remove {
                parent: 4,
                child: 6,
            }],
        );
        let batch = c.commit().unwrap();
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Remove { id: 4 }))
        );
        assert_eq!(frame_of(&batch, holder).map(|f| f.origin.y.0), Some(0.0));
    }

    /// Renders a Tally and counts its taps.
    #[derive(Clone, PartialEq, Props)]
    struct OuterProps {}

    #[derive(Event)]
    enum OuterEvent {
        InnerTap(u32),
    }

    #[component]
    fn Outer(_props: OuterProps, cx: Scope<OuterEvent>) -> impl IntoElement {
        let inner_taps = signal(0);
        view()
            .child(text(move || format!("outer {}", inner_taps.get())))
            .child(tally().label("In").on_tap(move |_: &TallyEvent| {
                inner_taps.update(|t| *t += 1);
                cx.emit(OuterEvent::InnerTap(inner_taps.get_untracked()));
            }))
    }

    #[test]
    fn nested_components_render_and_report_to_their_parent() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Tally>().register::<Outer>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Outer>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["In 0", "outer 0"]);
        // The nested Tally's host: the node listening to presses.
        let inner = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .unwrap();
        assert!(c.component_event(inner, EventKind::Press, &EventPayload::None));
        let events = js_events(&mut c);
        // JS hears the outer component's event, not the inner one.
        assert_eq!(
            events,
            [(
                2,
                EventKind::NativeEvent,
                EventPayload::Native {
                    name: "innerTap".into(),
                    data: json!(1)
                }
            )]
        );
        let mut shown = texts(&c.commit().unwrap());
        shown.sort();
        assert_eq!(shown, ["In 1", "outer 1"]);
    }

    #[test]
    fn the_apps_class_goes_last_and_unknown_components_render_nothing() {
        let mut c = core_with_tally();
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Tally>().into()),
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Class("p-8".into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                Op::Create {
                    id: 6,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 6,
                    prop: Prop::Component("test.missing".into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 6,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        // `p-8` (32pt) wins over the component's `p_2`: the text sits 32pt in.
        let text_id = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text { id, .. } => Some(*id),
                _ => None,
            })
            .unwrap();
        let frame = frame_of(&batch, text_id).unwrap();
        assert_eq!((frame.origin.x.0, frame.origin.y.0), (32.0, 32.0));
        // The unknown one is an empty view.
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Create { id: 6, .. }))
        );
    }

    /// A theme-colored swatch that darkens while pressed.
    #[derive(Clone, PartialEq, Props)]
    struct SwatchProps {}

    #[component]
    fn Swatch(_props: SwatchProps) -> impl IntoElement {
        view()
            .size_10()
            .bg(move || tokens().color("primary").unwrap())
            .active(|s| s.bg(rgb(0xff0000)))
    }

    #[test]
    fn theme_colors_and_press_styles_switch_natively() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Swatch>().tokens_from(test_tokens);
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Swatch>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let background = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ViewStyle { id: 2, style } => Some(style.background_color),
                _ => None,
            })
        };
        let primary = token("primary");
        let batch = c.commit().unwrap();
        assert_eq!(background(&batch), Some(Color::from(primary.light)));
        assert_eq!(frame_of(&batch, 2).map(|f| f.size.width.0), Some(40.0));
        // The platform reports presses on it (`active`).
        assert!(batch.items.iter().any(|i| matches!(
            i,
            MountItem::TrackStates { id: 2, states } if states & crate::tailwind::state::PRESSED != 0
        )));
        // Dark appearance: restyled natively.
        c.set_class_environment(crate::tailwind::ClassEnvironment {
            dark: true,
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert_eq!(background(&batch), Some(Color::from(primary.dark)));
        c.set_states(2, crate::tailwind::state::PRESSED);
        let batch = c.commit().unwrap();
        assert_eq!(background(&batch), Some(Color(0xff0000ff)));
    }

    /// A selected state whose style is the app's (as `nsh_base::Button`'s).
    #[derive(Clone, PartialEq, Props)]
    struct PillProps {
        #[prop(default)]
        selected: crate::ui::Prop<bool>,
        #[prop(default)]
        selected_style: crate::ui::Prop<crate::ui::Style>,
    }

    #[component]
    fn Pill(props: PillProps) -> impl IntoElement {
        view()
            .size_10()
            .accessibility_state(move || crate::AccessibilityState {
                selected: props.selected.get(),
                ..crate::AccessibilityState::default()
            })
            .selected_style(props.selected_style)
    }

    /// A selected pill styled with a theme color and an opacity a press
    /// changes, through its style prop's closure.
    #[component]
    fn Pills() -> impl IntoElement {
        let dim = signal(false);
        view()
            .on_press(move || dim.set(true))
            .child(pill().selected(true).selected_style(move |s| {
                s.bg(move || tokens().color("primary").unwrap())
                    .opacity(move || if dim.get() { 0.5_f32 } else { 1.0 })
            }))
    }

    #[test]
    fn a_style_prop_set_with_a_closure_follows_the_theme_and_its_signals() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Pills>().tokens_from(test_tokens);
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Pills>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let styled = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ViewStyle { id, style } if *id != 2 => {
                    Some((style.background_color, style.opacity))
                }
                _ => None,
            })
        };
        let primary = token("primary");
        let batch = c.commit().unwrap();
        assert_eq!(styled(&batch), Some((Color::from(primary.light), 1.0)));
        // Dark appearance: the theme color switches natively.
        c.set_class_environment(crate::tailwind::ClassEnvironment {
            dark: true,
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert_eq!(styled(&batch), Some((Color::from(primary.dark), 1.0)));
        // What the closure's bindings read changes it.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(styled(&batch), Some((Color::from(primary.dark), 0.5)));
    }

    #[test]
    fn the_host_theme_wins_over_the_apps_until_cleared() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Swatch>().tokens_from(test_tokens);
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Swatch>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let background = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ViewStyle { id: 2, style } => Some(style.background_color),
                _ => None,
            })
        };
        let themed = |hex: u32| {
            tokens_with(&[("primary", rgb(hex).into())]).over(&test_tokens(None).unwrap())
        };
        c.commit().unwrap();
        c.set_host_tokens(Some(themed(0x00ff00)));
        assert_eq!(
            c.commit().as_ref().and_then(background),
            Some(Color::from(rgb(0x00ff00)))
        );
        // The app's own theme (`uiTheme`) waits behind the host's.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: ROOT_ID,
                prop: Prop::UiTheme(r##"{ "primary": "#0000ff" }"##.into()),
            }],
        );
        assert_eq!(c.commit().as_ref().and_then(background), None);
        c.set_host_tokens(None);
        assert_eq!(
            c.commit().as_ref().and_then(background),
            Some(Color::from(rgb(0x0000ff)))
        );
        // Setting the same theme again renders nothing.
        c.set_tokens(themed(0x0000ff));
        assert_eq!(c.commit().as_ref().and_then(background), None);
    }

    #[test]
    fn classes_naming_theme_tokens_follow_the_theme() {
        let mut c = core();
        view_with_classes(&mut c, 2, "w-10 h-10 bg-primary");
        view_with_classes(&mut c, 4, "w-10 h-10 bg-chart-up");
        view_with_classes(&mut c, 6, "w-10 h-10 bg-red-500");
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(token("primary").light)
        );
        // Not a token of the app's theme.
        assert!(view_style_of(&batch, 4).is_none());
        let host = tokens_with(&[
            ("primary", AdaptiveColor::rgb(0x00ff00, 0x004400)),
            ("chart-up", rgb(0x0000ff).into()),
        ]);
        c.set_host_tokens(Some(host.clone()));
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(rgb(0x00ff00))
        );
        assert_eq!(
            view_style_of(&batch, 4).unwrap().background_color,
            Color::from(rgb(0x0000ff))
        );
        assert!(view_style_of(&batch, 6).is_none());
        c.set_class_environment(crate::tailwind::ClassEnvironment {
            dark: true,
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(rgb(0x004400))
        );
        // New values of the same tokens: only their classes are resolved.
        let mut changed = host;
        changed.set_color("primary", rgb(0xff00ff).into());
        c.set_host_tokens(Some(changed));
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(rgb(0xff00ff))
        );
        assert!(view_style_of(&batch, 4).is_none());
        assert!(view_style_of(&batch, 6).is_none());
    }

    #[test]
    fn the_apps_token_classes_on_a_component_follow_the_theme() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Swatch>().tokens_from(test_tokens);
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Swatch>().into()),
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Class("bg-chart-up".into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        c.commit().unwrap();
        c.set_host_tokens(Some(tokens_with(&[("chart-up", rgb(0x0000ff).into())])));
        let batch = c.commit().unwrap();
        // The app's class wins over the component's own background.
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(rgb(0x0000ff))
        );
    }

    #[test]
    fn a_host_theme_keeps_the_apps_own_tokens() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.tokens_from(test_tokens);
        c.set_components(registry);
        apply(
            &mut c,
            vec![Op::SetProp {
                id: ROOT_ID,
                prop: Prop::UiTheme(r##"{ "chart-up": "#0000ff" }"##.into()),
            }],
        );
        view_with_classes(&mut c, 2, "w-10 h-10 bg-chart-up");
        c.set_host_tokens(Some(crate::ui::tokens::sample()));
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, 2).unwrap().background_color,
            Color::from(rgb(0x0000ff))
        );
    }

    /// Wraps each JS child in a padded row.
    #[derive(Clone, PartialEq, Props)]
    struct RowsProps {
        children: Children,
    }

    #[component]
    fn Rows(props: RowsProps) -> impl IntoElement {
        view().children_each(props.children, |child, at| {
            view()
                .p_1()
                .style_when(move || !at.is_first(), |v| v.mt_2())
                .style_when(move || at.is_last(), |v| v.pb_2())
                .child(child)
        })
    }

    #[test]
    fn children_each_wraps_every_js_child_and_follows_changes() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Rows>();
        c.set_components(registry);
        let child = |id: NodeId| {
            vec![
                Op::Create { id, tag: Tag::View },
                style_op(id, &[("height", StyleValue::Number(10.0))]),
            ]
        };
        let mut ops = vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Component(std::any::type_name::<Rows>().into()),
            },
        ];
        ops.extend(child(4));
        ops.extend(child(6));
        ops.extend([
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ]);
        apply(&mut c, ops);
        let batch = c.commit().unwrap();
        let wrapper_of = |batch: &MountBatch, id: NodeId| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
                _ => None,
            })
        };
        let (w4, w6) = (
            wrapper_of(&batch, 4).unwrap(),
            wrapper_of(&batch, 6).unwrap(),
        );
        assert!(w4 % 2 == 1 && w6 % 2 == 1 && w4 != w6);
        // 4pt padding, 10pt children, 8pt between the rows.
        assert_eq!(
            frame_of(&batch, w4).map(|f| (f.origin.y.0, f.size.height.0)),
            Some((0.0, 18.0))
        );
        // The last has 8pt below.
        assert_eq!(
            frame_of(&batch, w6).map(|f| (f.origin.y.0, f.size.height.0)),
            Some((26.0, 22.0))
        );

        // A child inserted first gets its own wrapper; the others keep theirs
        // and move down (the second row now has the margin).
        let mut ops = child(8);
        ops.push(Op::Insert {
            parent: 2,
            child: 8,
            before: Some(4),
        });
        apply(&mut c, ops);
        let batch = c.commit().unwrap();
        let w8 = wrapper_of(&batch, 8).unwrap();
        assert!(![w4, w6].contains(&w8));
        assert_eq!(frame_of(&batch, w8).map(|f| f.origin.y.0), Some(0.0));
        assert_eq!(frame_of(&batch, w4).map(|f| f.origin.y.0), Some(26.0));
        assert!(wrapper_of(&batch, 4).is_none() && wrapper_of(&batch, 6).is_none());

        // A child moved (inserted again, as a keyed `<Each>` moves its row)
        // keeps its wrapper and stays in it; the wrapper moves.
        apply(
            &mut c,
            vec![Op::Insert {
                parent: 2,
                child: 8,
                before: None,
            }],
        );
        let batch = c.commit().unwrap();
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Remove { id } if *id == 8)),
            "the moved child stays in its wrapper"
        );
        assert_eq!(frame_of(&batch, w8).map(|f| f.origin.y.0), Some(52.0));
        assert_eq!(frame_of(&batch, w4).map(|f| f.origin.y.0), Some(0.0));
        apply(
            &mut c,
            vec![Op::Insert {
                parent: 2,
                child: 8,
                before: Some(4),
            }],
        );
        c.commit().unwrap();

        // A child removed takes its wrapper away; the child itself stays JS's.
        apply(
            &mut c,
            vec![Op::Remove {
                parent: 2,
                child: 4,
            }],
        );
        let batch = c.commit().unwrap();
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Delete { id } if *id == w4))
        );
        assert!(c.key(4).is_ok());
        assert_eq!(frame_of(&batch, w6).map(|f| f.origin.y.0), Some(26.0));
    }

    /// Ticks every 20ms from `start` until 3, then reports it; shows
    /// whether the window is wide.
    #[derive(Clone, Copy, PartialEq, Props)]
    struct ClockProps {
        #[prop(default)]
        start: crate::ui::Prop<u32>,
    }

    #[derive(Event)]
    enum ClockEvent {
        Done,
    }

    #[component]
    fn Clock(props: ClockProps, cx: Scope<ClockEvent>) -> impl IntoElement {
        let ticks = signal(props.start.get_untracked());
        // A new start starts again from it.
        effect(move || ticks.set(props.start.get()));
        let timer = stored(None::<Spawned<()>>);
        timer.replace(Some(set_interval(
            std::time::Duration::from_millis(20),
            move || {
                ticks.update(|t| *t += 1);
                if ticks.get_untracked() == 3 {
                    cx.emit(ClockEvent::Done);
                    // Cancelling the task stops it (`clearInterval`).
                    if let Some(timer) = timer.replace(None) {
                        timer.cancel();
                    }
                }
            },
        )));
        view().child(text(move || {
            let width = if window().width > Points(500.0) {
                "wide"
            } else {
                "narrow"
            };
            format!("{} {width}", ticks.get())
        }))
    }

    /// Fetches a value on the runtime's threads, then shows it.
    #[derive(Clone, PartialEq, Props)]
    struct LoaderProps {}

    #[component]
    fn Loader(_props: LoaderProps) -> impl IntoElement {
        let value = signal(None::<u64>);
        spawn(async move {
            // tokio's ecosystem: a `Send` future on the runtime, a timer.
            let loaded = background(async { (1..=10u64).product::<u64>() })
                .await
                .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            value.set(Some(loaded));
        });
        view().child(text(move || match value.get() {
            Some(v) => format!("loaded {v}"),
            None => "loading".to_owned(),
        }))
    }

    /// A resource through its states, driven by a task of its own: a slow
    /// load overtaken, a refetch, a failure, a value set here, no source.
    #[derive(Clone, PartialEq, Props)]
    struct ProfileProps {}

    #[component]
    fn Profile(_props: ProfileProps) -> impl IntoElement {
        let id = signal(Some(1u32));
        let profile = resource(
            move || id.get(),
            |id, info: crate::ui::ResourceInfo| async move {
                // The first load is slow: the second overtakes it.
                let ms = if id == 1 { 80 } else { 5 };
                timer(std::time::Duration::from_millis(ms)).await;
                if id == 3 {
                    Err(format!("no user {id}"))
                } else {
                    Ok(format!(
                        "user {id}{}",
                        if info.refetching { " again" } else { "" }
                    ))
                }
            },
        );
        spawn(async move {
            let settled = || async {
                while profile.loading() {
                    timer(std::time::Duration::from_millis(2)).await;
                }
            };
            timer(std::time::Duration::from_millis(10)).await;
            id.set(Some(2));
            settled().await;
            profile.refetch();
            settled().await;
            id.set(Some(3));
            settled().await;
            profile.mutate("local".into());
            id.set(None);
        });
        view().child(text(move || {
            format!(
                "{:?}|{}|{}",
                profile.state(),
                profile.get().unwrap_or_default(),
                profile.error().unwrap_or_default()
            )
        }))
    }

    #[test]
    fn resources_load_refresh_fail_and_count_the_latest_load_only() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .unwrap();
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Profile>();
        c.set_components(registry);
        c.set_task_runtime(runtime.handle().clone());
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Profile>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let mut shown = texts(&c.commit().unwrap());
        shown.extend(run_until(&mut c, |s| s.iter().any(|t| t == "Ready|local|")));
        shown.dedup();
        assert_eq!(
            shown,
            [
                "Pending||",
                // The slow first load never shows: the second replaced it.
                "Ready|user 2|",
                "Refreshing|user 2|",
                "Ready|user 2 again|",
                "Refreshing|user 2 again|",
                // A failure keeps the value.
                "Errored|user 2 again|no user 3",
                // A value set here clears the error; no source loads nothing.
                "Ready|local|",
            ]
        );
        assert_eq!(c.components.executor.task_count(), 0);
    }

    /// Runs the tasks and commits until `done` holds of what was shown.
    fn run_until(c: &mut Core<FakeEngine>, done: impl Fn(&[String]) -> bool) -> Vec<String> {
        let mut shown = Vec::new();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < end {
            c.run_component_tasks();
            if let Some(batch) = c.commit() {
                shown.extend(texts(&batch));
                if done(&shown) {
                    return shown;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        panic!("not done: {shown:?}");
    }

    #[test]
    fn state_tasks_props_and_the_environment() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .unwrap();
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Clock>().register::<Loader>();
        c.set_components(registry);
        c.set_task_runtime(runtime.handle().clone());
        let mount = |c: &mut Core<FakeEngine>, id: NodeId, name: &str| {
            apply(
                c,
                vec![
                    Op::Create { id, tag: Tag::View },
                    Op::SetProp {
                        id,
                        prop: Prop::Component(name.into()),
                    },
                    Op::Insert {
                        parent: ROOT_ID,
                        child: id,
                        before: None,
                    },
                ],
            )
        };
        mount(&mut c, 2, std::any::type_name::<Clock>());
        assert_eq!(texts(&c.commit().unwrap()), ["0 narrow"]);

        // The interval (a task: a timer, then an update) ticks to 3,
        // reports it and stops.
        let shown = run_until(&mut c, |s| s.iter().any(|t| t == "3 narrow"));
        assert!(shown.starts_with(&["1 narrow".to_owned()]));
        let events = js_events(&mut c);
        assert!(
            matches!(&events[..], [(2, EventKind::NativeEvent, EventPayload::Native { name, .. })] if &**name == "done")
        );
        std::thread::sleep(std::time::Duration::from_millis(60));
        c.run_component_tasks();
        assert!(c.commit().is_none(), "stopped");

        // A prop change reaches what reads it.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 2,
                prop: rust_prop::<ClockProps>("start", Some(json!(10))),
            }],
        );
        assert_eq!(texts(&c.commit().unwrap()), ["10 narrow"]);

        // What a binding read of the environment updates it; the rest does
        // not.
        let env = crate::ui::Environment {
            window: size_pt(390.0, 844.0),
            ..Default::default()
        };
        c.set_environment(crate::ui::Environment {
            keyboard_height: px(300.0),
            ..env
        });
        assert!(c.commit().is_none());
        c.set_viewport(size_pt(800.0, 600.0));
        assert!(texts(&c.commit().unwrap()).contains(&"10 wide".to_owned()));

        // A task with background work and a tokio timer.
        mount(&mut c, 4, std::any::type_name::<Loader>());
        assert!(texts(&c.commit().unwrap()).contains(&"loading".to_owned()));
        run_until(&mut c, |s| s.iter().any(|t| t == "loaded 3628800"));

        // A released component's tasks end with it.
        mount(&mut c, 6, std::any::type_name::<Clock>());
        c.commit();
        assert_eq!(c.components.executor.task_count(), 1);
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 6,
                },
                Op::Release { id: 6 },
            ],
        );
        c.commit();
        assert_eq!(c.components.executor.task_count(), 0);
    }

    /// A form: an input it controls, a scroll view, a modal while the
    /// name is long enough, a canvas drawing its length.
    #[component]
    fn Form(_props: FormProps) -> impl IntoElement {
        let name = signal(String::new());
        let focused = signal(false);
        let field = element_ref();
        view()
            .child(
                scroll().bounces(false).child(
                    input()
                        .element_ref(&field)
                        .value(move || name.get())
                        .placeholder(move || {
                            if name.with(String::is_empty) {
                                "Name"
                            } else {
                                ""
                            }
                        })
                        .on_change(move |text: &str| name.set(text.to_owned()))
                        .on_focus(move |_: &()| focused.set(true)),
                ),
            )
            .child(canvas(move || {
                let len = name.with(String::len) as f32;
                Painter::new().fill_rect(0.0, 0.0, len, 4.0)
            }))
            .child(when(
                move || name.with(String::len) > 2,
                // `nsh_base::dialog` is this, and nsh-base depends on the core.
                #[allow(deprecated)]
                move || {
                    modal()
                        .close_on_swipe(false)
                        .child(text(move || format!("Hi {}", name.get())))
                },
            ))
            .child(text(move || if focused.get() { "focused" } else { "idle" }))
            // Back to the field: focus it, the caret at the end.
            .child(view().on_press(move |_: &()| {
                field.focus();
                field.set_selection(3, 3);
            }))
    }

    #[derive(Clone, PartialEq, Props)]
    struct FormProps {}

    #[test]
    fn host_elements_take_typed_props_and_events() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Form>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Form>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        let created = |batch: &MountBatch, wanted: ViewKind| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Create { id, kind } if *kind == wanted => Some(*id),
                _ => None,
            })
        };
        let input = created(&batch, ViewKind::Input).expect("an input");
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button listens to presses");
        assert!(created(&batch, ViewKind::Scroll).is_some());
        assert!(created(&batch, ViewKind::Modal).is_none(), "no modal yet");
        let placeholder = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Input { config, .. } => Some(config.placeholder.clone()),
                _ => None,
            })
        };
        assert_eq!(placeholder(&batch).as_deref(), Some("Name"));
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Canvas { .. }))
        );
        assert_eq!(texts(&batch), ["idle"]);

        // Typing: the component gets the text, the placeholder goes back to
        // its default, the modal appears, the canvas draws again; the
        // input's value is the platform's already, so it is not sent back.
        c.input_changed(input, "Ada", 1);
        assert!(c.component_event(
            input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "Ada".into(),
                count: 1
            }
        ));
        assert!(c.component_event(input, EventKind::Focus, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(placeholder(&batch).as_deref(), Some(""));
        assert!(created(&batch, ViewKind::Modal).is_some());
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Canvas { .. }))
        );
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::InputValue { .. }))
        );
        assert_eq!(texts(&batch), ["Hi Ada", "focused"]);

        // The ref's commands reach the input it is on, in the next batch.
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let commands: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Command { id, command } => Some((*id, command.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            commands,
            [
                (input, Command::Focus),
                (input, Command::SetSelection { start: 3, end: 3 })
            ]
        );
    }

    /// Measures its box when pressed (and a ref no element carries).
    #[component]
    fn Ruler() -> impl IntoElement {
        let target = element_ref();
        let unused = element_ref();
        let shown = signal(String::new());
        view()
            .p_4()
            .child(
                view()
                    .pl(px(10.0))
                    .child(view().element_ref(&target).w(px(30.0)).h(px(20.0))),
            )
            .child(text(move || shown.get()))
            .child(view().w(px(5.0)).h(px(5.0)).on_press(move |_: &()| {
                let (target, unused) = (target.measure(), unused.measure());
                spawn(async move {
                    let (m, none) = (target.await, unused.await);
                    let m = m.expect("laid out");
                    shown.set(format!(
                        "{},{} {}x{} at {},{} {}",
                        m.frame.origin.x.0,
                        m.frame.origin.y.0,
                        m.frame.size.width.0,
                        m.frame.size.height.0,
                        m.page.x.0,
                        m.page.y.0,
                        none.is_none()
                    ));
                });
            }))
    }

    #[test]
    fn element_refs_measure_with_the_commits_layout() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Ruler>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Ruler>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button listens to presses");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        // The frame in its parent (past the parent's padding), the corner
        // in the surface (past the component's padding too); the ref no
        // element carries measures nothing.
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.contains(" at ")));
        assert_eq!(shown.last().unwrap(), "10,0 30x20 at 26,16 true");
    }

    #[derive(Clone, PartialEq, Debug)]
    struct Accent(u32);

    #[derive(Default, Clone)]
    struct Clicks(u32);

    #[derive(Clone, PartialEq, Props)]
    struct WithChildren {
        children: Children,
    }

    /// Provides an accent to what is below it, through the app's JSX.
    #[component]
    fn Theming(props: WithChildren) -> impl IntoElement {
        let accent = signal(Accent(0));
        provide_context(accent);
        view()
            .on_press(move |_: &()| accent.update(|a| a.0 += 1))
            .child(props.children)
    }

    /// Shows the accent above it and the surface's clicks; a press counts
    /// one.
    #[component]
    fn AccentSwatch(_props: FormProps) -> impl IntoElement {
        let accent = use_context::<Signal<Accent>>();
        let clicks = global::<Clicks>();
        view()
            .on_press(move |_: &()| clicks.update(|c| c.0 += 1))
            .child(text(move || {
                let accent = accent.map_or(0, |a| a.with(|a| a.0));
                format!("accent {accent} clicks {}", clicks.with(|c| c.0))
            }))
    }

    #[test]
    fn context_flows_down_and_globals_reach_their_readers() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Theming>().register::<AccentSwatch>();
        c.set_components(registry);
        // <Theming><view><Swatch/></view></Theming> and a second Swatch
        // outside it.
        let host = |id, name: &str| {
            vec![
                Op::Create { id, tag: Tag::View },
                Op::SetProp {
                    id,
                    prop: Prop::Component(name.into()),
                },
            ]
        };
        let mut ops = host(2, std::any::type_name::<Theming>());
        ops.push(Op::Create {
            id: 4,
            tag: Tag::View,
        });
        ops.extend(host(6, std::any::type_name::<AccentSwatch>()));
        ops.extend(host(8, std::any::type_name::<AccentSwatch>()));
        for (parent, child) in [(4, 6), (2, 4), (ROOT_ID, 2), (ROOT_ID, 8)] {
            ops.push(Op::Insert {
                parent,
                child,
                before: None,
            });
        }
        apply(&mut c, ops);
        let batch = c.commit().unwrap();
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["accent 0 clicks 0", "accent 0 clicks 0"]);

        // A new value: only the swatch below the provider changes.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["accent 1 clicks 0"]);

        // A global changed by one swatch changes both.
        assert!(c.component_event(8, EventKind::Press, &EventPayload::None));
        let mut shown = texts(&c.commit().unwrap());
        shown.sort();
        assert_eq!(shown, ["accent 0 clicks 1", "accent 1 clicks 1"]);
    }

    /// A sheet that follows drags natively and springs back when let go.
    #[component]
    fn Sheet(_props: FormProps) -> impl IntoElement {
        let offset = animated_value(0.0);
        let state = signal("resting");
        view()
            .bind_translate_y(&offset)
            .bind_opacity(&offset.interpolate(&[0.0, 300.0], &[1.0, 0.2]))
            .pan_values(None, Some(&offset))
            .on_pan_end(move |e: &PanEvent| {
                assert_eq!(e.value_y, Some(120.0));
                let end = offset.spring(0.0, Spring::default());
                state.set("springing");
                spawn(async move {
                    let finished = end.await;
                    state.set(if finished { "back" } else { "stopped" });
                });
            })
            .child(text(move || state.get()))
    }

    #[test]
    fn animated_values_bind_animate_and_end() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Sheet>();
        c.set_components(registry);
        c.set_task_runtime(runtime.handle().clone());
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Sheet>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        let animations: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Animation(op) => Some(op.clone()),
                _ => None,
            })
            .collect();
        // The value and its interpolation, in the core's id range.
        let value = match animations[0] {
            crate::animation::AnimationOp::CreateValue { node, value: 0.0 } => node,
            ref op => panic!("{op:?}"),
        };
        assert_eq!(value % 2, 1, "the core's ids are odd");
        assert!(
            matches!(animations[1], crate::animation::AnimationOp::CreateInterpolate { input, .. } if input == value)
        );
        assert_eq!(texts(&batch), ["resting"]);

        // Let go: a spring starts; its end resolves the task.
        let payload = EventPayload::Pan {
            translation: point(px(0.0), px(120.0)),
            velocity_x: 0.0,
            velocity_y: 300.0,
            value_x: None,
            value_y: Some(px(120.0)),
        };
        assert!(c.component_event(2, EventKind::PanEnd, &payload));
        let batch = c.commit().unwrap();
        let animation = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Animation(crate::animation::AnimationOp::Start {
                    node,
                    animation,
                    ..
                }) if *node == value => Some(*animation),
                _ => None,
            })
            .expect("a spring");
        assert_eq!(texts(&batch), ["springing"]);
        let mut finished = vec![
            crate::animation::Finished::new(animation, true),
            // JS's (even ids) stay for JS.
            crate::animation::Finished::new(8, true),
        ];
        c.animations_finished(&mut finished);
        assert_eq!(finished.len(), 1);
        let _guard = runtime.enter();
        assert_eq!(
            run_until(&mut c, |s| s.contains(&"back".to_owned())),
            ["back"]
        );

        // Released with the component: the value and what derives from it.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 2,
                },
                Op::Release { id: 2 },
            ],
        );
        let batch = [c.commit(), c.commit()];
        let released = batch
            .iter()
            .flatten()
            .flat_map(|b| &b.items)
            .filter(|i| {
                matches!(
                    i,
                    MountItem::Animation(crate::animation::AnimationOp::Release { .. })
                )
            })
            .count();
        assert_eq!(released, 2, "{batch:?}");
    }

    /// Handles made under an owner of their own, which a press disposes
    /// while the view stays: the view's binding and input hold what they
    /// name, so the fade goes on; the handles, shared by two listeners,
    /// do nothing from then on.
    #[component]
    fn Outlived() -> impl IntoElement {
        let (owner, (fade, field)) =
            crate::ui::create_root(|| (animated_value(1.0), element_ref()));
        let _ = fade.timing(0.0, 300.0, Easing::Linear);
        let shown = signal(String::new());
        view()
            .bind_opacity(&fade)
            .child(input().element_ref(&field))
            .child(view().on_press(move |_: &()| {
                field.focus();
                fade.set(0.5);
            }))
            .child(view().on_press(move |_: &()| {
                owner.dispose();
                fade.set(0.25);
                fade.stop();
                let _ = fade.spring(1.0, Spring::default());
                field.focus();
                let gone = fade.interpolate(&[0.0, 1.0], &[0.0, 1.0]);
                shown.set(format!("{:?} {:?}", field.node(), gone.live().is_none()));
            }))
            .child(text(move || shown.get()))
    }

    #[test]
    fn handles_outlived_by_what_binds_them_do_nothing() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Outlived>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Outlived>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let animations = |batch: &MountBatch| -> Vec<crate::animation::AnimationOp> {
            batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Animation(op) => Some(op.clone()),
                    _ => None,
                })
                .collect()
        };
        let commands = |batch: &MountBatch| -> Vec<(NodeId, Command)> {
            batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Command { id, command } => Some((*id, command.clone())),
                    _ => None,
                })
                .collect()
        };
        let batch = c.commit().unwrap();
        let ops = animations(&batch);
        let fade = match ops[..] {
            [
                crate::animation::AnimationOp::CreateValue { node, value: 1.0 },
                crate::animation::AnimationOp::Start { node: started, .. },
            ] if started == node => node,
            _ => panic!("{ops:?}"),
        };
        let input = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: ViewKind::Input,
                } => Some(*id),
                _ => None,
            })
            .expect("an input");
        let buttons: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .collect();
        let [first, second] = buttons[..] else {
            panic!("{buttons:?}");
        };

        // The handles work while their owner lives.
        assert!(c.component_event(first, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(
            animations(&batch),
            [crate::animation::AnimationOp::Set {
                node: fade,
                value: 0.5
            }]
        );
        assert_eq!(commands(&batch), [(input, Command::Focus)]);

        // Its owner goes: the binding holds the node (no release, its fade
        // runs on); the handles do nothing and name nothing, with no panic.
        assert!(c.component_event(second, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(animations(&batch), []);
        assert_eq!(commands(&batch), []);
        assert_eq!(texts(&batch), ["None true"]);
        assert!(c.component_event(first, EventKind::Press, &EventPayload::None));
        assert!(
            c.commit()
                .is_none_or(|b| animations(&b).is_empty() && commands(&b).is_empty())
        );

        // The node goes with the view that binds it.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 2,
                },
                Op::Release { id: 2 },
            ],
        );
        let released: Vec<_> = [c.commit(), c.commit()]
            .iter()
            .flatten()
            .flat_map(animations)
            .collect();
        assert_eq!(
            released,
            [crate::animation::AnimationOp::Release { node: fade }]
        );
    }

    /// One press derives nodes from the view's value (colors that follow
    /// the appearance too); the other makes state of its own, and a task
    /// that makes more.
    #[component]
    fn Repeated() -> impl IntoElement {
        let v = animated_value(0.0);
        let presses = signal(0);
        let colors = [AdaptiveColor {
            light: Color::BLACK.into(),
            dark: Color::TRANSPARENT.into(),
        }; 2];
        view()
            .bind_opacity(&v)
            .child(view().on_press(move |_: &()| {
                let half = v.mul(0.5);
                let _ = half.interpolate(&[0.0, 1.0], &[0.0, 1.0]);
                let _ = v.interpolate_colors(&[0.0, 1.0], &colors);
                presses.update(|n| *n += 1);
            }))
            .child(view().on_press(move |_: &()| {
                let _ = (signal(0), animated_value(1.0), element_ref(), stored(0));
                spawn(async move {
                    let _ = (signal(1), animated_value(2.0));
                });
            }))
            .child(text(move || presses.get().to_string()))
    }

    #[test]
    fn repeated_presses_do_not_grow_the_graph() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Repeated>();
        c.set_components(registry);
        let mount = |c: &mut Core<FakeEngine>, id| {
            apply(
                c,
                vec![
                    Op::Create { id, tag: Tag::View },
                    Op::SetProp {
                        id,
                        prop: Prop::Component(std::any::type_name::<Repeated>().into()),
                    },
                    Op::Insert {
                        parent: ROOT_ID,
                        child: id,
                        before: None,
                    },
                ],
            );
            let batch = c.commit().unwrap();
            let buttons: Vec<_> = batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Events { id, events } if events.contains(EventKind::Press) => {
                        Some(*id)
                    }
                    _ => None,
                })
                .collect();
            [buttons[0], buttons[1]]
        };
        let unmount = |c: &mut Core<FakeEngine>, id| {
            apply(
                c,
                vec![
                    Op::Remove {
                        parent: ROOT_ID,
                        child: id,
                    },
                    Op::Release { id },
                ],
            );
            let _ = (c.commit(), c.commit());
        };
        let press = |c: &mut Core<FakeEngine>, button| {
            assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
            c.run_component_tasks();
            let _ = c.commit();
        };
        let slots = |c: &Core<FakeEngine>| c.components.runtime.slots_in_use();
        // What the surface makes once (its environment, the theme) first.
        let _ = mount(&mut c, 2);
        unmount(&mut c, 2);
        let empty = slots(&c);

        let [derive, make] = mount(&mut c, 4);
        for _ in 0..5 {
            press(&mut c, derive);
        }
        let derived = slots(&c);
        for _ in 0..500 {
            press(&mut c, derive);
        }
        assert_eq!(slots(&c), derived, "deriving again adds nothing");

        // State a press makes is the component's: it goes with it.
        for _ in 0..50 {
            press(&mut c, make);
        }
        assert!(slots(&c) > derived);
        unmount(&mut c, 4);
        assert_eq!(slots(&c), empty, "released with the component");
    }

    /// A press disposes the branch its view is in (as what closes it does,
    /// unbatched), then makes state and a task.
    #[component]
    fn SelfClosing() -> impl IntoElement {
        let open = signal(true);
        view().child(when(open, move || {
            view().on_press(move |_: &()| {
                Owner::current().dispose();
                let _ = (signal(5), animated_value(1.0), element_ref());
                spawn(async {});
            })
        }))
    }

    #[test]
    fn a_listener_closing_its_own_view_leaves_nothing() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<SelfClosing>();
        c.set_components(registry);
        let mount = |c: &mut Core<FakeEngine>, id| {
            apply(
                c,
                vec![
                    Op::Create { id, tag: Tag::View },
                    Op::SetProp {
                        id,
                        prop: Prop::Component(std::any::type_name::<SelfClosing>().into()),
                    },
                    Op::Insert {
                        parent: ROOT_ID,
                        child: id,
                        before: None,
                    },
                ],
            );
            let batch = c.commit().unwrap();
            batch
                .items
                .iter()
                .find_map(|i| match i {
                    MountItem::Events { id, events } if events.contains(EventKind::Press) => {
                        Some(*id)
                    }
                    _ => None,
                })
                .unwrap()
        };
        let unmount = |c: &mut Core<FakeEngine>, id| {
            apply(
                c,
                vec![
                    Op::Remove {
                        parent: ROOT_ID,
                        child: id,
                    },
                    Op::Release { id },
                ],
            );
            let _ = (c.commit(), c.commit());
        };
        let _ = mount(&mut c, 2);
        unmount(&mut c, 2);
        let empty = c.components.runtime.slots_in_use();
        let button = mount(&mut c, 4);
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        c.run_component_tasks();
        let _ = c.commit();
        unmount(&mut c, 4);
        assert_eq!(c.components.runtime.slots_in_use(), empty);
    }

    /// Its own rows indexing its data; a press clears the data. Its errors
    /// show as a text.
    #[component]
    fn Clearable() -> impl IntoElement {
        let rows = signal((0..3).map(|i| format!("row {i}")).collect::<Vec<_>>());
        view()
            .flex_1()
            .child(
                view()
                    .h(px(20.0))
                    .on_press(move |_: &()| rows.set(Vec::new())),
            )
            .child(catch_error(
                move || {
                    virtual_list(
                        move || rows.with(Vec::len),
                        move |at| {
                            view()
                                .h(px(40.0))
                                .child(text(move || rows.with(|r| r[at.index()].clone())))
                        },
                    )
                    .estimated_item_size(px(40.0))
                    .flex_1()
                },
                |e, _| text(format!("failed: {}", e.message)),
            ))
    }

    #[test]
    fn virtual_lists_drop_rows_that_are_gone() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Clearable>(|| ()));
        let batch = c.commit().unwrap();
        assert!(
            texts(&batch).contains(&"row 2".to_owned()),
            "{:?}",
            texts(&batch)
        );
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        // The cells of rows that are gone render nothing until the list
        // binds them again, never a row past the end.
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        let mut shown = Vec::new();
        for _ in 0..3 {
            if let Some(batch) = c.commit() {
                shown.extend(texts(&batch));
            }
        }
        assert!(shown.iter().all(|t| !t.starts_with("failed")), "{shown:?}");
    }

    /// A chat: its own rows in a list that follows its end; a press makes
    /// the last row taller (a reply streaming in).
    #[component]
    fn Chat() -> impl IntoElement {
        let tall = signal(false);
        view()
            .flex_1()
            .child(
                view()
                    .h(px(20.0))
                    .on_press(move |_: &()| tall.update(|t| *t = !*t)),
            )
            .child(
                virtual_list(20, move |at| {
                    view().h(move || {
                        px(if tall.get() && at.is_last() {
                            120.0
                        } else {
                            40.0
                        })
                    })
                })
                .estimated_item_size(px(40.0))
                .follow_end(px(10.0))
                .flex_1(),
            )
    }

    #[test]
    fn virtual_lists_follow_their_end() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Chat>(|| ()));
        let batch = c.commit().unwrap();
        let created = |kind: ViewKind| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Create { id, kind: k } if *k == kind => Some(*id),
                _ => None,
            })
        };
        let list = created(ViewKind::Scroll).expect("a list");
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        let scrolled = |batch: &MountBatch| -> f32 {
            batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::ScrollBy { id, dy, .. } if *id == list => Some(dy.0),
                    _ => None,
                })
                .sum()
        };
        // At its end (20 rows of 40 in 460 points), the last row grows by
        // 80: the list scrolls with it.
        c.set_scroll_offset(list, point(px(0.0), px(800.0 - 460.0)), 0);
        assert!(c.commit().is_none(), "every row is bound already");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        assert_eq!(scrolled(&c.commit().unwrap()), 80.0);
        // Scrolled up, what is visible stays as the last row shrinks and
        // grows again.
        c.set_scroll_offset(list, point(px(0.0), px(100.0)), 1);
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        assert_eq!(scrolled(&c.commit().unwrap()), 0.0);
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        assert_eq!(scrolled(&c.commit().unwrap()), 0.0);
    }

    thread_local! {
        /// How many times `Opened` was made on this thread.
        static SETUPS: Cell<u32> = const { Cell::new(0) };
    }

    /// A drawer whose content (lazy children) shows while it is open.
    #[derive(Clone, Copy, PartialEq, Props)]
    struct DrawerProps {
        #[prop(default)]
        open: crate::ui::Prop<bool>,
        #[prop(lazy)]
        children: Children,
    }

    #[component]
    fn Drawer(props: DrawerProps) -> impl IntoElement {
        view().child(when(props.open, move || view().p_2().child(props.children)))
    }

    /// Content with state of its own: the how-manieth it was made.
    #[component]
    fn Opened() -> impl IntoElement {
        let n = SETUPS.with(|s| {
            s.set(s.get() + 1);
            s.get()
        });
        view().child(text(format!("opened {n}")))
    }

    /// Renders a drawer with content, opened and closed by a press.
    #[component]
    fn Shelf() -> impl IntoElement {
        let open = signal(false);
        view()
            .child(
                view()
                    .h(px(10.0))
                    .on_press(move |_: &()| open.update(|o| *o = !*o)),
            )
            .child(drawer().open(open).child(opened()))
    }

    #[test]
    fn lazy_children_a_component_passes_are_made_while_placed() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Shelf>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        let instances = c.components.instances.len();
        assert_eq!(SETUPS.with(Cell::get), 0, "closed: not made");
        let events = js_events(&mut c);
        assert!(events.is_empty(), "nothing for JS: {events:?}");

        // Opened: made, and placed in the same commit.
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["opened 1"]);
        assert_eq!(c.components.instances.len(), instances + 1);
        // Closed: released.
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        c.commit();
        assert_eq!(c.components.instances.len(), instances);
        // Opened again: made afresh.
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["opened 2"]);
        let events = js_events(&mut c);
        assert!(events.is_empty(), "nothing for JS: {events:?}");
    }

    /// Pastes the clipboard's text when pressed, if it holds some.
    #[component]
    fn Paster() -> impl IntoElement {
        let pasted = signal(String::new());
        view()
            .child(text(move || format!("pasted {}", pasted.get())))
            .child(view().h(px(10.0)).on_press(move |_: &()| {
                let (has, text) = (clipboard_has_string(), clipboard_string());
                spawn(async move {
                    let value = if has.await { text.await } else { "-".into() };
                    pasted.set(value);
                });
            }))
    }

    #[test]
    fn components_read_the_clipboard() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Paster>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        let reads: Vec<_> = c
            .commit()
            .unwrap()
            .items
            .into_iter()
            .filter_map(|i| match i {
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::ReadClipboard { id, has_only },
                } => Some((id, has_only)),
                _ => None,
            })
            .collect();
        assert_eq!(reads, [(1, true), (2, false)]);
        // The platform answers both on the root.
        for (id, has_only) in reads {
            let mut payload = vec![
                ("id", crate::PayloadValue::Number(f64::from(id))),
                ("has", crate::PayloadValue::Bool(true)),
            ];
            if !has_only {
                payload.push(("text", crate::PayloadValue::Str("hello".into())));
            }
            assert!(c.component_event(ROOT_ID, EventKind::Clipboard, &EventPayload::Map(payload)));
        }
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("pasted h")));
        assert_eq!(shown.last().unwrap(), "pasted hello");
    }

    #[test]
    fn a_clipboard_of_the_embedders_own_answers_in_place_of_the_platform() {
        use crate::clipboard::{ClipboardBackend, MemoryClipboard};
        let clipboard = std::sync::Arc::new(MemoryClipboard::new(Some("hello".into())));
        let mut c = core();
        c.set_clipboard(Some(clipboard.clone()));
        c.mount_root(&crate::ui::Root::new::<Paster>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        // Nothing goes to the platform: the reads are answered from it.
        let items = c.commit().map(|b| b.items).unwrap_or_default();
        assert!(
            !items.iter().any(|i| matches!(
                i,
                MountItem::Command {
                    command: Command::ReadClipboard { .. },
                    ..
                }
            )),
            "{items:?}"
        );
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("pasted h")));
        assert_eq!(shown.last().unwrap(), "pasted hello");
        clipboard.set_text(None);
        assert_eq!(clipboard.text(), None);
    }

    /// Pastes the clipboard's image and files when pressed.
    #[component]
    fn ImagePaster() -> impl IntoElement {
        let pasted = signal(String::new());
        view()
            .child(text(move || format!("pasted {}", pasted.get())))
            .child(view().h(px(10.0)).on_press(move |_: &()| {
                let (has, image, files) =
                    (clipboard_has_image(), clipboard_image(), clipboard_files());
                spawn(async move {
                    let has = has.await;
                    let image = image
                        .await
                        .map(|i| format!("{}x{} {}", i.size.width.0, i.size.height.0, i.url));
                    let files = files.await.join(",");
                    pasted.set(format!("{has} {image:?} {files}"));
                });
            }))
    }

    #[test]
    fn components_read_images_and_files_from_the_clipboard() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<ImagePaster>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        let reads: Vec<_> = c
            .commit()
            .unwrap()
            .items
            .into_iter()
            .filter_map(|i| match i {
                MountItem::Command {
                    id: ROOT_ID,
                    command:
                        command @ (Command::ReadClipboardImage { .. }
                        | Command::ReadClipboardFiles { .. }),
                } => Some(command),
                _ => None,
            })
            .collect();
        assert_eq!(
            reads,
            [
                Command::ReadClipboardImage {
                    id: 1,
                    has_only: true
                },
                Command::ReadClipboardImage {
                    id: 2,
                    has_only: false
                },
                Command::ReadClipboardFiles { id: 3 },
            ]
        );
        use crate::PayloadValue::{Bool, Number, Str};
        let answers = [
            vec![("id", Number(1.0)), ("has", Bool(true))],
            vec![
                ("id", Number(2.0)),
                ("has", Bool(true)),
                ("uri", Str("data:image/png;base64,AA==".into())),
                ("width", Number(4.0)),
                ("height", Number(3.0)),
            ],
            vec![
                ("id", Number(3.0)),
                ("has", Bool(true)),
                ("files", Str("file:///tmp/a%20b.png\nfile:///tmp/c/".into())),
            ],
        ];
        for payload in answers {
            assert!(c.component_event(ROOT_ID, EventKind::Clipboard, &EventPayload::Map(payload)));
        }
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("pasted t")));
        assert_eq!(
            shown.last().unwrap(),
            "pasted true Some(\"4x3 data:image/png;base64,AA==\") file:///tmp/a%20b.png,file:///tmp/c/"
        );
    }

    #[test]
    fn clipboard_images_need_the_capability() {
        let mut c = core();
        c.set_access(std::sync::Arc::new(crate::access::Access {
            declared: crate::access::Capabilities::from_json(&serde_json::json!({})).unwrap(),
            granted: None,
        }));
        c.mount_root(&crate::ui::Root::new::<ImagePaster>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        let items = c.commit().map(|b| b.items).unwrap_or_default();
        assert!(
            !items.iter().any(|i| matches!(i, MountItem::Command { .. })),
            "nothing reaches the platform"
        );
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("pasted f")));
        assert_eq!(shown.last().unwrap(), "pasted false None ");
    }

    /// Picks up to two photos when pressed and shows what came.
    #[component]
    fn PhotoPicker() -> impl IntoElement {
        let picked = signal(String::new());
        view()
            .child(text(move || format!("picked {}", picked.get())))
            .child(view().h(px(10.0)).on_press(move |_: &()| {
                let files = pick_images(crate::picker::PickRequest::new(true, 2));
                spawn(async move {
                    let files = files.await;
                    let shown: Vec<String> = files
                        .iter()
                        .map(|f| {
                            format!(
                                "{} {} {}x{} {}",
                                f.name,
                                f.mime,
                                f.size.width.0,
                                f.size.height.0,
                                f.data.len()
                            )
                        })
                        .collect();
                    picked.set(format!("{} [{}]", files.len(), shown.join(", ")));
                });
            }))
    }

    /// A 3×2 PNG's header.
    fn png_header() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
            0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
        ]
    }

    fn press_picker(c: &mut Core<FakeEngine>) -> Vec<MountItem> {
        c.mount_root(&crate::ui::Root::new::<PhotoPicker>(|| ()));
        let batch = c.commit().unwrap();
        let button = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .expect("the button");
        assert!(c.component_event(button, EventKind::Press, &EventPayload::None));
        c.commit().map(|b| b.items).unwrap_or_default()
    }

    #[test]
    fn picked_files_answer_the_pick() {
        let mut c = core();
        let items = press_picker(&mut c);
        let picks: Vec<_> = items
            .into_iter()
            .filter_map(|i| match i {
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::PickImages { id, request },
                } => Some((id, request)),
                _ => None,
            })
            .collect();
        assert_eq!(picks.len(), 1);
        let (id, request) = picks[0];
        assert_eq!(request.limit, 2);
        let file = |name: &str| crate::picker::PickedFile {
            name: name.into(),
            data: crate::ImageData::new(png_header()),
            ..Default::default()
        };
        // The platform's answer is completed (type, size, extension) and
        // cut to the request's limit.
        let files = vec![file("IMG_1"), file("b.png"), file("c.png")];
        assert!(c.component_event(
            ROOT_ID,
            EventKind::Pick,
            &EventPayload::Picked { id, files }
        ));
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("picked 2")));
        assert_eq!(
            shown.last().unwrap(),
            "picked 2 [IMG_1.png image/png 3x2 29, b.png image/png 3x2 29]"
        );
    }

    struct TestPicker;

    impl crate::picker::PickerBackend for TestPicker {
        fn pick_images(&self, request: crate::picker::PickRequest) -> crate::picker::PickFuture {
            assert_eq!(request.limit, 2);
            Box::pin(async {
                vec![crate::picker::PickedFile::new(
                    "x.png",
                    "",
                    crate::ImageData::new(png_header()),
                )]
            })
        }
    }

    #[test]
    fn a_picker_of_the_embedder_answers_in_place_of_the_platform() {
        let mut c = core();
        c.set_picker(Some(std::sync::Arc::new(TestPicker)));
        let items = press_picker(&mut c);
        assert!(
            !items.iter().any(|i| matches!(i, MountItem::Command { .. })),
            "nothing reaches the platform"
        );
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("picked 1")));
        assert_eq!(shown.last().unwrap(), "picked 1 [x.png image/png 3x2 29]");
    }

    #[test]
    fn picks_need_the_capability() {
        let mut c = core();
        c.set_access(std::sync::Arc::new(crate::access::Access {
            declared: crate::access::Capabilities::from_json(&serde_json::json!({})).unwrap(),
            granted: None,
        }));
        let items = press_picker(&mut c);
        assert!(
            !items.iter().any(|i| matches!(i, MountItem::Command { .. })),
            "nothing reaches the platform"
        );
        let shown = run_until(&mut c, |s| s.iter().any(|t| t.starts_with("picked 0")));
        assert_eq!(shown.last().unwrap(), "picked 0 []");
    }

    /// Shows a fallback while a component below it failed; a press tries
    /// again.
    #[component]
    fn Boundary(props: WithChildren) -> impl IntoElement {
        let retry = stored(None::<crate::ui::Reset>);
        view()
            .on_press(move |_: &()| {
                if let Some(reset) = retry.replace(None) {
                    reset.reset();
                }
            })
            .child(catch_error(
                move || props.children,
                move |e, reset| {
                    retry.replace(Some(reset));
                    text(format!("oops: {} ({})", e.component, e.message))
                },
            ))
    }

    /// Panics when pressed, and in a binding once `explode` is set.
    #[derive(Clone, Copy, PartialEq, Props)]
    struct FaultyProps {
        #[prop(default)]
        explode: crate::ui::Prop<bool>,
    }

    #[component]
    fn Faulty(props: FaultyProps) -> impl IntoElement {
        view()
            .on_press(|_: &()| panic!("pressed"))
            .child(text(move || {
                assert!(!props.explode.get(), "exploded");
                "fine"
            }))
    }

    #[test]
    fn errors_of_components_go_to_the_nearest_boundary() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Boundary>().register::<Faulty>();
        c.set_components(registry);
        let host = |id, name: &str| {
            vec![
                Op::Create { id, tag: Tag::View },
                Op::SetProp {
                    id,
                    prop: Prop::Component(name.into()),
                },
            ]
        };
        let mut ops = host(2, std::any::type_name::<Boundary>());
        ops.push(Op::Create {
            id: 4,
            tag: Tag::View,
        });
        ops.extend(host(6, std::any::type_name::<Faulty>()));
        for (parent, child) in [(4, 6), (2, 4), (ROOT_ID, 2)] {
            ops.push(Op::Insert {
                parent,
                child,
                before: None,
            });
        }
        apply(&mut c, ops);
        assert_eq!(texts(&c.commit().unwrap()), ["fine"]);

        // A listener panics: the boundary shows its fallback.
        assert!(c.component_event(6, EventKind::Press, &EventPayload::None));
        assert_eq!(
            texts(&c.commit().unwrap()),
            [format!(
                "oops: {} (pressed)",
                std::any::type_name::<Faulty>()
            )]
        );
        // Again: the content is back.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        c.commit();

        // A binding panics: the same.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 6,
                prop: rust_prop::<FaultyProps>("explode", Some(serde_json::json!(true))),
            }],
        );
        assert_eq!(
            texts(&c.commit().unwrap()),
            [format!(
                "oops: {} (exploded)",
                std::any::type_name::<Faulty>()
            )]
        );
    }

    /// A sentence with a link, a bold span and a badge inside it.
    #[component]
    fn Sentence() -> impl IntoElement {
        let taps = signal(0);
        let long = signal(false);
        view().child(
            text(move || format!("Tapped {} ", taps.get()))
                .text_size(px(16.0))
                .child(
                    text("the link")
                        .underline()
                        .role(crate::AccessibilityRole::Link)
                        .test_id("terms")
                        .focusable(move || !long.get())
                        .on_press(move |_: &()| {
                            taps.update(|t| *t += 1);
                            long.set(true);
                        }),
                )
                .child(", ")
                .child(text("bold").font_weight(FontWeight::BOLD))
                .child(when(long, || " and more"))
                .child(view().size(px(10.0)).bg(rgb(0xff0000))),
        )
    }

    #[test]
    fn rust_texts_nest_spans_links_and_inline_views() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Sentence>(|| ()));
        let batch = c.commit().unwrap();
        let text = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
        };
        let t = text(&batch).expect("one paragraph");
        assert_eq!(t.text, "Tapped 0 the link, bold\u{fffc}");
        assert_eq!(t.attachments.len(), 1, "the view sits in the text");
        assert!(t.spans.iter().any(|s| s.style.font_weight == 700));
        let link = &t.links[0];
        assert_eq!((link.start, link.end), (9, 17));
        assert_eq!(
            link.props.accessibility.role,
            crate::AccessibilityRole::Link
        );
        assert_eq!(link.props.test_id.as_deref(), Some("terms"));
        assert_eq!(link.props.focusable, Some(true));
        // Only the block and the inline view have native views.
        let views = batch
            .items
            .iter()
            .filter(|i| matches!(i, MountItem::Create { .. }))
            .count();
        assert_eq!(views, 3, "the root's host, the text and the view");
        // The link takes the press; the content changes in place.
        assert!(c.component_event(link.node, EventKind::Press, &EventPayload::None));
        let t = text(&c.commit().unwrap()).expect("built again");
        // A piece added between a span and the view goes in its place.
        assert_eq!(t.text, "Tapped 1 the link, bold and more\u{fffc}");
        assert_eq!(t.links[0].props.focusable, Some(false));
        // A real span has no native view, but its published link is a focus
        // target. Other commands still require their own native view.
        for command in [
            Command::Focus,
            Command::AccessibilityFocus,
            Command::Blur,
            Command::SetSelection { start: 0, end: 1 },
        ] {
            c.apply(Op::Command {
                id: link.node,
                command,
            })
            .unwrap();
        }
        let batch = c.commit().unwrap();
        let commands: Vec<_> = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::Command { id, command } => Some((*id, command.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            commands,
            [
                (link.node, Command::Focus),
                (link.node, Command::AccessibilityFocus),
                (link.node, Command::Blur),
            ]
        );
        // Removing the listener withdraws the link from the same snapshot;
        // a known span id must no longer receive native focus commands.
        c.apply(Op::Listen {
            id: link.node,
            event: EventKind::Press,
            enabled: false,
        })
        .unwrap();
        c.apply(Op::Command {
            id: link.node,
            command: Command::Focus,
        })
        .unwrap();
        let batch = c.commit().unwrap();
        assert!(text(&batch).unwrap().links.is_empty());
        assert!(
            !batch
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Command { .. }))
        );
    }
}

/// Rust components' touches and responder (`touch.rs`).
mod touch {
    use super::*;
    use crate::{
        TouchEvent, TouchPhase, TouchPoint,
        ui::{ClaimRequest, ResponderEvent, TouchClaim, prelude::*},
    };

    #[derive(Clone, PartialEq, Props)]
    struct PadProps {
        #[prop(default)]
        keep: bool,
    }

    /// An outer view taking horizontal swipes from an inner one that claims
    /// touches on start.
    #[component]
    fn Pad(props: PadProps) -> impl IntoElement {
        let log = signal(Vec::<String>::new());
        let note = move |what: &'static str, f: fn(&ResponderEvent) -> String| {
            move |e: &ResponderEvent| log.update(|l| l.push(format!("{what}{}", f(e))))
        };
        let none = |_: &ResponderEvent| String::new();
        view()
            .on_touch(move |t: &TouchEvent| log.update(|l| l.push(format!("touch {:?}", t.phase))))
            .claim_touches(TouchClaim::on_move().capture().ask(|r: &ClaimRequest| {
                if r.event.gesture.delta.x.abs() > px(50.0) {
                    r.claim();
                }
            }))
            .on_responder_grant(note("outer grant", none))
            .on_responder_reject(note("outer reject", none))
            .child(
                view()
                    .size(px(100.0))
                    .claim_touches(TouchClaim::on_start())
                    .keep_touches(props.keep)
                    .on_responder_grant(note("grant at ", |e| {
                        format!("{},{}", e.location.x.0, e.location.y.0)
                    }))
                    .on_responder_move(note("move ", |e| {
                        format!("{},{}", e.gesture.delta.x.0, e.gesture.delta.y.0)
                    }))
                    .on_responder_release(note("release ", |e| format!("{:.2}", e.gesture.vx)))
                    .on_responder_terminate(note("terminate", none)),
            )
            .child(text(move || log.with(|l| l.join("|"))))
    }

    fn touch(phase: TouchPhase, path: &[NodeId], x: f32, t: f64) -> EventPayload {
        EventPayload::Touch(Box::new(TouchEvent {
            phase,
            timestamp: t,
            activated: None,
            points: vec![TouchPoint {
                id: 7,
                target: path[0],
                path: if phase == TouchPhase::Start {
                    path.to_vec()
                } else {
                    Vec::new()
                },
                page: point(px(x), px(100.0)),
                location: point(px(x - 10.0), px(5.0)),
                changed: true,
            }],
        }))
    }

    fn log(batch: &MountBatch) -> Option<String> {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
    }

    fn commands(batch: &MountBatch) -> Vec<(NodeId, Command)> {
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Command { id, command } => Some((*id, command.clone())),
                _ => None,
            })
            .collect()
    }

    /// The pad mounted: the core, the outer node and the inner one (both
    /// listen to touches).
    fn mount_pad(keep: bool) -> (Core<FakeEngine>, NodeId, NodeId) {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Pad>(move || PadProps { keep }));
        let batch = c.commit().unwrap();
        let listening: Vec<NodeId> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Touch) => Some(*id),
                _ => None,
            })
            .collect();
        let [outer, inner] = listening[..] else {
            panic!("two listening views: {listening:?}");
        };
        (c, outer, inner)
    }

    #[test]
    fn an_element_claims_the_touches_on_start_and_blocks_scrolling() {
        let (mut c, outer, inner) = mount_pad(false);
        let path = [inner, outer];
        // The root's touches: the components hear theirs, JS still gets
        // the event for its own nodes.
        assert!(!c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &path, 20.0, 0.0)
        ));
        let batch = c.commit().unwrap();
        assert_eq!(log(&batch).unwrap(), "touch Start|grant at 10,5");
        assert_eq!(
            commands(&batch),
            [(inner, Command::SetJsResponder { block: true })]
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Move, &path, 40.0, 16.0),
        );
        let batch = c.commit().unwrap();
        assert_eq!(
            log(&batch).unwrap(),
            "touch Start|grant at 10,5|touch Move|move 20,0"
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::End, &path, 40.0, 32.0),
        );
        let batch = c.commit().unwrap();
        assert!(log(&batch).unwrap().ends_with("|touch End|release 0.88"));
        assert_eq!(commands(&batch), [(ROOT_ID, Command::ClearJsResponder)]);
    }

    #[test]
    fn a_capturing_claim_takes_the_touches_over_unless_they_are_kept() {
        let (mut c, outer, inner) = mount_pad(false);
        let path = [inner, outer];
        let send = |c: &mut Core<FakeEngine>, phase, x, t| {
            c.component_event(ROOT_ID, EventKind::Touch, &touch(phase, &path, x, t));
        };
        send(&mut c, TouchPhase::Start, 0.0, 0.0);
        send(&mut c, TouchPhase::Move, 30.0, 16.0);
        // Far enough sideways: the outer view asks and claims.
        send(&mut c, TouchPhase::Move, 80.0, 32.0);
        let batch = c.commit().unwrap();
        let text = log(&batch).unwrap();
        assert!(
            text.ends_with("move 30,0|touch Move|terminate|outer grant"),
            "{text}"
        );
        assert_eq!(
            commands(&batch).last(),
            Some(&(outer, Command::SetJsResponder { block: true }))
        );

        // An inner responder that keeps the touches rejects the claim.
        let (mut c, outer, inner) = mount_pad(true);
        let path = [inner, outer];
        let send = |c: &mut Core<FakeEngine>, phase, x, t| {
            c.component_event(ROOT_ID, EventKind::Touch, &touch(phase, &path, x, t));
        };
        send(&mut c, TouchPhase::Start, 0.0, 0.0);
        send(&mut c, TouchPhase::Move, 80.0, 16.0);
        let text = log(&c.commit().unwrap()).unwrap();
        assert!(text.ends_with("|outer reject|move 80,0"), "{text}");
        // A cancel (a native gesture took over) terminates it.
        send(&mut c, TouchPhase::Cancel, 80.0, 32.0);
        let batch = c.commit().unwrap();
        assert!(log(&batch).unwrap().ends_with("|terminate"));
        assert_eq!(commands(&batch), [(ROOT_ID, Command::ClearJsResponder)]);
    }

    #[test]
    fn physical_contact_cleanup_preserves_other_contacts_and_never_calls_rust_listeners() {
        let (mut c, outer, inner) = mount_pad(false);
        let path = [inner, outer];
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &path, 20.0, 0.0),
        );
        let EventPayload::Touch(mut second) = touch(TouchPhase::Start, &path, 20.0, 16.0) else {
            unreachable!();
        };
        let mut first = second.points[0].clone();
        first.changed = false;
        second.points[0].id = 8;
        // A second contact has no Rust listeners on its own path, but the
        // existing responder still owns its moves until every contact ends.
        second.points[0].path.clear();
        second.points.insert(0, first);
        c.component_event(ROOT_ID, EventKind::Touch, &EventPayload::Touch(second));
        assert_eq!(
            log(&c.commit().unwrap()).unwrap(),
            "touch Start|grant at 10,5"
        );

        c.cancel_touch(7);
        c.cancel_touch(7);
        c.cancel_touch(99);
        let EventPayload::Touch(mut movement) = touch(TouchPhase::Move, &path, 40.0, 32.0) else {
            unreachable!();
        };
        movement.points[0].id = 8;
        c.component_event(ROOT_ID, EventKind::Touch, &EventPayload::Touch(movement));
        let batch = c.commit().unwrap();
        assert!(commands(&batch).is_empty());
        let moved = log(&batch).unwrap();
        assert!(moved.starts_with("touch Start|grant at 10,5|move "));

        c.cancel_touch(8);
        let batch = c.commit().unwrap();
        assert_eq!(commands(&batch), [(ROOT_ID, Command::ClearJsResponder)]);
        assert_eq!(log(&batch), None, "cancellation never calls a listener");
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &path, 20.0, 48.0),
        );
        assert_eq!(
            log(&c.commit().unwrap()).unwrap(),
            format!("{moved}|touch Start|grant at 10,5")
        );
    }

    #[test]
    fn js_and_component_responders_share_the_native_block() {
        let (mut c, outer, inner) = mount_pad(false);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                Op::Command {
                    id: 2,
                    command: Command::SetJsResponder { block: true },
                },
            ],
        );
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(2, Command::SetJsResponder { block: true })]
        );
        // A component's responder blocks around itself while it has the
        // touches; when it lets go, JS's block is back.
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &[inner, outer], 0.0, 0.0),
        );
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(inner, Command::SetJsResponder { block: true })]
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::End, &[inner, outer], 0.0, 16.0),
        );
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(2, Command::SetJsResponder { block: true })]
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &[inner, outer], 0.0, 32.0),
        );
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(inner, Command::SetJsResponder { block: true })]
        );
        c.cancel_touch(7);
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(2, Command::SetJsResponder { block: true })],
            "physical cleanup only releases the Rust side's native block"
        );
        apply(
            &mut c,
            vec![Op::Command {
                id: ROOT_ID,
                command: Command::ClearJsResponder,
            }],
        );
        assert_eq!(
            commands(&c.commit().unwrap()),
            [(ROOT_ID, Command::ClearJsResponder)]
        );
    }

    /// A view scrubbed sideways: it waits for the platform's pan (its
    /// start claim is not asked meanwhile).
    #[component]
    fn Scrub() -> impl IntoElement {
        let log = signal(Vec::<String>::new());
        view()
            .child(
                view()
                    .size(px(100.0))
                    .claim_touches(TouchClaim::on_start())
                    .claim_touches(TouchClaim::on_pan(crate::PanActivation::horizontal(
                        px(10.0),
                        px(10.0),
                    )))
                    .on_responder_grant(move |_: &ResponderEvent| {
                        log.update(|l| l.push("grant".into()));
                    }),
            )
            .child(text(move || log.with(|l| l.join("|"))))
    }

    #[test]
    fn a_pan_claim_waits_for_the_platform_to_activate_it() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Scrub>(|| ()));
        let batch = c.commit().unwrap();
        let (id, activation) = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } => props.pan_activation.map(|a| (*id, a)),
                _ => None,
            })
            .expect("the activation is mounted");
        assert_eq!(
            activation,
            crate::PanActivation::horizontal(px(10.0), px(10.0))
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &[id], 0.0, 0.0),
        );
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Move, &[id], 5.0, 16.0),
        );
        // Nothing to mount: no claim before the activation.
        assert!(c.commit().is_none_or(|b| commands(&b).is_empty()));
        let mut activated = touch(TouchPhase::Move, &[id], 14.0, 32.0);
        if let EventPayload::Touch(t) = &mut activated {
            t.activated = Some(id);
        }
        c.component_event(ROOT_ID, EventKind::Touch, &activated);
        let batch = c.commit().unwrap();
        assert_eq!(log(&batch), Some("grant".into()), "{batch:?}");
        assert_eq!(
            commands(&batch),
            [(id, Command::SetJsResponder { block: true })]
        );
    }

    /// A band dragged by its touches, dimmed while pressed.
    #[component]
    fn Band() -> impl IntoElement {
        view()
            .size(px(40.0))
            .opacity(0.9)
            .active(|s| s.opacity(0.5))
            .claim_touches(TouchClaim::on_start())
    }

    #[test]
    fn the_responder_stays_pressed_until_its_touches_end() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Band>(|| ()));
        let batch = c.commit().unwrap();
        let id = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewStyle { id, style } if style.opacity == 0.9 => Some(*id),
                _ => None,
            })
            .expect("the band is mounted");
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::Start, &[id], 0.0, 0.0),
        );
        let batch = c.commit().unwrap();
        assert_eq!(view_style_of(&batch, id).unwrap().opacity, 0.5);
        // The drag left the band: the platform reports it no longer pressed.
        c.set_states(id, 0);
        assert!(c.commit().is_none_or(|b| view_style_of(&b, id).is_none()));
        c.component_event(
            ROOT_ID,
            EventKind::Touch,
            &touch(TouchPhase::End, &[id], 80.0, 16.0),
        );
        let batch = c.commit().unwrap();
        assert_eq!(view_style_of(&batch, id).unwrap().opacity, 0.9);
    }

    #[test]
    fn a_pan_activation_decides_by_axis() {
        let pan = crate::PanActivation::horizontal(px(10.0), px(8.0));
        assert_eq!(pan.decide(px(4.0), px(3.0)), None);
        assert_eq!(pan.decide(px(-11.0), px(3.0)), Some(true));
        assert_eq!(pan.decide(px(4.0), px(-9.0)), Some(false));
        // Both passed by one move: the fail offset wins.
        assert_eq!(pan.decide(px(20.0), px(9.0)), Some(false));
        let any = crate::PanActivation::default();
        assert_eq!(any.decide(px(6.0), px(6.0)), None);
        assert_eq!(any.decide(px(8.0), px(8.0)), Some(true));
    }

    /// A card scaled and turned by two-finger gestures.
    #[component]
    fn Card() -> impl IntoElement {
        let (scale, angle) = (animated_value(1.0), animated_value(0.0));
        view()
            .pinch_value(&scale)
            .rotation_value(&angle)
            .bind_scale(&scale)
            .bind_rotate(&angle)
    }

    #[test]
    fn pinches_and_rotations_drive_animated_values() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Card>(|| ()));
        let batch = c.commit().unwrap();
        let values = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Gestures { values, .. } => Some(*values),
                _ => None,
            })
            .expect("gesture values");
        let created: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Animation(AnimationOp::CreateValue { node, .. }) => Some(*node),
                _ => None,
            })
            .collect();
        assert_eq!(values.pinch, Some(created[0]));
        assert_eq!(values.rotation, Some(created[1]));
    }
}

/// Rust components' drawings (`ui::Painter`).
mod painter {
    use super::*;
    use crate::{
        canvas::{CanvasGradient, CanvasOp, FillRule, GradientShape, Num, Paint, svg_path},
        geometry::{bounds, percentage, point, px, radians, size},
        ui::prelude::*,
    };

    #[test]
    fn painters_hit_test_what_they_drew() {
        // A slice drawn moved by 10, a line along the top, a rectangle as
        // the current path.
        let slice = svg_path("M0 0 L40 0 L0 40 Z");
        let p = Painter::new()
            .save()
            .translate(10.0, 10.0)
            .fill_path(&slice, FillRule::NonZero)
            .restore()
            .line_width(4.0)
            .stroke_svg("M0 2 L100 2")
            .begin_path()
            .rect(bounds(point(px(60.0), px(60.0)), size(px(20.0), px(20.0))));
        let at = |x, y| point(px(x), px(y));
        // Paths given are tested with the transform at the end: drawn
        // translated, the slice is hit where it shows only with the same
        // transform recorded.
        assert!(p.path_contains(&slice, at(5.0, 5.0), FillRule::NonZero));
        assert!(!p.path_contains(&slice, at(45.0, 45.0), FillRule::NonZero));
        let moved = Painter::new().translate(10.0, 10.0);
        assert!(moved.path_contains(&slice, at(15.0, 15.0), FillRule::NonZero));
        assert!(!moved.path_contains(&slice, at(5.0, 5.0), FillRule::NonZero));
        // The current path, and strokes with the line width.
        assert!(p.is_point_in_path(at(70.0, 70.0), FillRule::EvenOdd));
        assert!(!p.is_point_in_path(at(50.0, 70.0), FillRule::NonZero));
        assert!(p.is_point_in_stroke(at(60.0, 70.0)));
        assert!(!p.is_point_in_stroke(at(70.0, 70.0)));
        let top = svg_path("M0 2 L100 2");
        assert!(p.stroke_contains(&top, at(50.0, 3.5)));
        assert!(!p.stroke_contains(&top, at(50.0, 5.0)));
    }

    /// A drawing painting with its view's style: the stroke, width and
    /// dashes of the canvas's own style, the fill `currentColor`, the text
    /// color the canvas inherits.
    #[component]
    fn ViewPainted() -> impl IntoElement {
        use crate::{PatchValue, StyleDecl, StyleKey, SvgPaint};
        let set = |key, value: &str| StyleDecl::Set(key, PatchValue::Str(value.into()));
        let p = Painter::new()
            .fill_style_from_view(SvgPaint::CurrentColor)
            .stroke_style_from_view(SvgPaint::None)
            .line_width_from_view()
            .line_dash_from_view()
            .fill_rect(0.0, 0.0, 10.0, 10.0);
        view()
            .inline_style(crate::ui::Style::from_decls([set(
                StyleKey::Color,
                "#00ff00",
            )]))
            .child(canvas(p).inline_style(crate::ui::Style::from_decls([
                set(StyleKey::Stroke, "#ff0000"),
                set(StyleKey::StrokeWidth, "3"),
                set(StyleKey::StrokeDasharray, "2 1"),
            ])))
            .child(canvas(
                Painter::new()
                    .fill_style_from_view(SvgPaint::None)
                    .stroke_style_from_view(SvgPaint::CurrentColor)
                    .line_width_from_view()
                    .line_dash_from_view(),
            ))
    }

    #[test]
    fn drawings_paint_with_their_views_style() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<ViewPainted>(|| ()));
        let batch = c.commit().unwrap();
        let drawings: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Canvas { drawing, .. } => Some(drawing.clone()),
                _ => None,
            })
            .collect();
        let [styled, plain] = &drawings[..] else {
            panic!("{drawings:?}")
        };
        let green = crate::style::Color(0x00ff_00ff);
        assert_eq!(styled.ops[0], CanvasOp::FillStyle(Paint::Color(green)));
        assert_eq!(
            styled.ops[1],
            CanvasOp::StrokeStyle(Paint::Color(crate::style::Color(0xff00_00ff)))
        );
        assert_eq!(styled.ops[2], CanvasOp::LineWidth(Num::Const(3.0)));
        assert_eq!(styled.ops[3], CanvasOp::LineDash([px(2.0), px(1.0)].into()));
        // Nothing set: the drawing's initial paints, CSS's width of 1 and a
        // solid line.
        assert_eq!(
            plain.ops[0],
            CanvasOp::FillStyle(Paint::Color(crate::style::Color::TRANSPARENT))
        );
        assert_eq!(plain.ops[1], CanvasOp::StrokeStyle(Paint::Color(green)));
        assert_eq!(plain.ops[2], CanvasOp::LineWidth(Num::Const(1.0)));
        assert_eq!(plain.ops[3], CanvasOp::LineDash([].into()));
    }
    /// A canvas that has drawn nothing and records an empty drawing (a
    /// component's canvas before its first layout) sends nothing; one
    /// that has drawn sends what it draws.
    #[component]
    fn EmptyAndDrawn() -> impl IntoElement {
        view()
            .child(canvas(Painter::new()))
            .child(canvas(Painter::new().fill_rect(0.0, 0.0, 10.0, 10.0)))
    }

    #[test]
    fn an_empty_first_drawing_sends_nothing() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<EmptyAndDrawn>(|| ()));
        let batch = c.commit().unwrap();
        let drawings: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Canvas { drawing, .. } => Some(drawing.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(drawings.len(), 1, "{drawings:?}");
        assert!(!drawings[0].ops.is_empty());
    }

    /// A label placed by its measured width, gradients, a stroked SVG path
    /// and an operation built by hand reading an animated value.
    #[component]
    fn Label() -> impl IntoElement {
        let offset = animated_value(3.0);
        let width = crate::ui::prelude::measure_text("600 20px system-ui", "100%");
        let mut p = Painter::new()
            .stroke_style(
                CanvasGradient::conic(radians(0.0), point(px(50.0), px(50.0)))
                    .add_color_stop(percentage(1.0), rgb(0x6366f1))
                    .add_color_stop(percentage(0.0), rgb(0x22d3ee)),
            )
            .stroke_path(&svg_path("M20 6L9 17l-5-5"))
            .fill_style(CanvasGradient::radial(
                point(px(0.0), px(0.0)),
                px(4.0),
                point(px(0.0), px(0.0)),
                px(40.0),
            ))
            .fill_path(&svg_path("M0 0h10v10z"), FillRule::EvenOdd)
            .fill_text("100%", 50.0 - width.0, 20.0);
        let x = p.num(&offset);
        p = p.op(CanvasOp::LineDashOffset(x));
        view().child(canvas(p))
    }

    #[test]
    fn rust_drawings_measure_text_and_use_every_paint() {
        let mut c = core();
        c.mount_root(&crate::ui::Root::new::<Label>(|| ()));
        let batch = c.commit().unwrap();
        let drawing = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Canvas { drawing, .. } => Some(drawing.clone()),
                _ => None,
            })
            .expect("a drawing");
        let ops = &drawing.ops;
        // Stops sorted by offset, whatever order they came in.
        let CanvasOp::StrokeStyle(Paint::Gradient(ring)) = &ops[0] else {
            panic!("{:?}", ops[0])
        };
        assert_eq!(
            ring.shape,
            GradientShape::Conic {
                start_angle: radians(0.0),
                center: point(px(50.0), px(50.0)),
            }
        );
        assert_eq!(ring.stops[0], (percentage(0.0), Color::from(rgb(0x22d3ee))));
        assert!(matches!(&ops[1], CanvasOp::Stroke(Some(path)) if path.len() == 3));
        assert!(matches!(
            &ops[2],
            CanvasOp::FillStyle(Paint::Gradient(g)) if matches!(g.shape, GradientShape::Radial { .. })
        ));
        assert!(matches!(
            &ops[3],
            CanvasOp::Fill(Some(_), FillRule::EvenOdd)
        ));
        // 8pt per character in the fake engine.
        assert!(matches!(
            &ops[4],
            CanvasOp::FillText {
                x: Num::Const(18.0),
                ..
            }
        ));
        // The animated value is a slot of the drawing.
        assert_eq!(ops[5], CanvasOp::LineDashOffset(Num::Slot(0)));
        assert_eq!(drawing.slots.len(), 1);
    }
}

/// A row (2) holding a field (3) whose absolutely placed menu (4) hangs
/// below it, inside a card (5): row and card get the menu's area, the
/// field does not reach out of the card, a clipping card stops it.
#[test]
fn overflowing_children_mount_their_area() {
    let mut c = core();
    let create = |id| Op::Create { id, tag: Tag::View };
    let insert = |parent, child| Op::Insert {
        parent,
        child,
        before: None,
    };
    apply(
        &mut c,
        vec![
            create(5),
            create(2),
            create(4),
            style_op(5, &[("padding", StyleValue::Number(10.0))]),
            style_op(2, &[("height", StyleValue::Number(40.0))]),
            style_op(
                4,
                &[
                    ("position", StyleValue::Str("absolute")),
                    ("top", StyleValue::Number(40.0)),
                    ("left", StyleValue::Number(0.0)),
                    ("width", StyleValue::Number(100.0)),
                    ("height", StyleValue::Number(120.0)),
                ],
            ),
            insert(2, 4),
            insert(5, 2),
            insert(ROOT_ID, 5),
        ],
    );
    let batch = c.commit().unwrap();
    let overflow = |batch: &MountBatch, id: NodeId| {
        batch.items.iter().rev().find_map(|i| match i {
            MountItem::Overflow { id: i, extent } if *i == id => Some(*extent),
            _ => None,
        })
    };
    // The row is 300 wide (the card's padding), 40 tall: the menu reaches
    // 120 below it.
    assert_eq!(
        overflow(&batch, 2),
        Some(Some(rect(0.0, 0.0, 300.0, 160.0)))
    );
    // In the card (60 tall: 40 + padding) at (10, 10): down to 170.
    assert_eq!(
        overflow(&batch, 5),
        Some(Some(rect(0.0, 0.0, 320.0, 170.0)))
    );
    // Leaves have nothing to report, and nothing is sent again unchanged.
    assert_eq!(overflow(&batch, 4), None);
    c.apply(style_op(2, &[("height", StyleValue::Number(40.0))]))
        .unwrap();
    if let Some(batch) = c.commit() {
        assert_eq!(overflow(&batch, 2), None);
    }
    // A clipping card has no area (what is outside is not drawn), and the
    // menu inside the row now fits: the row's area goes away.
    c.apply(style_op(
        5,
        &[
            ("padding", StyleValue::Number(10.0)),
            ("overflow", StyleValue::Str("hidden")),
        ],
    ))
    .unwrap();
    c.apply(style_op(2, &[("height", StyleValue::Number(200.0))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(overflow(&batch, 5), Some(None));
    assert_eq!(overflow(&batch, 2), Some(None));
}

/// A view that loses its only, absolutely placed child lays out again:
/// taffy keeps the children it hoisted out of flow while the view has no
/// children to lay out, so the freed child must not stay listed there.
#[test]
fn a_view_that_loses_its_absolute_child_lays_out() {
    let mut c = core();
    for (id, absolute) in [(2, false), (4, true), (6, false)] {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
        let mut props = vec![("height", StyleValue::Number(20.0))];
        if absolute {
            props.push(("position", StyleValue::Str("absolute")));
        }
        c.apply(style_op(id, &props)).unwrap();
    }
    for (parent, child) in [(2, 4), (ROOT_ID, 2), (ROOT_ID, 6)] {
        c.apply(Op::Insert {
            parent,
            child,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    c.apply(Op::Release { id: 4 }).unwrap();
    // A new node takes the freed one's slot.
    c.apply(Op::Create {
        id: 8,
        tag: Tag::View,
    })
    .unwrap();
    c.apply(Op::Insert {
        parent: 6,
        child: 8,
        before: None,
    })
    .unwrap();
    c.apply(style_op(2, &[("height", StyleValue::Number(30.0))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Frame { id: 6, frame, .. } if frame.origin.y.0 == 30.0
    )));
}

/// An absolutely placed view leaving a block that is not laid out again (in
/// a `display: none` subtree, which taffy hides without renewing the
/// blocks' lists of the out-of-flow boxes they placed) lays out: the freed
/// view must not stay listed there. Its sibling stays and keeps the block
/// from being childless.
#[test]
fn an_absolute_view_leaving_a_hidden_block_lays_out() {
    let mut c = core();
    // 2 (hidden later) > 4 (relative: the block) > 6 (absolute), 8.
    for (id, absolute) in [(2, false), (4, false), (6, true), (8, false)] {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
        let mut props = vec![("height", StyleValue::Number(20.0))];
        if absolute {
            props.push(("position", StyleValue::Str("absolute")));
        }
        if id == 4 {
            props.push(("position", StyleValue::Str("relative")));
        }
        c.apply(style_op(id, &props)).unwrap();
    }
    for (parent, child) in [(4, 6), (4, 8), (2, 4), (ROOT_ID, 2)] {
        c.apply(Op::Insert {
            parent,
            child,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    c.apply(style_op(
        2,
        &[
            ("height", StyleValue::Number(20.0)),
            ("display", StyleValue::Str("none")),
        ],
    ))
    .unwrap();
    c.commit().unwrap();
    // Out while hidden, and a new view takes the freed one's slot.
    c.apply(Op::Release { id: 6 }).unwrap();
    c.apply(Op::Create {
        id: 10,
        tag: Tag::View,
    })
    .unwrap();
    c.apply(Op::Insert {
        parent: ROOT_ID,
        child: 10,
        before: None,
    })
    .unwrap();
    c.commit().unwrap();
    // Shown again: the block lays its children out.
    c.apply(style_op(2, &[("height", StyleValue::Number(30.0))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Frame { id: 10, frame, .. } if frame.origin.y.0 == 30.0
    )));
}

/// As above, with the block absolutely placed itself: its fresh layout node
/// must not leave its old one listed by the block that placed it.
#[test]
fn an_absolute_view_leaving_a_hidden_absolute_block_lays_out() {
    let mut c = core();
    // 2 (hidden later) > 4 (absolute: the block) > 6 (absolute), 8.
    for (id, absolute) in [(2, false), (4, true), (6, true), (8, false)] {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
        let mut props = vec![("height", StyleValue::Number(20.0))];
        if absolute {
            props.push(("position", StyleValue::Str("absolute")));
        }
        c.apply(style_op(id, &props)).unwrap();
    }
    for (parent, child) in [(4, 6), (4, 8), (2, 4), (ROOT_ID, 2)] {
        c.apply(Op::Insert {
            parent,
            child,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    c.apply(style_op(
        2,
        &[
            ("height", StyleValue::Number(20.0)),
            ("display", StyleValue::Str("none")),
        ],
    ))
    .unwrap();
    c.commit().unwrap();
    // Out while hidden, and new views take the freed ones' slots.
    c.apply(Op::Release { id: 6 }).unwrap();
    for id in [10, 12] {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
        c.apply(Op::Insert {
            parent: ROOT_ID,
            child: id,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    // Shown again: the blocks lay their children out.
    c.apply(style_op(2, &[("height", StyleValue::Number(30.0))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Frame { id: 10, frame, .. } if frame.origin.y.0 == 30.0
    )));
}

/// `measure` gives the frame in the parent and the position in the root
/// view, minus the offsets of the scroll views around.
#[test]
fn measures_in_root_coordinates() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Scroll,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            Op::Create {
                id: 6,
                tag: Tag::View,
            },
            style_op(
                2,
                &[
                    ("marginTop", StyleValue::Number(50.0)),
                    ("height", StyleValue::Number(300.0)),
                ],
            ),
            style_op(
                4,
                &[
                    ("padding", StyleValue::Number(20.0)),
                    ("height", StyleValue::Number(1000.0)),
                ],
            ),
            style_op(
                6,
                &[
                    ("marginTop", StyleValue::Number(500.0)),
                    ("height", StyleValue::Number(30.0)),
                ],
            ),
            Op::Insert {
                parent: 4,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit().unwrap();
    let m = c.measure(6).unwrap();
    assert_eq!(m.frame, rect(20.0, 520.0, 280.0, 30.0));
    assert_eq!(m.page, point(px(20.0), px(570.0)));
    c.set_scroll_offset(2, point(px(0.0), px(400.0)), u32::MAX);
    let m = c.measure(6).unwrap();
    assert_eq!(m.page, point(px(20.0), px(170.0)));
    // Detached or unknown: nothing to measure.
    c.apply(Op::Remove {
        parent: 4,
        child: 6,
    })
    .unwrap();
    c.commit();
    assert_eq!(c.measure(6), None);
    assert_eq!(c.measure(1000), None);
}

/// `desktop={{ windowDrag }}` reaches the platform in the view's props, and
/// clearing it sends them again.
#[test]
fn window_drag_is_a_view_prop() {
    let mut c = core();
    let drag = |value| Op::SetProp {
        id: 2,
        prop: Prop::WindowDrag(value),
    };
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            drag(Some(true)),
            Op::Insert {
                parent: crate::ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ViewProps { id: 2, props } if props.window_drag == Some(true))
    ));
    apply(&mut c, vec![drag(None)]);
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ViewProps { id: 2, props } if props.window_drag.is_none())
    ));
}

/// `focusable={false}` reaches the platform in the view's props.
#[test]
fn focusable_is_a_view_prop() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Focusable(Some(false)),
            },
            Op::Insert {
                parent: crate::ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(
        |i| matches!(i, MountItem::ViewProps { id: 2, props } if props.focusable == Some(false))
    ));
    // Cleared (JS's `undefined`): the default, sent again.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Focusable(None),
        }],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch.items.iter().any(
            |i| matches!(i, MountItem::ViewProps { id: 2, props } if props.focusable.is_none())
        )
    );
}

/// Components that run once: their views mounted with bindings.
mod views {
    use std::{cell::Cell, rc::Rc};

    use serde_json::json;

    use super::*;
    use crate::{
        Prop,
        ui::{Component, Props, Registry, Root, Scope, prelude::*},
    };

    fn texts(batch: &MountBatch) -> Vec<String> {
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Text { text, .. } => Some(text.text.clone()),
                _ => None,
            })
            .collect()
    }

    fn root_host(batch: &MountBatch) -> NodeId {
        batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert {
                    parent: ROOT_ID,
                    child,
                    ..
                } => Some(*child),
                _ => None,
            })
            .expect("the root's host is in the root view")
    }

    /// The node showing text `content`.
    fn text_node(batch: &MountBatch, content: &str) -> NodeId {
        batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text { id, text, .. } if text.text == content => Some(*id),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no text {content:?}"))
    }

    /// The native parent of node `id`.
    fn native_parent<M: TextEngine>(c: &Core<M>, id: NodeId) -> Option<NodeId> {
        let key = c.key(id).expect("a node");
        let parent = c.nodes[key as usize].parent;
        (parent != NO_KEY).then(|| c.nodes[parent as usize].id)
    }

    /// Counts presses: the text is a binding, nothing renders again.
    #[derive(Default)]
    struct Counter;

    #[derive(Clone, PartialEq, Props)]
    struct CounterProps {
        #[prop(default = "Taps".into())]
        label: crate::ui::Prop<SharedString>,
    }

    #[derive(Event)]
    enum CounterEvent {
        Tap(u32),
    }

    impl Component for Counter {
        type Props = CounterProps;
        type Event = CounterEvent;

        fn view(props: CounterProps, cx: Scope<CounterEvent>) -> impl IntoElement {
            let count = signal(0);
            view()
                .p_2()
                .on_press(move |_: &()| {
                    count.update(|n| *n += 1);
                    cx.emit(CounterEvent::Tap(count.get_untracked()));
                })
                .child(text(move || {
                    format!("{} {}", props.label.get(), count.get())
                }))
                .child(text("static"))
        }
    }

    #[test]
    fn a_view_runs_once_and_its_bindings_send_only_what_changed() {
        let mut c = core();
        c.mount_root(&Root::new::<Counter>(|| CounterProps {
            label: "Hits".into(),
        }));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Hits 0", "static"]);
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Hits 1"], "one text changed");
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Create { .. } | MountItem::Delete { .. })),
            "no node made or freed: {:?}",
            batch.items
        );
    }

    #[component]
    fn ForwardedCounter(_props: (), cx: Scope<CounterEvent>) -> impl IntoElement {
        view()
            .on_press(cx.forward(CounterEvent::Tap(7)))
            .child(text("forwarded"))
    }

    /// Two listeners of one event on one element, and of a nested
    /// component's events, each noting itself.
    #[component]
    fn Twice() -> impl IntoElement {
        let log = signal(String::new());
        let note = move |c: char| log.update(|l| l.push(c));
        view()
            .on_press(move || note('a'))
            .on_press(move || note('b'))
            .child(
                Counter::element(CounterProps::default())
                    .on_event(move |_: &CounterEvent| note('c'))
                    .on_event(move |_: &CounterEvent| note('d')),
            )
            .child(
                ForwardedCounter::element(()).on_event(move |event: &CounterEvent| {
                    let CounterEvent::Tap(value) = event;
                    assert_eq!(*value, 7);
                    note('e');
                }),
            )
            .child(text(move || format!("log {}", log.get())))
    }

    #[test]
    fn every_listener_of_an_event_runs_in_order() {
        let mut c = core();
        c.mount_root(&Root::new::<Twice>(|| ()));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        let counter = native_parent(&c, text_node(&batch, "Taps 0")).unwrap();
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["log ab"]);
        assert!(c.component_event(counter, EventKind::Press, &EventPayload::None));
        assert!(texts(&c.commit().unwrap()).contains(&"log abcd".to_owned()));
        let forwarded = native_parent(&c, text_node(&batch, "forwarded")).unwrap();
        assert!(c.component_event(forwarded, EventKind::Press, &EventPayload::None));
        assert!(texts(&c.commit().unwrap()).contains(&"log abcde".to_owned()));
    }

    #[derive(Event)]
    enum ChooserEvent {
        Press,
        Pick(u32),
        Placed { at: u32 },
    }

    /// Emits each of its events on a press: a press, the pick 7, the
    /// placement at 9.
    #[component]
    fn Chooser(cx: Scope<ChooserEvent>) -> impl IntoElement {
        view().child(text("choose")).on_press(move || {
            cx.emit(ChooserEvent::Press);
            cx.emit(ChooserEvent::Pick(7));
            cx.emit(ChooserEvent::Placed { at: 9 });
        })
    }

    /// A [`Chooser`] heard through its events' listener methods.
    #[component]
    fn Chosen() -> impl IntoElement {
        let log = signal(String::new());
        let note = move |s: String| log.update(|l| l.push_str(&s));
        view()
            .child(
                chooser()
                    .on_press(move || note("press ".into()))
                    .on_press(move |_: &()| note("again ".into()))
                    .on_pick(move |index: &u32| note(format!("pick {index} ")))
                    .on_placed(move |event: &ChooserEvent| {
                        if let ChooserEvent::Placed { at } = event {
                            note(format!("placed {at}"));
                        }
                    }),
            )
            .child(text(move || format!("log {}", log.get())))
    }

    #[test]
    fn a_components_listener_methods_hear_their_event_and_its_data() {
        let mut c = core();
        c.mount_root(&Root::new::<Chosen>(|| ()));
        let batch = c.commit().unwrap();
        let chooser = native_parent(&c, text_node(&batch, "choose")).unwrap();
        assert!(c.component_event(chooser, EventKind::Press, &EventPayload::None));
        assert_eq!(
            texts(&c.commit().unwrap()),
            ["log press again pick 7 placed 9"]
        );
    }

    /// A region made again with what it read: its pressable text is kept
    /// (the same node), its listener the new run's.
    #[component]
    fn Rerun() -> impl IntoElement {
        let log = signal(String::new());
        let run = signal(0);
        view()
            .child(dynamic(move || {
                let at = run.get();
                text("tap").on_press(move || log.update(|l| l.push_str(&at.to_string())))
            }))
            .child(text("again").on_press(move || run.update(|r| *r += 1)))
            .child(text(move || format!("log {}", log.get())))
    }

    #[test]
    fn a_node_made_again_hears_only_its_new_listeners() {
        let mut c = core();
        c.mount_root(&Root::new::<Rerun>(|| ()));
        let batch = c.commit().unwrap();
        let (tap, again) = (text_node(&batch, "tap"), text_node(&batch, "again"));
        for _ in 0..3 {
            assert!(c.component_event(again, EventKind::Press, &EventPayload::None));
            let _ = c.commit();
        }
        assert!(c.component_event(tap, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["log 3"]);
    }

    #[test]
    fn a_prop_from_js_reaches_only_what_reads_it() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Counter>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Counter>().into()),
                },
                Op::SetProp {
                    id: 2,
                    prop: rust_prop::<CounterProps>("label", Some(json!("Hits"))),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        assert_eq!(texts(&c.commit().unwrap()), ["Hits 0", "static"]);
        c.apply(Op::SetProp {
            id: 2,
            prop: rust_prop::<CounterProps>("label", Some(json!("Runs"))),
        })
        .unwrap();
        assert_eq!(texts(&c.commit().unwrap()), ["Runs 0"]);
        // Its events reach JS.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        c.commit();
        let events = js_events(&mut c);
        assert!(events.iter().any(|(id, kind, payload)| *id == 2
            && *kind == EventKind::NativeEvent
            && matches!(payload, EventPayload::Native { name, data } if &**name == "tap" && *data == json!(1))));
    }

    /// Shows one branch or the other.
    #[derive(Default)]
    struct Toggle;

    #[derive(Clone, PartialEq, Props)]
    struct ToggleProps {}

    thread_local! {
        static CLEANED: Cell<u32> = const { Cell::new(0) };
    }

    impl Component for Toggle {
        type Props = ToggleProps;
        type Event = NoEvent;

        fn view(_: ToggleProps, _: Scope<NoEvent>) -> impl IntoElement {
            let on = signal(false);
            view()
                .on_press(move |_: &()| on.update(|v| *v = !*v))
                .child(text("before"))
                .child(
                    when(on, || {
                        cleanup(|| CLEANED.with(|c| c.set(c.get() + 1)));
                        text("on")
                    })
                    .otherwise(|| text("off")),
                )
                .child(text("after"))
        }
    }

    /// The texts under `parent`, in order (by the inserts of `batch` and
    /// those before).
    fn order(c: &Core<FakeEngine>, parent: NodeId) -> Vec<String> {
        let key = c.key(parent).unwrap();
        c.nodes[key as usize]
            .children
            .iter()
            .filter_map(|&k| {
                let node = &c.nodes[k as usize];
                node.children
                    .first()
                    .map(|&raw| c.nodes[raw as usize].text.clone())
            })
            .collect()
    }

    #[test]
    fn if_makes_the_branch_it_flips_to_in_place_and_drops_the_other() {
        let mut c = core();
        c.mount_root(&Root::new::<Toggle>(|| ToggleProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert_eq!(order(&c, host), ["before", "off", "after"]);
        c.component_event(host, EventKind::Press, &EventPayload::None);
        c.commit();
        assert_eq!(order(&c, host), ["before", "on", "after"]);
        c.component_event(host, EventKind::Press, &EventPayload::None);
        c.commit();
        assert_eq!(order(&c, host), ["before", "off", "after"]);
        assert_eq!(CLEANED.with(Cell::get), 1, "the branch's cleanup ran");
    }

    /// Flips its branch there and back in one listener: each branch is a
    /// component with a prop.
    #[derive(Default)]
    struct Flicker;

    #[derive(Clone, PartialEq, Props)]
    struct FlickerProps {}

    impl Component for Flicker {
        type Props = FlickerProps;
        type Event = NoEvent;

        fn view(_: FlickerProps, _: Scope<NoEvent>) -> impl IntoElement {
            let on = signal(false);
            view()
                .on_press(move |_: &()| {
                    on.set(true);
                    on.set(false);
                })
                .child(
                    when(on, || Counter::element(CounterProps { label: "On".into() })).otherwise(
                        || {
                            Counter::element(CounterProps {
                                label: "Off".into(),
                            })
                        },
                    ),
                )
        }
    }

    #[test]
    fn a_region_run_replaced_before_it_applied_is_never_applied() {
        let mut c = core();
        c.mount_root(&Root::new::<Flicker>(|| FlickerProps {}));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["Off 0", "static"]);
        let host = root_host(&batch);
        // The "on" run's props went with it before the core applied it:
        // only the "off" run applies, to the same counter.
        c.component_event(host, EventKind::Press, &EventPayload::None);
        let texts = c.commit().map(|batch| texts(&batch)).unwrap_or_default();
        assert!(!texts.iter().any(|t| t.starts_with("On")), "{texts:?}");
    }

    /// A list of rows by key.
    #[derive(Default)]
    struct Rows;

    #[derive(Clone, PartialEq, Props)]
    struct RowsProps {}

    thread_local! {
        static MADE: Cell<u32> = const { Cell::new(0) };
        static ITEMS: Cell<Option<Signal<Vec<u32>>>> = const { Cell::new(None) };
    }

    impl Component for Rows {
        type Props = RowsProps;
        type Event = NoEvent;

        fn view(_: RowsProps, _: Scope<NoEvent>) -> impl IntoElement {
            let items = signal(vec![1, 2, 3]);
            ITEMS.with(|i| i.set(Some(items)));
            view()
                .child(text("before"))
                .child(each(
                    items,
                    |n| *n,
                    |item, index| {
                        MADE.with(|m| m.set(m.get() + 1));
                        text(move || format!("{}@{}", item.get(), index.get()))
                    },
                ))
                .child(text("after"))
        }
    }

    #[test]
    fn each_keeps_the_rows_that_stay_and_makes_only_new_ones() {
        let mut c = core();
        c.mount_root(&Root::new::<Rows>(|| RowsProps {}));
        let batch = c.commit().unwrap();
        // The rows are the root view's children: the host's.
        let list = root_host(&batch);
        assert_eq!(order(&c, list), ["before", "1@0", "2@1", "3@2", "after"]);
        let one = text_node(&batch, "1@0");
        let before = text_node(&batch, "before");
        let after = text_node(&batch, "after");
        let items = ITEMS.with(Cell::get).unwrap();
        {
            let _entered = c.components.runtime.enter();
            items.set(vec![3, 1, 4]);
        }
        let batch = c.commit().unwrap();
        assert_eq!(order(&c, list), ["before", "3@0", "1@1", "4@2", "after"]);
        assert_eq!(MADE.with(Cell::get), 4, "one new row");
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Create { id, .. } if *id == one)),
            "row 1 kept its node"
        );

        // A tail append must remain inside the region, ahead of the static
        // trailing sibling. Further moves and removals retain the old rows.
        for (items_now, expected) in [
            (
                vec![3, 1, 4, 5],
                vec!["before", "3@0", "1@1", "4@2", "5@3", "after"],
            ),
            (
                vec![4, 3, 5, 1],
                vec!["before", "4@0", "3@1", "5@2", "1@3", "after"],
            ),
            (vec![5, 1], vec!["before", "5@0", "1@1", "after"]),
        ] {
            {
                let _entered = c.components.runtime.enter();
                items.set(items_now);
            }
            let batch = c.commit().unwrap();
            assert_eq!(order(&c, list), expected);
            assert!(
                !batch.items.iter().any(|item| matches!(item, MountItem::Insert { child, .. } if *child == before || *child == after)),
                "static siblings stay mounted in place"
            );
            assert!(
                !batch
                    .items
                    .iter()
                    .any(|item| matches!(item,MountItem::Create {id,..} if *id==one)),
                "row 1 retains its original node through append and moves"
            );
        }
        assert_eq!(
            MADE.with(Cell::get),
            5,
            "only the appended row was constructed"
        );
    }

    thread_local! {
        static KEYED_PHASE: Cell<Option<Signal<u32>>> = const {Cell::new(None)};
    }

    #[component]
    fn DuplicateKeys() -> impl IntoElement {
        let phase = signal(0);
        KEYED_PHASE.with(|current| current.set(Some(phase)));
        view().child(dynamic(move || match phase.get() {
            0 => vec![
                text("first text").key("shared").into_element(),
                view()
                    .key("shared")
                    .child(text("first view"))
                    .into_element(),
                text("second text").key("shared").into_element(),
                text("plain first").into_element(),
                text("plain second").into_element(),
            ],
            1 => vec![
                view()
                    .key("shared")
                    .child(text("updated view"))
                    .into_element(),
                text("updated first").key("shared").into_element(),
                text("updated second").key("shared").into_element(),
                text("plain survivor").into_element(),
            ],
            _ => vec![
                text("last first").key("shared").into_element(),
                view().key("shared").child(text("last view")).into_element(),
                text("plain last").into_element(),
            ],
        }))
    }

    #[test]
    fn duplicate_keys_consume_the_first_unused_matching_kind_without_advancing_plain_siblings() {
        let mut c = core();
        c.mount_root(&Root::of::<DuplicateKeys>());
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        let first = text_node(&batch, "first text");
        let second = text_node(&batch, "second text");
        let original_view = native_parent(&c, text_node(&batch, "first view")).unwrap();
        let plain = text_node(&batch, "plain first");
        let phase = KEYED_PHASE.with(Cell::get).unwrap();
        {
            let _entered = c.components.runtime.enter();
            phase.set(1);
        }
        let batch = c.commit().unwrap();
        assert_eq!(text_node(&batch, "updated first"), first);
        assert_eq!(text_node(&batch, "updated second"), second);
        assert_eq!(
            native_parent(&c, text_node(&batch, "updated view")),
            Some(original_view)
        );
        assert_eq!(text_node(&batch, "plain survivor"), plain);
        let ids = |c: &Core<FakeEngine>| {
            c.nodes[c.key(host).unwrap() as usize]
                .children
                .iter()
                .map(|&key| c.nodes[key as usize].id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&c), vec![original_view, first, second, plain]);
        {
            let _entered = c.components.runtime.enter();
            phase.set(2);
        }
        let batch = c.commit().unwrap();
        assert_eq!(text_node(&batch, "last first"), first);
        assert_eq!(
            native_parent(&c, text_node(&batch, "last view")),
            Some(original_view)
        );
        assert_eq!(text_node(&batch, "plain last"), plain);
        assert_eq!(ids(&c), vec![first, original_view, plain]);
        assert!(
            c.key(second).is_err(),
            "the unused duplicate leaves the tree"
        );
    }

    /// A list whose rows are regions: row 2 shows nothing until `LATE`.
    #[derive(Default)]
    struct RegionRows;

    thread_local! {
        static REGION_ITEMS: Cell<Option<Signal<Vec<u32>>>> = const { Cell::new(None) };
        static LATE: Cell<Option<Signal<bool>>> = const { Cell::new(None) };
    }

    impl Component for RegionRows {
        type Props = RowsProps;
        type Event = NoEvent;

        fn view(_: RowsProps, _: Scope<NoEvent>) -> impl IntoElement {
            let items = signal(vec![1, 2]);
            let late = signal(false);
            REGION_ITEMS.with(|i| i.set(Some(items)));
            LATE.with(|l| l.set(Some(late)));
            view().child(each(
                items,
                |n| *n,
                move |item, index| {
                    dynamic(move || {
                        let n = item.get();
                        (n != 2 || late.get()).then(|| text(format!("{n}@{}", index.get())))
                    })
                },
            ))
        }
    }

    #[test]
    fn each_keeps_rows_whose_root_is_a_region() {
        let mut c = core();
        c.mount_root(&Root::new::<RegionRows>(|| RowsProps {}));
        let batch = c.commit().unwrap();
        let list = root_host(&batch);
        assert_eq!(order(&c, list), ["1@0"]);
        let items = REGION_ITEMS.with(Cell::get).unwrap();
        let late = LATE.with(Cell::get).unwrap();
        // Row 1 stays and its region runs again (its index moved); row 2
        // stays, still empty.
        {
            let _entered = c.components.runtime.enter();
            items.set(vec![3, 1, 2]);
        }
        c.commit();
        assert_eq!(order(&c, list), ["3@0", "1@1"]);
        // Row 2's region, kept empty, shows its row now.
        {
            let _entered = c.components.runtime.enter();
            late.set(true);
        }
        c.commit();
        assert_eq!(order(&c, list), ["3@0", "1@1", "2@2"]);
        // Rows kept as they are, a new one after them.
        {
            let _entered = c.components.runtime.enter();
            items.set(vec![3, 1, 2, 4]);
        }
        c.commit();
        assert_eq!(order(&c, list), ["3@0", "1@1", "2@2", "4@3"]);
    }

    /// Made with `#[component]`: reads the appearance and a timer.
    #[component]
    fn Clock(_props: (), cx: Scope<NoEvent>) -> impl IntoElement {
        let ticks = signal(0);
        set_timeout(std::time::Duration::ZERO, move || ticks.set(1));
        let _ = cx.insets();
        view().child(text(move || {
            format!(
                "{} {} {}",
                if dark() { "dark" } else { "light" },
                ticks.get(),
                tokens().number("radius").unwrap()
            )
        }))
    }

    #[test]
    fn a_function_component_reads_the_environment_and_its_timers_run() {
        let mut c = core();
        c.mount_root(&Root::new::<Clock>(|| ()));
        let batch = c.commit().unwrap();
        let shown = texts(&batch);
        assert!(shown[0].starts_with("light 0 "), "{shown:?}");
        c.set_environment(crate::ui::Environment {
            dark: true,
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert!(
            texts(&batch)[0].starts_with("dark 0 "),
            "{:?}",
            texts(&batch)
        );
    }

    thread_local! {
        static INTROS: Cell<u32> = const { Cell::new(0) };
    }

    #[derive(Clone, PartialEq, Props)]
    struct IntroProps {
        label: SharedString,
    }

    /// Counts its views: what a component does as it is made (an entrance)
    /// happens each time.
    #[component]
    fn Intro(props: IntroProps) -> impl IntoElement {
        INTROS.with(|n| n.set(n.get() + 1));
        text(props.label)
    }

    /// Shows an `Intro` for the tab chosen; a press switches tabs.
    #[component]
    fn Tabs() -> impl IntoElement {
        let first = signal(true);
        view()
            .on_press(move |_: &()| first.update(|f| *f = !*f))
            .child(dynamic(move || {
                intro().label(if first.get() { "one" } else { "two" })
            }))
    }

    #[test]
    fn a_component_a_region_makes_again_runs_again() {
        INTROS.with(|n| n.set(0));
        let mut c = core();
        c.mount_root(&Root::new::<Tabs>(|| ()));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["one"]);
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["two"]);
        assert_eq!(INTROS.with(Cell::get), 2);
    }

    /// Shows "late" 10 ms after it is made.
    #[component]
    fn Later() -> impl IntoElement {
        let shown = signal("soon");
        set_timeout(std::time::Duration::from_millis(10), move || {
            shown.set("late")
        });
        text(move || shown.get())
    }

    #[test]
    fn the_core_keeps_its_tasks_timers() {
        // No tokio runtime: the core fires its tasks' timers itself, and
        // tells the engine when to wake for the next.
        let mut c = core();
        c.mount_root(&Root::new::<Later>(|| ()));
        assert_eq!(texts(&c.commit().unwrap()), ["soon"]);
        c.run_component_tasks();
        let due = c.next_task_timer().expect("a timer waits");
        assert!(due > std::time::Instant::now());
        std::thread::sleep(due.saturating_duration_since(std::time::Instant::now()));
        c.run_component_tasks();
        assert_eq!(texts(&c.commit().unwrap()), ["late"]);
        assert_eq!(c.next_task_timer(), None);
    }

    /// A box bordered while a signal holds.
    #[component]
    fn Framed() -> impl IntoElement {
        let on = signal(false);
        view()
            .size_10()
            .on_press(move |_: &()| on.set(true))
            .style_when(on, |s| s.border_1().border_color(rgb(0xff0000)))
    }

    #[test]
    fn a_bound_style_layer_draws_its_border() {
        let mut c = core();
        c.mount_root(&Root::new::<Framed>(|| ()));
        let host = root_host(&c.commit().unwrap());
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let style = batch.items.iter().find_map(|i| match i {
            MountItem::ViewStyle { style, .. } if style.borders.widths.top > Points::ZERO => {
                Some(style.clone())
            }
            _ => None,
        });
        assert!(style.is_some(), "{:#?}", batch.items);
    }

    /// A track whose color moves between two theme colors natively.
    #[component]
    fn Track() -> impl IntoElement {
        let on = animated_value(0.0);
        let off_color = AdaptiveColor {
            light: rgb(0xeeeeee).into(),
            dark: rgb(0x222222).into(),
        };
        view().size_10().bind_background(&on.interpolate_colors(
            &[0.0, 1.0],
            &[off_color, AdaptiveColor::from(rgb(0x00ff00))],
        ))
    }

    #[test]
    fn interpolated_theme_colors_follow_the_appearance() {
        let colors = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Animation(
                    crate::animation::AnimationOp::CreateInterpolate { output, .. }
                    | crate::animation::AnimationOp::SetOutput { output, .. },
                ) => Some(output.clone()),
                _ => None,
            })
        };
        let mut c = core();
        c.mount_root(&Root::new::<Track>(|| ()));
        assert_eq!(
            colors(&c.commit().unwrap()),
            Some(crate::animation::Output::Colors(vec![
                0xeeeeeeff, 0x00ff00ff
            ]))
        );
        c.set_environment(crate::ui::Environment {
            dark: true,
            ..Default::default()
        });
        // The same node, the dark colors: no view is made again.
        let batch = c.commit().unwrap();
        assert_eq!(
            colors(&batch),
            Some(crate::animation::Output::Colors(vec![
                0x222222ff, 0x00ff00ff
            ]))
        );
        assert!(!batch.items.iter().any(|i| matches!(
            i,
            MountItem::Animation(crate::animation::AnimationOp::CreateInterpolate { .. })
        )));
    }

    /// Three tracks sharing their light colors: two theme colors with
    /// other dark ones, and a constant one.
    #[component]
    fn SharedLight() -> impl IntoElement {
        let on = animated_value(0.0);
        let green = AdaptiveColor::from(rgb(0x00ff00));
        let track = |dark| {
            let off = AdaptiveColor {
                light: rgb(0x000000).into(),
                dark,
            };
            view()
                .size_10()
                .bind_background(&on.interpolate_colors(&[0.0, 1.0], &[off, green]))
        };
        view()
            .child(track(rgb(0xffffff).into()))
            .child(track(rgb(0x808080).into()))
            .child(track(rgb(0x000000).into()))
    }

    #[test]
    fn color_interpolations_sharing_their_light_colors_are_apart() {
        let outputs = |batch: &MountBatch| {
            let mut outputs: Vec<_> = batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Animation(
                        crate::animation::AnimationOp::CreateInterpolate { output, .. }
                        | crate::animation::AnimationOp::SetOutput { output, .. },
                    ) => Some(output.clone()),
                    _ => None,
                })
                .collect();
            outputs.sort_by_key(|o| format!("{o:?}"));
            outputs
        };
        let colors = |off: u32| crate::animation::Output::Colors(vec![off, 0x00ff00ff]);
        let mut c = core();
        c.mount_root(&Root::new::<SharedLight>(|| ()));
        assert_eq!(outputs(&c.commit().unwrap()), vec![colors(0x000000ff); 3]);
        c.set_environment(crate::ui::Environment {
            dark: true,
            ..Default::default()
        });
        assert_eq!(
            outputs(&c.commit().unwrap()),
            [colors(0x808080ff), colors(0xffffffff)]
        );
    }

    /// A style bound to a signal.
    #[derive(Default)]
    struct Lamp;

    #[derive(Clone, PartialEq, Props)]
    struct LampProps {}

    impl Component for Lamp {
        type Props = LampProps;
        type Event = NoEvent;

        fn view(_: LampProps, _: Scope<NoEvent>) -> impl IntoElement {
            let on = signal(false);
            view()
                .on_press(move |_: &()| on.update(|v| *v = !*v))
                .w(px(10.0))
                .bg(move || {
                    if on.get() {
                        rgb(0xff0000)
                    } else {
                        rgb(0x0000ff)
                    }
                })
                .style_when(on, |s| s.opacity(0.5))
        }
    }

    #[test]
    fn bound_styles_change_alone() {
        let mut c = core();
        c.mount_root(&Root::new::<Lamp>(|| LampProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        let style = view_style_of(&batch, host).unwrap();
        assert_eq!(style.background_color, crate::style::Color(0x0000_ffff));
        assert_eq!(style.opacity, 1.0);
        c.component_event(host, EventKind::Press, &EventPayload::None);
        let batch = c.commit().unwrap();
        let style = view_style_of(&batch, host).unwrap();
        assert_eq!(style.background_color, crate::style::Color(0xff00_00ff));
        assert_eq!(style.opacity, 0.5);
        let _ = Rc::new(());
    }

    /// Its own rows in a list, from a signal: a press on a row removes it,
    /// one on "add" appends one. A row's text says when it is the last.
    #[derive(Default)]
    struct Mailbox;

    #[derive(Clone, PartialEq, Props)]
    struct MailboxProps {
        #[prop(default)]
        rows: crate::ui::Prop<u32>,
    }

    impl Component for Mailbox {
        type Props = MailboxProps;
        type Event = NoEvent;

        fn view(props: MailboxProps, _: Scope<NoEvent>) -> impl IntoElement {
            let rows = signal(
                (0..props.rows.get_untracked())
                    .map(|i| format!("mail {i}"))
                    .collect::<Vec<_>>(),
            );
            view()
                .flex_1()
                .child(view().h(px(20.0)).label("add").on_press(move |_: &()| {
                    rows.update(|r| {
                        let n = r.len();
                        r.push(format!("new {n}"));
                    });
                }))
                .child(
                    virtual_list(
                        move || rows.with(Vec::len),
                        move |at| {
                            view()
                                .h(px(40.0))
                                .on_press(move |_: &()| {
                                    rows.update(|r| {
                                        r.remove(at.index());
                                    });
                                })
                                // Indexing: a row's bindings never read
                                // past the rows.
                                .child(text(move || {
                                    let row = rows.with(|r| r[at.index()].clone());
                                    let last = if at.is_last() { " (last)" } else { "" };
                                    format!("{row}{last}")
                                }))
                        },
                    )
                    .estimated_item_size(px(40.0))
                    .keys(move || rows.get())
                    .flex_1(),
                )
        }
    }

    fn mailbox(rows: u32) -> (Core<FakeEngine>, MountBatch) {
        let mut c = core();
        c.mount_root(&Root::new::<Mailbox>(move || MailboxProps {
            rows: rows.into(),
        }));
        let batch = c.commit().unwrap();
        (c, batch)
    }

    fn pressable(batch: &MountBatch) -> Vec<NodeId> {
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .collect()
    }

    fn creates(batch: &MountBatch) -> usize {
        batch
            .items
            .iter()
            .filter(|i| matches!(i, MountItem::Create { .. }))
            .count()
    }

    #[test]
    fn a_views_list_splices_and_its_cells_keep_their_rows() {
        use rustc_hash::FxHashMap;

        // This fixture consumes native ancestry and text, including the
        // source Remove before the retirement ACK. Text updates to a parked
        // cell are not visible rows; ProjectRoot reattaches its actual owner.
        fn consume(
            batch: &MountBatch,
            parents: &mut FxHashMap<NodeId, NodeId>,
            values: &mut FxHashMap<NodeId, String>,
        ) {
            for item in &batch.items {
                match item {
                    MountItem::Insert { parent, child, .. } => {
                        parents.insert(*child, *parent);
                    }
                    MountItem::ProjectRoot { parent, id, .. } => {
                        parents.insert(*id, *parent);
                    }
                    MountItem::Remove { id } | MountItem::Delete { id } => {
                        parents.remove(id);
                    }
                    MountItem::RetireListCell { roots, .. } => {
                        for root in roots {
                            parents.remove(root);
                        }
                    }
                    // The native tree was detached before this confirmation.
                    MountItem::ListCellRetired { .. } => {}
                    MountItem::Text { id, text, .. } => {
                        values.insert(*id, text.text.clone());
                    }
                    _ => {}
                }
            }
        }
        fn attached(mut id: NodeId, parents: &FxHashMap<NodeId, NodeId>) -> bool {
            while id != ROOT_ID {
                let Some(&parent) = parents.get(&id) else {
                    return false;
                };
                id = parent;
            }
            true
        }
        fn visible(
            parents: &FxHashMap<NodeId, NodeId>,
            values: &FxHashMap<NodeId, String>,
        ) -> Vec<(NodeId, String)> {
            let mut shown: Vec<_> = values
                .iter()
                .filter(|(id, _)| attached(**id, parents))
                .map(|(&id, value)| (id, value.clone()))
                .collect();
            shown.sort_unstable();
            shown
        }

        let (mut c, batch) = mailbox(100);
        let (mut parents, mut values) = (FxHashMap::default(), FxHashMap::default());
        consume(&batch, &mut parents, &mut values);
        let shown = visible(&parents, &values);
        assert!(shown.iter().any(|(_, text)| text == "mail 0"), "{shown:?}");
        assert!(shown.len() < 100, "virtualized: {}", shown.len());
        let initial: Vec<_> = shown
            .iter()
            .map(|(text, value)| {
                let row = parents[text];
                let cell = parents[&row];
                (*text, value.clone(), row, cell)
            })
            .collect();
        // Pick the actual row by its text, rather than relying on the
        // traversal order in which native event masks were emitted.
        let &(old_text, _, row0, old_cell) = initial
            .iter()
            .find(|(_, text, _, _)| text == "mail 0")
            .unwrap();
        assert!(c.component_event(row0, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let request = batch
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::RetireListCell { id, request, roots }
                    if *id == old_cell && roots == &[old_cell] =>
                {
                    Some(*request)
                }
                _ => None,
            })
            .expect("the deleted source owner must await native retirement");
        assert!(batch.items.iter().any(|item| matches!(
            item, MountItem::Remove { id } if *id == old_cell
        )));
        assert!(!batch.items.iter().any(|item| matches!(
            item, MountItem::ProjectRoot { id, .. } if *id == old_cell
        )));
        assert!(!c.accepts_native_input(row0));
        consume(&batch, &mut parents, &mut values);
        assert!(!attached(old_text, &parents));
        let incoming = format!("mail {}", shown.len());
        let new_text = visible(&parents, &values)
            .into_iter()
            .find_map(|(id, text)| (text == incoming).then_some(id))
            .expect("the next source row is visible without waiting for the old owner ACK");
        let new_row = parents[&new_text];
        let new_cell = parents[&new_row];
        assert_ne!(new_cell, old_cell);
        let mut made: Vec<_> = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::Create { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        made.sort_unstable();
        let mut new_subtree = vec![new_cell, new_row, new_text];
        new_subtree.sort_unstable();
        // Exactly one incoming Cell/View/Text subtree overlaps the deleted
        // but not yet acknowledged owner; survivors are not reconstructed.
        assert_eq!(made, new_subtree, "{:?}", batch.items);
        for &(text, ref value, row, cell) in &initial {
            if cell == old_cell {
                continue;
            }
            assert_eq!(values[&text], *value);
            assert_eq!(parents[&text], row);
            assert_eq!(parents[&row], cell);
            assert!(attached(text, &parents));
            assert!(!batch.items.iter().any(|item| matches!(
                item, MountItem::Text { id, .. } if *id == text
            )));
        }
        assert_eq!(visible(&parents, &values).len(), shown.len());

        // Native has excluded the old source owner before acknowledging it.
        // Only now may the next splice reuse it, without any new native node.
        c.retire_list_cell(old_cell, request, true);
        let confirmed = c.commit().unwrap();
        assert!(confirmed.items.iter().any(|item| matches!(
            item, MountItem::ListCellRetired { roots } if roots == &[old_cell]
        )));
        consume(&confirmed, &mut parents, &mut values);
        let &(next_text, _, next_row, next_cell) = initial
            .iter()
            .find(|(_, text, _, _)| text == "mail 1")
            .unwrap();
        assert!(c.component_event(next_row, EventKind::Press, &EventPayload::None));
        let batch = commit_with_native_retirement(&mut c).unwrap();
        assert_eq!(creates(&batch), 0, "{:?}", batch.items);
        assert!(batch.items.iter().any(|item| matches!(
            item, MountItem::ProjectRoot { id, .. } if *id == old_cell
        )));
        consume(&batch, &mut parents, &mut values);
        assert!(!attached(next_text, &parents));
        assert_eq!(parents[&old_text], row0);
        assert_eq!(parents[&row0], old_cell);
        assert!(attached(old_text, &parents));
        assert_eq!(values[&old_text], format!("mail {}", shown.len() + 1));
        for &(text, ref value, row, cell) in &initial {
            if cell == old_cell || cell == next_cell {
                continue;
            }
            assert_eq!(values[&text], *value);
            assert_eq!(parents[&text], row);
            assert_eq!(parents[&row], cell);
            assert!(attached(text, &parents));
        }
        assert_eq!(values[&new_text], incoming);
        assert_eq!(parents[&new_text], new_row);
        assert_eq!(parents[&new_row], new_cell);
        assert!(attached(new_text, &parents));
        assert_eq!(visible(&parents, &values).len(), shown.len());
    }

    #[test]
    fn a_views_list_grows_in_place() {
        let (mut c, batch) = mailbox(3);
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["mail 0", "mail 1", "mail 2 (last)"]);
        let add = pressable(&batch)[0];
        assert!(c.component_event(add, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        // The old last row's text changes; a cell comes for the new one.
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["mail 2", "new 3 (last)"]);
    }

    #[test]
    fn a_views_list_cells_show_other_rows_through_their_bindings() {
        let (mut c, batch) = mailbox(1000);
        let list = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: crate::ViewKind::Scroll,
                } => Some(*id),
                _ => None,
            })
            .expect("a list");
        // The native retirement handshake overlaps two windows before a
        // detached cell can be reused. Consume both warmup windows first.
        for offset in [10_000.0, 15_000.0] {
            c.set_scroll_offset(list, point(px(0.0), px(offset)), u32::MAX);
            commit_with_native_retirement(&mut c).unwrap();
        }
        // Scrolling on: the cells are reused and their content stays; only
        // the texts change.
        c.set_scroll_offset(list, point(px(0.0), px(20_000.0)), u32::MAX);
        let batch = commit_with_native_retirement(&mut c).unwrap();
        assert_eq!(creates(&batch), 0, "{:?}", batch.items);
        let shown = texts(&batch);
        assert!(shown.contains(&"mail 500".to_owned()), "{shown:?}");
    }

    #[test]
    fn a_views_list_drops_the_rows_that_went_past_its_end() {
        let (mut c, batch) = mailbox(3);
        // The row of the last text.
        let text = text_node(&batch, "mail 2 (last)");
        let last = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Insert { parent, child, .. } if *child == text => Some(*parent),
                _ => None,
            })
            .expect("the last row");
        assert!(c.component_event(last, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["mail 1 (last)"]);
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Delete { .. })),
            "the gone row's nodes: {:?}",
            batch.items
        );
    }

    /// A list whose top padding is a signal; a press on it flips it.
    #[derive(Default)]
    struct Padded;

    #[derive(Clone, PartialEq, Props)]
    struct PaddedProps {}

    impl Component for Padded {
        type Props = PaddedProps;
        type Event = NoEvent;

        fn view(_: PaddedProps, _: Scope<NoEvent>) -> impl IntoElement {
            let padded = signal(false);
            view()
                .flex_1()
                .on_press(move |_: &()| padded.update(|p| *p = !*p))
                .child(
                    virtual_list(3, |at| text(format!("row {}", at.index())).h(px(40.0)))
                        .content_padding_top(move || if padded.get() { 10.0_f32 } else { 0.0 })
                        .flex_1(),
                )
        }
    }

    #[test]
    fn a_views_list_layout_is_a_binding() {
        let mut c = core();
        c.mount_root(&Root::new::<Padded>(|| PaddedProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        // The rows move down; nothing is made again.
        assert_eq!(creates(&batch), 0, "{:?}", batch.items);
        let moved: Vec<f32> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Frame { frame, .. } => Some(frame.origin.y.0),
                _ => None,
            })
            .collect();
        assert!(moved.contains(&10.0), "{:?}", batch.items);
    }

    thread_local! {
        /// How many times `Fresh` was made on this thread.
        static FRESH: Cell<u32> = const { Cell::new(0) };
    }

    /// Content with a state of its own: the how-manieth it was made.
    #[derive(Default)]
    struct Fresh;

    #[derive(Clone, PartialEq, Props)]
    struct FreshProps {}

    impl Component for Fresh {
        type Props = FreshProps;
        type Event = NoEvent;

        fn view(_: FreshProps, _: Scope<NoEvent>) -> impl IntoElement {
            let n = FRESH.with(|f| {
                f.set(f.get() + 1);
                f.get()
            });
            view().child(text(format!("fresh {n}")))
        }
    }

    /// Places its (lazy) children while open.
    #[derive(Default)]
    struct Pocket;

    #[derive(Clone, PartialEq, Props)]
    struct PocketProps {
        #[prop(default)]
        open: crate::ui::Prop<bool>,
        #[prop(lazy)]
        children: Children,
    }

    impl Component for Pocket {
        type Props = PocketProps;
        type Event = NoEvent;

        fn view(props: PocketProps, _: Scope<NoEvent>) -> impl IntoElement {
            let children = props.children;
            view().child(when(props.open, move || view().p_2().child(children)))
        }
    }

    /// Places its children.
    #[derive(Default)]
    struct Holder;

    #[derive(Clone, PartialEq, Props)]
    struct HolderProps {
        children: Children,
    }

    impl Component for Holder {
        type Props = HolderProps;
        type Event = NoEvent;

        fn view(props: HolderProps, _: Scope<NoEvent>) -> impl IntoElement {
            view().child(props.children)
        }
    }

    /// A label (a component whose root is a text).
    #[component]
    fn Label() -> impl IntoElement {
        text("label")
    }

    /// Shows a label (a component), a text and a holder of a text while
    /// open, as a holder's content; a press closes.
    #[component]
    fn Shutter() -> impl IntoElement {
        let open = signal(true);
        view().on_press(move || open.set(false)).child(
            Holder::element(HolderProps {
                children: Children::default(),
            })
            .child(when(open, || {
                vec![
                    label().into_element(),
                    text("plain").into_element(),
                    Holder::element(HolderProps {
                        children: Children::default(),
                    })
                    .child(text("inside"))
                    .into_element(),
                ]
            })),
        )
    }

    #[test]
    fn content_leaving_a_nested_component_is_only_deleted() {
        let mut c = core();
        c.mount_root(&Root::new::<Shutter>(|| ()));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        // Deleting a view detaches it natively: no `Remove` before.
        let count = |f: fn(&MountItem) -> bool| batch.items.iter().filter(|i| f(i)).count();
        let removes = count(|i| matches!(i, MountItem::Remove { .. }));
        let deletes = count(|i| matches!(i, MountItem::Delete { .. }));
        assert_eq!((removes, deletes), (0, 4), "{:?}", batch.items);
        let holder = c
            .components
            .instances
            .values()
            .find(|i| !i.js_children.is_empty());
        assert!(holder.is_none(), "no holder keeps what left it");
    }

    /// Passes its children on to a holder while shown; a press hides and
    /// shows the holder.
    #[derive(Default)]
    struct Forward;

    #[derive(Clone, PartialEq, Props)]
    struct ForwardProps {
        children: Children,
    }

    impl Component for Forward {
        type Props = ForwardProps;
        type Event = NoEvent;

        fn view(props: ForwardProps, _: Scope<NoEvent>) -> impl IntoElement {
            let shown = signal(true);
            let children = props.children;
            view()
                .on_press(move || shown.update(|s| *s = !*s))
                .child(when(shown, move || {
                    Holder::element(HolderProps {
                        children: Children::default(),
                    })
                    .child(text("first"))
                    .child(children)
                }))
        }
    }

    /// Gives a forward three texts, the middle one in a region; a press
    /// toggles it.
    #[derive(Default)]
    struct Relay;

    #[derive(Clone, PartialEq, Props)]
    struct RelayProps {}

    impl Component for Relay {
        type Props = RelayProps;
        type Event = NoEvent;

        fn view(_: RelayProps, _: Scope<NoEvent>) -> impl IntoElement {
            let middle = signal(false);
            view().on_press(move || middle.update(|m| *m = !*m)).child(
                Forward::element(ForwardProps {
                    children: Children::default(),
                })
                .child(text("a"))
                .child(when(middle, || text("b")))
                .child(text("c")),
            )
        }
    }

    /// The ids of the native children of `id`.
    fn native_children<M: TextEngine>(c: &Core<M>, id: NodeId) -> Vec<NodeId> {
        let key = c.key(id).expect("a node");
        c.nodes[key as usize]
            .children
            .iter()
            .map(|&k| c.nodes[k as usize].id)
            .collect()
    }

    #[test]
    fn children_passed_on_to_a_nested_component_are_placed_by_it() {
        let mut c = core();
        c.mount_root(&Root::new::<Relay>(|| RelayProps {}));
        let batch = c.commit().unwrap();
        let relay = root_host(&batch);
        let [first, a, cc] = ["first", "a", "c"].map(|t| text_node(&batch, t));
        let holder = native_parent(&c, a).expect("placed");
        assert_eq!(native_children(&c, holder), [first, a, cc]);
        let forward = native_parent(&c, holder).expect("in the forward");
        assert_eq!(native_parent(&c, forward), Some(relay));
        // Content joining the forward's children goes in its place there.
        assert!(c.component_event(relay, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let b = text_node(&batch, "b");
        assert_eq!(native_children(&c, holder), [first, a, b, cc]);
        // The holder goes: the children it was passed leave it, kept.
        assert!(c.component_event(forward, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        for id in [a, b, cc] {
            assert_eq!(native_parent(&c, id), None);
            assert!(
                batch
                    .items
                    .iter()
                    .any(|i| matches!(i, MountItem::Remove { id: r } if *r == id)),
                "{id} is removed: {:?}",
                batch.items
            );
            assert!(
                !batch
                    .items
                    .iter()
                    .any(|i| matches!(i, MountItem::Delete { id: d } if *d == id)),
                "{id} stays"
            );
        }
        // Shown again: a new holder places them.
        assert!(c.component_event(forward, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let holder = native_parent(&c, a).expect("placed again");
        let first = text_node(&batch, "first");
        assert_eq!(native_children(&c, holder), [first, a, b, cc]);
        // Leaving the content, a child leaves the holder.
        assert!(c.component_event(relay, EventKind::Press, &EventPayload::None));
        c.commit();
        assert_eq!(native_children(&c, holder), [first, a, cc]);
    }

    #[test]
    fn content_passed_on_two_deep_leaves_every_level() {
        let mut c = core();
        c.mount_root(&Root::new::<Relay>(|| RelayProps {}));
        let batch = c.commit().unwrap();
        let relay = root_host(&batch);
        assert!(c.component_event(relay, EventKind::Press, &EventPayload::None));
        let b = text_node(&c.commit().unwrap(), "b");
        let holding = |c: &Core<FakeEngine>| {
            c.components
                .instances
                .iter()
                .filter(|(_, i)| i.js_children.contains(&b))
                .count()
        };
        assert_eq!(holding(&c), 2, "the forward's and the holder's");
        assert!(c.component_event(relay, EventKind::Press, &EventPayload::None));
        c.commit().unwrap();
        assert!(c.key(b).is_err(), "released");
        assert_eq!(holding(&c), 0, "no component keeps it");
    }

    #[test]
    fn js_children_through_a_forward() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Forward>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Forward>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                Op::Create {
                    id: 6,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 2,
                    child: 6,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        let first = text_node(&batch, "first");
        let holder = native_parent(&c, 6).expect("placed");
        assert_eq!(native_children(&c, holder), [first, 6]);
        // Hide.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(native_parent(&c, 6), None, "{:?}", batch.items);
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Remove { id: 6 })),
            "{:?}",
            batch.items
        );
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Delete { id: 6 }))
        );
        // While hidden: JS adds 8, removes 6.
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 8,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 2,
                    child: 8,
                    before: None,
                },
                Op::Remove {
                    parent: 2,
                    child: 6,
                },
            ],
        );
        let batch = c.commit();
        assert_eq!(
            native_parent(&c, 8),
            None,
            "hidden: {:?}",
            batch.map(|b| b.items)
        );
        assert_eq!(native_parent(&c, 6), None);
        // Show.
        assert!(c.component_event(2, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let first = text_node(&batch, "first");
        let holder = native_parent(&c, 8).expect("placed again");
        assert_eq!(native_children(&c, holder), [first, 8], "{:?}", batch.items);
        // JS inserts 6 before 8, then moves 8 before 6.
        apply(
            &mut c,
            vec![Op::Insert {
                parent: 2,
                child: 6,
                before: Some(8),
            }],
        );
        c.commit();
        assert_eq!(native_children(&c, holder), [first, 6, 8]);
        apply(
            &mut c,
            vec![Op::Insert {
                parent: 2,
                child: 8,
                before: Some(6),
            }],
        );
        c.commit();
        assert_eq!(native_children(&c, holder), [first, 8, 6]);
        // The host goes; JS's children stay.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 2,
                },
                Op::Release { id: 2 },
            ],
        );
        let batch = c.commit().unwrap();
        for id in [6, 8] {
            assert!(c.key(id).is_ok());
            assert_eq!(native_parent(&c, id), None, "{id}: {:?}", batch.items);
            assert!(
                !batch
                    .items
                    .iter()
                    .any(|i| matches!(i, MountItem::Delete { id: d } if *d == id))
            );
        }
        assert!(c.components.instances.is_empty());
        // JS re-inserts 6 into root: fine.
        apply(
            &mut c,
            vec![Op::Insert {
                parent: ROOT_ID,
                child: 6,
                before: None,
            }],
        );
        c.commit();
        assert_eq!(native_parent(&c, 6), Some(ROOT_ID));
    }

    /// Shows whether it has children, and places them while shown; a press
    /// hides and shows them.
    #[derive(Default)]
    struct Shy;

    #[derive(Clone, PartialEq, Props)]
    struct ShyProps {
        children: crate::ui::Prop<Children>,
    }

    impl Component for Shy {
        type Props = ShyProps;
        type Event = NoEvent;

        fn view(props: ShyProps, _: Scope<NoEvent>) -> impl IntoElement {
            let shown = signal(true);
            let children = props.children;
            view()
                .on_press(move || shown.update(|s| *s = !*s))
                .child(text(move || format!("empty {}", children.get().is_empty())))
                .child(when(shown, move || view().child(children.get_untracked())))
        }
    }

    /// Passes its children on to a shy one.
    #[component]
    fn PassOn(props: HolderProps) -> impl IntoElement {
        view().child(
            Shy::element(ShyProps {
                children: Default::default(),
            })
            .child(props.children),
        )
    }

    /// Gives a pass-on one text while on; a press turns it off.
    #[component]
    fn Giver() -> impl IntoElement {
        let on = signal(true);
        view()
            .on_press(move || on.update(|o| *o = !*o))
            .child(pass_on().child(when(on, || text("given"))))
    }

    #[test]
    fn a_deep_component_knows_when_its_only_child_left() {
        let mut c = core();
        c.mount_root(&Root::new::<Giver>(|| ()));
        let batch = c.commit().unwrap();
        let giver = root_host(&batch);
        let shy = native_parent(&c, text_node(&batch, "empty false")).unwrap();
        assert!(c.component_event(giver, EventKind::Press, &EventPayload::None));
        assert!(texts(&c.commit().unwrap()).contains(&"empty true".to_owned()));
        // Hidden and shown again, it places nothing.
        for _ in 0..2 {
            assert!(c.component_event(shy, EventKind::Press, &EventPayload::None));
            let _ = c.commit();
        }
        let dead = c
            .components
            .instances
            .values()
            .flat_map(|i| &i.js_children)
            .filter(|&&id| c.key(id).is_err())
            .count();
        assert_eq!(dead, 0, "no released child");
    }

    thread_local! {
        static PLAQUE_TAPS: Cell<u32> = const { Cell::new(0) };
    }

    /// A counter as its view's root, dimmed, hearing its taps.
    #[derive(Default)]
    struct Plaque;

    #[derive(Clone, PartialEq, Props)]
    struct PlaqueProps {}

    impl Component for Plaque {
        type Props = PlaqueProps;
        type Event = NoEvent;

        fn view(_: PlaqueProps, _: Scope<NoEvent>) -> impl IntoElement {
            Counter::element(CounterProps {
                label: "Plaque".into(),
            })
            .opacity(0.5)
            .on_event(|e: &CounterEvent| {
                let CounterEvent::Tap(n) = e;
                PLAQUE_TAPS.with(|t| t.set(*n));
            })
        }
    }

    /// A plaque as its view's root: two components deep.
    #[derive(Default)]
    struct Shelf;

    #[derive(Clone, PartialEq, Props)]
    struct ShelfProps {}

    impl Component for Shelf {
        type Props = ShelfProps;
        type Event = NoEvent;

        fn view(_: ShelfProps, _: Scope<NoEvent>) -> impl IntoElement {
            Plaque::element(PlaqueProps {}).bg(rgb(0xff0000))
        }
    }

    #[test]
    fn a_component_rooted_in_another_shares_its_host() {
        let mut c = core();
        c.mount_root(&Root::new::<Counter>(|| CounterProps {
            label: "Plaque".into(),
        }));
        let alone = creates(&c.commit().unwrap());
        for deep in [false, true] {
            let mut c = core();
            if deep {
                c.mount_root(&Root::new::<Shelf>(|| ShelfProps {}));
            } else {
                c.mount_root(&Root::new::<Plaque>(|| PlaqueProps {}));
            }
            let batch = c.commit().unwrap();
            // The counter's view makes the host: no view of its own.
            assert_eq!(creates(&batch), alone, "{:?}", batch.items);
            let host = root_host(&batch);
            let style = view_style_of(&batch, host).expect("styled");
            assert_eq!(style.opacity, 0.5, "the styles the view gives it");
            if deep {
                assert_ne!(style.background_color, crate::Color::TRANSPARENT);
            }
            assert_eq!(texts(&batch), ["Plaque 0", "static"]);
            let text = text_node(&batch, "Plaque 0");
            assert_eq!(native_parent(&c, text), Some(host));
            // Its listener runs on the host, its events reach the view.
            assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
            let batch = c.commit().unwrap();
            assert_eq!(texts(&batch), ["Plaque 1"]);
            assert_eq!(PLAQUE_TAPS.with(Cell::get), 1);
            PLAQUE_TAPS.with(|t| t.set(0));
            assert!(
                batch.items.iter().all(|i| match i {
                    MountItem::Insert { parent, child, .. } =>
                        c.key(*parent).is_ok() && c.key(*child).is_ok(),
                    _ => true,
                }),
                "only nodes' own ids"
            );
        }
    }

    /// A press target with no look: presses, its selection for screen
    /// readers, and the app's styles.
    #[derive(Default)]
    struct Key;

    #[derive(Clone, PartialEq, Props)]
    struct KeyProps {
        #[prop(default)]
        selected: crate::ui::Prop<bool>,
    }

    impl Component for Key {
        type Props = KeyProps;
        type Event = NoEvent;

        fn view(props: KeyProps, _: Scope<NoEvent>) -> impl IntoElement {
            let selected = props.selected;
            view()
                .size_10()
                .accessibility_state(move || crate::AccessibilityState {
                    selected: selected.get(),
                    ..crate::AccessibilityState::default()
                })
                .on_press(|| {})
        }
    }

    /// Two keys in a row, styled per state as an app styles a `Button`.
    #[derive(Default)]
    struct Keys;

    #[derive(Clone, PartialEq, Props)]
    struct KeysProps {}

    impl Component for Keys {
        type Props = KeysProps;
        type Event = NoEvent;

        fn view(_: KeysProps, _: Scope<NoEvent>) -> impl IntoElement {
            let key = |selected: bool| {
                Key::element(KeyProps {
                    selected: selected.into(),
                })
                .bg(rgb(0x0000ff))
                .selected(|s| s.bg(rgb(0x00ff00)))
                .hover(|s| s.opacity(0.5))
                .active(|s| s.bg(rgb(0xff0000)))
            };
            view().flex_row().child(key(false)).child(key(true))
        }
    }

    #[test]
    fn a_nested_components_state_styles_follow_its_roots_states() {
        use crate::tailwind::state::{HOVERED, PRESSED};
        let mut c = core();
        c.mount_root(&Root::new::<Keys>(|| KeysProps {}));
        let batch = c.commit().unwrap();
        // The keys' roots report presses and hovers to the core.
        let tracked = |id: NodeId| {
            batch.items.iter().any(|i| {
                matches!(i, MountItem::TrackStates { id: v, states }
                    if *v == id && states & (PRESSED | HOVERED) == PRESSED | HOVERED)
            })
        };
        let roots: Vec<NodeId> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::TrackStates { id, .. } if tracked(*id) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(roots.len(), 2, "{:?}", batch.items);
        let is_selected = |id: NodeId| {
            batch.items.iter().any(|i| {
                matches!(i, MountItem::ViewProps { id: v, props }
                    if *v == id && props.accessibility.state.selected)
            })
        };
        let (selected, plain) = match is_selected(roots[0]) {
            true => (roots[0], roots[1]),
            false => (roots[1], roots[0]),
        };
        let background =
            |batch: &MountBatch, id| view_style_of(batch, id).map(|s| s.background_color);
        assert_eq!(background(&batch, plain), Some(crate::Color(0x0000ffff)));
        assert_eq!(
            background(&batch, selected),
            Some(crate::Color(0x00ff00ff)),
            "selected:"
        );
        c.set_states(plain, PRESSED | HOVERED);
        let batch = c.commit().unwrap();
        let style = view_style_of(&batch, plain).expect("restyled");
        assert_eq!(style.background_color, crate::Color(0xff0000ff), "active:");
        assert_eq!(style.opacity, 0.5, "hover:");
        c.set_states(plain, 0);
        let batch = c.commit().unwrap();
        assert_eq!(background(&batch, plain), Some(crate::Color(0x0000ffff)));
    }

    /// A page whose header's colors are typed styles, theme colors among
    /// them.
    #[derive(Default)]
    struct Page;

    #[derive(Clone, PartialEq, Props)]
    struct PageProps {}

    impl Component for Page {
        type Props = PageProps;
        type Event = NoEvent;

        // The core's own stack and screen: `nsh_base`'s wrap them.
        #[allow(deprecated)]
        fn view(_: PageProps, _: Scope<NoEvent>) -> impl IntoElement {
            stack().flex_1().child(
                screen()
                    .title("Page")
                    .header_style_with(|s| {
                        s.bg(AdaptiveColor::rgb(0xffffff, 0x000000))
                            .text_color(rgb(0x00ff00))
                            .tint_color(rgb(0x0000ff))
                    })
                    .child(view().flex_1()),
            )
        }
    }

    #[test]
    fn typed_header_styles_reach_the_screens_config() {
        let mut c = core();
        c.mount_root(&Root::new::<Page>(|| PageProps {}));
        let config = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ScreenConfig { config, .. } => Some((**config).clone()),
                _ => None,
            })
        };
        let first = config(&c.commit().unwrap()).expect("a screen");
        assert_eq!(first.background_color, Some(crate::Color(0xffffffff)));
        assert_eq!(first.title_color, Some(crate::Color(0x00ff00ff)));
        assert_eq!(first.tint_color, Some(crate::Color(0x0000ffff)));
        // Dark appearance: the theme color switches natively.
        c.set_class_environment(crate::tailwind::ClassEnvironment {
            dark: true,
            ..Default::default()
        });
        let dark = config(&c.commit().unwrap()).expect("restyled");
        assert_eq!(dark.background_color, Some(crate::Color(0x000000ff)));
    }

    /// A screen whose trailing header button is UIKit's own.
    #[derive(Default)]
    struct SystemItemPage;

    #[derive(Clone, PartialEq, Props)]
    struct SystemItemPageProps {}

    impl Component for SystemItemPage {
        type Props = SystemItemPageProps;
        type Event = NoEvent;

        // The core's own stack and screen: `nsh_base`'s wrap them.
        #[allow(deprecated)]
        fn view(_: SystemItemPageProps, _: Scope<NoEvent>) -> impl IntoElement {
            stack().flex_1().child(
                screen()
                    .header_right_system_item(crate::HeaderSystemItem::Add)
                    .header_right(view().on_press(|_: &()| {}))
                    .child(view().flex_1()),
            )
        }
    }

    /// The platform draws the trailing header button itself, by the name the
    /// screen passes (`add` here); the `headerRight` view stays the press
    /// target either way.
    #[test]
    fn a_system_header_button_reaches_the_screens_config() {
        let mut c = core();
        c.mount_root(&Root::new::<SystemItemPage>(|| SystemItemPageProps {}));
        let config = c
            .commit()
            .unwrap()
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ScreenConfig { config, .. } => Some((**config).clone()),
                _ => None,
            })
            .expect("a screen");
        assert_eq!(config.right_system_item, Some(crate::HeaderSystemItem::Add));
        assert!(config.right.is_some(), "the trailing slot is set");
    }

    /// Without the prop the header is built as before: no system button, so
    /// the platform wraps the app's `headerRight` view instead.
    #[test]
    fn a_screen_without_the_prop_has_no_system_header_button() {
        let mut c = core();
        c.mount_root(&Root::new::<Page>(|| PageProps {}));
        let config = c
            .commit()
            .unwrap()
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ScreenConfig { config, .. } => Some((**config).clone()),
                _ => None,
            })
            .expect("a screen");
        assert_eq!(config.right_system_item, None);
    }

    /// A Rust component that renders a native component.
    #[derive(Default)]
    struct NativeHost;

    #[derive(Clone, PartialEq, Props)]
    struct NativeHostProps {}

    impl Component for NativeHost {
        type Props = NativeHostProps;
        type Event = NoEvent;

        fn view(_: NativeHostProps, _: Scope<NoEvent>) -> impl IntoElement {
            crate::ui::native("test.native")
                .prop("items", serde_json::json!([1]))
                .flex_1()
        }
    }

    /// The platform is told which component a Rust `native()` element holds,
    /// and gets its props.
    #[test]
    fn a_native_component_from_rust_is_named() {
        let mut c = core();
        c.mount_root(&Root::new::<NativeHost>(|| NativeHostProps {}));
        let batch = c.commit().unwrap();
        let named = batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Component { name, .. } if &**name == "test.native"));
        assert!(
            named,
            "the platform is told which component to make: {:#?}",
            batch.items
        );
        let props = batch.items.iter().any(|i| {
            matches!(i, MountItem::ComponentProps { props, .. }
            if props.iter().any(|(k, _)| &**k == "items"))
        });
        assert!(props, "its props reach it");
    }

    /// A holder of its children as its view's root.
    #[derive(Default)]
    struct Tray;

    #[derive(Clone, PartialEq, Props)]
    struct TrayProps {
        children: Children,
    }

    impl Component for Tray {
        type Props = TrayProps;
        type Event = NoEvent;

        fn view(props: TrayProps, _: Scope<NoEvent>) -> impl IntoElement {
            Holder::element(HolderProps {
                children: Children::default(),
            })
            .opacity(0.5)
            .child(props.children)
        }
    }

    #[test]
    fn a_js_host_of_a_rooted_component_takes_the_apps_styles_events_and_children() {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Tray>();
        registry.register::<Plaque>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Plaque>().into()),
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Class("opacity-25".into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        // The app's class goes after what the view gives the counter.
        assert_eq!(view_style_of(&batch, 2).map(|s| s.opacity), Some(0.25));
        // JS stops listening to presses: the counter's view still does.
        apply(
            &mut c,
            vec![
                Op::Listen {
                    id: 2,
                    event: EventKind::Press,
                    enabled: true,
                },
                Op::Listen {
                    id: 2,
                    event: EventKind::Press,
                    enabled: false,
                },
            ],
        );
        c.commit();
        let key = c.key(2).unwrap();
        assert!(c.nodes[key as usize].events.contains(EventKind::Press));
        // The app's classes change: the node follows.
        c.apply(Op::SetProp {
            id: 2,
            prop: Prop::Class("opacity-75".into()),
        })
        .unwrap();
        let batch = c.commit().unwrap();
        assert_eq!(view_style_of(&batch, 2).map(|s| s.opacity), Some(0.75));
        // A tray: JS's children go into the host itself.
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 4,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 4,
                    prop: Prop::Component(std::any::type_name::<Tray>().into()),
                },
                Op::Insert {
                    parent: ROOT_ID,
                    child: 4,
                    before: None,
                },
                Op::Create {
                    id: 6,
                    tag: Tag::View,
                },
                Op::Insert {
                    parent: 4,
                    child: 6,
                    before: None,
                },
            ],
        );
        let batch = c.commit().unwrap();
        assert_eq!(native_parent(&c, 6), Some(4));
        assert_eq!(creates(&batch), 2, "{:?}", batch.items);
        // Released: its nodes go, JS's child stays.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 4,
                },
                Op::Release { id: 4 },
                Op::Release { id: 2 },
            ],
        );
        let batch = c.commit().unwrap();
        assert!(c.key(6).is_ok());
        assert_eq!(native_parent(&c, 6), None);
        assert!(c.components.instances.is_empty());
        let deleted: Vec<NodeId> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Delete { id } => Some(*id),
                _ => None,
            })
            .collect();
        assert!(deleted.contains(&2) && deleted.contains(&4), "{deleted:?}");
        assert_eq!(c.nodes.len(), 2, "the root and JS's child are left");
    }

    /// Places its corner slot as it is after a title, or padded when
    /// `framed`.
    #[derive(Default)]
    struct Corner;

    #[derive(Clone, PartialEq, Props)]
    struct CornerProps {
        #[prop(default)]
        framed: bool,
        corner: crate::ui::Prop<Option<Slot>>,
    }

    impl Component for Corner {
        type Props = CornerProps;
        type Event = NoEvent;

        fn view(props: CornerProps, _: Scope<NoEvent>) -> impl IntoElement {
            let framed = props.framed;
            view().child(text("title")).child(
                props
                    .corner
                    .place(move |c| if framed { c.p_2() } else { c }),
            )
        }
    }

    /// Fills corners: with a counter, with what a press switches (a
    /// text, a view of a text), with a text shown while on, and framed.
    #[derive(Default)]
    struct Corners;

    #[derive(Clone, PartialEq, Props)]
    struct CornersProps {}

    impl Component for Corners {
        type Props = CornersProps;
        type Event = NoEvent;

        fn view(_: CornersProps, _: Scope<NoEvent>) -> impl IntoElement {
            let n = signal(0);
            view()
                .on_press(move || n.update(|n| *n += 1))
                .child(Corner::element(CornerProps::default()).fill(
                    "corner",
                    Counter::element(CounterProps {
                        label: "Aside".into(),
                    }),
                ))
                .child(dynamic(move || {
                    // A corner each run, filled anew.
                    let fill = if n.get() % 2 == 0 {
                        text("even").into_element()
                    } else {
                        view().child(text("odd")).into_element()
                    };
                    Corner::element(CornerProps::default()).fill("corner", fill)
                }))
                .child(Corner::element(CornerProps::default()).fill(
                    "corner",
                    dynamic(move || (n.get() == 1).then(|| text("one"))),
                ))
                .child(
                    Corner::element(CornerProps {
                        framed: true,
                        ..Default::default()
                    })
                    .fill("corner", text("framed")),
                )
        }
    }

    #[test]
    fn a_slot_a_view_fills_is_placed_as_it_is() {
        let mut c = core();
        c.mount_root(&Root::new::<Corners>(|| CornersProps {}));
        let batch = c.commit().unwrap();
        let root = root_host(&batch);
        let corners = native_children(&c, root);
        assert_eq!(corners.len(), 4);
        // The third corner's fill shows nothing: its title alone.
        assert_eq!(native_children(&c, corners[2]).len(), 1);
        // The counter's host is the corner's child: no holder.
        let counted = native_parent(&c, text_node(&batch, "Aside 0")).expect("placed");
        assert_eq!(native_parent(&c, counted), Some(corners[0]));
        assert_eq!(native_children(&c, corners[0]).len(), 2);
        assert_eq!(
            native_parent(&c, text_node(&batch, "even")),
            Some(corners[1])
        );
        // Styled: in a node of the corner's own.
        let framed = native_parent(&c, text_node(&batch, "framed")).expect("placed");
        assert_ne!(framed, corners[3]);
        assert_eq!(native_parent(&c, framed), Some(corners[3]));
        // Its listener and events are its own.
        assert!(c.component_event(counted, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["Aside 1"]);
        // Filled anew: the new element takes the old one's place.
        assert!(c.component_event(root, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let odd = native_parent(&c, text_node(&batch, "odd")).expect("placed");
        let corners = native_children(&c, root);
        assert_eq!(native_parent(&c, odd), Some(corners[1]));
        assert_eq!(native_children(&c, corners[1]).len(), 2);
        // A fill that shows something now: placed in its corner.
        let one = text_node(&batch, "one");
        assert_eq!(native_parent(&c, one), Some(corners[2]));
        // And gone again (released with no holder to leave); even again.
        assert!(c.component_event(root, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert!(c.key(one).is_err(), "released");
        assert!(
            !batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Remove { .. })),
            "{:?}",
            batch.items
        );
        let corners = native_children(&c, root);
        assert_eq!(native_children(&c, corners[2]).len(), 1, "the title alone");
        let even = text_node(&batch, "even");
        assert_eq!(native_parent(&c, even), Some(corners[1]));
        assert_eq!(native_children(&c, corners[1]).len(), 2);
    }

    #[derive(Clone, PartialEq, Props)]
    struct MidProps {
        corner: crate::ui::Prop<Option<Slot>>,
    }

    /// Passes its corner slot on to a corner's.
    #[component]
    fn Mid(props: MidProps) -> impl IntoElement {
        view().child(
            Corner::element(CornerProps::default()).fill("corner", props.corner.place(|c| c)),
        )
    }

    /// Fills a mid's corner with a text, and another's with what a press
    /// switches (a text, nothing, a view of a text).
    #[component]
    fn Top() -> impl IntoElement {
        let n = signal(0);
        view()
            .on_press(move || n.update(|n| *n += 1))
            .child(mid().corner(text("deep")))
            .child(mid().corner(dynamic(move || match n.get() % 3 {
                0 => Some(text("switched").into_element()),
                1 => None,
                _ => Some(view().child(text("boxed")).into_element()),
            })))
    }

    #[test]
    fn a_filled_slot_passed_on_to_another_slot_is_placed_there() {
        let mut c = core();
        c.mount_root(&Root::new::<Top>(|| ()));
        let batch = c.commit().unwrap();
        let top = root_host(&batch);
        // Each mid's view is its corner.
        let mids = native_children(&c, top);
        let [first, second] = [0, 1].map(|i| native_children(&c, mids[i])[0]);
        let deep = text_node(&batch, "deep");
        assert_eq!(native_parent(&c, deep), Some(first), "{:?}", batch.items);
        let switched = text_node(&batch, "switched");
        assert_eq!(native_parent(&c, switched), Some(second));
        // Gone, then a view of a text: the deeper corner follows.
        assert!(c.component_event(top, EventKind::Press, &EventPayload::None));
        c.commit().unwrap();
        assert_eq!(native_children(&c, second).len(), 1, "the title alone");
        assert!(c.component_event(top, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let boxed = native_parent(&c, text_node(&batch, "boxed")).expect("placed");
        assert_eq!(native_parent(&c, boxed), Some(second), "{:?}", batch.items);
    }

    /// A corner as its view's root, its fill switched by a press on it
    /// (a text, a view of a text).
    #[component]
    fn RootedCorner() -> impl IntoElement {
        let on = signal(true);
        let flip = move || on.update(|o| *o = !*o);
        Corner::element(CornerProps::default()).fill(
            "corner",
            dynamic(move || {
                if on.get() {
                    text("x").on_press(flip).into_element()
                } else {
                    view().on_press(flip).child(text("y")).into_element()
                }
            }),
        )
    }

    #[test]
    fn a_component_rooted_in_another_fills_its_slot() {
        let mut c = core();
        c.mount_root(&Root::new::<RootedCorner>(|| ()));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert_eq!(native_parent(&c, text_node(&batch, "x")), Some(host));
        assert_eq!(native_children(&c, host).len(), 2);
        for round in 0..4 {
            let fill = native_children(&c, host)[1];
            assert!(c.component_event(fill, EventKind::Press, &EventPayload::None));
            let batch = c.commit().unwrap();
            assert_eq!(
                native_children(&c, host).len(),
                2,
                "{round}: {:?}",
                batch.items
            );
        }
    }

    /// Rows of a list, each with a filled corner, a holder of a text and a
    /// plaque.
    #[component]
    fn FilledRows() -> impl IntoElement {
        view().flex_1().child(
            virtual_list(200, move |at| {
                view()
                    .h(px(40.0))
                    .child(
                        Corner::element(CornerProps::default())
                            .fill("corner", text(move || format!("r{}", at.index()))),
                    )
                    .child(
                        Holder::element(HolderProps {
                            children: Children::default(),
                        })
                        .child(text(move || format!("h{}", at.index()))),
                    )
                    .child(Plaque::element(PlaqueProps {}))
            })
            .estimated_item_size(px(40.0))
            .flex_1(),
        )
    }

    #[test]
    fn list_rows_with_filled_slots_follow_their_rows() {
        let mut c = core();
        c.mount_root(&Root::new::<FilledRows>(|| ()));
        let batch = commit_with_native_retirement(&mut c).unwrap();
        let list = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: ViewKind::Scroll,
                } => Some(*id),
                _ => None,
            })
            .expect("a list");
        let mut shown: std::collections::HashMap<String, NodeId> = Default::default();
        let record = |b: &MountBatch, shown: &mut std::collections::HashMap<String, NodeId>| {
            for i in &b.items {
                if let MountItem::Text { id, text, .. } = i {
                    shown.retain(|_, v| v != id);
                    shown.insert(text.text.clone(), *id);
                }
            }
        };
        record(&batch, &mut shown);
        // Keep the original nodes as identity markers too: recycling updates
        // their labels, while the filled corner and holder stay in one row.
        let original_pairs: Vec<_> = shown
            .iter()
            .filter_map(|(text, &id)| {
                let index = text.strip_prefix('r')?;
                Some((id, *shown.get(&format!("h{index}"))?))
            })
            .collect();
        assert_eq!(original_pairs.len(), 25);
        // With a 480pt viewport and 40pt rows, each middle window has
        // 37 rows including overscan. A 900pt forward step overlaps 14 or
        // 15 of them; wrapping from 6300pt to 200pt overlaps none. Native
        // still owns the previous window while the next one is built, so
        // the first pass grows through 47, 60 and 67 row owners. Each row here
        // has 15 nodes and five component instances, besides the three
        // outer nodes and one outer instance.
        let windows = [
            ((10, 46), (708, 236)),
            ((33, 69), (903, 301)),
            ((55, 91), (903, 301)),
            ((78, 114), (903, 301)),
            ((100, 136), (903, 301)),
            ((123, 159), (903, 301)),
            ((145, 181), (903, 301)),
            ((0, 29), (1008, 336)),
            ((15, 51), (1008, 336)),
            ((38, 74), (1008, 336)),
            ((60, 96), (1008, 336)),
            ((83, 119), (1008, 336)),
        ];
        // The last-to-first step also joins two disjoint middle windows:
        // 83..119 to 10..46 needs 74 owners. Once that transition has been
        // consumed, both complete passes must reuse exactly that pool.
        for round in 0..3 {
            for (at, &((first, last), size)) in windows.iter().enumerate() {
                let step = at as u32 + 1;
                let y = (step as f32 * 900.0) % 7000.0;
                c.set_scroll_offset(list, point(px(0.0), px(y)), u32::MAX);
                for _ in 0..3 {
                    if let Some(b) = commit_with_native_retirement(&mut c) {
                        record(&b, &mut shown);
                    }
                }
                assert_eq!(
                    bound_items(&c, list),
                    (first..=last).collect::<Vec<_>>(),
                    "{round}:{step}: complete window"
                );
                let expected_size = if round == 0 { size } else { (1113, 371) };
                assert_eq!(
                    (c.nodes.len(), c.components.instances.len()),
                    expected_size,
                    "{round}:{step}: native overlap working set"
                );
                for index in first..=last {
                    for prefix in ['r', 'h'] {
                        let expected = format!("{prefix}{index}");
                        if shown.contains_key(&expected) {
                            continue;
                        }
                        let state = c.nodes[c.key(list).unwrap() as usize]
                            .list
                            .as_ref()
                            .unwrap();
                        let slot = state
                            .slots
                            .iter()
                            .find(|slot| slot.index == Some(index))
                            .unwrap();
                        let mut pending = vec![slot.cell];
                        let mut texts = Vec::new();
                        while let Some(key) = pending.pop() {
                            let node = &c.nodes[key as usize];
                            if !node.text.is_empty() {
                                texts.push((node.id, node.text.clone(), node.frame));
                            }
                            pending.extend_from_slice(&node.children);
                        }
                        panic!(
                            "{round}:{step}: missing {expected}; slot index/rendered/requested={:?}, cell={} frame={:?}; live cell text={texts:?}; tracked text={shown:?}",
                            (slot.index, slot.rendered, slot.requested),
                            c.nodes[slot.cell as usize].id,
                            c.nodes[slot.cell as usize].frame,
                        );
                    }
                }
                // Every r<i> shown is in the corner of the row showing h<i>.
                for (t, &id) in &shown {
                    let Some(n) = t.strip_prefix('r') else {
                        continue;
                    };
                    if c.key(id).is_err() {
                        continue;
                    }
                    let Some(corner) = native_parent(&c, id) else {
                        continue;
                    };
                    let row = native_parent(&c, corner).expect("a corner in a row");
                    if let Some(&h) = shown.get(&format!("h{n}"))
                        && c.key(h).is_ok()
                    {
                        let holder = native_parent(&c, h).unwrap();
                        assert_eq!(
                            native_parent(&c, holder),
                            Some(row),
                            "{round}:{step}: {t} and h{n}"
                        );
                    }
                }
                for &(r, h) in &original_pairs {
                    let corner = native_parent(&c, r).expect("the original filled text");
                    let holder = native_parent(&c, h).expect("the original held text");
                    let row = native_parent(&c, corner).expect("the original corner's row");
                    assert_eq!(
                        native_parent(&c, holder),
                        Some(row),
                        "{round}:{step}: original slot nodes {r}/{h} stay in one row"
                    );
                }
            }
        }
    }

    /// A text as its root.
    #[derive(Default)]
    struct Lit;

    #[derive(Clone, PartialEq, Props)]
    struct LitProps {}

    impl Component for Lit {
        type Props = LitProps;
        type Event = NoEvent;

        fn view(_: LitProps, _: Scope<NoEvent>) -> impl IntoElement {
            text("lit").p_1()
        }
    }

    /// Gives a lit text an animated opacity, an inline style and insets a
    /// press changes; and a plaque (rooted in a counter) an inline style.
    #[derive(Default)]
    struct Lighting;

    #[derive(Clone, PartialEq, Props)]
    struct LightingProps {}

    impl Component for Lighting {
        type Props = LightingProps;
        type Event = NoEvent;

        fn view(_: LightingProps, _: Scope<NoEvent>) -> impl IntoElement {
            let v = animated_value(0.5);
            let wide = signal(false);
            let red = crate::ui::Style::default().with(
                crate::StyleKey::BackgroundColor,
                crate::PatchValue::Str("#ff0000".into()),
            );
            view()
                .on_press(move || wide.update(|w| *w = !*w))
                .child(
                    Lit::element(LitProps {})
                        .bind_opacity(&v)
                        .inline_style(red.clone())
                        .inset_padding(move || {
                            EdgeInsets::all(px(if wide.get() { 8.0 } else { 4.0 }))
                        }),
                )
                .child(Plaque::element(PlaqueProps {}).inline_style(red))
        }
    }

    #[test]
    fn what_a_view_gives_a_component_element_goes_on_its_root() {
        let mut c = core();
        c.mount_root(&Root::new::<Lighting>(|| LightingProps {}));
        let batch = c.commit().unwrap();
        let root = root_host(&batch);
        let lit = text_node(&batch, "lit");
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::AnimationBindings { id, .. } if *id == lit)),
            "the opacity is bound on the text: {:?}",
            batch.items
        );
        let red = crate::Color::rgba(0xff, 0, 0, 0xff);
        assert_eq!(
            view_style_of(&batch, lit).map(|s| s.background_color),
            Some(red)
        );
        let insets = |c: &Core<FakeEngine>, id| {
            let key = c.key(id).unwrap();
            c.nodes[key as usize]
                .insets
                .as_deref()
                .copied()
                .unwrap_or_default()[0]
        };
        assert_eq!(insets(&c, lit), EdgeInsets::all(px(4.0)));
        // On a rooted component's host too, over the counter's own style.
        let plaque = native_children(&c, root)[1];
        assert_eq!(
            view_style_of(&batch, plaque).map(|s| s.background_color),
            Some(red)
        );
        // A bound inset follows.
        assert!(c.component_event(root, EventKind::Press, &EventPayload::None));
        c.commit();
        assert_eq!(insets(&c, lit), EdgeInsets::all(px(8.0)));
    }

    /// A count its API reads.
    #[derive(Default)]
    struct Dial;

    #[derive(Clone, Copy)]
    struct DialApi {
        at: crate::ui::Signal<i32>,
    }

    #[crate::ui::methods]
    impl DialApi {
        /// Where it is.
        pub(crate) fn at(&self) -> i32 {
            self.at.get_untracked()
        }
    }

    impl Component for Dial {
        type Props = ();
        type Event = NoEvent;
        const METHODS: crate::ui::Methods = crate::ui::Methods::of::<DialApi>();

        fn view(_: (), cx: Scope<NoEvent>) -> impl IntoElement {
            let at = signal(7);
            cx.methods(DialApi { at });
            text(move || format!("at {}", at.get()))
        }
    }

    thread_local! {
        static DIAL: Cell<Option<crate::ui::ComponentRef<Dial>>> = const { Cell::new(None) };
    }

    #[derive(Clone, PartialEq, Props)]
    struct DialPanelProps {
        rooted: bool,
    }

    /// A dial with a ref, as its view's root or inside a view.
    #[component]
    fn DialPanel(props: DialPanelProps) -> impl IntoElement {
        let handle = component_ref::<Dial>();
        DIAL.with(|d| d.set(Some(handle)));
        let el = Dial::element(()).component_ref(&handle);
        if props.rooted {
            el.into_element()
        } else {
            view().child(el).into_element()
        }
    }

    #[test]
    fn the_api_of_a_component_rooted_in_another_is_its_refs() {
        for rooted in [false, true] {
            let mut c = core();
            c.mount_root(&Root::new::<DialPanel>(move || DialPanelProps { rooted }));
            let _ = c.commit().unwrap();
            let dial = DIAL.with(Cell::get).unwrap();
            let _entered = c.components.runtime.enter();
            let at = dial.api::<DialApi>().map(|api| api.at());
            assert_eq!(at, Some(7), "rooted: {rooted}");
        }
    }

    /// A view passing content to nested components: a pocket's lazy
    /// children and a region in a holder's; a press opens and closes.
    #[derive(Default)]
    struct Wardrobe;

    #[derive(Clone, PartialEq, Props)]
    struct WardrobeProps {}

    impl Component for Wardrobe {
        type Props = WardrobeProps;
        type Event = NoEvent;

        fn view(_: WardrobeProps, _: Scope<NoEvent>) -> impl IntoElement {
            let open = signal(false);
            view()
                .on_press(move |_: &()| open.update(|o| *o = !*o))
                .child(
                    Pocket::element(PocketProps {
                        open: open.into(),
                        children: Children::default(),
                    })
                    .child(Fresh::element(FreshProps {})),
                )
                .child(
                    Holder::element(HolderProps {
                        children: Children::default(),
                    })
                    .child(text("before"))
                    .child(when(open, || text("open")))
                    .child(text("after")),
                )
        }
    }

    #[test]
    fn a_view_passes_lazy_children_and_regions_to_nested_components() {
        let mut c = core();
        c.mount_root(&Root::new::<Wardrobe>(|| WardrobeProps {}));
        let batch = c.commit().unwrap();
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["after", "before"]);
        assert_eq!(FRESH.with(Cell::get), 0, "closed: not made");
        let host = root_host(&batch);
        // Opened: the content is made, the region's text placed between.
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let mut shown = texts(&batch);
        shown.sort();
        assert_eq!(shown, ["fresh 1", "open"]);
        // The region's text is the holder's middle child.
        let holder = c
            .components
            .instances
            .values()
            .find(|i| i.js_children.len() == 3)
            .expect("the holder has three children");
        assert_eq!(holder.js_children[1], text_node(&batch, "open"));
        // Closed, then opened again: made afresh.
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        c.commit();
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let mut shown = texts(&c.commit().unwrap());
        shown.sort();
        assert_eq!(shown, ["fresh 2", "open"]);
        let events = js_events(&mut c);
        assert!(events.is_empty(), "nothing for JS: {events:?}");
    }

    /// A text as its root: a count, bumped by a press.
    #[derive(Default)]
    struct Tally;

    #[derive(Clone, PartialEq, Props)]
    struct TallyProps {}

    impl Component for Tally {
        type Props = TallyProps;
        type Event = NoEvent;

        fn view(_: TallyProps, _: Scope<NoEvent>) -> impl IntoElement {
            let n = signal(0);
            text(move || format!("tally {}", n.get())).on_press(move |_: &()| n.update(|n| *n += 1))
        }
    }

    /// A scroll view as its root.
    #[derive(Default)]
    struct Scroller;

    #[derive(Clone, PartialEq, Props)]
    struct ScrollerProps {}

    impl Component for Scroller {
        type Props = ScrollerProps;
        type Event = NoEvent;

        fn view(_: ScrollerProps, _: Scope<NoEvent>) -> impl IntoElement {
            scroll().child(text("inside"))
        }
    }

    #[test]
    fn a_views_root_can_be_any_element() {
        let mut c = core();
        c.mount_root(&Root::new::<Tally>(|| TallyProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert!(
            batch.items.iter().any(|i| matches!(
                i,
                MountItem::Create { id, kind: crate::ViewKind::Text } if *id == host
            )),
            "the host is the text: {:?}",
            batch.items
        );
        assert_eq!(
            batch
                .items
                .iter()
                .filter(|i| matches!(i, MountItem::Create { id, .. } if *id == host))
                .count(),
            1,
            "made once"
        );
        assert_eq!(texts(&batch), ["tally 0"]);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["tally 1"]);

        let mut c = core();
        c.mount_root(&Root::new::<Scroller>(|| ScrollerProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert!(
            batch.items.iter().any(|i| matches!(
                i,
                MountItem::Create { id, kind: crate::ViewKind::Scroll } if *id == host
            )),
            "the host is the scroll view: {:?}",
            batch.items
        );
        assert_eq!(texts(&batch), ["inside"]);
    }

    /// Dims a nested component (its host) with a bound style; a press
    /// flips it.
    #[derive(Default)]
    struct Dimmer;

    #[derive(Clone, PartialEq, Props)]
    struct DimmerProps {}

    impl Component for Dimmer {
        type Props = DimmerProps;
        type Event = NoEvent;

        fn view(_: DimmerProps, _: Scope<NoEvent>) -> impl IntoElement {
            let dim = signal(false);
            view()
                .on_press(move |_: &()| dim.update(|d| *d = !*d))
                .child(
                    Holder::element(HolderProps {
                        children: Children::default(),
                    })
                    .w(px(10.0))
                    .opacity(move || if dim.get() { 0.5_f32 } else { 1.0 }),
                )
        }
    }

    #[test]
    fn a_views_bound_styles_on_a_nested_component_are_a_binding() {
        let mut c = core();
        c.mount_root(&Root::new::<Dimmer>(|| DimmerProps {}));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        let dimmed = batch.items.iter().find_map(|i| match i {
            MountItem::ViewStyle { id, style } if style.opacity == 0.5 => Some(*id),
            _ => None,
        });
        let nested = dimmed.expect("the nested host is dimmed");
        assert_ne!(nested, host);
        assert_eq!(creates(&batch), 0);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(view_style_of(&batch, nested).map(|s| s.opacity), Some(1.0));
    }

    /// Counts back presses while its view lives.
    #[derive(Default)]
    struct Catcher;

    #[derive(Clone, PartialEq, Props)]
    struct CatcherProps {}

    impl Component for Catcher {
        type Props = CatcherProps;
        type Event = NoEvent;

        fn view(_: CatcherProps, _: Scope<NoEvent>) -> impl IntoElement {
            let caught = signal(0);
            on_back_press(move || {
                caught.update(|n| *n += 1);
                true
            });
            view().child(text(move || format!("caught {}", caught.get())))
        }
    }

    #[test]
    fn a_views_back_press_listener_hears_the_back_button() {
        let mut c = core();
        c.mount_root(&Root::new::<Catcher>(|| CatcherProps {}));
        assert_eq!(texts(&c.commit().unwrap()), ["caught 0"]);
        assert!(c.component_event(ROOT_ID, EventKind::BackPress, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["caught 1"]);
    }

    /// Its view panics as it is made.
    #[derive(Default)]
    struct Broken;

    #[derive(Clone, PartialEq, Props)]
    struct BrokenProps {}

    impl Component for Broken {
        type Props = BrokenProps;
        type Event = NoEvent;

        fn view(_: BrokenProps, _: Scope<NoEvent>) -> impl IntoElement {
            panic!("no view");
            #[allow(unreachable_code)]
            view()
        }
    }

    /// A counter whose text panics past 1, and a broken component, each
    /// under an error boundary.
    #[derive(Default)]
    struct Guarded;

    #[derive(Clone, PartialEq, Props)]
    struct GuardedProps {}

    impl Component for Guarded {
        type Props = GuardedProps;
        type Event = NoEvent;

        fn view(_: GuardedProps, _: Scope<NoEvent>) -> impl IntoElement {
            let n = signal(0);
            view()
                .on_press(move |_: &()| n.update(|n| *n += 1))
                .child(catch_error(
                    move || {
                        text(move || {
                            assert!(n.get() < 2, "too many");
                            format!("n {}", n.get())
                        })
                    },
                    |e, _| text(format!("failed: {}", e.message)),
                ))
                .child(catch_error(
                    || Broken::element(BrokenProps {}),
                    |e, _| text(format!("{} failed", e.component)),
                ))
        }
    }

    #[test]
    fn error_boundaries_show_their_fallback() {
        let mut c = core();
        c.mount_root(&Root::new::<Guarded>(|| GuardedProps {}));
        let batch = c.commit().unwrap();
        let shown = texts(&batch);
        assert!(shown.contains(&"n 0".to_owned()), "{shown:?}");
        assert!(
            shown.iter().any(|t| t.ends_with("Broken failed")),
            "{shown:?}"
        );
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["n 1"]);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(texts(&c.commit().unwrap()), ["failed: too many"]);
    }

    /// A large component with one value changing often: 300 rows of
    /// static content and a counter.
    #[component]
    fn Ticker() -> impl IntoElement {
        let tick = signal(0_u32);
        view()
            .on_press(move |_: &()| tick.update(|t| *t += 1))
            .child(text(move || format!("tick {}", tick.get())))
            .children((0..300).map(|i| {
                view()
                    .flex_row()
                    .p_2()
                    .gap_2()
                    .child(view().size(px(20.0)).bg(rgb(0x3366ff)))
                    .child(text(format!("row {i}")).text_sm())
            }))
    }

    /// `cargo test --release -p nsh-core bench_view_tick -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_view_tick() {
        let mut c = core();
        c.mount_root(&Root::new::<Ticker>(|| ()));
        let host = root_host(&c.commit().unwrap());
        let n = 2000;
        let (mut event, mut commit) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
        let mut items = 0;
        for _ in 0..n {
            let start = std::time::Instant::now();
            c.component_event(host, EventKind::Press, &EventPayload::None);
            let mid = std::time::Instant::now();
            items += c.commit().map_or(0, |b| b.items.len());
            event += mid - start;
            commit += mid.elapsed();
        }
        eprintln!(
            "view tick: {:?} per event, {:?} per commit, {} mount items",
            event / n,
            commit / n,
            items / n as usize
        );
    }

    /// How many rows [`Board`] shows, and how many of its values change
    /// on each tick (the first cell of as many rows).
    const BOARD_ROWS: usize = 80;
    const BOARD_TICKING: usize = 40;

    #[derive(Clone, Copy, PartialEq, Props)]
    struct BoardProps {
        /// Its cells have a size of their own: what their text says moves
        /// nothing around them.
        fixed: bool,
        /// Each tick changes how wide the changing values are (a sign comes
        /// and goes); otherwise they keep their width, but for the rare
        /// digit a price gains (the tests' text engine gives every
        /// character one width, as tabular figures have).
        widening: bool,
    }

    /// A page of high-frequency updates, a quote board: 80 rows of a
    /// mark and five cells (about a thousand nodes), the first cells of 40
    /// rows changing together on each press.
    #[component]
    fn Board(props: BoardProps) -> impl IntoElement {
        let (fixed, widening) = (props.fixed, props.widening);
        let ticks: Vec<Signal<u32>> = (0..BOARD_TICKING).map(|_| signal(0)).collect();
        let pressed = ticks.clone();
        let cell = move |content: Text| {
            let cell = view().p_1().child(content);
            if fixed {
                cell.w(px(56.0)).h(px(24.0))
            } else {
                cell
            }
        };
        view()
            .on_press(move |_: &()| {
                batch(|| {
                    for tick in &pressed {
                        tick.update(|t| *t += 7);
                    }
                })
            })
            .children((0..BOARD_ROWS).map(|row| {
                let first = match ticks.get(row) {
                    Some(&tick) => text(move || {
                        let t = tick.get();
                        let sign = if widening && t % 2 == 1 { "+" } else { "" };
                        format!("{sign}{}.{:02}", 9 + t / 3, t % 100)
                    }),
                    None => text(format!("{row}.00")),
                };
                view()
                    .flex_row()
                    .items_center()
                    .p_1()
                    .gap_2()
                    .child(view().size(px(12.0)).bg(rgb(0x22aa66)))
                    .child(cell(first))
                    .children((1..5).map(move |col| cell(text(format!("r{row} c{col}")))))
            }))
    }

    /// `cargo test --release -p nsh-core bench_high_frequency -- --ignored --nocapture`
    ///
    /// The cost of a commit when many values of a large page change at
    /// once and often: [`Board`] with fixed cells, and with cells that
    /// take their text's size, the values keeping their widths or not.
    #[test]
    #[ignore]
    fn bench_high_frequency() {
        for (fixed, widening, label) in [
            (true, false, "fixed cells"),
            (false, false, "content-sized cells, same widths"),
            (false, true, "content-sized cells, new widths"),
        ] {
            let mut c = core();
            c.mount_root(&Root::new::<Board>(move || BoardProps { fixed, widening }));
            let first = c.commit().unwrap();
            let nodes = first
                .items
                .iter()
                .filter(|i| matches!(i, MountItem::Create { .. }))
                .count();
            let host = root_host(&first);
            let n = 2000;
            let (mut event, mut commit) = (std::time::Duration::ZERO, std::time::Duration::ZERO);
            let mut items = 0;
            for _ in 0..n {
                let start = std::time::Instant::now();
                c.component_event(host, EventKind::Press, &EventPayload::None);
                let mid = std::time::Instant::now();
                items += c.commit().map_or(0, |b| b.items.len());
                event += mid - start;
                commit += mid.elapsed();
            }
            eprintln!(
                "high frequency ({label}, {nodes} views, {BOARD_TICKING} values a tick): \
                 {:?} per event, {:?} per commit, {} mount items",
                event / n,
                commit / n,
                items / n as usize
            );
        }
    }

    #[derive(Clone, Copy, PartialEq, Props)]
    struct ShownProps {
        value: crate::ui::Prop<SharedString>,
    }

    /// Shows its prop.
    #[component]
    fn Shown(props: ShownProps) -> impl IntoElement {
        text(props.value)
    }

    /// Passes `Shown` a binding, then, from the second press, a value: its
    /// region makes the element again, a new `Shown`.
    #[component]
    fn Passer() -> impl IntoElement {
        let n = signal(0);
        let fixed = signal(false);
        view()
            .on_press(move |_: &()| {
                if n.get_untracked() == 1 {
                    fixed.set(true);
                }
                n.update(|n| *n += 1);
            })
            .child(dynamic(move || {
                let value: crate::ui::Prop<SharedString> = if fixed.get() {
                    "fixed".into()
                } else {
                    crate::ui::Prop::bind(move || format!("n {}", n.get()).into())
                };
                shown().value(value)
            }))
    }

    #[test]
    fn a_prop_follows_a_binding_and_a_region_made_again_makes_a_new_component() {
        let mut c = core();
        c.mount_root(&Root::new::<Passer>(|| ()));
        let batch = c.commit().unwrap();
        assert_eq!(texts(&batch), ["n 0"]);
        let host = root_host(&batch);
        let press = |c: &mut Core<FakeEngine>| {
            assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
            c.commit().map(|b| texts(&b)).unwrap_or_default()
        };
        assert_eq!(press(&mut c), ["n 1"]);
        assert_eq!(press(&mut c), ["fixed"]);
        // The old `Shown` went with its binding.
        assert!(press(&mut c).is_empty());
    }

    /// Counts Mod+K while a branch is shown; a press hides the branch.
    #[component]
    fn Shortcuts() -> impl IntoElement {
        let count = signal(0);
        let shown = signal(true);
        view()
            .on_press(move |_: &()| shown.set(false))
            .child(text(move || format!("k {}", count.get())))
            .child(when(shown, move || {
                on_key("mod+k", move |_| count.update(|c| *c += 1));
                view()
            }))
    }

    #[test]
    fn a_views_shortcuts_join_jss_and_run_in_the_core() {
        use crate::keymap::{KeyBinding, Keymap, Keystroke, When};
        let tables = |batch: &MountBatch| -> Vec<Vec<u32>> {
            batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Keymap(k) => Some(k.bindings().iter().map(|b| b.id).collect()),
                    _ => None,
                })
                .collect()
        };
        let mut c = core();
        // Apps bind their shortcuts before rendering their first component.
        let js = KeyBinding::new(
            1,
            Keystroke::parse_with("mod+j", true).unwrap(),
            When::Auto,
            false,
        );
        apply(
            &mut c,
            vec![
                Op::SetProp {
                    id: ROOT_ID,
                    prop: Prop::Keymap(std::sync::Arc::new(Keymap::new(vec![js]))),
                },
                Op::Listen {
                    id: ROOT_ID,
                    event: EventKind::KeyCommand,
                    enabled: true,
                },
            ],
        );
        assert_eq!(tables(&c.commit().unwrap()), [vec![1]]);
        c.mount_root(&Root::new::<Shortcuts>(|| ()));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        let table = tables(&batch);
        let [js_id, ours] = table.last().expect("a table").as_slice() else {
            panic!("{table:?}");
        };
        assert_eq!(*js_id, 1);
        let ours = *ours;
        assert!(ours >= crate::ui::keys::FIRST_ID);
        // JS's table joins it: JS's first, then the views'.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: ROOT_ID,
                prop: Prop::Keymap(std::sync::Arc::new(Keymap::new(vec![js]))),
            }],
        );
        assert_eq!(tables(&c.commit().unwrap()), [vec![1, ours]]);
        // The view's runs here; JS's goes to JS.
        let key = |id: u32| EventPayload::Value(crate::PayloadValue::Number(id as f64));
        assert!(c.component_event(ROOT_ID, EventKind::KeyCommand, &key(ours)));
        assert_eq!(texts(&c.commit().unwrap()), ["k 1"]);
        assert!(!c.component_event(ROOT_ID, EventKind::KeyCommand, &key(1)));
        // The binding goes with its owner.
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(tables(&c.commit().unwrap()), [vec![1]]);
        assert!(
            c.nodes[c.root as usize]
                .events
                .contains(EventKind::KeyCommand)
        );
    }

    #[test]
    fn jss_shortcuts_bound_before_any_view_stay_beside_the_views() {
        use crate::keymap::{KeyBinding, Keymap, Keystroke, When};
        let tables = |batch: &MountBatch| -> Vec<Vec<u32>> {
            batch
                .items
                .iter()
                .filter_map(|i| match i {
                    MountItem::Keymap(k) => Some(k.bindings().iter().map(|b| b.id).collect()),
                    _ => None,
                })
                .collect()
        };
        let listening = |c: &Core<FakeEngine>| {
            c.nodes[c.root as usize]
                .events
                .contains(EventKind::KeyCommand)
        };
        let mut c = core();
        let js = KeyBinding::new(
            1,
            Keystroke::parse_with("escape", true).unwrap(),
            When::Always,
            false,
        );
        apply(
            &mut c,
            vec![
                Op::SetProp {
                    id: ROOT_ID,
                    prop: Prop::Keymap(std::sync::Arc::new(Keymap::new(vec![js]))),
                },
                Op::Listen {
                    id: ROOT_ID,
                    event: EventKind::KeyCommand,
                    enabled: true,
                },
            ],
        );
        assert_eq!(tables(&c.commit().unwrap()), [vec![1]]);
        c.mount_root(&Root::new::<Shortcuts>(|| ()));
        let batch = c.commit().unwrap();
        let host = root_host(&batch);
        let table = tables(&batch);
        let [js, ours] = table.last().expect("a table").as_slice() else {
            panic!("{table:?}");
        };
        assert_eq!(*js, 1);
        assert!(*ours >= crate::ui::keys::FIRST_ID);
        assert!(listening(&c));
        // The view's binding goes; JS's stays, still listened to.
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        assert_eq!(tables(&c.commit().unwrap()), [vec![1]]);
        assert!(listening(&c));
    }

    /// A pressable box with the pointing hand.
    #[component]
    fn Pointing() -> impl IntoElement {
        view().size_10().cursor_pointer()
    }

    #[test]
    fn a_typed_cursor_reaches_the_view() {
        let mut c = core();
        c.mount_root(&Root::new::<Pointing>(|| ()));
        let batch = c.commit().unwrap();
        assert!(
            batch.items.iter().any(|i| matches!(
                i,
                MountItem::ViewStyle { style, .. } if style.cursor == crate::Cursor::Pointer
            )),
            "{:#?}",
            batch.items
        );
    }

    /// A leaf in a region of its own.
    #[component]
    fn Leafy() -> impl IntoElement {
        view().child(dynamic(|| text("leaf")))
    }

    /// Shows a `Leafy` until pressed.
    #[component]
    fn Branch() -> impl IntoElement {
        let shown = signal(true);
        view()
            .on_press(move |_: &()| shown.set(false))
            .child(when(shown, leafy))
    }

    #[test]
    fn a_released_view_releases_what_its_regions_made() {
        let mut c = core();
        c.mount_root(&Root::new::<Branch>(|| ()));
        let batch = c.commit().unwrap();
        let leaf = text_node(&batch, "leaf");
        let host = root_host(&batch);
        assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert!(
            batch
                .items
                .iter()
                .any(|i| matches!(i, MountItem::Delete { id } if *id == leaf)),
            "{:?}",
            batch.items
        );
    }
    /// A download's progress: a range for screen readers that follows the
    /// app's value, and none while it is indeterminate.
    #[derive(Default)]
    struct Download;

    #[derive(Clone, PartialEq, Props)]
    struct DownloadProps {}

    impl Component for Download {
        type Props = DownloadProps;
        type Event = NoEvent;

        fn view(_: DownloadProps, _: Scope<NoEvent>) -> impl IntoElement {
            let now = signal(Some(40.0_f32));
            view()
                .size_10()
                .accessible(true)
                .role(crate::AccessibilityRole::Progressbar)
                .accessibility_value(move || {
                    Some(crate::AccessibilityValue {
                        min: Some(0.0),
                        max: Some(100.0),
                        now: now.get(),
                        text: None,
                    })
                })
                .on_press(move || now.set(now.get().map_or(Some(0.0), |_| None)))
        }
    }

    #[test]
    fn an_elements_accessibility_value_follows_its_signals() {
        let mut c = core();
        c.mount_root(&Root::new::<Download>(|| DownloadProps {}));
        let batch = c.commit().unwrap();
        let value = |batch: &MountBatch| {
            batch.items.iter().find_map(|i| match i {
                MountItem::ViewProps { id, props }
                    if props.accessibility.role == crate::AccessibilityRole::Progressbar =>
                {
                    Some((*id, props.accessibility.value.clone()))
                }
                _ => None,
            })
        };
        let (id, first) = value(&batch).expect("the progress bar's props");
        let range = |now| crate::AccessibilityValue {
            min: Some(0.0),
            max: Some(100.0),
            now,
            text: None,
        };
        assert_eq!(first, Some(range(Some(40.0))));
        assert!(c.component_event(id, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(value(&batch).map(|(_, v)| v), Some(Some(range(None))));
        assert!(c.component_event(id, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert_eq!(value(&batch).map(|(_, v)| v), Some(Some(range(Some(0.0)))));
    }
}

mod rust_desktop {
    use std::cell::Cell;

    use super::*;
    use crate::{
        desktop::{DesktopCommand, TitleBarStyle},
        geometry::{Edges, Points},
        ui::{
            Root,
            desktop::{close_window, set_title_bar, title_bar},
            prelude::*,
        },
    };

    thread_local! {
        static DRAG: Cell<Option<Signal<bool>>> = const {Cell::new(None)};
        static READS: Cell<u32> = const {Cell::new(0)};
    }

    #[component]
    fn Chrome() -> impl IntoElement {
        set_title_bar(TitleBarStyle::Hidden, Some(px(42.0)));
        let drag = signal(true);
        DRAG.set(Some(drag));
        view()
            .window_drag(move || drag.get())
            .child(text(move || {
                READS.set(READS.get() + 1);
                let area = title_bar();
                format!("{} {} {}", area.top.0, area.left.0, area.right.0)
            }))
            .child(
                text("Close window")
                    .window_drag(false)
                    .on_press(|_: &()| close_window()),
            )
    }

    #[test]
    fn rust_title_bar_commands_and_reactive_drag_props_reach_the_platform() {
        let mut c = core();
        READS.set(0);
        c.set_environment(crate::ui::Environment {
            title_bar: Edges {
                top: Points(42.0),
                left: Points(78.0),
                right: Points(0.0),
                bottom: Points(0.0),
            },
            ..Default::default()
        });
        c.mount_root(&Root::of::<Chrome>());
        let batch = c.commit().unwrap();
        assert!(batch.items.iter().any(|item| matches!(item, MountItem::Command {id: crate::ROOT_ID, command: Command::Desktop(command)} if **command == DesktopCommand::SetTitleBar {style:TitleBarStyle::Hidden, height:Some(px(42.0))})));
        let header = batch
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::ViewProps { id, props } if props.window_drag == Some(true) => Some(*id),
                _ => None,
            })
            .unwrap();
        let close = batch
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::Text { id, text, .. } if text.text == "Close window" => Some(*id),
                _ => None,
            })
            .unwrap();
        assert!(batch.items.iter().any(|item| matches!(item, MountItem::ViewProps {id, props} if *id == close && props.window_drag == Some(false))));
        assert!(
            batch
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Text {text, ..} if text.text == "42 78 0"))
        );
        {
            let _entered = c.components.runtime.enter();
            DRAG.get().unwrap().set(false);
        }
        let batch = c.commit().unwrap();
        assert!(batch.items.iter().any(|item| matches!(item, MountItem::ViewProps {id, props} if *id == header && props.window_drag == Some(false))));
        assert!(
            !batch
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Create { .. }))
        );
        let reads = READS.get();
        c.set_environment(crate::ui::Environment {
            dark: true,
            title_bar: Edges {
                top: Points(42.0),
                left: Points(78.0),
                right: Points(0.0),
                bottom: Points(0.0),
            },
            ..Default::default()
        });
        assert!(c.commit().is_none());
        assert_eq!(
            READS.get(),
            reads,
            "other environment changes do not rerun title_bar readers"
        );
        c.set_environment(crate::ui::Environment {
            title_bar: Edges {
                top: Points(42.0),
                left: Points(0.0),
                right: Points(138.0),
                bottom: Points(0.0),
            },
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert!(
            batch
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Text {text, ..} if text.text == "42 0 138"))
        );
        c.set_environment(crate::ui::Environment::default());
        let batch = c.commit().unwrap();
        assert!(
            batch
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Text {text, ..} if text.text == "0 0 0"))
        );
        assert!(c.component_event(close, EventKind::Press, &EventPayload::None));
        let batch = c.commit().unwrap();
        assert!(batch.items.iter().any(|item| matches!(item, MountItem::Command {id:crate::ROOT_ID, command:Command::Desktop(command)} if **command == DesktopCommand::Close)));
    }
}

#[test]
fn file_drop_callbacks_keep_urls_and_disabled_targets_unmount_their_events() {
    use crate::ui::prelude::*;
    #[component]
    fn DropView() -> impl IntoElement {
        let received = signal(String::new());
        let disabled = signal(false);
        view()
            .disabled(move || disabled.get())
            .on_press(move |_: &()| disabled.set(true))
            .on_file_drag_enter(|_: &()| {})
            .on_file_drag_leave(|_: &()| {})
            .on_file_drop(move |event: &crate::ui::FileDropEvent| {
                received.set(event.uris.join("\n"))
            })
            .child(text(move || received.get()))
    }
    let mut c = core();
    c.mount_root(&crate::ui::Root::of::<DropView>());
    let batch = c.commit().unwrap();
    let host = batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Events { id, events } if events.contains(EventKind::FileDrop) => Some(*id),
            _ => None,
        })
        .unwrap();
    let uris = vec![
        "file:///tmp/a%20b.txt".into(),
        "file:///tmp/%E4%B8%AD%E6%96%87/".into(),
    ];
    assert!(c.component_event(
        host,
        EventKind::FileDrop,
        &EventPayload::FileDrop(uris.clone())
    ));
    let delivered = c.commit().unwrap();
    assert!(delivered.items.iter().any(|item| matches!(item,
        MountItem::Text { text, .. } if text.text == uris.join("\n"))));
    assert!(c.component_event(host, EventKind::Press, &EventPayload::None));
    let disabled = c.commit().unwrap();
    let events = disabled
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Events { id, events } if *id == host => Some(*events),
            _ => None,
        })
        .unwrap();
    for event in [
        EventKind::FileDragEnter,
        EventKind::FileDragLeave,
        EventKind::FileDrop,
    ] {
        assert!(!events.contains(event));
    }
}

#[test]
fn hover_moves_reach_rust_listeners_with_their_positions_and_modifiers() {
    use crate::ui::prelude::*;
    #[component]
    fn Crosshair() -> impl IntoElement {
        let at = signal(String::new());
        view()
            .on_hover_move(move |e: &HoverEvent| {
                at.set(format!(
                    "{} {} {} {} {}",
                    e.position.x.0,
                    e.position.y.0,
                    e.page_position.x.0,
                    e.page_position.y.0,
                    e.modifiers.shift
                ))
            })
            .child(text(move || at.get()))
    }
    let mut c = core();
    c.mount_root(&crate::ui::Root::of::<Crosshair>());
    let batch = c.commit().unwrap();
    let host = batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Events { id, events } if events.contains(EventKind::HoverMove) => Some(*id),
            _ => None,
        })
        .expect("the listening view mounts HoverMove in its event mask");
    let event = crate::HoverEvent {
        position: point(px(4.0), px(5.0)),
        page_position: point(px(14.0), px(25.0)),
        modifiers: crate::keymap::Modifiers {
            shift: true,
            ..Default::default()
        },
    };
    assert!(c.component_event(host, EventKind::HoverMove, &EventPayload::Hover(event)));
    let delivered = c.commit().unwrap();
    assert!(delivered.items.iter().any(|item| matches!(item,
        MountItem::Text { text, .. } if text.text == "4 5 14 25 true")));
    // Another payload is not a hover move.
    assert!(c.component_event(host, EventKind::HoverMove, &EventPayload::None));
    assert!(
        c.commit()
            .is_none_or(|b| !b.items.iter().any(|i| matches!(i, MountItem::Text { .. })))
    );
}

#[test]
fn context_menus_reach_rust_listeners_with_their_positions() {
    use crate::ui::prelude::*;
    #[component]
    fn Row() -> impl IntoElement {
        let at = signal(String::new());
        view()
            .on_context_menu(move |e: &ContextMenuEvent| {
                at.set(format!(
                    "{} {} {} {}",
                    e.position.x.0, e.position.y.0, e.page_position.x.0, e.page_position.y.0
                ))
            })
            .child(text(move || at.get()))
    }
    let mut c = core();
    c.mount_root(&crate::ui::Root::of::<Row>());
    let batch = c.commit().unwrap();
    let host = batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Events { id, events } if events.contains(EventKind::ContextMenu) => {
                Some(*id)
            }
            _ => None,
        })
        .expect("the listening view mounts ContextMenu in its event mask");
    let event = crate::ContextMenuEvent {
        position: point(px(4.0), px(5.0)),
        page_position: point(px(14.0), px(25.0)),
        ..Default::default()
    };
    assert!(c.component_event(
        host,
        EventKind::ContextMenu,
        &EventPayload::ContextMenu(event)
    ));
    let delivered = c.commit().unwrap();
    assert!(delivered.items.iter().any(|item| matches!(item,
        MountItem::Text { text, .. } if text.text == "4 5 14 25")));
}

/// A container `2` with `style` and empty children `4`, `6`, ... with
/// theirs, laid out at the root; the children's frames.
fn grid_frames(
    container: &[(&str, StyleValue<'_>)],
    children: &[&[(&str, StyleValue<'_>)]],
) -> Vec<Bounds<Points>> {
    let mut c = core();
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::View,
        },
        style_op(2, container),
    ];
    for (i, child) in children.iter().enumerate() {
        let id = 4 + 2 * i as NodeId;
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(style_op(id, child));
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    (0..children.len())
        .map(|i| frame_of(&batch, 4 + 2 * i as NodeId).expect("a frame"))
        .collect()
}

#[test]
fn grids_place_items_by_line_name() {
    let s = StyleValue::Str;
    let grid = [
        ("display", s("grid")),
        ("width", StyleValue::Number(300.0)),
        ("gridTemplateColumns", s("[a] 40px [b] 60px [c] 1fr [d]")),
    ];
    let f = grid_frames(
        &grid,
        &[
            &[("gridColumnStart", s("b"))],
            &[("gridColumn", s("a / c"))],
            &[("gridColumn", s("b / span d"))],
            &[("gridColumnStart", s("c")), ("gridColumnEnd", s("d"))],
        ],
    );
    let xw = |r: Bounds<Points>| (r.origin.x.0, r.size.width.0);
    assert_eq!(xw(f[0]), (40.0, 60.0));
    assert_eq!(xw(f[1]), (0.0, 100.0));
    assert_eq!(xw(f[2]), (40.0, 260.0));
    assert_eq!(xw(f[3]), (100.0, 200.0));

    // Several names per line, names in repetitions.
    let f = grid_frames(
        &[
            ("display", s("grid")),
            ("width", StyleValue::Number(300.0)),
            (
                "gridTemplateColumns",
                s("[full-start] 20px [main-start] repeat(2, [col] 1fr) [main-end] 20px [full-end]"),
            ),
        ],
        &[
            &[("gridColumn", s("main-start / main-end"))],
            &[("gridColumn", s("2 col / full-end"))],
            &[("gridColumn", s("full-start / full-end"))],
        ],
    );
    assert_eq!(xw(f[0]), (20.0, 260.0));
    assert_eq!(xw(f[1]), (150.0, 150.0));
    assert_eq!(xw(f[2]), (0.0, 300.0));
}

#[test]
fn grid_auto_tracks_stretch_unless_aligned() {
    let s = StyleValue::Str;
    let n = StyleValue::Number;
    let grid = [
        ("display", s("grid")),
        ("width", n(300.0)),
        ("height", n(200.0)),
        ("gridTemplateColumns", s("1fr 1fr")),
    ];
    // CSS's `normal`: the auto rows share the container's height.
    let f = grid_frames(&grid, &[&[], &[], &[]]);
    assert_eq!((f[0].origin.y.0, f[0].size.height.0), (0.0, 100.0));
    assert_eq!((f[2].origin.y.0, f[2].size.height.0), (100.0, 100.0));
    let mut normal = grid.to_vec();
    normal.push(("alignContent", s("normal")));
    assert_eq!(grid_frames(&normal, &[&[]])[0].size.height.0, 200.0);
    // Columns too, without a template.
    let f = grid_frames(&grid[..3], &[&[]]);
    assert_eq!(f[0].size.width.0, 300.0);
    // A value set explicitly applies.
    let mut start = grid.to_vec();
    start.push(("alignContent", s("flex-start")));
    assert_eq!(grid_frames(&start, &[&[]])[0].size.height.0, 0.0);
    let mut start = grid[..3].to_vec();
    start.push(("justifyContent", s("start")));
    assert_eq!(grid_frames(&start, &[&[]])[0].size.width.0, 0.0);
    // Flex containers keep React Native's `flex-start` for wrapped lines.
    let f = grid_frames(
        &[
            ("flexDirection", s("row")),
            ("flexWrap", s("wrap")),
            ("width", n(300.0)),
            ("height", n(200.0)),
        ],
        &[&[("width", n(200.0))], &[("width", n(200.0))]],
    );
    assert_eq!((f[0].size.height.0, f[1].origin.y.0), (0.0, 0.0));
}

/// A container `2` with `classes` and empty children `4`, `6`, ... with
/// theirs, laid out at the root; the children's frames.
fn class_frames(classes: &str, children: &[&str]) -> Vec<Bounds<Points>> {
    let mut c = core();
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::View,
        },
        class_op(2, classes),
    ];
    for (i, child) in children.iter().enumerate() {
        let id = 4 + 2 * i as NodeId;
        ops.push(Op::Create { id, tag: Tag::View });
        ops.push(class_op(id, child));
        ops.push(Op::Insert {
            parent: 2,
            child: id,
            before: None,
        });
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    (0..children.len())
        .map(|i| frame_of(&batch, 4 + 2 * i as NodeId).expect("a frame"))
        .collect()
}

/// The alignment classes lay out as their Tailwind CSS declarations do in
/// a browser.
#[test]
fn alignment_classes_lay_out_as_in_a_browser() {
    let yh = |r: Bounds<Points>| (r.origin.y.0, r.size.height.0);
    let grid = "grid grid-cols-2 w-[300px] h-[200px]";
    // Unset (`normal`) and `content-normal`: the auto rows stretch.
    let f = class_frames(grid, &["", "", ""]);
    assert_eq!((yh(f[0]), yh(f[2])), ((0.0, 100.0), (100.0, 100.0)));
    let f = class_frames(&format!("{grid} content-normal"), &["", "", ""]);
    assert_eq!(yh(f[2]), (100.0, 100.0));
    // `content-start` (`align-content: flex-start`) packs them at the start.
    let f = class_frames(&format!("{grid} content-start"), &["h-5", "", "h-8"]);
    assert_eq!((yh(f[0]), yh(f[2])), ((0.0, 20.0), (20.0, 32.0)));
    // `justify-normal` stretches auto columns; `place-content-start`
    // packs both axes.
    let free = "grid w-[300px] h-[200px]";
    let f = class_frames(&format!("{free} justify-normal"), &[""]);
    assert_eq!((f[0].size.width.0, f[0].size.height.0), (300.0, 200.0));
    let f = class_frames(&format!("{free} place-content-start"), &[""]);
    assert_eq!((f[0].size.width.0, f[0].size.height.0), (0.0, 0.0));
    let f = class_frames(&format!("{free} place-content-end"), &["w-10 h-5"]);
    assert_eq!((f[0].origin.x.0, f[0].origin.y.0), (260.0, 180.0));
    // Items: `place-items-end`, `justify-items-start`.
    let cells = "grid grid-cols-[100px] grid-rows-[40px] w-[300px]";
    let f = class_frames(&format!("{cells} place-items-end"), &["w-10 h-5"]);
    assert_eq!((f[0].origin.x.0, f[0].origin.y.0), (60.0, 20.0));
    let f = class_frames(&format!("{cells} justify-items-start"), &["w-10"]);
    assert_eq!((f[0].origin.x.0, f[0].size.height.0), (0.0, 40.0));

    // Flex containers: unset keeps React Native's `flex-start` for wrapped
    // lines, as before; `content-start` is the same, and `content-normal`
    // stretches the lines, as CSS's `normal` does there.
    let flex = "flex flex-wrap w-[300px] h-[200px]";
    let lines = ["w-[200px]", "w-[200px]"];
    let f = class_frames(flex, &lines);
    assert_eq!((yh(f[0]), yh(f[1])), ((0.0, 0.0), (0.0, 0.0)));
    let f = class_frames(&format!("{flex} content-start"), &lines);
    assert_eq!((yh(f[0]), yh(f[1])), ((0.0, 0.0), (0.0, 0.0)));
    let f = class_frames(&format!("{flex} content-normal"), &lines);
    assert_eq!((yh(f[0]), yh(f[1])), ((0.0, 100.0), (100.0, 100.0)));
    // `justify-normal` is `flex-start` in a flex container.
    let f = class_frames("flex w-[300px] justify-normal", &["w-10"]);
    assert_eq!(f[0].origin.x.0, 0.0);
}

#[test]
fn start_and_end_follow_the_writing_direction() {
    let s = StyleValue::Str;
    let n = StyleValue::Number;
    let item = [("width", n(50.0)), ("height", n(20.0))];
    let grid = |justify: &'static str, direction: &'static str| {
        [
            ("display", s("grid")),
            ("width", n(300.0)),
            ("height", n(100.0)),
            ("gridTemplateColumns", s("100px")),
            ("gridTemplateRows", s("40px")),
            ("justifyItems", s(justify)),
            ("alignItems", s("end")),
            ("direction", s(direction)),
        ]
    };
    let f = grid_frames(&grid("start", "ltr"), &[&item]);
    assert_eq!((f[0].origin.x.0, f[0].origin.y.0), (0.0, 20.0));
    let f = grid_frames(&grid("end", "ltr"), &[&item]);
    assert_eq!(f[0].origin.x.0, 50.0);
    // Right to left, the track is at the right and its start is its right.
    let f = grid_frames(&grid("start", "rtl"), &[&item]);
    assert_eq!(f[0].origin.x.0, 250.0);
    let f = grid_frames(&grid("end", "rtl"), &[&item]);
    assert_eq!(f[0].origin.x.0, 200.0);
    // Per item, and `self-start` / `self-end`.
    let f = grid_frames(
        &grid("start", "ltr"),
        &[&[
            ("width", n(50.0)),
            ("justifySelf", s("self-end")),
            ("alignSelf", s("start")),
        ]],
    );
    assert_eq!((f[0].origin.x.0, f[0].origin.y.0), (50.0, 0.0));
    // Tracks: `justifyContent: end` puts the column at the end.
    let mut end = grid("start", "ltr").to_vec();
    end.push(("justifyContent", s("end")));
    assert_eq!(grid_frames(&end, &[&item])[0].origin.x.0, 200.0);
    let mut end = grid("start", "rtl").to_vec();
    end.push(("justifyContent", s("end")));
    assert_eq!(grid_frames(&end, &[&item])[0].origin.x.0, 50.0);
    // In flex containers too.
    let f = grid_frames(
        &[
            ("width", n(300.0)),
            ("alignItems", s("end")),
            ("justifyContent", s("end")),
            ("height", n(100.0)),
        ],
        &[&item],
    );
    assert_eq!((f[0].origin.x.0, f[0].origin.y.0), (250.0, 80.0));
}

/// What builders take: listeners without arguments, children in an
/// `Option`, a `Vec`, an array or an iterator.
mod builders {
    use super::*;
    use crate::ui::{Listener, Root, prelude::*};

    /// The mount items of `C`'s first frame and of the frames after a press
    /// on each text of `taps`, in order.
    fn run<C: Component>(
        props: impl Fn() -> C::Props + Send + Sync + 'static,
        taps: &[&str],
    ) -> Vec<String> {
        let mut c = core();
        c.mount_root(&Root::new::<C>(props));
        let mut nodes = std::collections::HashMap::new();
        let mut out = Vec::new();
        let mut batch = c.commit().unwrap();
        for tap in taps.iter().map(Some).chain([None]) {
            for item in &batch.items {
                if let MountItem::Text { id, text, .. } = item {
                    nodes.insert(text.text.clone(), *id);
                }
            }
            out.push(format!("{:?}", batch.items));
            let Some(tap) = tap else { break };
            let node = *nodes
                .get(*tap)
                .unwrap_or_else(|| panic!("no text {tap:?} in {nodes:?}"));
            assert!(c.component_event(node, EventKind::Press, &EventPayload::None));
            batch = c.commit().unwrap_or_default();
        }
        out
    }

    /// A pressable text, through a helper that passes a listener on.
    fn tap<M>(label: &'static str, on_press: impl IntoListener<(), M>) -> Text {
        text(label).on_press(on_press)
    }

    #[component]
    fn ListenersOfEvents() -> impl IntoElement {
        let n = signal(0);
        view()
            .child(text("one").on_press(move |_: &()| n.update(|n| *n += 1)))
            .child(tap("ten", move |_: &()| n.update(|n| *n += 10)))
            .child(tap(
                "hundred",
                Listener::from(move |_: &()| n.update(|n| *n += 100)),
            ))
            .child(input().on_focus(move |_: &()| n.set(0)))
            .child(text(move || format!("n {}", n.get())))
    }

    #[component]
    fn ListenersWithout() -> impl IntoElement {
        let n = signal(0);
        view()
            .child(text("one").on_press(move || n.update(|n| *n += 1)))
            .child(tap("ten", move || n.update(|n| *n += 10)))
            .child(tap(
                "hundred",
                Listener::from(move |_: &()| n.update(|n| *n += 100)),
            ))
            .child(input().on_focus(move || n.set(0)))
            .child(text(move || format!("n {}", n.get())))
    }

    #[test]
    fn listeners_of_events_without_data_take_closures_without_arguments() {
        let taps = ["one", "ten", "hundred", "one"];
        let of_events = run::<ListenersOfEvents>(|| (), &taps);
        assert_eq!(run::<ListenersWithout>(|| (), &taps), of_events);
        assert!(of_events[4].contains("\"n 112\""), "{}", of_events[4]);
    }

    #[component]
    fn ChildrenOneByOne() -> impl IntoElement {
        view()
            .child(text("a"))
            .child(text("c"))
            .child(text("d"))
            .child(text("e"))
            .child(text("f"))
            .child(text("row 0"))
            .child(text("row 1"))
            .child(text("x").child("y").child("z"))
            .child(dynamic(|| vec![text("left"), text("right")]))
    }

    #[component]
    fn ChildrenTogether() -> impl IntoElement {
        view()
            .child(Some(text("a")))
            .child(None::<Text>)
            .child(vec![text("c"), text("d")])
            .child(["e", "f"].map(text))
            .child((0..2).map(|i| text(format!("row {i}"))))
            .child(text("x").child(["y", "z"]))
            .child(dynamic(|| [text("left"), text("right")]))
    }

    #[test]
    fn options_vecs_arrays_and_iterators_are_children() {
        let one_by_one = run::<ChildrenOneByOne>(|| (), &[]);
        assert_eq!(run::<ChildrenTogether>(|| (), &[]), one_by_one);
        assert!(one_by_one[0].contains("\"row 1\""));
        assert!(one_by_one[0].contains("\"right\""));
    }

    /// The setters of host elements' own options, each given a closure
    /// of `flipped`.
    #[component]
    fn BoundOptions() -> impl IntoElement {
        let flipped = signal(false);
        let pick =
            move |a: &'static str, b: &'static str| move || if flipped.get() { b } else { a };
        view()
            .child(text("flip").on_press(move || flipped.set(true)))
            .child(
                text("lines")
                    .number_of_lines(move || if flipped.get() { 2_u32 } else { 1 })
                    .selectable(flipped)
                    .max_font_size_multiplier(move || if flipped.get() { 3.0_f32 } else { 1.5 }),
            )
            .child(
                image("a.png")
                    .resize_mode(move || {
                        if flipped.get() {
                            crate::ResizeMode::Contain
                        } else {
                            crate::ResizeMode::Cover
                        }
                    })
                    .placeholder(pick("before.png", "after.png"))
                    .fade_duration(move || if flipped.get() { 300.0_f32 } else { 100.0 }),
            )
            .child(web_view(pick(
                "https://before.test/",
                "https://after.test/",
            )))
            .child(video(pick(
                "https://before.test/v.mp4",
                "https://after.test/v.mp4",
            )))
            .child(native("map").prop("zoom", move || {
                serde_json::json!(if flipped.get() { 9 } else { 4 })
            }))
    }

    #[test]
    fn host_options_take_signals_and_closures() {
        let frames = run::<BoundOptions>(|| (), &["flip"]);
        for before in [
            "before.png",
            "https://before.test/",
            "https://before.test/v.mp4",
            "Number(4)",
            "Cover",
            "fade_ms: Some(100.0)",
            "max_lines: 1",
            "selectable: Some(false)",
        ] {
            assert!(frames[0].contains(before), "{before} in {}", frames[0]);
        }
        for after in [
            "after.png",
            "https://after.test/",
            "https://after.test/v.mp4",
            "Number(9)",
            "resize_mode: Contain",
            "fade_ms: Some(300.0)",
            "max_lines: 2",
            "selectable: Some(true)",
        ] {
            assert!(frames[1].contains(after), "{after} in {}", frames[1]);
        }
        for gone in ["before.png", "before.test"] {
            assert!(!frames[1].contains(gone), "{gone} in {}", frames[1]);
        }
    }

    #[test]
    fn a_status_bar_style_is_a_setting() {
        let setting = crate::StatusBarStyle::Light.into_reactive();
        assert_eq!(
            setting.get(),
            StatusBarSetting::default().foreground(crate::StatusBarStyle::Light)
        );
    }
}

/// Render functions (`Option<Renderer<T>>` props) and the app's classes on
/// a view's elements (`app_class`).
mod renders {
    use serde_json::json;

    use super::*;
    use crate::{
        Prop,
        ui::{AnyValue, Props, Registry, Rendered, Renderer, Root, dynamic, prelude::*},
    };

    /// Renders each item (`key:label`) with the app's function, keyed by
    /// its key; in one paragraph when `inline`.
    #[derive(Clone, PartialEq, Props)]
    struct ShelfProps {
        #[prop(default)]
        items: crate::ui::Prop<Vec<String>>,
        #[prop(default)]
        inline: bool,
        render_item: crate::ui::Prop<Option<Renderer<String>>>,
    }

    fn split(item: &str) -> (String, String) {
        let (key, label) = item.split_once(':').unwrap_or((item, item));
        (key.to_owned(), label.to_owned())
    }

    #[component]
    fn Shelf(props: ShelfProps) -> impl IntoElement {
        let rows = each(
            props.items,
            |item: &String| split(item).0,
            move |item, _| {
                // (A row's root is a node: an `Each` keeps rows by it.)
                view().child(dynamic(move || -> Option<Rendered> {
                    let (key, label) = split(&item.get());
                    props.render_item.get().map(|r| r.render(key, label))
                }))
            },
        );
        if props.inline {
            text("on the shelf: ").child(rows).into_element()
        } else {
            view().child(rows).into_element()
        }
    }

    fn core_with_shelf(inline: bool) -> Core<FakeEngine> {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Shelf>();
        c.set_components(registry);
        let mut ops = vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Component(std::any::type_name::<Shelf>().into()),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::RustProp(
                    "renderItem",
                    Some(AnyValue::new(Some(Renderer::<String>::__js_of(
                        "renderItem",
                        2,
                    )))),
                ),
            },
            items(&["a:Apple", "b:Banana"]),
        ];
        if inline {
            ops.push(Op::SetProp {
                id: 2,
                prop: rust_prop::<ShelfProps>("inline", Some(json!(true))),
            });
        }
        ops.push(Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        });
        apply(&mut c, ops);
        c
    }

    fn items(items: &[&str]) -> Op {
        Op::SetProp {
            id: 2,
            prop: rust_prop::<ShelfProps>("items", Some(json!(items))),
        }
    }

    /// What the core asked JS: `$render key value` / `$unrender key`.
    fn asked(c: &mut Core<FakeEngine>) -> Vec<String> {
        js_events(c)
            .into_iter()
            .filter_map(|(host, _, payload)| match payload {
                EventPayload::Native { name, data } if name.starts_with("$") => {
                    assert_eq!(host, 2);
                    assert_eq!(data["prop"], "renderItem");
                    let key = data["key"].as_str().unwrap().to_owned();
                    Some(match data.get("value") {
                        Some(v) => format!("{name} {key} {}", v.as_str().unwrap()),
                        None => format!("{name} {key}"),
                    })
                }
                _ => None,
            })
            .collect()
    }

    /// JS's answer to `$render key`: holder `holder` with a text of
    /// `label`, inserted into the host.
    fn holder(holder: NodeId, key: &str, label: &str) -> Vec<Op> {
        vec![
            Op::Create {
                id: holder,
                tag: Tag::View,
            },
            Op::SetProp {
                id: holder,
                prop: Prop::ComponentRender(format!("renderItem\u{1f}{key}").into()),
            },
            Op::Create {
                id: holder + 2,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: holder + 4,
                text: label.into(),
            },
            Op::Insert {
                parent: holder + 2,
                child: holder + 4,
                before: None,
            },
            Op::Insert {
                parent: holder,
                child: holder + 2,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: holder,
                before: None,
            },
        ]
    }

    fn parent_of(c: &Core<FakeEngine>, id: NodeId) -> Option<NodeId> {
        let key = c.key(id).ok()?;
        let parent = c.nodes[key as usize].parent;
        (parent != NO_KEY).then(|| c.nodes[parent as usize].id)
    }

    #[test]
    fn js_renders_each_key_once_per_value_and_releases_it() {
        let mut c = core_with_shelf(false);
        c.commit().unwrap();
        assert_eq!(asked(&mut c), ["$render a Apple", "$render b Banana"]);
        apply(&mut c, holder(10, "a", "Apple"));
        apply(&mut c, holder(20, "b", "Banana"));
        c.commit().unwrap();
        // Each holder is the only child of its placeholder, a view of the
        // core's in the component's view.
        let (a, b) = (parent_of(&c, 10).unwrap(), parent_of(&c, 20).unwrap());
        assert_eq!((a % 2, b % 2), (1, 1));
        assert_ne!(a, b);
        // In their rows.
        let row = |p| parent_of(&c, p).and_then(|r| parent_of(&c, r));
        assert_eq!(row(a), row(b));
        assert!(asked(&mut c).is_empty());
        // An equal value asks nothing; a new one asks again; the holder of
        // the new render replaces the old one.
        apply(&mut c, vec![items(&["a:Apple", "b:Banana"])]);
        let _ = c.commit();
        assert!(asked(&mut c).is_empty());
        apply(&mut c, vec![items(&["a:Avocado", "b:Banana"])]);
        let _ = c.commit();
        assert_eq!(asked(&mut c), ["$render a Avocado"]);
        apply(&mut c, holder(30, "a", "Avocado"));
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: 2,
                    child: 10,
                },
                Op::Release { id: 10 },
            ],
        );
        c.commit().unwrap();
        assert_eq!(parent_of(&c, 30), Some(a));
        // A key that leaves is released once.
        apply(&mut c, vec![items(&["b:Banana"])]);
        let _ = c.commit();
        assert_eq!(asked(&mut c), ["$unrender a"]);
        assert_eq!(parent_of(&c, 30), None, "out of the tree");
        assert!(c.key(a).is_err(), "the placeholder went");
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: 2,
                    child: 30,
                },
                Op::Release { id: 30 },
            ],
        );
        let _ = c.commit();
        assert!(asked(&mut c).is_empty());
        // Back: rendered again.
        apply(&mut c, vec![items(&["a:Apple", "b:Banana"])]);
        let _ = c.commit();
        assert_eq!(asked(&mut c), ["$render a Apple"]);
        // The host goes: nothing is left of its renders.
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 2,
                },
                Op::Release { id: 2 },
            ],
        );
        let _ = c.commit();
        assert!(c.components.renders.is_empty());
    }

    #[test]
    fn a_holder_coming_after_its_key_left_stays_out_of_the_tree() {
        let mut c = core_with_shelf(false);
        c.commit().unwrap();
        asked(&mut c);
        apply(&mut c, vec![items(&["b:Banana"])]);
        let _ = c.commit();
        assert_eq!(asked(&mut c), ["$unrender a"]);
        // JS answers the first ask after the core moved on.
        apply(&mut c, holder(10, "a", "Apple"));
        let _ = c.commit();
        assert_eq!(parent_of(&c, 10), None);
    }

    #[test]
    fn renders_in_a_paragraph_are_inline_views() {
        let mut c = core_with_shelf(true);
        c.commit().unwrap();
        assert_eq!(asked(&mut c), ["$render a Apple", "$render b Banana"]);
        apply(&mut c, holder(10, "a", "Apple"));
        let batch = c.commit().unwrap();
        let place = parent_of(&c, 10).unwrap();
        // The row is an inline view of the paragraph.
        let paragraph = parent_of(&c, parent_of(&c, place).unwrap()).unwrap();
        let key = c.key(paragraph).unwrap();
        assert_eq!(c.nodes[key as usize].kind, Kind::Text);
        // Laid out as an attachment of the paragraph: it has a frame.
        assert!(frame_of(&batch, place).is_some(), "{:?}", batch.items);
    }

    /// A Rust view passing a closure: rendered on the spot.
    #[derive(Clone, PartialEq, Props)]
    struct ShelvesProps {}

    #[component]
    fn Shelves(_props: ShelvesProps) -> impl IntoElement {
        shelf()
            .items(vec!["a:Apple".to_owned(), "b:Banana".to_owned()])
            .render_item(|label| text(format!("[{label}]")))
    }

    #[test]
    fn a_rust_renderer_renders_in_place() {
        let mut c = core();
        c.mount_root(&Root::new::<Shelves>(|| ShelvesProps {}));
        let batch = c.commit().unwrap();
        let texts: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Text { text, .. } => Some(text.text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["[Apple]", "[Banana]"]);
        assert!(js_events(&mut c).is_empty());
    }

    /// A view styling a part with the app's classes.
    #[derive(Clone, PartialEq, Props)]
    struct CardProps {
        #[prop(default)]
        heading_class: crate::ui::Prop<Option<SharedString>>,
    }

    #[component]
    fn Card(props: CardProps) -> impl IntoElement {
        view().child(
            view()
                .bg(crate::ui::palette::RED.shade(500))
                .border_2()
                .app_class(props.heading_class),
        )
    }

    fn core_with_card(class: &str) -> Core<FakeEngine> {
        let mut c = core();
        let mut registry = Registry::new();
        registry.register::<Card>();
        c.set_components(registry);
        apply(
            &mut c,
            vec![
                Op::Create {
                    id: 2,
                    tag: Tag::View,
                },
                Op::SetProp {
                    id: 2,
                    prop: Prop::Component(std::any::type_name::<Card>().into()),
                },
                card_class(class),
                Op::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        );
        c
    }

    fn card_class(class: &str) -> Op {
        Op::SetProp {
            id: 2,
            prop: rust_prop::<CardProps>("headingClass", Some(json!(class))),
        }
    }

    /// The heading's view: the host's only child.
    fn heading(c: &Core<FakeEngine>) -> NodeId {
        let key = c.key(2).unwrap();
        let child = c.nodes[key as usize].children[0];
        c.nodes[child as usize].id
    }

    #[test]
    fn the_apps_classes_go_after_an_elements_own_styles() {
        let mut c = core_with_card("bg-white dark:bg-black");
        let batch = c.commit().unwrap();
        let id = heading(&c);
        let style = view_style_of(&batch, id).unwrap();
        // The app's background wins; the view's own border stays.
        assert_eq!(style.background_color, Color(0xffff_ffff));
        assert_eq!(style.borders.widths.to_array().map(|w| w.0), [2.0; 4]);
        // Dark: the app's dark variant.
        c.set_class_environment(crate::tailwind::ClassEnvironment {
            dark: true,
            ..Default::default()
        });
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, id).unwrap().background_color,
            Color(0x0000_00ff)
        );
        // Another class from the app: applied again, on the same node.
        apply(&mut c, vec![card_class("bg-red-500 dark:bg-white")]);
        let batch = c.commit().unwrap();
        assert_eq!(heading(&c), id);
        assert_eq!(
            view_style_of(&batch, id).unwrap().background_color,
            Color(0xffff_ffff)
        );
        // None: the view's own.
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 2,
                prop: rust_prop::<CardProps>("headingClass", None),
            }],
        );
        let batch = c.commit().unwrap();
        assert_eq!(
            view_style_of(&batch, id).unwrap().background_color,
            Color::from(crate::ui::palette::RED.shade(500))
        );
    }
}

mod rust_selection_area {
    use std::cell::Cell;

    use super::*;
    use crate::ui::{Root, prelude::*};

    thread_local! {
        static AREA: Cell<Option<Signal<bool>>> = const { Cell::new(None) };
    }

    #[component]
    fn Area() -> impl IntoElement {
        let area = signal(true);
        AREA.set(Some(area));
        view()
            .child(
                view()
                    .selection_area(move || area.get())
                    .child(text("inside")),
            )
            .child(view().child(text("outside")))
    }

    /// `Element::selection_area` reaches the platform in the view's props,
    /// follows its signal, and views without it get no props for it.
    #[test]
    fn a_selection_area_is_a_view_prop() {
        let mut c = core();
        c.mount_root(&Root::of::<Area>());
        let batch = c.commit().unwrap();
        let areas: Vec<_> = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::ViewProps { id, props } if props.selection_area => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(areas.len(), 1, "{:?}", batch.items);
        assert!(
            !batch.items.iter().any(
                |item| matches!(item, MountItem::ViewProps { props, .. } if !props.selection_area)
            ),
            "views without the flag get no props: {:?}",
            batch.items
        );
        {
            let _entered = c.components.runtime.enter();
            AREA.get().unwrap().set(false);
        }
        let batch = c.commit().unwrap();
        assert!(batch.items.iter().any(
            |item| matches!(item, MountItem::ViewProps { id, props } if *id == areas[0] && !props.selection_area)
        ));
    }
}

/// Creates `id` of `tag` with `style`, in `parent`.
fn add(
    c: &mut Core<FakeEngine>,
    id: NodeId,
    tag: Tag,
    parent: NodeId,
    s: &[(&str, StyleValue<'_>)],
) {
    apply(
        c,
        vec![
            Op::Create { id, tag },
            style_op(id, s),
            Op::Insert {
                parent,
                child: id,
                before: None,
            },
        ],
    );
}

fn inserts(batch: &MountBatch) -> Vec<(NodeId, NodeId, Option<NodeId>)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Insert {
                parent,
                child,
                before,
            } => Some((*parent, *child, *before)),
            // This helper observes the core's first requested anchor. The
            // native consumers separately test which candidate is present.
            MountItem::ProjectRoot {
                parent,
                id,
                following,
            } => Some((*parent, *id, following.first().copied())),
            _ => None,
        })
        .collect()
}

fn overlay_prop(id: NodeId, prop: crate::OverlayProp) -> Op {
    Op::SetProp {
        id,
        prop: Prop::Overlay(prop),
    }
}

fn list_with_promoted_popups() -> (Core<FakeEngine>, Vec<NodeId>) {
    let mut c = core();
    add(
        &mut c,
        2,
        Tag::List,
        ROOT_ID,
        &[("height", StyleValue::Number(100.0))],
    );
    apply(
        &mut c,
        vec![
            Op::SetProp {
                id: 2,
                prop: Prop::Count(200),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(20.0)),
            },
        ],
    );
    c.commit();
    let mut next = 100;
    let mut cells = Vec::new();
    assert!(render_binds(&mut c, &mut next, &mut cells, 20.0) > 0);
    c.commit();
    add(&mut c, 700, Tag::Modal, cells[0], &[]);
    add(
        &mut c,
        701,
        Tag::Input,
        700,
        &[("height", StyleValue::Number(32.0))],
    );
    add(&mut c, 702, Tag::Overlay, 700, &[]);
    add(
        &mut c,
        703,
        Tag::View,
        702,
        &[
            ("width", StyleValue::Number(80.0)),
            ("height", StyleValue::Number(40.0)),
        ],
    );
    apply(
        &mut c,
        vec![overlay_prop(
            702,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Point(point(
                px(100.0),
                px(100.0),
            ))),
        )],
    );
    let mounted = c.commit().unwrap();
    assert!(
        inserts(&mounted)
            .iter()
            .any(|&(parent, child, _)| parent == 700 && child == 702),
        "the overlay must actually be hosted outside the cell: {:?}",
        inserts(&mounted)
    );
    (c, cells)
}

fn popup_retirement(batch: &MountBatch, cell: NodeId) -> (u64, Vec<NodeId>) {
    batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::RetireListCell {
                id, request, roots, ..
            } if *id == cell => Some((*request, roots.clone())),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no retirement for popup cell {cell}: {:?}", batch.items))
}

fn assert_popup_roots(mut actual: Vec<NodeId>, expected: &[NodeId]) {
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(actual, expected);
}

#[test]
fn list_retirement_keeps_logical_popup_focus_and_revokes_all_owned_roots() {
    let (mut c, cells) = list_with_promoted_popups();
    let cell = cells[0];

    // The native hierarchy starts at the promoted popup, so its focus
    // path contains neither the logical cell nor its list.
    for (path, offset) in [(&[701, 700][..], 800.0), (&[703, 702, 700][..], 1200.0)] {
        c.set_focus_path(path);
        c.set_scroll_offset(2, point(px(0.0), px(offset)), u32::MAX);
        if let Some(batch) = c.commit() {
            assert!(
                !batch.items.iter().any(|item| matches!(item,
                MountItem::RetireListCell { id, .. } if *id == cell)),
                "native popup focus must keep its logical row alive"
            );
        }
    }

    c.set_focus_path(&[ROOT_ID]);
    let pending = c.commit().unwrap();
    let (request, roots) = popup_retirement(&pending, cell);
    assert_popup_roots(roots, &[cell, 700, 702]);

    // Native can acquire focus after this request was queued. Reporting
    // the real popup path before its refusal cancels the whole request.
    c.set_focus_path(&[701, 700]);
    c.retire_list_cell(cell, request, false);
    let restored = c.commit().unwrap();
    for root in [cell, 700, 702] {
        assert!(
            inserts(&restored)
                .iter()
                .any(|&(_, child, _)| child == root),
            "cancelling retirement must reproject popup root {root}"
        );
    }
    c.retire_list_cell(cell, request, true);
    if let Some(late) = c.commit() {
        assert!(!late.items.iter().any(|item| matches!(item,
            MountItem::ListCellRetired { roots, .. } if roots.contains(&cell))));
    }

    // Removing the source is stronger than focus retention. Every native
    // root must lose the old row's lifetime, including the hosted overlay.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::Count(0),
    })
    .unwrap();
    let removed = c.commit().unwrap();
    for root in [cell, 700, 702] {
        assert!(
            removed.items.iter().any(|item| matches!(item,
            MountItem::Remove { id } if *id == root)),
            "source removal left popup root {root} attached"
        );
    }
}

#[test]
fn promoted_roots_cancel_queued_retirement_and_wait_for_the_cell_to_reappear() {
    let (mut c, cells) = list_with_promoted_popups();
    let cell = cells[0];
    c.set_scroll_offset(2, point(px(0.0), px(800.0)), u32::MAX);
    let (first, _) = popup_retirement(&c.commit().unwrap(), cell);

    // A newly opened popup belongs to this existing row. An older snapshot
    // must not authorize retiring the new root or its current owner.
    add(&mut c, 704, Tag::Modal, cell, &[]);
    add(
        &mut c,
        705,
        Tag::Input,
        704,
        &[("height", StyleValue::Number(32.0))],
    );
    c.set_focus_path(&[705, 704]);
    let inserted = c.commit().unwrap();
    for root in [cell, 700, 702, 704] {
        assert!(
            inserts(&inserted)
                .iter()
                .any(|&(_, child, _)| child == root),
            "new popup insertion must restore the whole current root group: {root}"
        );
    }
    c.retire_list_cell(cell, first, true);
    if let Some(late) = c.commit() {
        assert!(!late.items.iter().any(|item| matches!(item,
            MountItem::ListCellRetired { roots, .. } if roots.contains(&cell))));
    }

    c.set_focus_path(&[ROOT_ID]);
    let (current, roots) = popup_retirement(&c.commit().unwrap(), cell);
    assert_ne!(current, first);
    assert_popup_roots(roots, &[cell, 700, 702, 704]);
    c.retire_list_cell(cell, current, true);
    let acknowledged = c.commit().unwrap();
    let roots = acknowledged
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::ListCellRetired { roots, .. } if roots.contains(&cell) => {
                Some(roots.clone())
            }
            _ => None,
        })
        .expect("a confirmed retirement must detach the entire observed root group");
    assert_popup_roots(roots, &[cell, 700, 702, 704]);
    assert!(
        !acknowledged.items.iter().any(|item| matches!(item,
        MountItem::Remove { id } if [cell, 700, 702, 704].contains(id))),
        "a retirement receipt must not masquerade as source removal"
    );

    add(&mut c, 706, Tag::Modal, cell, &[]);
    if let Some(hidden) = c.commit() {
        assert!(
            !inserts(&hidden).iter().any(|&(_, child, _)| child == 706),
            "a popup cannot become an independent input root while its cell is retired"
        );
    }
    c.set_scroll_offset(2, point(px(0.0), px(0.0)), u32::MAX);
    // A free cell need not be chosen for the same row again. Grow the real
    // viewport so the parked cell is reused without assuming pool order.
    c.apply(style_op(2, &[("height", StyleValue::Number(400.0))]))
        .unwrap();
    let mut resumed = c.commit().unwrap();
    let mut next = 100 + cells.len() as u32;
    let mut cells = cells;
    render_binds(&mut c, &mut next, &mut cells, 20.0);
    if let Some(batch) = c.commit() {
        resumed.items.extend(batch.items);
    }
    for root in [cell, 700, 702, 704, 706] {
        assert!(
            inserts(&resumed).iter().any(|&(_, child, _)| child == root),
            "returning the row must reproject deferred popup root {root}"
        );
    }
}

#[test]
fn restored_overlay_keeps_order_candidates_for_another_retiring_cell() {
    let (mut c, cells) = list_with_promoted_popups();
    for (overlay, input, parent) in [
        (710, 711, cells[0]),
        (712, 713, cells[1]),
        (714, 715, ROOT_ID),
    ] {
        add(&mut c, overlay, Tag::Overlay, parent, &[]);
        add(
            &mut c,
            input,
            Tag::Input,
            overlay,
            &[
                ("width", StyleValue::Number(80.0)),
                ("height", StyleValue::Number(32.0)),
            ],
        );
        c.apply(overlay_prop(
            overlay,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Point(point(
                px(100.0),
                px(100.0),
            ))),
        ))
        .unwrap();
    }
    let mounted = c.commit().unwrap();
    for overlay in [710, 712, 714] {
        assert!(
            inserts(&mounted)
                .iter()
                .any(|&(parent, child, _)| parent == ROOT_ID && child == overlay)
        );
    }
    c.set_scroll_offset(2, point(px(0.0), px(800.0)), u32::MAX);
    let pending = c.commit().unwrap();
    let (request, _) = popup_retirement(&pending, cells[0]);
    let (_, other_roots) = popup_retirement(&pending, cells[1]);
    assert!(other_roots.contains(&712));

    // The other cell has not replied. Its overlay can still be present or
    // already parked. Core must preserve both possible anchors, not guess.
    c.set_focus_path(&[701, 700]);
    c.retire_list_cell(cells[0], request, false);
    let restored = c.commit().unwrap();
    let following = restored
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::ProjectRoot {
                parent: ROOT_ID,
                id: 710,
                following,
            } => Some(following),
            _ => None,
        })
        .expect("the restored overlay needs its actual ordered host candidates");
    let other = following
        .iter()
        .position(|&id| id == 712)
        .expect("an unacknowledged sibling must remain an anchor candidate");
    let visible = following
        .iter()
        .position(|&id| id == 714)
        .expect("the still-active following overlay is the next fallback");
    assert!(other < visible, "anchor order changed: {following:?}");
    assert!(!following.contains(&710));
}

#[test]
fn container_reinsertion_and_display_changes_restore_only_eligible_popup_roots() {
    let (mut c, cells) = list_with_promoted_popups();
    let cell = cells[0];
    add(&mut c, 720, Tag::View, cell, &[]);
    c.apply(Op::Insert {
        parent: 720,
        child: 700,
        before: None,
    })
    .unwrap();
    c.commit();
    c.apply(Op::Remove {
        parent: cell,
        child: 720,
    })
    .unwrap();
    let removed = c.commit().unwrap();
    for root in [700, 702] {
        assert!(removed.items.iter().any(|item| matches!(item,
            MountItem::Remove { id } if *id == root)));
    }
    c.apply(Op::Insert {
        parent: cell,
        child: 720,
        before: None,
    })
    .unwrap();
    let restored = c.commit().unwrap();
    for root in [700, 702] {
        assert!(inserts(&restored).iter().any(|&(_, id, _)| id == root));
    }

    c.apply(style_op(720, &[("display", StyleValue::Str("none"))]))
        .unwrap();
    c.commit();
    c.apply(style_op(720, &[("display", StyleValue::Str("flex"))]))
        .unwrap();
    let visible = c.commit().unwrap();
    for root in [700, 702] {
        assert!(inserts(&visible).iter().any(|&(_, id, _)| id == root));
        assert!(
            !visible.items.iter().any(|item| matches!(item,
            MountItem::Create { id, .. } if *id == root)),
            "unhiding must restore the existing popup, not recreate it"
        );
    }
    add(
        &mut c,
        723,
        Tag::View,
        cell,
        &[("display", StyleValue::Str("none"))],
    );
    add(&mut c, 724, Tag::Modal, 723, &[]);
    if let Some(hidden) = c.commit() {
        assert!(!inserts(&hidden).iter().any(|&(_, id, _)| id == 724));
    }
    c.apply(style_op(723, &[("display", StyleValue::Str("flex"))]))
        .unwrap();
    assert!(
        inserts(&c.commit().unwrap())
            .iter()
            .any(|&(_, id, _)| id == 724)
    );

    c.set_scroll_offset(2, point(px(0.0), px(800.0)), u32::MAX);
    let (request, _) = popup_retirement(&c.commit().unwrap(), cell);
    if let Some(quiet) = c.commit() {
        assert!(
            !inserts(&quiet)
                .iter()
                .any(|&(_, id, _)| [cell, 700, 702, 724].contains(&id)),
            "an unchanged commit must not cancel retirement by reprojecting popup roots"
        );
    }
    c.retire_list_cell(cell, request, true);
    let confirmed = c.commit().unwrap();
    assert!(
        confirmed.items.iter().any(|item| matches!(item,
        MountItem::ListCellRetired { roots, .. } if roots.contains(&cell))),
        "the same retirement request must remain valid across a quiet commit"
    );
}

#[test]
fn moving_containers_and_overlays_revoke_stale_retirement_snapshots() {
    for overlay in [false, true] {
        for detached in [false, true] {
            let (mut c, cells) = list_with_promoted_popups();
            add(
                &mut c,
                720,
                if overlay { Tag::Overlay } else { Tag::View },
                cells[0],
                &[],
            );
            if overlay {
                add(
                    &mut c,
                    722,
                    Tag::View,
                    720,
                    &[
                        ("width", StyleValue::Number(80.0)),
                        ("height", StyleValue::Number(40.0)),
                    ],
                );
                c.apply(overlay_prop(
                    720,
                    crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Point(point(
                        px(100.0),
                        px(100.0),
                    ))),
                ))
                .unwrap();
            }
            c.apply(Op::Insert {
                parent: 720,
                child: 700,
                before: None,
            })
            .unwrap();
            let mounted = c.commit().unwrap();
            assert!(inserts(&mounted).iter().any(|&(_, id, _)| id == 700));
            c.set_scroll_offset(2, point(px(0.0), px(800.0)), u32::MAX);
            let pending = c.commit().unwrap();
            let (old_source, _) = popup_retirement(&pending, cells[0]);
            let (old_target, _) = popup_retirement(&pending, cells[1]);
            if detached {
                c.retire_list_cell(cells[1], old_target, true);
                c.commit();
            }
            c.apply(Op::Insert {
                parent: cells[1],
                child: 720,
                before: None,
            })
            .unwrap();
            if !detached {
                c.set_focus_path(&[701, 700]);
            }
            let moved = c.commit().unwrap();
            for root in if overlay {
                vec![720, 700, 702]
            } else {
                vec![700, 702]
            } {
                if detached {
                    assert!(
                        moved.items.iter().any(|item| matches!(item,
                        MountItem::Remove { id } if *id == root)),
                        "active popup {root} moved into a detached cell must lose its old projection"
                    );
                    assert!(!inserts(&moved).iter().any(|&(_, id, _)| id == root));
                } else {
                    assert!(
                        inserts(&moved).iter().any(|&(_, id, _)| id == root),
                        "moving into a retiring cell must cancel and restore popup {root}"
                    );
                }
            }
            c.retire_list_cell(cells[0], old_source, true);
            c.retire_list_cell(cells[1], old_target, true);
            if let Some(late) = c.commit() {
                assert!(
                    !late.items.iter().any(|item| matches!(item,
                    MountItem::ListCellRetired { roots, .. }
                        if roots.contains(&cells[0]) || roots.contains(&cells[1]))),
                    "moving a popup must invalidate snapshots from its old and new ancestors"
                );
            }
        }
    }
}

#[test]
fn a_closed_hint_does_not_revive_its_modal_when_the_cell_returns() {
    let (mut c, cells) = list_with_promoted_popups();
    let cell = cells[0];
    add(&mut c, 720, Tag::Modal, 702, &[]);
    let mounted = c.commit().unwrap();
    assert!(inserts(&mounted).iter().any(|&(_, id, _)| id == 720));
    apply(
        &mut c,
        vec![
            overlay_prop(
                702,
                crate::OverlayProp::Hint(Some(std::time::Duration::ZERO)),
            ),
            overlay_prop(702, crate::OverlayProp::Open(Some(false))),
        ],
    );
    let closed = c.commit().unwrap();
    assert!(
        closed
            .items
            .iter()
            .any(|item| matches!(item, MountItem::Remove { id: 702 })),
        "the hint must actually lose its native host before checking its descendant"
    );
    assert!(
        closed
            .items
            .iter()
            .any(|item| matches!(item, MountItem::Remove { id: 720 })),
        "losing the overlay's host must also revoke its independent modal"
    );
    c.set_scroll_offset(2, point(px(0.0), px(800.0)), u32::MAX);
    let (request, roots) = popup_retirement(&c.commit().unwrap(), cell);
    // The dormant modal still has an allocated SDK resource lifetime.
    // Retire it too; restoring it separately requires a visible ancestor.
    assert_popup_roots(roots, &[cell, 700, 720]);
    c.set_scroll_offset(2, point(px(0.0), px(0.0)), u32::MAX);
    let returned = c.commit().unwrap();
    assert!(
        !inserts(&returned)
            .iter()
            .any(|&(_, id, _)| [702, 720].contains(&id)),
        "returning the cell cannot make an unhosted popup independently interactive"
    );
    c.retire_list_cell(cell, request, true);
    if let Some(late) = c.commit() {
        assert!(!late.items.iter().any(|item| matches!(item,
            MountItem::ListCellRetired { roots, .. } if roots.contains(&cell))));
    }
    c.apply(overlay_prop(702, crate::OverlayProp::Open(Some(true))))
        .unwrap();
    let opened = c.commit().unwrap();
    for root in [702, 720] {
        assert!(
            inserts(&opened).iter().any(|&(_, id, _)| id == root),
            "a genuinely hosted overlay must restore its existing descendant root {root}"
        );
    }
}

#[test]
fn popup_focus_return_preserves_logical_parents_across_native_overlay_relocation() {
    let mut c = core();
    add(&mut c, 2, Tag::Overlay, ROOT_ID, &[]);
    add(&mut c, 4, Tag::View, 2, &[]);
    add(&mut c, 6, Tag::Overlay, 4, &[]);
    add(&mut c, 8, Tag::Overlay, ROOT_ID, &[]);
    add(&mut c, 10, Tag::Modal, ROOT_ID, &[]);
    add(&mut c, 12, Tag::Overlay, 10, &[]);
    apply(
        &mut c,
        vec![
            overlay_prop(2, crate::OverlayProp::FocusReturn(true)),
            overlay_prop(6, crate::OverlayProp::FocusReturn(true)),
            overlay_prop(12, crate::OverlayProp::FocusReturn(true)),
        ],
    );
    let batch = c.commit().unwrap();
    let parents = batch
        .items
        .iter()
        .filter_map(|item| match item {
            MountItem::ViewProps { id, props } => {
                props.focus_return_parent.map(|parent| (*id, parent))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(parents.contains(&(2, ROOT_ID)), "{parents:?}");
    assert!(parents.contains(&(6, 2)), "{parents:?}");
    assert!(parents.contains(&(12, 10)), "{parents:?}");
    assert!(inserts(&batch).contains(&(ROOT_ID, 6, None)));
    assert!(!parents.iter().any(|(id, _)| *id == 8));

    apply(
        &mut c,
        vec![overlay_prop(2, crate::OverlayProp::FocusReturn(false))],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::ViewProps { id: 2, props } if props.focus_return_parent.is_none())));
    assert!(batch.items.iter().any(|item| matches!(item,
        MountItem::ViewProps { id: 6, props } if props.focus_return_parent == Some(ROOT_ID))));
}

#[test]
fn fixed_views_are_laid_out_in_their_root_view() {
    let mut c = core();
    // A padded box below another; a `fixed` bar inside it.
    view_with_classes(&mut c, 2, "h-[100px]");
    view_with_classes(&mut c, 3, "p-[20px] h-[200px]");
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            class_op(4, "fixed inset-x-0 bottom-0 h-[40px]"),
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Create {
                id: 5,
                tag: Tag::View,
            },
            class_op(5, "h-[10px]"),
            Op::Insert {
                parent: 3,
                child: 5,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // Against the surface (320 x 480), in the root view's native view,
    // out of its parent's layout (5 is the first in flow).
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 440.0, 320.0, 40.0)));
    let ins = inserts(&batch);
    assert!(ins.contains(&(ROOT_ID, 4, None)), "{ins:?}");
    assert!(!ins.iter().any(|&(p, c, _)| p == 3 && c == 4), "{ins:?}");
    assert_eq!(frame_of(&batch, 5), Some(rect(20.0, 20.0, 280.0, 10.0)));
    // No longer fixed: back in its parent, laid out there.
    c.apply(class_op(4, "absolute inset-x-0 bottom-0 h-[40px]"))
        .unwrap();
    let batch = c.commit().unwrap();
    let ins = inserts(&batch);
    assert!(ins.contains(&(3, 4, Some(5))), "{ins:?}");
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 160.0, 320.0, 40.0)));
    // And fixed again.
    c.apply(class_op(4, "fixed inset-x-0 bottom-0 h-[40px]"))
        .unwrap();
    let batch = c.commit().unwrap();
    assert!(inserts(&batch).contains(&(ROOT_ID, 4, None)));
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 440.0, 320.0, 40.0)));
}

#[test]
fn perspective_gives_children_depth_from_the_center() {
    use crate::transform::TransformKind as T;
    let mut c = core();
    view_with_classes(&mut c, 2, "perspective-[400px] w-[200px] h-[200px]");
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "size-[100px] rotate-y-45"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            class_op(4, "size-[100px] rotate-12"),
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let steps = |batch: &MountBatch, id| {
        view_style_of(batch, id).map(|v| {
            v.transform
                .ops()
                .iter()
                .map(|op| (op.kind, op.value))
                .collect::<Vec<_>>()
        })
    };
    // 3's center is 50 left of and 50 above the parent's: the perspective
    // is seen from the parent's center, before 3's own rotation.
    assert_eq!(
        steps(&batch, 3).unwrap(),
        [
            (T::TranslateX, 50.0),
            (T::TranslateY, 50.0),
            (T::Perspective, 400.0),
            (T::TranslateX, -50.0),
            (T::TranslateY, -50.0),
            (T::RotateY, 45.0),
        ]
    );
    // A view that stays in its plane is as it was.
    assert_eq!(steps(&batch, 4).unwrap(), [(T::Rotate, 12.0)]);
    // The parent's own transform does not get it.
    assert_eq!(
        view_style_of(&batch, 2).map(|v| v.transform.ops().len()),
        None
    );
    // Without it, the children's own transforms.
    c.apply(class_op(2, "w-[200px] h-[200px]")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(steps(&batch, 3).unwrap(), [(T::RotateY, 45.0)]);
}

/// Each character half its font size wide, one line: lengths in `ch`.
struct SizedEngine;

impl TextEngine for SizedEngine {
    type Prepared = f32;

    fn prepare(&self, text: &AttributedText) -> f32 {
        text.spans
            .iter()
            .map(|s| (s.end - s.start) as f32 * s.style.font_size.0 / 2.0)
            .sum()
    }

    fn measure(&self, w: &f32, _: Option<Points>) -> Size<Points> {
        size_pt(*w, 16.0)
    }

    fn layout(&self, _: &f32, _: Size<Points>) -> TextLayout {
        TextLayout(Arc::new(()))
    }
}

#[test]
fn prose_is_65ch_of_the_font() {
    let mut c = Core::new(SizedEngine, size_pt(2000.0, 480.0));
    // Built from the inside out, as JSX does: the font is in place when
    // the commit comes.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            class_op(3, "max-w-prose w-full h-[10px]"),
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            class_op(4, "max-w-prose w-full h-[10px] text-[10px]"),
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            class_op(2, "text-[20px]"),
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    let width = |batch: &MountBatch, id| frame_of(batch, id).map(|f| f.size.width.0);
    // 65 times the `0` of the font: the inherited 20pt one's (10pt), its
    // own 10pt one's (5pt).
    assert_eq!(width(&batch, 3), Some(650.0));
    assert_eq!(width(&batch, 4), Some(325.0));
    // The font around it changes: so does `ch`.
    c.apply(class_op(2, "text-[16px]")).unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(width(&batch, 3), Some(520.0));
}

#[test]
fn static_views_ignore_their_insets() {
    let mut c = core();
    view_with_classes(&mut c, 2, "relative top-4 left-2 size-[10px] static");
    view_with_classes(&mut c, 3, "static top-4 size-[10px]");
    view_with_classes(&mut c, 4, "static md:relative top-4 size-[10px]");
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 2), Some(rect(0.0, 0.0, 10.0, 10.0)));
    assert_eq!(frame_of(&batch, 3), Some(rect(0.0, 10.0, 10.0, 10.0)));
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 20.0, 10.0, 10.0)));
    c.set_viewport(size_pt(800.0, 480.0));
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 36.0, 10.0, 10.0)));
}

#[test]
fn overlays_show_in_their_root_view_above_its_children() {
    use StyleValue::Number;
    let mut c = core();
    // A clipping box with an overlay deep inside.
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[
            ("height", Number(100.0)),
            ("overflow", StyleValue::Str("hidden")),
        ],
    );
    add(&mut c, 4, Tag::View, 2, &[("padding", Number(5.0))]);
    add(
        &mut c,
        6,
        Tag::Overlay,
        4,
        &[("left", Number(10.0)), ("top", Number(300.0))],
    );
    add(
        &mut c,
        8,
        Tag::View,
        6,
        &[("width", Number(50.0)), ("height", Number(20.0))],
    );
    let batch = c.commit().unwrap();
    let creates = batch.items.iter().find_map(|i| match i {
        MountItem::Create { id: 6, kind } => Some(*kind),
        _ => None,
    });
    assert_eq!(creates, Some(ViewKind::View));
    let ins = inserts(&batch);
    assert!(ins.contains(&(ROOT_ID, 6, None)), "{ins:?}");
    assert!(!ins.iter().any(|&(p, c, _)| p == 4 && c == 6));
    assert!(ins.contains(&(6, 8, None)));
    // `position: fixed` in the root view, out of its parent's layout.
    assert_eq!(frame_of(&batch, 6), Some(rect(10.0, 300.0, 50.0, 20.0)));
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 0.0, 320.0, 10.0)));
    // Measured in the root view.
    let m = c.measure(8).unwrap();
    assert_eq!(m.page, point(px(10.0), px(300.0)));

    // The root view's children go below the overlays.
    add(&mut c, 10, Tag::View, ROOT_ID, &[("height", Number(10.0))]);
    let batch = c.commit().unwrap();
    assert_eq!(inserts(&batch), vec![(ROOT_ID, 10, Some(6))]);

    // Out of the tree: out of the root view; back in: on top.
    add(&mut c, 12, Tag::Overlay, ROOT_ID, &[]);
    c.commit().unwrap();
    apply(
        &mut c,
        vec![Op::Remove {
            parent: ROOT_ID,
            child: 2,
        }],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id: 6 }))
    );
    apply(
        &mut c,
        vec![Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: Some(10),
        }],
    );
    let batch = c.commit().unwrap();
    let ins = inserts(&batch);
    assert!(ins.contains(&(ROOT_ID, 2, Some(10))), "{ins:?}");
    assert!(ins.contains(&(ROOT_ID, 6, None)), "{ins:?}");
    assert_eq!(c.overlays.last().map(|&k| c.nodes[k as usize].id), Some(6));
    // Released with its parent's subtree.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: ROOT_ID,
                child: 2,
            },
            Op::Release { id: 6 },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Delete { id: 6 }))
    );
    assert_eq!(c.overlays.len(), 1);
    // `display: none` around it hides it.
    add(&mut c, 14, Tag::View, ROOT_ID, &[]);
    add(&mut c, 16, Tag::Overlay, 14, &[]);
    c.commit().unwrap();
    apply(
        &mut c,
        vec![style_op(14, &[("display", StyleValue::Str("none"))])],
    );
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id: 16 }))
    );
}

#[test]
fn anchored_overlays_go_beside_their_anchor_and_follow_it() {
    use StyleValue::Number;
    let mut c = core();
    add(
        &mut c,
        2,
        Tag::Scroll,
        ROOT_ID,
        &[("height", Number(480.0))],
    );
    add(&mut c, 4, Tag::View, 2, &[("height", Number(100.0))]);
    add(
        &mut c,
        6,
        Tag::View,
        2,
        &[
            ("width", Number(80.0)),
            ("height", Number(40.0)),
            ("marginLeft", Number(20.0)),
        ],
    );
    add(&mut c, 8, Tag::View, 2, &[("height", Number(1000.0))]);
    add(&mut c, 10, Tag::Overlay, 6, &[]);
    add(
        &mut c,
        12,
        Tag::View,
        10,
        &[("width", Number(120.0)), ("height", Number(60.0))],
    );
    apply(
        &mut c,
        vec![
            overlay_prop(
                10,
                crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Node(6)),
            ),
            overlay_prop(10, crate::OverlayProp::Align(crate::overlay::Align::Start)),
            overlay_prop(10, crate::OverlayProp::Offset(px(4.0))),
            Op::Listen {
                id: 10,
                event: EventKind::Position,
                enabled: true,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10), Some(rect(20.0, 144.0, 120.0, 60.0)));
    let events = js_events(&mut c);
    assert!(events.iter().any(|(id, kind, payload)| *id == 10
        && *kind == EventKind::Position
        && matches!(payload, EventPayload::Map(m) if m.contains(&("placement", PayloadValue::Str("bottom".into()))))));

    // The scroll view scrolled: it follows.
    c.set_scroll_offset(2, point(px(0.0), px(30.0)), 0);
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10), Some(rect(20.0, 114.0, 120.0, 60.0)));
    // Near the bottom of the screen it goes above.
    c.set_scroll_offset(2, point(px(0.0), px(-300.0)), 0);
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10), Some(rect(20.0, 336.0, 120.0, 60.0)));
    let events = js_events(&mut c);
    assert!(events.iter().any(|(_, kind, payload)| *kind == EventKind::Position
        && matches!(payload, EventPayload::Map(m) if m.contains(&("placement", PayloadValue::Str("top".into()))))));

    // Kept inside the safe area less the margin.
    c.set_scroll_offset(2, point(px(0.0), px(0.0)), 0);
    c.set_safe_area(EdgeInsets {
        left: px(30.0),
        ..EdgeInsets::default()
    });
    apply(
        &mut c,
        vec![overlay_prop(10, crate::OverlayProp::Margin(px(8.0)))],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10).map(|f| f.origin.x), Some(px(38.0)));

    // A point anchor.
    apply(
        &mut c,
        vec![overlay_prop(
            10,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Point(point(
                px(200.0),
                px(50.0),
            ))),
        )],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10), Some(rect(192.0, 54.0, 120.0, 60.0)));

    // A box anchor (an input's caret): below its bottom.
    apply(
        &mut c,
        vec![overlay_prop(
            10,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Bounds(rect(
                200.0, 50.0, 1.0, 20.0,
            ))),
        )],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 10), Some(rect(192.0, 74.0, 120.0, 60.0)));
}

#[test]
fn a_caret_is_located_in_the_root_view() {
    use StyleValue::Number;
    let mut c = core();
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[("paddingTop", Number(30.0)), ("paddingLeft", Number(12.0))],
    );
    add(
        &mut c,
        4,
        Tag::Input,
        2,
        &[("width", Number(200.0)), ("height", Number(40.0))],
    );
    c.commit().unwrap();
    let mut payload = EventPayload::caret(rect(25.0, 10.0, 1.0, 18.0));
    c.locate_caret(4, &mut payload);
    let EventPayload::Map(fields) = &payload else {
        panic!("a map");
    };
    assert!(fields.contains(&("bounds", PayloadValue::Bounds(rect(25.0, 10.0, 1.0, 18.0)))));
    assert!(fields.contains(&(
        "pageBounds",
        PayloadValue::Bounds(rect(37.0, 40.0, 1.0, 18.0))
    )));

    // A caret the platform could not place: empty, where the input is.
    let mut payload = EventPayload::None;
    c.locate_caret(4, &mut payload);
    let EventPayload::Map(fields) = &payload else {
        panic!("a map");
    };
    assert!(fields.contains(&("bounds", PayloadValue::Bounds(Bounds::default()))));
    assert!(fields.contains(&(
        "pageBounds",
        PayloadValue::Bounds(rect(12.0, 30.0, 0.0, 0.0))
    )));
}

fn touch_down(path: Vec<NodeId>) -> EventPayload {
    EventPayload::Touch(Box::new(crate::TouchEvent {
        phase: crate::TouchPhase::Start,
        timestamp: 0.0,
        points: vec![crate::TouchPoint {
            id: 1,
            target: path[0],
            path,
            page: point(px(5.0), px(6.0)),
            location: point(px(5.0), px(6.0)),
            changed: true,
        }],
        activated: None,
    }))
}

#[test]
fn overlays_hear_presses_outside_and_cancel_from_the_top() {
    use StyleValue::Number;
    let mut c = core();
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    add(&mut c, 4, Tag::Overlay, 2, &[]);
    add(&mut c, 6, Tag::Overlay, 4, &[]);
    apply(
        &mut c,
        vec![
            overlay_prop(
                4,
                crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Node(2)),
            ),
            Op::Listen {
                id: 4,
                event: EventKind::PressOutside,
                enabled: true,
            },
            Op::Listen {
                id: 4,
                event: EventKind::Cancel,
                enabled: true,
            },
            Op::Listen {
                id: 6,
                event: EventKind::Cancel,
                enabled: true,
            },
        ],
    );
    let batch = c.commit().unwrap();
    // The overlays, the anchor and the root listen to touches.
    for id in [ROOT_ID, 2, 4, 6] {
        let events = batch.items.iter().find_map(|i| match i {
            MountItem::Events { id: i, events } if *i == id => Some(*events),
            _ => None,
        });
        assert!(events.is_some_and(|e| e.contains(EventKind::Touch)), "{id}");
        assert!(
            events.is_some_and(|e| e.contains_listener(EventKind::Touch)),
            "{id}"
        );
    }
    // Escape is bound, back listened to.
    let keymap = batch.items.iter().find_map(|i| match i {
        MountItem::Keymap(k) => Some(k.clone()),
        _ => None,
    });
    assert!(keymap.is_some_and(|k| k.bindings().iter().any(|b| b.id == overlay::ESCAPE_BINDING)));
    js_events(&mut c);

    for (path, outside) in [
        (vec![ROOT_ID], true),
        (vec![2, ROOT_ID], false),
        (vec![4, ROOT_ID], false),
        (vec![6, ROOT_ID], false),
    ] {
        c.component_event(ROOT_ID, EventKind::Touch, &touch_down(path.clone()));
        let events = js_events(&mut c);
        let pressed = events
            .iter()
            .any(|(id, kind, _)| *id == 4 && *kind == EventKind::PressOutside);
        assert_eq!(pressed, outside, "{path:?}");
    }

    // The top one listening hears Escape and back.
    c.component_event(
        ROOT_ID,
        EventKind::KeyCommand,
        &EventPayload::Value(PayloadValue::Number(overlay::ESCAPE_BINDING as f64)),
    );
    c.commit();
    let events = js_events(&mut c);
    assert!(
        events.contains(&(6, EventKind::Cancel, EventPayload::None)),
        "{events:?}"
    );
    assert!(!events.iter().any(|(id, ..)| *id == 4));
    apply(
        &mut c,
        vec![Op::Listen {
            id: 6,
            event: EventKind::Cancel,
            enabled: false,
        }],
    );
    c.commit();
    assert!(c.component_event(ROOT_ID, EventKind::BackPress, &EventPayload::None));
    c.commit();
    let events = js_events(&mut c);
    assert!(
        events.contains(&(4, EventKind::Cancel, EventPayload::None)),
        "{events:?}"
    );

    // Closed: nothing is listened to any more.
    apply(
        &mut c,
        vec![Op::Remove {
            parent: 2,
            child: 4,
        }],
    );
    let batch = c.commit().unwrap();
    let root_events = batch.items.iter().find_map(|i| match i {
        MountItem::Events {
            id: ROOT_ID,
            events,
        } => Some(*events),
        _ => None,
    });
    assert!(root_events.is_some_and(|e| !e.contains(EventKind::Touch)));
}

#[test]
fn nested_overlays_report_outside_presses_from_the_native_touch_path() {
    let mut c = core();
    c.set_environment(crate::ui::Environment {
        os: crate::platform::Os::Linux,
        idiom: crate::platform::Idiom::Desktop,
        ..crate::ui::Environment::default()
    });
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[("height", StyleValue::Number(40.0))],
    );
    add(&mut c, 4, Tag::Overlay, 2, &[]);
    add(&mut c, 6, Tag::Overlay, 4, &[]);
    apply(
        &mut c,
        vec![
            overlay_prop(
                4,
                crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Node(2)),
            ),
            Op::Listen {
                id: 4,
                event: EventKind::PressOutside,
                enabled: true,
            },
            Op::Listen {
                id: 6,
                event: EventKind::PressOutside,
                enabled: true,
            },
        ],
    );
    c.commit();
    js_events(&mut c);
    // A press in the parent popup is outside only the nested one.
    for (path, expected) in [
        (vec![4, ROOT_ID], vec![6]),
        (vec![6, ROOT_ID], vec![]),
        (vec![ROOT_ID], vec![4, 6]),
    ] {
        c.component_event(ROOT_ID, EventKind::Touch, &touch_down(path));
        let outside: Vec<_> = js_events(&mut c)
            .into_iter()
            .filter_map(|(id, kind, _)| (kind == EventKind::PressOutside).then_some(id))
            .collect();
        assert_eq!(outside, expected);
    }

    // Native overlays remain root siblings after their logical parent moves.
    add(&mut c, 10, Tag::View, ROOT_ID, &[]);
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: ROOT_ID,
                child: 2,
            },
            Op::Insert {
                parent: 10,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    js_events(&mut c);
    c.component_event(ROOT_ID, EventKind::Touch, &touch_down(vec![4, ROOT_ID]));
    let outside: Vec<_> = js_events(&mut c)
        .into_iter()
        .filter_map(|(id, kind, _)| (kind == EventKind::PressOutside).then_some(id))
        .collect();
    assert_eq!(outside, [6]);
}

#[test]
fn overlays_in_a_modal_show_in_it() {
    use StyleValue::Number;
    let mut c = core();
    add(&mut c, 2, Tag::Modal, ROOT_ID, &[]);
    add(&mut c, 4, Tag::View, 2, &[("height", Number(40.0))]);
    add(
        &mut c,
        6,
        Tag::Overlay,
        4,
        &[("right", Number(0.0)), ("bottom", Number(0.0))],
    );
    add(
        &mut c,
        8,
        Tag::View,
        6,
        &[("width", Number(10.0)), ("height", Number(10.0))],
    );
    c.set_root_size(2, size_pt(200.0, 300.0), EdgeInsets::default());
    let batch = c.commit().unwrap();
    assert!(inserts(&batch).contains(&(2, 6, None)));
    assert_eq!(frame_of(&batch, 6), Some(rect(190.0, 290.0, 10.0, 10.0)));
}

#[test]
fn overlays_anchored_to_content_go_by_what_the_wrapper_draws() {
    use StyleValue::Number;
    let mut c = core();
    // A wrapper the root stretches, around an 80 × 30 trigger.
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[("paddingTop", Number(50.0))],
    );
    add(&mut c, 4, Tag::View, 2, &[]);
    add(
        &mut c,
        6,
        Tag::View,
        4,
        &[
            ("width", Number(80.0)),
            ("height", Number(30.0)),
            ("alignSelf", StyleValue::Str("flex-start")),
        ],
    );
    add(&mut c, 8, Tag::Overlay, 2, &[]);
    add(
        &mut c,
        10,
        Tag::View,
        8,
        &[("width", Number(40.0)), ("height", Number(20.0))],
    );
    apply(
        &mut c,
        vec![overlay_prop(
            8,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Content(4)),
        )],
    );
    let batch = c.commit().unwrap();
    // Centered below the trigger (0, 50, 80 × 30), not the 320-wide wrapper.
    assert_eq!(frame_of(&batch, 8), Some(rect(20.0, 80.0, 40.0, 20.0)));
    // Against the wrapper itself: centered on its width.
    apply(
        &mut c,
        vec![overlay_prop(
            8,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Node(4)),
        )],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 8), Some(rect(140.0, 80.0, 40.0, 20.0)));
}

/// The texts a batch lays out.
fn texts_of(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

/// Whether the batch mounts `id` listening to `kind`.
fn mounts_listening(batch: &MountBatch, id: NodeId, kind: EventKind) -> Option<bool> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::Events { id: i, events } if *i == id => Some(events.contains(kind)),
        _ => None,
    })
}

fn hint_watch(c: &Core<FakeEngine>, id: NodeId) -> crate::overlay::HintWatchToken {
    c.overlay_state
        .hinting
        .iter()
        .find(|watch| watch.key == c.key(id).unwrap())
        .and_then(|watch| watch.token)
        .expect("the mounted callback-free hint watch")
}

#[test]
fn tooltips_show_after_the_pointer_rests_and_hide_when_it_leaves_or_presses() {
    use StyleValue::Number;
    let clock = crate::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let _clock = clock.enter();
    let mut c = core();
    c.set_environment(crate::ui::Environment {
        os: crate::platform::Os::Linux,
        idiom: crate::platform::Idiom::Desktop,
        ..crate::ui::Environment::default()
    });
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[
            ("marginTop", Number(100.0)),
            ("width", Number(80.0)),
            ("height", Number(40.0)),
        ],
    );
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::Text("Saves it".into())),
        }],
    );
    let batch = c.commit().unwrap();
    // The element follows the pointer; the tooltip waits out of the view.
    assert_eq!(mounts_listening(&batch, 2, EventKind::HoverIn), Some(true));
    let event_mask = |batch: &MountBatch| {
        batch
            .items
            .iter()
            .rev()
            .find_map(|item| match item {
                MountItem::Events { id: 2, events } => Some(*events),
                _ => None,
            })
            .expect("the tooltip anchor's mounted events")
    };
    let passive = event_mask(&batch);
    let hint = c.overlay_state.tooltips[&2].overlay;
    for kind in [EventKind::Show, EventKind::Dismiss] {
        // The anchor must remount when a custom hint gains callbacks, although
        // its aggregate Touch/Hover event set stays unchanged.
        apply(
            &mut c,
            vec![Op::Listen {
                id: hint,
                event: kind,
                enabled: true,
            }],
        );
        let callbacks = event_mask(&c.commit().unwrap());
        assert_eq!(callbacks.bits(), passive.bits());
        for event in [EventKind::Touch, EventKind::HoverIn, EventKind::HoverOut] {
            assert!(callbacks.contains_listener(event));
        }
        apply(
            &mut c,
            vec![Op::Listen {
                id: hint,
                event: kind,
                enabled: false,
            }],
        );
        let restored = event_mask(&c.commit().unwrap());
        assert_eq!(restored.bits(), passive.bits());
        assert!(restored.hint_watch().is_some());
        assert!(!restored.contains_listener(EventKind::Touch));
    }
    // A second hint may gain its callback before it acquires this anchor.
    // Its addition and removal must still update the existing watch's route.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::Overlay,
            },
            overlay_prop(
                4,
                crate::OverlayProp::Hint(Some(crate::overlay::HINT_DELAY)),
            ),
            Op::Listen {
                id: 4,
                event: EventKind::Dismiss,
                enabled: true,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
        ],
    );
    assert!(event_mask(&c.commit().unwrap()).contains_listener(EventKind::Touch));
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: 2,
                child: 4,
            },
            Op::Release { id: 4 },
        ],
    );
    let restored = event_mask(&c.commit().unwrap());
    assert_eq!(restored.bits(), passive.bits());
    assert!(restored.hint_watch().is_some());
    assert!(!restored.contains_listener(EventKind::Touch));
    assert_ne!(restored.hint_watch(), passive.hint_watch());
    assert!(((passive | restored) | restored).hint_watch().is_none());
    assert!((passive | (restored | restored)).hint_watch().is_none());
    assert!(texts_of(&batch).is_empty(), "{:?}", texts_of(&batch));

    c.observe_hint(crate::overlay::HintObservation::Enter(hint_watch(&c, 2)));
    c.run_component_tasks();
    assert!(c.commit().is_none());
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(499));
    c.run_component_tasks();
    assert!(c.commit().is_none());
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(1));
    c.run_component_tasks();
    let batch = c.commit().unwrap();
    assert_eq!(texts_of(&batch), ["Saves it"]);
    // In the root view, above the element.
    let overlay = inserts(&batch)
        .into_iter()
        .find(|&(p, ..)| p == ROOT_ID)
        .map(|(_, child, _)| child)
        .expect("the tooltip's overlay in the root view");
    let frame = frame_of(&batch, overlay).unwrap();
    assert_eq!(frame.bottom(), px(96.0));
    // A bubble of the theme's `popover` tokens.
    let style = batch.items.iter().find_map(|i| match i {
        MountItem::ViewStyle { id, style } if *id == overlay => Some(style.clone()),
        _ => None,
    });
    assert!(
        style.is_some_and(|s| s.background_color != Color::default() && s.border_radius.0 > 0.0)
    );
    let overlay_key = c.key(overlay).unwrap();
    let text_id = batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Text { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    let text_key = c.key(text_id).unwrap();
    let text_layout = c.nodes[text_key as usize].layout.unwrap();
    let raw_key = c.nodes[text_key as usize].children[0];
    let raw_id = c.nodes[raw_key as usize].id;

    // Leaving hides it.
    c.component_event(2, EventKind::HoverOut, &EventPayload::None);
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == overlay))
    );

    // A press hides it too, until the pointer comes again.
    c.component_event(2, EventKind::HoverIn, &EventPayload::None);
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    assert!(c.commit().is_some());
    c.observe_hint(crate::overlay::HintObservation::Press(vec![hint_watch(
        &c, 2,
    )]));
    let batch = c.commit().unwrap();
    assert!(
        batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Remove { id } if *id == overlay))
    );
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(1000));
    c.run_component_tasks();
    assert!(c.commit().is_none());

    // Reopening retains the native text and its style: the batch inserts the
    // original bubble instead of sending its unchanged text a second time.
    let assert_shown = |c: &Core<FakeEngine>, batch: &MountBatch| {
        assert_eq!(c.overlay_state.tooltips[&2].overlay, overlay);
        assert_eq!(c.key(overlay).unwrap(), overlay_key);
        assert!(inserts(batch).contains(&(ROOT_ID, overlay, None)));
        assert!(!batch.items.iter().any(
            |item| matches!(item, MountItem::Delete { id } if *id == overlay || *id == text_id)
        ));
        let state = c.overlay(overlay_key).unwrap();
        assert_eq!(state.host, Some(ROOT_ID));
        assert!(state.placed.is_some());
        let bubble = &c.nodes[overlay_key as usize];
        assert!(bubble.created);
        assert!(bubble.frame.size.width > px(0.0) && bubble.frame.size.height > px(0.0));
        assert_eq!(bubble.children, [text_key]);
        let text = &c.nodes[text_key as usize];
        assert_eq!(text.id, text_id);
        assert_eq!(text.kind, Kind::Text);
        assert!(text.created);
        assert_eq!(text.layout, Some(text_layout));
        assert_eq!(text.parent, overlay_key);
        assert_eq!(text.children, [raw_key]);
        let raw = &c.nodes[raw_key as usize];
        assert_eq!(raw.id, raw_id);
        assert_eq!(raw.kind, Kind::RawText);
        assert_eq!(raw.parent, text_key);
        assert_eq!(raw.text, "Saves it");
    };
    for (id, kind) in [
        (2, EventKind::Touch),
        (2, EventKind::HoverIn),
        (2, EventKind::HoverOut),
        (ROOT_ID, EventKind::HoverIn),
    ] {
        assert!(passive.contains(kind));
        assert!(!passive.contains_listener(kind));
        // A native watch never erases an actual listener of the same event,
        // including one on an ancestor in the anchor's input scope.
        apply(
            &mut c,
            vec![Op::Listen {
                id,
                event: kind,
                enabled: true,
            }],
        );
        let active = event_mask(&c.commit().unwrap());
        assert!(active.contains_listener(kind));
        assert!(active.contains_listener(EventKind::HoverIn));
        assert!(active.hint_watch().is_none());
        // The ordinary callback-capable path still displays the same native
        // text tooltip; producer and consumer use the same passivity rule.
        c.component_event(2, EventKind::HoverIn, &EventPayload::None);
        clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
        c.run_component_tasks();
        let shown = c.commit().unwrap();
        assert_shown(&c, &shown);
        c.component_event(2, EventKind::HoverOut, &EventPayload::None);
        let hidden = c.commit().unwrap();
        assert!(
            hidden
                .items
                .iter()
                .any(|item| matches!(item, MountItem::Remove { id } if *id == overlay))
        );
        assert_eq!(c.overlay(overlay_key).unwrap().host, None);
        apply(
            &mut c,
            vec![Op::Listen {
                id,
                event: kind,
                enabled: false,
            }],
        );
        let restored = event_mask(&c.commit().unwrap());
        assert_eq!(restored.bits(), passive.bits());
        assert!(!restored.contains_listener(kind));
        assert!(restored.hint_watch().is_some());
    }

    // No tooltip: the element no longer follows the pointer.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::None),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(mounts_listening(&batch, 2, EventKind::HoverIn), Some(false));
}

#[test]
fn observed_hints_never_gain_callbacks_from_new_subscriptions_or_a_pending_timer() {
    use StyleValue::Number;

    use crate::overlay::HintObservation::{Enter, Leave, Press};
    let clock = crate::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let _clock = clock.enter();
    let mut c = core();
    c.set_environment(crate::ui::Environment {
        os: crate::platform::Os::Linux,
        idiom: crate::platform::Idiom::Desktop,
        ..Default::default()
    });
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::Text("Native hint".into())),
        }],
    );
    c.commit().unwrap();
    let hint = c.overlay_state.tooltips[&2].overlay;
    let hint_key = c.key(hint).unwrap();
    let watch = hint_watch(&c, 2);
    let listen = |id, event, enabled| Op::Listen { id, event, enabled };

    // These changes have not reached a platform mount. The FIFO observation
    // must inspect current Core ownership and never become an ordinary event.
    apply(&mut c, vec![listen(2, EventKind::HoverIn, true)]);
    c.observe_hint(Enter(watch));
    assert!(c.overlay(hint_key).unwrap().waiting.is_none());
    assert!(js_events(&mut c).is_empty());
    apply(
        &mut c,
        vec![
            listen(2, EventKind::HoverIn, false),
            listen(hint, EventKind::Show, true),
        ],
    );
    c.observe_hint(Enter(watch));
    assert!(c.overlay(hint_key).unwrap().waiting.is_none());
    assert!(js_events(&mut c).is_empty());

    // An initially passive timer cannot invoke a Show listener added before
    // its deadline, even without another commit between subscription and due.
    apply(&mut c, vec![listen(hint, EventKind::Show, false)]);
    c.observe_hint(Enter(watch));
    assert!(c.overlay(hint_key).unwrap().waiting.is_some());
    apply(&mut c, vec![listen(hint, EventKind::Show, true)]);
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    assert!(c.overlay(hint_key).unwrap().hinted.is_none());
    assert!(js_events(&mut c).is_empty());

    apply(&mut c, vec![listen(hint, EventKind::Show, false)]);
    c.commit();
    c.observe_hint(Enter(hint_watch(&c, 2)));
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    let shown = c.commit().expect("the native hint becomes visible");
    assert_eq!(texts_of(&shown), ["Native hint"]);
    assert!(js_events(&mut c).is_empty());

    // A displayed passive hint also keeps its origin. New Touch/Dismiss
    // subscriptions cannot make an old press or leave enter application code.
    apply(
        &mut c,
        vec![
            listen(2, EventKind::Touch, true),
            listen(hint, EventKind::Dismiss, true),
        ],
    );
    c.observe_hint(Press(vec![watch]));
    c.observe_hint(Leave(watch));
    let hidden = c.commit().expect("the old native hint is removed");
    assert!(
        hidden
            .items
            .iter()
            .any(|item| matches!(item, MountItem::Remove { id } if *id == hint))
    );
    assert!(js_events(&mut c).is_empty());

    // Ordinary callback-capable hints still receive their existing events.
    c.component_event(2, EventKind::HoverIn, &EventPayload::None);
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    c.commit();
    c.component_event(2, EventKind::HoverOut, &EventPayload::None);
    assert_eq!(
        js_events(&mut c),
        [(hint, EventKind::Dismiss, EventPayload::None)]
    );
}

#[test]
fn observed_hints_keep_their_original_anchor_and_hint_lifetimes() {
    use StyleValue::Number;

    use crate::overlay::HintObservation::{Enter, Leave};
    let clock = crate::time::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    let _clock = clock.enter();
    let mut c = core();
    c.set_environment(crate::ui::Environment {
        os: crate::platform::Os::Linux,
        idiom: crate::platform::Idiom::Desktop,
        ..Default::default()
    });
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    add(&mut c, 6, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    add(&mut c, 4, Tag::Overlay, 2, &[]);
    apply(
        &mut c,
        vec![overlay_prop(
            4,
            crate::OverlayProp::Hint(Some(crate::overlay::HINT_DELAY)),
        )],
    );
    c.commit().unwrap();
    let original = hint_watch(&c, 2);
    apply(&mut c, vec![style_op(6, &[("height", Number(41.0))])]);
    c.commit().unwrap();
    assert_eq!(
        hint_watch(&c, 2),
        original,
        "unrelated rendering keeps the watch"
    );
    c.observe_hint(Enter(original));
    let key = c.key(4).unwrap();
    assert!(c.overlay(key).unwrap().waiting.is_some());

    // Reanchoring before the timer fires cannot move the old hover to the
    // new anchor, even before any mount reaches the platform.
    apply(
        &mut c,
        vec![overlay_prop(
            4,
            crate::OverlayProp::Anchor(crate::overlay::OverlayAnchor::Node(6)),
        )],
    );
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    assert!(c.overlay(key).unwrap().hinted.is_none());
    c.commit().unwrap();
    let reanchored = hint_watch(&c, 6);
    assert_ne!(original, reanchored);
    c.observe_hint(Enter(original));
    assert!(c.overlay(key).unwrap().waiting.is_none());
    c.observe_hint(Enter(reanchored));
    assert!(c.overlay(key).unwrap().waiting.is_some());

    // Reusing the hint's public NodeId is a different generational layout
    // owner. An old observation must not start that replacement's timer.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: 2,
                child: 4,
            },
            Op::Release { id: 4 },
        ],
    );
    add(&mut c, 4, Tag::Overlay, 6, &[]);
    apply(
        &mut c,
        vec![overlay_prop(
            4,
            crate::OverlayProp::Hint(Some(crate::overlay::HINT_DELAY)),
        )],
    );
    let replacement_key = c.key(4).unwrap();
    c.observe_hint(Enter(reanchored));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_none());
    c.commit().unwrap();
    let replacement = hint_watch(&c, 6);
    assert_ne!(replacement, reanchored);
    c.observe_hint(Enter(replacement));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_some());

    // Detached hints are not observable before the next commit either.
    apply(
        &mut c,
        vec![Op::Remove {
            parent: 6,
            child: 4,
        }],
    );
    c.observe_hint(Enter(replacement));
    clock.advance_to(crate::time::now() + std::time::Duration::from_millis(500));
    c.run_component_tasks();
    assert!(c.overlay(replacement_key).unwrap().hinted.is_none());
    c.commit();

    // The anchor's NodeId can also be reused. Its new layout lifetime must
    // not inherit the observation token published for the original node.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: ROOT_ID,
                child: 6,
            },
            Op::Release { id: 6 },
        ],
    );
    add(&mut c, 6, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    apply(
        &mut c,
        vec![Op::Insert {
            parent: 6,
            child: 4,
            before: None,
        }],
    );
    c.observe_hint(Enter(replacement));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_none());
    c.commit().unwrap();
    let new_anchor = hint_watch(&c, 6);
    assert_ne!(replacement, new_anchor);
    c.observe_hint(Enter(new_anchor));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_some());
    c.observe_hint(Leave(new_anchor));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_none());
    // Reuse while the original watch is still cached, before any new mount.
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: 6,
                child: 4,
            },
            Op::Remove {
                parent: ROOT_ID,
                child: 6,
            },
            Op::Release { id: 6 },
        ],
    );
    add(&mut c, 6, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    apply(
        &mut c,
        vec![Op::Insert {
            parent: 6,
            child: 4,
            before: None,
        }],
    );
    c.observe_hint(Enter(new_anchor));
    assert!(c.overlay(replacement_key).unwrap().waiting.is_none());
    c.commit().unwrap();
    assert_ne!(hint_watch(&c, 6), new_anchor);
    assert!(js_events(&mut c).is_empty());
}

#[test]
fn tooltips_wait_for_nothing_on_touch_screens() {
    use StyleValue::Number;
    let mut c = core();
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::Text("Saves it".into())),
        }],
    );
    let batch = c.commit().unwrap();
    assert_eq!(mounts_listening(&batch, 2, EventKind::HoverIn), None);
}

#[test]
fn a_tooltip_element_is_shown_as_it_is() {
    use StyleValue::Number;
    let mut c = core();
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    add(&mut c, 4, Tag::Text, ROOT_ID, &[]);
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: ROOT_ID,
                child: 4,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Tooltip(crate::overlay::TooltipContent::Node(4)),
            },
            // Shown whatever the pointer does.
            Op::SetProp {
                id: 2,
                prop: Prop::Tooltip(crate::overlay::TooltipContent::Node(4)),
            },
        ],
    );
    c.commit();
    let key = c.key(4).unwrap();
    let overlay = c.nodes[key as usize].parent;
    assert_eq!(c.nodes[overlay as usize].kind, Kind::Overlay);
    assert_eq!(c.nodes[c.nodes[overlay as usize].parent as usize].id, 2);
    // A text in place of the element: it leaves (still JS's).
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::Text("Hi".into())),
        }],
    );
    c.commit();
    assert_eq!(c.nodes[c.key(4).unwrap() as usize].parent, NO_KEY);
    // Released with the element.
    let made = c.overlay_state.tooltips[&2];
    apply(
        &mut c,
        vec![
            Op::Remove {
                parent: ROOT_ID,
                child: 2,
            },
            Op::Release { id: 2 },
        ],
    );
    c.commit();
    assert!(c.overlay_state.tooltips.is_empty());
    assert!(c.key(made.overlay).is_err());
}

#[test]
fn a_tooltip_element_that_is_a_hint_overlay_is_the_tooltip_itself() {
    use StyleValue::Number;
    let mut c = core();
    add(&mut c, 2, Tag::View, ROOT_ID, &[("height", Number(40.0))]);
    // As `nsh-base`'s `Tooltip` makes it: a hint overlay, out of the tree.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::Overlay,
            },
            overlay_prop(
                4,
                crate::OverlayProp::Hint(Some(std::time::Duration::from_millis(300))),
            ),
            Op::SetProp {
                id: 2,
                prop: Prop::Tooltip(crate::overlay::TooltipContent::Node(4)),
            },
        ],
    );
    let wrapper = c.overlay_state.tooltips[&2].overlay;
    c.commit();
    let made = c.overlay_state.tooltips[&2];
    assert_eq!(made.overlay, 4);
    assert!(c.key(wrapper).is_err(), "the core's own overlay is gone");
    let key = c.key(4).unwrap();
    assert_eq!(c.nodes[c.nodes[key as usize].parent as usize].id, 2);
    // Another tooltip: it leaves the element, still JS's.
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 2,
            prop: Prop::Tooltip(crate::overlay::TooltipContent::Text("Hi".into())),
        }],
    );
    c.commit();
    assert_eq!(c.nodes[c.key(4).unwrap() as usize].parent, NO_KEY);
    assert_ne!(c.overlay_state.tooltips[&2].overlay, 4);
}

#[test]
fn native_focus_hints_keep_passive_input_routes_and_the_original_overlay() {
    use crate::{OverlayProp, PointerEvents, tailwind::state::FOCUSED};
    let mut c = core();
    c.set_environment(crate::ui::Environment {
        os: crate::platform::Os::Linux,
        idiom: crate::platform::Idiom::Desktop,
        ..Default::default()
    });
    add(
        &mut c,
        2,
        Tag::View,
        ROOT_ID,
        &[("height", StyleValue::Number(40.0))],
    );
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::Overlay,
            },
            overlay_prop(4, OverlayProp::Hint(Some(std::time::Duration::ZERO))),
            overlay_prop(4, OverlayProp::HintOnFocus(true)),
            overlay_prop(4, OverlayProp::Placement(crate::overlay::Placement::Left)),
            Op::SetProp {
                id: 4,
                prop: Prop::PointerEvents(PointerEvents::None),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Tooltip(crate::overlay::TooltipContent::Node(4)),
            },
        ],
    );
    add(
        &mut c,
        6,
        Tag::View,
        4,
        &[
            ("width", StyleValue::Number(80.0)),
            ("height", StyleValue::Number(20.0)),
        ],
    );
    let mounted = c.commit().unwrap();
    assert_eq!(c.overlay_state.tooltips[&2].overlay, 4);
    let events = mounted
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Events { id: 2, events } => Some(*events),
            _ => None,
        })
        .unwrap();
    assert!(events.hint_watch().is_some());
    for kind in [
        EventKind::Touch,
        EventKind::HoverIn,
        EventKind::HoverOut,
        EventKind::Focus,
    ] {
        assert!(!events.contains_listener(kind));
    }
    let hint = c.key(4).unwrap();
    assert_eq!(c.overlay(hint).unwrap().host, None);
    c.set_states(2, FOCUSED);
    let focused = c.commit().unwrap();
    assert!(inserts(&focused).contains(&(ROOT_ID, 4, None)));
    assert_eq!(c.overlay(hint).unwrap().host, Some(ROOT_ID));
    c.set_states(2, 0);
    let blurred = c.commit().unwrap();
    assert!(
        blurred
            .items
            .iter()
            .any(|item| matches!(item, MountItem::Remove { id: 4 }))
    );
    assert_eq!(c.overlay(hint).unwrap().host, None);
    assert_eq!(c.overlay_state.tooltips[&2].overlay, 4);
}

/// An image node `id` showing `source` (and `placeholder`), in the root.
fn image_ops(id: NodeId, source: ImageSource, placeholder: Option<ImageSource>) -> Vec<Op> {
    let mut ops = vec![
        Op::Create {
            id,
            tag: Tag::Image,
        },
        Op::SetProp {
            id,
            prop: Prop::Source(Some(source)),
        },
    ];
    if placeholder.is_some() {
        ops.push(Op::SetProp {
            id,
            prop: Prop::Image(ImageProp::Placeholder(placeholder)),
        });
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: id,
        before: None,
    });
    ops
}

fn asset(uri: &str, scales: &[f32]) -> ImageSource {
    ImageSource {
        uri: uri.into(),
        size: Some(crate::geometry::size_pt(40.0, 30.0)),
        scales: scales.iter().copied().collect(),
        data: None,
    }
}

/// The source and placeholder URIs of `id`'s last image item.
fn image_uris(batch: &MountBatch, id: NodeId) -> Option<(Option<String>, Option<String>)> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::Image {
            id: i,
            source,
            options,
            ..
        } if *i == id => Some((
            source.as_ref().map(|s| s.uri.to_string()),
            options.placeholder.as_ref().map(|s| s.uri.to_string()),
        )),
        _ => None,
    })
}

fn at_ratio(c: &mut Core<FakeEngine>, pixel_ratio: f32) {
    c.set_environment(crate::ui::Environment {
        pixel_ratio,
        ..Default::default()
    });
}

#[test]
fn image_scales_pick_the_smallest_at_least_the_ratio_else_the_largest() {
    let set: ImageScales = [1.0, 2.0, 3.0].into_iter().collect();
    let picks: Vec<_> = [1.0, 1.5, 2.0, 2.625, 3.0, 3.5]
        .into_iter()
        .map(|r| set.pick(r))
        .collect();
    assert_eq!(
        picks,
        [
            Some(1.0),
            Some(2.0),
            Some(2.0),
            Some(3.0),
            Some(3.0),
            Some(3.0)
        ]
    );
    let set = |values: [f32; 2]| values.into_iter().collect::<ImageScales>();
    assert_eq!(set([1.0, 1.5]).pick(1.2), Some(1.5));
    assert_eq!(set([2.0, 4.0]).pick(1.0), Some(2.0));
    assert_eq!(ImageScales::NONE.pick(2.0), None);
    assert_eq!(
        IMAGE_SCALES
            .into_iter()
            .collect::<ImageScales>()
            .iter()
            .collect::<Vec<_>>(),
        IMAGE_SCALES
    );
}

#[test]
fn image_scales_name_the_variants_and_keep_the_1x_file() {
    let a = asset("asset:/img/a.png", &[1.0, 1.5, 2.0, 3.0, 4.0]);
    let uris: Vec<_> = [1.0, 1.5, 2.0, 3.0, 4.0]
        .into_iter()
        .map(|r| a.uri_for(r).to_string())
        .collect();
    assert_eq!(
        uris,
        [
            "asset:/img/a.png",
            "asset:/img/a@1.5x.png",
            "asset:/img/a@2x.png",
            "asset:/img/a@3x.png",
            "asset:/img/a@4x.png"
        ]
    );
    // The 1x file is the URI itself, not a copy.
    assert!(std::sync::Arc::ptr_eq(&a.uri_for(1.0), &a.uri));
    assert_eq!(
        &*asset("asset:/x.y/b", &[1.0, 2.0]).uri_for(2.0),
        "asset:/x.y/b@2x"
    );
    assert_eq!(
        &*asset("asset:/.hidden", &[1.0, 2.0]).uri_for(2.0),
        "asset:/.hidden@2x"
    );
    assert_eq!(
        &*asset("asset:/c.d.webp", &[3.0]).uri_for(1.0),
        "asset:/c.d@3x.webp"
    );
}

#[test]
fn image_scales_leave_remote_and_file_uris_alone() {
    for uri in [
        "https://x.org/a.png",
        "http://x.org/a.png",
        "/tmp/a.png",
        "file:///a.png",
    ] {
        let source = asset(uri, &[1.0, 2.0, 3.0]);
        assert!(
            std::sync::Arc::ptr_eq(&source.uri_for(3.0), &source.uri),
            "{uri}"
        );
    }
}

/// A query or a fragment is no part of a bundled file's name: such an
/// asset URI loads as it is, at every ratio.
#[test]
fn image_scales_leave_uris_with_a_query_or_a_fragment_alone() {
    for uri in [
        "asset:/a.png?v=2",
        "asset:/a.png#frame",
        "asset:/dir?x=1/a.png",
        "asset:/a#b.png",
    ] {
        let source = asset(uri, &[1.0, 2.0, 3.0]);
        for ratio in [1.0, 2.0, 3.0] {
            assert!(
                std::sync::Arc::ptr_eq(&source.uri_for(ratio), &source.uri),
                "{uri} at {ratio}"
            );
        }
        let mut c = core();
        at_ratio(&mut c, 3.0);
        apply(&mut c, image_ops(2, source, None));
        let batch = c.commit().unwrap();
        assert_eq!(image_uris(&batch, 2), Some((Some(uri.into()), None)));
    }
}

#[test]
fn image_scales_drop_invalid_values() {
    let set: ImageScales = [f32::NAN, -2.0, 0.0, 2.5, 5.0, f32::INFINITY, 2.0]
        .into_iter()
        .collect();
    assert_eq!(set.iter().collect::<Vec<_>>(), [2.0]);
    assert!(
        [f32::NAN, -1.0]
            .into_iter()
            .collect::<ImageScales>()
            .is_empty()
    );
}

/// The JS shapes, through the host decoding (a JSON stand-in for JS
/// values).
#[test]
fn image_scales_decode_from_js() {
    use crate::js::host::{HostCx, HostInput, HostList, HostValue};

    struct J(serde_json::Value);
    struct L(Vec<serde_json::Value>);
    impl HostList for L {
        type Item = J;
        fn len(&self) -> usize {
            self.0.len()
        }
        fn item(&self, i: usize) -> Option<J> {
            self.0.get(i).cloned().map(J)
        }
    }
    impl HostInput for J {
        type List = L;
        fn is_nullish(&self) -> bool {
            self.0.is_null()
        }
        fn is_object(&self) -> bool {
            self.0.is_object() || self.0.is_array()
        }
        fn as_bool(&self) -> Option<bool> {
            self.0.as_bool()
        }
        fn as_number(&self) -> Option<f64> {
            self.0.as_f64()
        }
        fn as_string(&self) -> Option<String> {
            self.0.as_str().map(str::to_owned)
        }
        fn field(&self, key: &str) -> Option<J> {
            self.0.get(key).cloned().map(J)
        }
        fn as_list(&self) -> Option<L> {
            self.0.as_array().cloned().map(L)
        }
        fn entries(&self) -> Vec<(String, J)> {
            Vec::new()
        }
        fn truthy(&self) -> bool {
            !self.0.is_null()
        }
    }
    let decode = |v: serde_json::Value| ImageSource::decode(&J(v), &mut HostCx::default());

    let source = decode(serde_json::json!({
        "url": "asset:/a.png", "size": { "width": 40, "height": 30 }, "scales": [1, 2, "3", -1, 2.5, 3]
    }))
    .unwrap();
    assert_eq!(source.size, Some(crate::geometry::size_pt(40.0, 30.0)));
    assert_eq!(source.scales.iter().collect::<Vec<_>>(), [1.0, 2.0, 3.0]);
    let plain =
        decode(serde_json::json!({ "url": "asset:/a.png", "size": { "width": 40, "height": 30 } }));
    assert_eq!(plain.unwrap().scales, ImageScales::NONE);
    assert_eq!(
        decode(serde_json::json!("https://x.org/a.png"))
            .unwrap()
            .scales,
        ImageScales::NONE
    );
    let odd = decode(serde_json::json!({ "url": "asset:/a.png", "scales": "2" })).unwrap();
    assert!(odd.scales.is_empty());
    // Only the first entries are read.
    let long = decode(serde_json::json!({
        "url": "asset:/a.png", "scales": [1, 1, 1, 1, 1, 1, 1, 1, 2]
    }));
    assert_eq!(long.unwrap().scales.iter().collect::<Vec<_>>(), [1.0]);
}

#[test]
fn image_scales_mount_the_variant_for_the_pixel_ratio() {
    for (ratio, file) in [
        (1.0, "a.png"),
        (2.0, "a@2x.png"),
        (2.625, "a@3x.png"),
        (3.0, "a@3x.png"),
    ] {
        let mut c = core();
        at_ratio(&mut c, ratio);
        let mut ops = image_ops(
            2,
            asset("asset:/a.png", &[1.0, 2.0, 3.0]),
            Some(asset("asset:/p.png", &[1.0, 2.0])),
        );
        ops.extend(image_ops(3, asset("asset:/a.png", &[1.0, 2.0, 3.0]), None));
        ops.push(style_op(3, &[("alignSelf", StyleValue::Str("flex-start"))]));
        apply(&mut c, ops);
        let batch = c.commit().unwrap();
        let placeholder = if ratio > 1.0 { "p@2x.png" } else { "p.png" };
        assert_eq!(
            image_uris(&batch, 2),
            Some((
                Some(format!("asset:/{file}")),
                Some(format!("asset:/{placeholder}"))
            )),
            "at {ratio}"
        );
        // The size in points does not depend on the variant.
        assert_eq!(
            frame_of(&batch, 3).map(|f| f.size),
            Some(crate::geometry::size_pt(40.0, 30.0)),
            "at {ratio}"
        );
    }
}

#[test]
fn image_scales_change_nothing_without_scales() {
    let mut c = core();
    at_ratio(&mut c, 3.0);
    let plain = asset("asset:/a.png", &[]);
    apply(
        &mut c,
        image_ops(2, plain.clone(), Some(asset("asset:/a@3x.png", &[]))),
    );
    let batch = c.commit().unwrap();
    let source = batch.items.iter().find_map(|i| match i {
        MountItem::Image { id: 2, source, .. } => source.clone(),
        _ => None,
    });
    assert_eq!(source, Some(plain));
    assert_eq!(
        image_uris(&batch, 2),
        Some((Some("asset:/a.png".into()), Some("asset:/a@3x.png".into())))
    );
    // A ratio change sends nothing for them.
    at_ratio(&mut c, 2.0);
    let batch = c.commit();
    assert!(
        batch.is_none_or(|b| !b.items.iter().any(|i| matches!(i, MountItem::Image { .. }))),
        "nothing for images without scales"
    );
}

/// Rust components: an `asset!` image with variants (`ImageAsset::scales`)
/// is picked as an imported one.
mod asset_variants {
    use super::*;
    use crate::ui::{ImageAsset, prelude::*};

    const FLAG: ImageAsset = ImageAsset {
        url: "asset:/@demo/flag.png",
        size: crate::geometry::size_pt(17.0, 12.0),
        scales: &[1.0, 2.0, 3.0],
    };
    const PLAIN: ImageAsset = ImageAsset {
        url: "asset:/@demo/plain.png",
        size: crate::geometry::size_pt(10.0, 10.0),
        scales: &[],
    };

    #[component]
    fn Flags() -> impl IntoElement {
        view()
            .child(image(FLAG))
            .child(image(PLAIN).placeholder(FLAG))
    }

    /// The image items' source and placeholder URIs, in mount order.
    fn shown(pixel_ratio: f32) -> Vec<(Option<String>, Option<String>)> {
        let mut c = core();
        at_ratio(&mut c, pixel_ratio);
        c.mount_root(&crate::ui::Root::new::<Flags>(|| ()));
        let batch = c.commit().unwrap();
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Image { id, .. } => image_uris(&batch, *id),
                _ => None,
            })
            .collect()
    }

    fn some(uri: &str) -> Option<String> {
        Some(uri.to_owned())
    }

    #[test]
    fn asset_variants_pick_for_the_pixel_ratio() {
        assert_eq!(
            shown(3.0),
            [
                (some("asset:/@demo/flag@3x.png"), None),
                (
                    some("asset:/@demo/plain.png"),
                    some("asset:/@demo/flag@3x.png")
                )
            ]
        );
        assert_eq!(
            shown(2.0),
            [
                (some("asset:/@demo/flag@2x.png"), None),
                (
                    some("asset:/@demo/plain.png"),
                    some("asset:/@demo/flag@2x.png")
                )
            ]
        );
    }

    #[test]
    fn asset_variants_none_keep_the_file() {
        assert_eq!(
            shown(1.0),
            [
                (some("asset:/@demo/flag.png"), None),
                (
                    some("asset:/@demo/plain.png"),
                    some("asset:/@demo/flag.png")
                )
            ]
        );
        let src: crate::ui::ImageSrc = PLAIN.into();
        assert!(src.scales.is_empty());
        let src: crate::ui::ImageSrc = FLAG.into();
        assert_eq!(src.scales.iter().collect::<Vec<_>>(), [1.0, 2.0, 3.0]);
        assert_eq!(src.size, Some((17.0, 12.0)));
    }
}

mod rust_lazy_context {
    use super::*;
    use crate::ui::{Root, prelude::*};

    #[derive(Clone, PartialEq, Props)]
    struct ProviderProps {
        #[prop(lazy)]
        children: Children,
    }

    #[component]
    fn Provider(props: ProviderProps) -> impl IntoElement {
        provide_context("provided");
        let open = signal(false);
        view()
            .on_press(move || open.set(true))
            .child(when(open, move || props.children))
    }

    #[component]
    fn Consumer() -> impl IntoElement {
        text(use_context::<&'static str>().unwrap_or("missing"))
    }

    #[component]
    fn App() -> impl IntoElement {
        provider().child(consumer())
    }

    #[test]
    fn rust_lazy_children_inherit_the_context_where_they_are_placed() {
        let mut c = core();
        c.mount_root(&Root::of::<App>());
        let batch = c.commit().unwrap();
        let trigger = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Events { id, events } if events.contains(EventKind::Press) => Some(*id),
                _ => None,
            })
            .unwrap();
        c.component_event(trigger, EventKind::Press, &EventPayload::None);
        let batch = c.commit().unwrap();
        let texts: Vec<_> = batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Text { text, .. } => Some(text.text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["provided"]);
    }
}

/// The tokens' `font-sans` is the font text is drawn with unless it sets
/// its own, as a page's `--font-sans` is in Tailwind; a new one lays the
/// text out again.
#[test]
fn text_takes_the_tokens_sans_font() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 3,
                text: "hello".into(),
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let text = text_item(&c.commit().unwrap()).unwrap();
    assert_eq!(text.spans[0].style.font_family, None);
    let mut tokens = crate::ui::tokens::sample();
    tokens.set_font(crate::ui::FONT_SANS, "Inter");
    c.set_tokens(tokens);
    let text = text_item(&c.commit().unwrap()).unwrap();
    assert_eq!(
        text.spans[0].style.font_family,
        Some(crate::style::FontFamily::new("Inter"))
    );
}

/// A page: scroll view 2 (400 tall) holding a header (view 3, `header`
/// tall) and, for each of `lists`, a list in its parent's viewport (ids 4,
/// 5, …) of that many rows estimated at 50, then a footer (view 9, 10
/// tall).
fn page(c: &mut Core<FakeEngine>, header: f32, lists: &[u32]) {
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        style_op(2, &[("height", StyleValue::Number(400.0))]),
        Op::Create {
            id: 3,
            tag: Tag::View,
        },
        style_op(3, &[("height", StyleValue::Number(header))]),
        Op::Insert {
            parent: 2,
            child: 3,
            before: None,
        },
    ];
    for (i, &count) in lists.iter().enumerate() {
        let id = 4 + i as u32;
        ops.extend([
            Op::Create { id, tag: Tag::List },
            Op::SetProp {
                id,
                prop: Prop::ListViewport(crate::ListViewport::Parent),
            },
            Op::SetProp {
                id,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id,
                prop: Prop::Count(count),
            },
            Op::Insert {
                parent: 2,
                child: id,
                before: None,
            },
        ]);
    }
    ops.extend([
        Op::Create {
            id: 9,
            tag: Tag::View,
        },
        style_op(9, &[("height", StyleValue::Number(10.0))]),
        Op::Insert {
            parent: 2,
            child: 9,
            before: None,
        },
        Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        },
    ]);
    apply(c, ops);
}

/// The items list `id` has bound, in order.
fn bound_items(c: &Core<FakeEngine>, id: NodeId) -> Vec<u32> {
    let list = c.nodes[c.key(id).unwrap() as usize].list.as_ref().unwrap();
    let mut items: Vec<u32> = list.slots.iter().filter_map(|s| s.index).collect();
    items.sort_unstable();
    items
}

fn scroll_content(batch: &MountBatch, id: NodeId) -> Option<f32> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::ScrollContent { id: i, size } if *i == id => Some(size.height.0),
        _ => None,
    })
}

#[test]
fn a_list_below_a_header_renders_the_rows_in_the_pages_viewport() {
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    let batch = c.commit().unwrap();
    // A plain view that clips its cells, at its full length in the page:
    // the page's content covers it, in the same batch.
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Create {
            id: 4,
            kind: ViewKind::View
        }
    )));
    assert!(!batch.items.iter().any(|i| matches!(
        i,
        MountItem::ScrollConfig { id: 4, .. } | MountItem::ScrollContent { id: 4, .. }
    )));
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::ViewStyle { id: 4, style } if style.overflow_hidden
    )));
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 100.0, 320.0, 5000.0)));
    assert_eq!(frame_of(&batch, 9), Some(rect(0.0, 5100.0, 320.0, 10.0)));
    assert_eq!(scroll_content(&batch, 2), Some(5110.0));
    // The rows from the list's start to the viewport's end and a screen
    // more: 0 to 700 of the list.
    assert_eq!(bound_items(&c, 4), (0..=14).collect::<Vec<_>>());
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = c.commit().unwrap();
    assert_eq!(
        frame_of(&batch, cells[3]),
        Some(rect(0.0, 150.0, 320.0, 50.0))
    );

    // The page scrolls: the list's rows follow, 1900 into it.
    c.set_scroll_offset(2, point(px(0.0), px(2000.0)), 0);
    commit_with_native_retirement(&mut c);
    assert_eq!(bound_items(&c, 4), (30..=54).collect::<Vec<_>>());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = c.commit().unwrap();
    let cell = cells[bound_slot(&c, 4, 40) as usize];
    assert_eq!(frame_of(&batch, cell), Some(rect(0.0, 2000.0, 320.0, 50.0)));
}

#[test]
fn a_page_lists_spare_cells_are_hidden_when_its_rows_change() {
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    let mut batches = Vec::new();
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    batches.extend(c.commit());
    // Far down the page, then other rows and back to the top, as an app
    // switching what the page shows does.
    c.set_scroll_offset(2, point(px(0.0), px(4000.0)), 0);
    batches.extend(c.commit());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    batches.extend(c.commit());
    apply(
        &mut c,
        vec![Op::SetProp {
            id: 4,
            prop: Prop::Count(20),
        }],
    );
    c.set_scroll_offset(2, point(px(0.0), px(0.0)), 0);
    batches.extend(c.commit());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    batches.extend(c.commit());
    // Every cell without a row is hidden, every cell with one shows.
    let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
    let mut spare = 0;
    for (slot, &cell) in cells.iter().enumerate() {
        let (mut style, mut props) = (false, false);
        for batch in &batches {
            let (s, p) = hidden_in(batch, cell);
            style = s.unwrap_or(style);
            props = p.unwrap_or(props);
        }
        let unbound = list.slots[slot].index.is_none();
        spare += unbound as u32;
        assert_eq!((style, props), (unbound, unbound), "cell {cell}");
    }
    assert!(spare > 0);
}

/// The slot list `id` bound item `index` to.
fn bound_slot(c: &Core<FakeEngine>, id: NodeId, index: u32) -> u32 {
    let list = c.nodes[c.key(id).unwrap() as usize].list.as_ref().unwrap();
    list.slots
        .iter()
        .position(|s| s.index == Some(index))
        .unwrap() as u32
}

#[test]
fn lists_in_one_page_scroll_with_it() {
    let mut c = core();
    // 20 rows (1000) then 100 rows, below no header.
    page(&mut c, 0.0, &[20, 100]);
    c.commit();
    assert_eq!(bound_items(&c, 4), (0..=16).collect::<Vec<_>>());
    // The second starts at 1000, below the viewport and its overscan.
    assert!(bound_items(&c, 5).is_empty());
    let key = c.key(2).unwrap();
    assert_eq!(
        c.nodes[key as usize]
            .scroll
            .as_ref()
            .unwrap()
            .dependents
            .len(),
        2
    );
    // Scrolled 1500: the first list is past, the second 500 into its rows.
    c.set_scroll_offset(2, point(px(0.0), px(1500.0)), 0);
    c.commit();
    assert!(bound_items(&c, 4).is_empty());
    assert_eq!(bound_items(&c, 5), (2..=26).collect::<Vec<_>>());
}

#[test]
fn a_list_far_below_the_viewport_renders_nothing() {
    let mut c = core();
    page(&mut c, 2000.0, &[100]);
    c.commit();
    assert!(bound_items(&c, 4).is_empty());
    let mut binds = Vec::new();
    c.take_list_binds(&mut binds);
    assert!(binds.is_empty());
    c.set_scroll_offset(2, point(px(0.0), px(1700.0)), 0);
    c.commit();
    assert_eq!(bound_items(&c, 4), (0..=10).collect::<Vec<_>>());
}

#[test]
fn a_page_list_loads_more_as_its_end_nears() {
    let mut c = core();
    page(&mut c, 1000.0, &[20]);
    c.commit();
    let load_more = |c: &mut Core<FakeEngine>| {
        js_events(c)
            .iter()
            .any(|e| e.0 == 4 && e.1 == EventKind::LoadMore)
    };
    assert!(!load_more(&mut c));
    c.set_scroll_offset(2, point(px(0.0), px(1100.0)), 0);
    c.commit();
    assert!(!load_more(&mut c));
    // Its end 600 below the viewport's end, within a viewport.
    c.set_scroll_offset(2, point(px(0.0), px(1300.0)), 0);
    c.commit();
    assert!(load_more(&mut c));
}

/// The scrolls of page 2 in `batch`: `ScrollBy` deltas and `ScrollTo`
/// offsets, in order.
fn page_scrolls(batch: &MountBatch) -> Vec<(bool, f32)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ScrollBy { id: 2, dy, .. } => Some((false, dy.0)),
            MountItem::Command {
                id: 2,
                command: Command::ScrollTo { y, .. },
            } => Some((true, y.0)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_page_moves_only_for_rows_wholly_above_its_viewport() {
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    // The list's start shows: rows taller than estimated push what is
    // below them down, and the page stays.
    render_binds(&mut c, &mut next_id, &mut cells, 80.0);
    let batch = c.commit().unwrap();
    assert!(page_scrolls(&batch).is_empty());
    assert_eq!(
        frame_of(&batch, 9),
        Some(rect(0.0, 100.0 + 15.0 * 80.0 + 85.0 * 50.0, 320.0, 10.0))
    );
    // Far down, then back up over rows not measured yet: those wholly
    // above the viewport's top keep the visible rows in place.
    c.set_scroll_offset(2, point(px(0.0), px(3000.0)), 0);
    c.commit();
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    c.commit();
    c.set_scroll_offset(2, point(px(0.0), px(2200.0)), 0);
    c.commit();
    render_binds(&mut c, &mut next_id, &mut cells, 80.0);
    let batch = c.commit().unwrap();
    let scrolls = page_scrolls(&batch);
    assert_eq!(scrolls.len(), 1, "one ScrollBy per commit: {scrolls:?}");
    let (to, by) = scrolls[0];
    assert!(!to && by > 0.0, "{scrolls:?}");
    // The page's content grew first.
    let grow = batch
        .items
        .iter()
        .position(|i| matches!(i, MountItem::ScrollContent { id: 2, .. }))
        .unwrap();
    let scroll = batch
        .items
        .iter()
        .position(|i| matches!(i, MountItem::ScrollBy { id: 2, .. }))
        .unwrap();
    assert!(grow < scroll);
    // The window already moved with it: a stale report (before the
    // platform applied the scroll) does not move it back.
    let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
    let local = list.offset;
    c.set_scroll_offset(2, point(px(0.0), px(2200.0)), 0);
    c.commit();
    let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
    assert_eq!(list.offset, local);
    // Applied, it reports where it is.
    c.set_scroll_offset(2, point(px(0.0), px(2200.0 + by)), 1);
    c.commit();
    let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
    assert_eq!(list.offset, local);
}

#[test]
fn scroll_to_index_in_a_page_scrolls_the_page_within_its_content() {
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    c.commit();
    c.apply(Op::Command {
        id: 4,
        command: Command::ScrollToIndex {
            index: 10,
            animated: false,
            automatic: false,
            view_position: crate::geometry::Percentage(0.0),
            view_offset: px(0.0),
        },
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(page_scrolls(&batch), [(true, 600.0)]);
    assert!(
        !batch
            .items
            .iter()
            .any(|i| matches!(i, MountItem::Command { id: 4, .. }))
    );
    // The window followed in the same commit.
    assert_eq!(bound_items(&c, 4).first(), Some(&2));
    // The last row: as far as the page scrolls (5110 - 400).
    c.apply(Op::Command {
        id: 4,
        command: Command::ScrollToIndex {
            index: 99,
            animated: false,
            automatic: false,
            view_position: crate::geometry::Percentage(0.0),
            view_offset: px(0.0),
        },
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(page_scrolls(&batch), [(true, 4710.0)]);
    // The list's end at the viewport's end.
    c.apply(Op::Command {
        id: 4,
        command: Command::ScrollToEnd { animated: false },
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(page_scrolls(&batch), [(true, 4700.0)]);
}

#[test]
fn automatic_page_list_targets_wait_for_the_lists_native_idle() {
    use crate::tailwind::state::HOVERED;
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    c.commit();
    for index in [10, 20] {
        c.apply(Op::Command {
            id: 4,
            command: Command::ScrollToIndex {
                index,
                animated: false,
                automatic: true,
                view_position: crate::geometry::Percentage(0.0),
                view_offset: px(0.0),
            },
        })
        .unwrap();
        assert!(
            c.commit()
                .is_none_or(|batch| page_scrolls(&batch).is_empty())
        );
        // The target pin owns the pending request, not the command queue.
        assert!(c.commands.is_empty());
    }
    // The enclosing scroll view's state is not the list's own snapshot.
    c.set_states(2, 0);
    assert!(
        c.commit()
            .is_none_or(|batch| page_scrolls(&batch).is_empty())
    );
    c.set_states(4, HOVERED);
    assert!(
        c.commit()
            .is_none_or(|batch| page_scrolls(&batch).is_empty())
    );
    c.set_states(4, 0);
    let batch = c.commit().unwrap();
    assert_eq!(page_scrolls(&batch), [(true, 1100.0)]);
    assert!(batch.items.iter().any(|item| matches!(
        item,
        MountItem::Command {
            id: 2,
            command: Command::ScrollTo {
                animated: false,
                ..
            },
        }
    )));
    assert!(c.commands.is_empty());
    assert!(
        c.commit()
            .is_none_or(|batch| page_scrolls(&batch).is_empty())
    );
}

#[test]
fn the_viewport_is_fixed_when_the_list_is_made() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::List,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 4,
                before: None,
            },
            // In the batch that makes it: it counts.
            Op::SetProp {
                id: 4,
                prop: Prop::ListViewport(crate::ListViewport::Parent),
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Create {
            id: 4,
            kind: ViewKind::View
        }
    )));
    // Later: ignored.
    c.apply(Op::SetProp {
        id: 4,
        prop: Prop::ListViewport(crate::ListViewport::Own),
    })
    .unwrap();
    let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
    assert!(list.parent);
    assert_ne!(list.warned & list::ignored::VIEWPORT, 0);
    assert!(c.commit().is_none());
}

#[test]
fn own_lists_have_no_spacer_and_scroll_themselves() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Scroll,
            },
            Op::Create {
                id: 4,
                tag: Tag::List,
            },
            Op::SetProp {
                id: 4,
                prop: Prop::Count(100),
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Create {
            id: 4,
            kind: ViewKind::Scroll
        }
    )));
    // No height of its own in a scroll view: nothing to show.
    assert_eq!(frame_of(&batch, 4).map(|f| f.size.height.0), Some(0.0));
    assert!(c.parent_lists.is_empty());
    let key = c.key(4).unwrap();
    let layout = c.nodes[key as usize].layout.unwrap();
    assert!(c.layout.children(layout).is_empty());
    let key = c.key(2).unwrap();
    assert!(
        c.nodes[key as usize]
            .scroll
            .as_ref()
            .unwrap()
            .dependents
            .is_empty()
    );
}

#[test]
fn a_page_lists_padding_and_border_place_its_cells() {
    let mut c = core();
    page(&mut c, 0.0, &[3]);
    c.apply(style_op(
        4,
        &[
            ("paddingTop", StyleValue::Number(20.0)),
            ("paddingLeft", StyleValue::Number(16.0)),
            ("paddingRight", StyleValue::Number(16.0)),
            ("paddingBottom", StyleValue::Number(30.0)),
        ],
    ))
    .unwrap();
    let batch = c.commit().unwrap();
    // Its padding around the rows, as in a browser.
    assert_eq!(frame_of(&batch, 9).map(|f| f.origin.y.0), Some(200.0));
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = c.commit().unwrap();
    assert_eq!(
        frame_of(&batch, cells[1]),
        Some(rect(16.0, 70.0, 288.0, 50.0))
    );
}

#[test]
fn a_page_list_with_no_scroll_view_around_it_renders_for_the_screen() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 4,
                tag: Tag::List,
            },
            Op::SetProp {
                id: 4,
                prop: Prop::ListViewport(crate::ListViewport::Parent),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::Count(100),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 4,
                before: None,
            },
        ],
    );
    c.commit();
    // The screen (480 tall) and a screen more.
    assert_eq!(bound_items(&c, 4), (0..=19).collect::<Vec<_>>());
}

#[test]
fn a_page_list_in_a_cell_of_a_list_follows_that_list() {
    let mut c = core();
    // Apply only the actual native outputs, preserving pending Core receipts
    // until the existing user reports (and the explicit ACKs below).
    let native_y = std::cell::Cell::new(0.0f32);
    let applied = std::cell::Cell::new(0u32);
    let commit = |c: &mut Core<FakeEngine>| {
        let batch = c.commit();
        if let Some(batch) = &batch {
            native_y.set(scrolled(batch, native_y.get()));
            applied.set(applied.get() + page_scrolls(batch).len() as u32);
        }
        batch
    };
    // An outer list of its own (400 tall) with one row: a list in its
    // parent's viewport, below a 100 pt header in the row.
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(2, &[("height", StyleValue::Number(400.0))]),
            Op::SetProp {
                id: 2,
                prop: Prop::Count(1),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    commit(&mut c);
    let mut binds = Vec::new();
    c.take_list_binds(&mut binds);
    assert_eq!(binds[0].binds, [(0, 0)]);
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 50,
                tag: Tag::Cell,
            },
            Op::SetProp {
                id: 50,
                prop: Prop::Slot(CellSlot::Item(0)),
            },
            Op::Insert {
                parent: 2,
                child: 50,
                before: None,
            },
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            style_op(3, &[("height", StyleValue::Number(100.0))]),
            Op::Insert {
                parent: 50,
                child: 3,
                before: None,
            },
            Op::Create {
                id: 4,
                tag: Tag::List,
            },
            Op::SetProp {
                id: 4,
                prop: Prop::ListViewport(crate::ListViewport::Parent),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::Count(100),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::ListSourceRows(Some(Arc::new(crate::ListSourceRows {
                    id: "page/item-40".into(),
                    source_len: 80,
                    projection_len: 80,
                    rows: (0..100)
                        .map(|index| {
                            if index == 40 {
                                std::iter::once(0..80).collect()
                            } else {
                                Vec::new()
                            }
                        })
                        .collect::<Vec<_>>()
                        .into(),
                    ..Default::default()
                }))),
            },
            Op::Insert {
                parent: 50,
                child: 4,
                before: None,
            },
            Op::SetProp {
                id: 50,
                prop: Prop::CellIndex(0),
            },
        ],
    );
    let batch = commit(&mut c).unwrap();
    // The outer row is as tall as the header and the list.
    assert_eq!(scroll_content(&batch, 2), Some(5100.0));
    assert_eq!(bound_items(&c, 4), (0..=14).collect::<Vec<_>>());
    let key = c.key(2).unwrap();
    assert_eq!(
        c.nodes[key as usize]
            .scroll
            .as_ref()
            .unwrap()
            .dependents
            .len(),
        1
    );
    // The outer list scrolls 2100: 2000 into the inner one.
    native_y.set(2100.0);
    c.set_scroll_offset(2, point(px(0.0), px(2100.0)), u32::MAX);
    commit(&mut c);
    assert_eq!(bound_items(&c, 4), (32..=56).collect::<Vec<_>>());

    // Text in a parent-viewport list contributes to the enclosing List's
    // source anchor, but explicit navigation from that child must replace
    // the enclosing reader's old position, including before its receipt.
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let row = cells[bound_slot(&c, 4, 40) as usize];
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 1000,
                tag: Tag::Text,
            },
            Op::SetProp {
                id: 1000,
                prop: Prop::TextSource(Some(Arc::new(crate::TextSource::Literal {
                    id: "page/item-40".into(),
                    offset: 0,
                }))),
            },
            Op::CreateText {
                id: 1001,
                text: "R".repeat(80),
            },
            Op::Insert {
                parent: 1000,
                child: 1001,
                before: None,
            },
            Op::Insert {
                parent: row,
                child: 1000,
                before: None,
            },
        ],
    );
    commit(&mut c);
    c.apply(style_op(3, &[("height", StyleValue::Number(120.0))]))
        .unwrap();
    assert_eq!(page_scrolls(&commit(&mut c).unwrap()), [(false, 20.0)]);
    // A parent-list measurement forwards its own above-viewport correction
    // to the same owner. The next layout round must not count it again.
    let previous_row = cells[bound_slot(&c, 4, 39) as usize];
    c.apply(style_op(
        previous_row,
        &[("height", StyleValue::Number(70.0))],
    ))
    .unwrap();
    assert_eq!(page_scrolls(&commit(&mut c).unwrap()), [(false, 20.0)]);
    c.apply(Op::Command {
        id: 4,
        command: Command::ScrollToIndex {
            index: 43,
            animated: false,
            automatic: false,
            view_position: crate::geometry::Percentage(0.0),
            view_offset: px(0.0),
        },
    })
    .unwrap();
    assert_eq!(page_scrolls(&commit(&mut c).unwrap()), [(true, 2290.0)]);
    assert!(commit(&mut c).is_none_or(|batch| page_scrolls(&batch).is_empty()));

    // At the end, the child's estimates shrink above the viewport while
    // its last row grows more. The owner follows the total size change,
    // including the next layout round in which the spacer resizes its cell.
    c.apply(Op::SetProp {
        id: 2,
        prop: Prop::FollowEnd(Some(px(32.0))),
    })
    .unwrap();
    c.apply(Op::Command {
        id: 2,
        command: Command::ScrollToEnd { animated: false },
    })
    .unwrap();
    commit(&mut c);
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    commit(&mut c);
    assert_eq!(c.nodes[key as usize].list.as_ref().unwrap().offset, 4740.0);
    let above = cells[bound_slot(&c, 4, 90) as usize];
    let last = cells[bound_slot(&c, 4, 99) as usize];
    c.apply(style_op(above, &[("height", StyleValue::Number(10.0))]))
        .unwrap();
    c.apply(style_op(last, &[("height", StyleValue::Number(150.0))]))
        .unwrap();
    let batch = commit(&mut c).unwrap();
    assert_eq!(scroll_content(&batch, 2), Some(5200.0));
    assert_eq!(c.nodes[key as usize].list.as_ref().unwrap().offset, 4800.0);
    assert_eq!(
        page_scrolls(&batch)
            .iter()
            .filter(|(to, _)| !to)
            .map(|(_, by)| by)
            .sum::<f32>(),
        60.0
    );
    assert!(commit(&mut c).is_none_or(|batch| page_scrolls(&batch).is_empty()));

    // The same measurements while reading above the end preserve the
    // source glyph's position, rather than pulling the reader to the tail.
    native_y.set(2120.0);
    c.set_scroll_offset(2, point(px(0.0), px(2120.0)), u32::MAX);
    commit(&mut c);
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    commit(&mut c);
    let point = crate::text_source::SourcePoint {
        id: "page/item-40".into(),
        byte: 0,
    };
    let owner = c.nodes[key as usize].list.as_ref().unwrap();
    assert_eq!(
        owner.source_geometry.position(&point).unwrap() - owner.offset,
        20.0
    );
    let above = cells[bound_slot(&c, 4, 38) as usize];
    let below = cells[bound_slot(&c, 4, 45) as usize];
    c.apply(style_op(above, &[("height", StyleValue::Number(10.0))]))
        .unwrap();
    c.apply(style_op(below, &[("height", StyleValue::Number(150.0))]))
        .unwrap();
    let batch = commit(&mut c).unwrap();
    assert_eq!(
        page_scrolls(&batch)
            .iter()
            .filter(|(to, _)| !to)
            .map(|(_, by)| by)
            .sum::<f32>(),
        -40.0
    );
    let owner = c.nodes[key as usize].list.as_ref().unwrap();
    assert_eq!(owner.offset, 2080.0);
    assert_eq!(
        owner.source_geometry.position(&point).unwrap() - owner.offset,
        20.0
    );

    // A real native receipt finishes the existing correction before the
    // next reflow; its offset/count come only from actual By/To outputs.
    assert_eq!(native_y.get(), 2080.0);
    c.set_scroll_offset(
        2,
        crate::geometry::point(px(0.0), px(native_y.get())),
        applied.get(),
    );
    assert!(
        commit(&mut c).is_none_or(|batch| page_scrolls(&batch).is_empty()),
        "acknowledging the settled reader must not move it"
    );
    assert!(c.nodes[key as usize].list.as_ref().unwrap().settled());

    // These already-bound rows straddle the viewport. Their opposite
    // changes move the same glyph by 20pt without changing content length.
    let before_len = c.nodes[key as usize].list.as_ref().unwrap().content_len();
    let previous_row = cells[bound_slot(&c, 4, 39) as usize];
    let later_row = cells[bound_slot(&c, 4, 45) as usize];
    c.apply(style_op(
        previous_row,
        &[("height", StyleValue::Number(90.0))],
    ))
    .unwrap();
    c.apply(style_op(
        later_row,
        &[("height", StyleValue::Number(130.0))],
    ))
    .unwrap();
    let batch = commit(&mut c).unwrap();
    // A wheel capture uses the cached line index, while its next source
    // correction resolves the ready provider. Both must mean the same y.
    let (captured, cached_y) = {
        let owner = c.nodes[key as usize].list.as_ref().unwrap();
        owner
            .source_geometry
            .first_visible(owner.offset, owner.offset + owner.viewport)
            .unwrap()
    };
    assert_eq!(captured, point);
    assert_eq!(
        c.reading_position(key, &captured),
        crate::text_source::SourcePosition::Ready(cached_y),
        "cached wheel capture and the ready provider disagree at native offset {}",
        native_y.get()
    );

    assert_eq!(page_scrolls(&batch), [(false, 20.0)]);
    assert_eq!(
        c.nodes[key as usize].list.as_ref().unwrap().content_len(),
        before_len
    );
    assert_eq!(native_y.get(), 2100.0);
    c.set_scroll_offset(
        2,
        crate::geometry::point(px(0.0), px(native_y.get())),
        applied.get(),
    );
    assert!(
        commit(&mut c).is_none_or(|batch| page_scrolls(&batch).is_empty()),
        "the one layout correction must not repeat after its receipt"
    );
    assert!(c.nodes[key as usize].list.as_ref().unwrap().settled());

    let before_wheel = native_y.get();
    for step in 1..=4 {
        native_y.set(native_y.get() - 48.0);
        c.set_scroll_offset(
            2,
            crate::geometry::point(px(0.0), px(native_y.get())),
            applied.get(),
        );
        let batch = commit(&mut c);
        let scrolls = batch.as_ref().map(page_scrolls).unwrap_or_default();
        assert!(
            scrolls.is_empty(),
            "wheel {step} was undone by another layout/source correction: {scrolls:?}"
        );
        let owner = c.nodes[key as usize].list.as_ref().unwrap();
        assert_eq!(owner.offset, native_y.get());
        assert_eq!(owner.reading_point(), Some(&point));
        let (captured, cached_y) = owner
            .source_geometry
            .first_visible(owner.offset, owner.offset + owner.viewport)
            .unwrap();
        assert_eq!(captured, point);
        assert_eq!(cached_y - native_y.get(), 20.0 + step as f32 * 48.0);
        assert_eq!(
            c.reading_position(key, &captured),
            crate::text_source::SourcePosition::Ready(cached_y),
            "wheel {step}: cached capture and the ready provider disagree"
        );
    }
    assert_eq!(native_y.get(), before_wheel - 192.0);

    // Released, the outer list leaves the inner one without a view.
    c.apply(Op::Remove {
        parent: ROOT_ID,
        child: 2,
    })
    .unwrap();
    c.apply(Op::Release { id: 2 }).unwrap();
    commit(&mut c);
    let key = c.key(4).unwrap();
    assert_eq!(c.nodes[key as usize].list.as_ref().unwrap().outer, None);
}

#[test]
fn a_page_list_keeps_its_scroll_commands_until_it_is_placed() {
    let mut c = core();
    page(&mut c, 100.0, &[100]);
    c.commit();
    // Out of the page: no view to scroll yet.
    c.apply(Op::Remove {
        parent: 2,
        child: 4,
    })
    .unwrap();
    c.apply(Op::Command {
        id: 4,
        command: Command::ScrollToIndex {
            index: 10,
            animated: false,
            automatic: false,
            view_position: crate::geometry::Percentage(0.0),
            view_offset: px(0.0),
        },
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(page_scrolls(&batch).is_empty());
    // Back in the page: the page scrolls to the row.
    c.apply(Op::Insert {
        parent: 2,
        child: 4,
        before: Some(9),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(page_scrolls(&batch), [(true, 600.0)]);
}

/// The sticky cells sent to view `id` in `batch` (the last set), by cell.
fn sticky_of(batch: &MountBatch, id: NodeId) -> Option<Vec<(NodeId, f32, f32)>> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::StickyCells { id: v, cells } if *v == id => {
            Some(cells.iter().map(|c| (c.cell, c.start.0, c.end.0)).collect())
        }
        _ => None,
    })
}

/// [`render_binds`] for the lists of a page: each list's cells by slot.
fn render_lists_binds(
    c: &mut Core<FakeEngine>,
    next_id: &mut u32,
    cells: &mut rustc_hash::FxHashMap<NodeId, Vec<u32>>,
    row_height: f32,
) {
    let mut binds = Vec::new();
    c.take_list_binds(&mut binds);
    // The overscan too, as an engine with time to spare binds it.
    c.take_paced_list_binds(usize::MAX, &mut binds);
    for bind in binds {
        let list_cells = cells.entry(bind.list).or_default();
        for (slot, index) in bind.binds {
            while list_cells.len() <= slot as usize {
                let id = *next_id;
                *next_id += 1;
                apply(
                    c,
                    vec![
                        Op::Create { id, tag: Tag::Cell },
                        Op::SetProp {
                            id,
                            prop: Prop::Slot(CellSlot::Item(list_cells.len() as u32)),
                        },
                        Op::Insert {
                            parent: bind.list,
                            child: id,
                            before: None,
                        },
                    ],
                );
                list_cells.push(id);
            }
            let cell = list_cells[slot as usize];
            c.apply(style_op(
                cell,
                &[("height", StyleValue::Number(row_height))],
            ))
            .unwrap();
            c.apply(Op::SetProp {
                id: cell,
                prop: Prop::CellIndex(index),
            })
            .unwrap();
        }
    }
}

#[test]
fn page_lists_sticky_rows_stick_to_the_pages_viewport() {
    let mut c = core();
    // Two lists of 20 rows (1000) below a 100 pt header; rows 0 and 10 of
    // each stick.
    page(&mut c, 100.0, &[20, 20]);
    for id in [4, 5] {
        c.apply(Op::SetProp {
            id,
            prop: Prop::StickyIndices(vec![0, 10]),
        })
        .unwrap();
    }
    commit_with_native_retirement(&mut c);
    let (mut next_id, mut cells) = (100, rustc_hash::FxHashMap::default());
    render_lists_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = commit_with_native_retirement(&mut c).unwrap();
    // The page's scroll view pins them, in its offsets: the first list's
    // row 0 from 100 until row 10 pushes it out, row 10 from 600 until its
    // bottom meets the list's end (1100).
    let pinned = sticky_of(&batch, 2).expect("the page's sticky cells");
    assert!(
        pinned.contains(&(cells[&4][bound_slot(&c, 4, 0) as usize], 100.0, 550.0)),
        "{pinned:?}"
    );
    assert!(
        pinned.contains(&(cells[&4][bound_slot(&c, 4, 10) as usize], 600.0, 1050.0)),
        "{pinned:?}"
    );
    // None for the lists themselves.
    assert_eq!(sticky_of(&batch, 4), None);
    // The second list's rows are not bound yet (it starts at 1100, past
    // the window); scrolled there, its row 0 joins, from 1100.
    c.set_scroll_offset(2, point(px(0.0), px(1200.0)), 0);
    commit_with_native_retirement(&mut c);
    render_lists_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = commit_with_native_retirement(&mut c).unwrap();
    let pinned = sticky_of(&batch, 2).expect("the page's sticky cells");
    assert!(
        pinned.contains(&(cells[&5][bound_slot(&c, 5, 0) as usize], 1100.0, 1550.0)),
        "{pinned:?}"
    );
    assert!(
        pinned.contains(&(cells[&4][bound_slot(&c, 4, 10) as usize], 600.0, 1050.0)),
        "{pinned:?}"
    );
    // A sticky cell goes on top of its list's other cells.
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::ProjectRoot { parent: 5, id, .. } if *id == cells[&5][bound_slot(&c, 5, 0) as usize]
    )));
    // The first list leaves the page: its cells leave the page's set, and
    // the second list's move up with it (it now starts at 100).
    c.apply(Op::Remove {
        parent: 2,
        child: 4,
    })
    .unwrap();
    let batch = commit_with_native_retirement(&mut c).unwrap();
    let pinned = sticky_of(&batch, 2).expect("the page's sticky cells");
    assert!(
        pinned.iter().all(|p| cells[&5].contains(&p.0)),
        "{pinned:?}"
    );
    assert!(
        pinned.contains(&(cells[&5][bound_slot(&c, 5, 0) as usize], 100.0, 550.0)),
        "{pinned:?}"
    );
}

#[test]
fn page_list_native_order_keeps_sticky_rows_above_recycled_cells() {
    fn note_order(c: &mut Core<FakeEngine>, order: &mut Vec<NodeId>) -> Vec<MountItem> {
        let mut consumed = Vec::new();
        while let Some(batch) = c.commit() {
            let mut retired = Vec::new();
            for item in &batch.items {
                match item {
                    MountItem::Insert {
                        parent,
                        child,
                        before,
                    } => {
                        order.retain(|id| id != child);
                        if *parent == 4 {
                            let at = before
                                .map(|before| order.iter().position(|&id| id == before).unwrap())
                                .unwrap_or(order.len());
                            order.insert(at, *child);
                        }
                    }
                    MountItem::ProjectRoot {
                        parent,
                        id,
                        following,
                    } => {
                        order.retain(|child| child != id);
                        if *parent == 4 {
                            // `order` contains only roots actually attached
                            // to this host; parked candidates are skipped.
                            let at = following
                                .iter()
                                .find_map(|following| order.iter().position(|id| id == following))
                                .unwrap_or(order.len());
                            order.insert(at, *id);
                        }
                    }
                    MountItem::Remove { id } | MountItem::Delete { id } => {
                        order.retain(|child| child != id);
                    }
                    MountItem::RetireListCell { id, request, roots } => {
                        order.retain(|child| !roots.contains(child));
                        retired.push((*id, *request));
                    }
                    // This native consumer already detached before its ACK.
                    MountItem::ListCellRetired { .. } => {}
                    _ => {}
                }
            }
            consumed.extend(batch.items);
            if retired.is_empty() {
                break;
            }
            for (id, request) in retired {
                c.retire_list_cell(id, request, true);
            }
        }
        consumed
    }
    fn check_order(c: &Core<FakeEngine>, order: &[NodeId]) {
        let list = c.nodes[c.key(4).unwrap() as usize].list.as_ref().unwrap();
        let mut rows: Vec<_> = list
            .slots
            .iter()
            .filter_map(|slot| slot.ready().map(|index| (index, slot.cell)))
            .collect();
        rows.sort_unstable_by_key(|&(index, _)| index);
        let mut expected: Vec<_> = rows
            .iter()
            .map(|&(_, cell)| c.nodes[cell as usize].id)
            .collect();
        expected.sort_by_key(|id| list.sent_sticky.iter().any(|range| range.cell == *id));
        assert_eq!(order, expected);
        assert_eq!(order, list.mounted_cells);
    }

    let mut c = core();
    page(&mut c, 0.0, &[100]);
    let mut order = Vec::new();
    note_order(&mut c, &mut order);
    let (mut next_id, mut cells) = (100, rustc_hash::FxHashMap::default());
    render_lists_binds(&mut c, &mut next_id, &mut cells, 50.0);
    note_order(&mut c, &mut order);
    check_order(&c, &order);
    // Changing only the sticky set must reorder already-mounted cells.
    c.apply(Op::SetProp {
        id: 4,
        prop: Prop::StickyIndices(vec![0, 2]),
    })
    .unwrap();
    note_order(&mut c, &mut order);
    check_order(&c, &order);
    assert!(!note_order(&mut c, &mut order).iter().any(|item| matches!(
        item,
        MountItem::Insert { parent: 4, .. } | MountItem::ProjectRoot { parent: 4, .. }
    )));
    // Recycled and newly bound cells stay below the existing sticky rows.
    c.set_scroll_offset(2, point(px(0.0), px(600.0)), 0);
    note_order(&mut c, &mut order);
    render_lists_binds(&mut c, &mut next_id, &mut cells, 50.0);
    note_order(&mut c, &mut order);
    check_order(&c, &order);
    for sticky in [vec![4], vec![]] {
        c.apply(Op::SetProp {
            id: 4,
            prop: Prop::StickyIndices(sticky),
        })
        .unwrap();
        note_order(&mut c, &mut order);
        check_order(&c, &order);
    }
}

/// A view (or a text) moved into a container inside a `display: none`
/// view, absolutely positioned or not, loses its old frame: its native
/// view is not left showing at its former size in a parent of no size.
#[test]
fn views_moved_into_a_hidden_subtree_lose_their_frames() {
    for (tag, position) in [
        (Tag::View, "relative"),
        (Tag::Text, "relative"),
        (Tag::View, "absolute"),
        (Tag::Text, "absolute"),
    ] {
        let mut c = core();
        let mut ops = vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            style_op(2, &[("display", StyleValue::Str("none"))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            style_op(4, &[("position", StyleValue::Str(position))]),
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Create { id: 6, tag },
            style_op(6, &[("height", StyleValue::Number(20.0))]),
            Op::Insert {
                parent: ROOT_ID,
                child: 6,
                before: None,
            },
        ];
        if tag == Tag::Text {
            ops.push(Op::CreateText {
                id: 8,
                text: "hello".into(),
            });
            ops.push(Op::Insert {
                parent: 6,
                child: 8,
                before: None,
            });
        }
        apply(&mut c, ops);
        let shown = c.commit().unwrap();
        assert_eq!(frame_of(&shown, 6).unwrap().size, size_pt(320.0, 20.0));
        apply(
            &mut c,
            vec![
                Op::Remove {
                    parent: ROOT_ID,
                    child: 6,
                },
                Op::Insert {
                    parent: 4,
                    child: 6,
                    before: None,
                },
            ],
        );
        let hidden = c.commit().unwrap();
        assert_eq!(
            frame_of(&hidden, 6),
            Some(Bounds::default()),
            "{tag:?} in a {position} container"
        );
    }
}

/// Hiding a list must not discard the frames of its clean cached cells
/// when it returns to the same width, including across repeated moves.
#[test]
fn list_cell_descendants_restore_after_hidden_reparent() {
    for (tag, position) in [
        (Tag::View, "relative"),
        (Tag::Text, "relative"),
        (Tag::View, "absolute"),
        (Tag::Text, "absolute"),
    ] {
        let mut c = core();
        add(
            &mut c,
            2,
            Tag::View,
            ROOT_ID,
            &[("display", StyleValue::Str("none"))],
        );
        add(
            &mut c,
            4,
            Tag::View,
            2,
            &[("position", StyleValue::Str(position))],
        );
        add(
            &mut c,
            6,
            Tag::List,
            ROOT_ID,
            &[("height", StyleValue::Number(100.0))],
        );
        apply(
            &mut c,
            vec![
                Op::SetProp {
                    id: 6,
                    prop: Prop::EstimatedItemSize(px(20.0)),
                },
                Op::SetProp {
                    id: 6,
                    prop: Prop::Count(1),
                },
            ],
        );
        c.commit();
        let (mut next_id, mut cells) = (100, Vec::new());
        render_binds(&mut c, &mut next_id, &mut cells, 20.0);
        add(
            &mut c,
            200,
            tag,
            cells[0],
            &[("height", StyleValue::Number(20.0))],
        );
        if tag == Tag::Text {
            apply(
                &mut c,
                vec![
                    Op::CreateText {
                        id: 202,
                        text: "hello".into(),
                    },
                    Op::Insert {
                        parent: 200,
                        child: 202,
                        before: None,
                    },
                ],
            );
        }
        c.commit();
        let child = c.key(200).unwrap();
        let cell = c.key(cells[0]).unwrap();
        let shown = c.nodes[child as usize].frame;
        let shown_cell = c.nodes[cell as usize].frame;
        assert_eq!(shown.size, size_pt(320.0, 20.0));
        for _ in 0..2 {
            c.apply(Op::Insert {
                parent: 4,
                child: 6,
                before: None,
            })
            .unwrap();
            c.commit();
            assert_eq!(c.nodes[child as usize].frame, Bounds::default());
            assert_eq!(c.nodes[cell as usize].frame, Bounds::default());
            c.apply(Op::Insert {
                parent: ROOT_ID,
                child: 6,
                before: None,
            })
            .unwrap();
            c.commit();
            assert_eq!(
                c.nodes[child as usize].frame, shown,
                "{tag:?} in {position}"
            );
            assert_eq!(c.nodes[cell as usize].frame, shown_cell);
        }
    }
}

/// The layout an incremental commit gives equals the one a core laid out
/// from scratch gives the same tree: random trees of views and texts,
/// changed by random insertions, moves, removals, style and text changes,
/// compared node by node after each commit. What makes layout incremental
/// (caches, dirty propagation, partial walks) is held to this.
mod layout_consistency {
    use std::collections::{BTreeMap, HashMap};

    use super::*;

    /// A seeded xorshift64*: the same seed, the same trees.
    struct Rng(u64);

    impl Rng {
        fn new(seed: u64) -> Rng {
            Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
        }

        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }

        fn pick<T: Copy>(&mut self, of: &[T]) -> T {
            of[self.below(of.len())]
        }

        /// True `percent`% of the time.
        fn chance(&mut self, percent: u64) -> bool {
            self.next() % 100 < percent
        }
    }

    #[derive(Clone, Copy, Debug)]
    enum Value {
        N(f32),
        S(&'static str),
    }

    /// A view or a text (its raw text child and content) in the model.
    #[derive(Clone, Debug)]
    struct Node {
        parent: NodeId,
        text: Option<(NodeId, String)>,
        style: Vec<(&'static str, Value)>,
        children: Vec<NodeId>,
    }

    /// The tree as the test made it.
    #[derive(Default)]
    struct Model {
        nodes: BTreeMap<NodeId, Node>,
        next: NodeId,
    }

    impl Model {
        fn id(&mut self) -> NodeId {
            self.next += 2;
            self.next
        }

        fn children(&self, parent: NodeId) -> Vec<NodeId> {
            if parent == ROOT_ID {
                self.roots().to_vec()
            } else {
                self.nodes[&parent].children.clone()
            }
        }

        fn roots(&self) -> &[NodeId] {
            self.nodes
                .get(&0)
                .map_or(&[][..], |root| root.children.as_slice())
        }

        fn is_inside(&self, mut id: NodeId, ancestor: NodeId) -> bool {
            loop {
                if id == ancestor {
                    return true;
                }
                match self.nodes.get(&id) {
                    Some(node) if node.parent != ROOT_ID => id = node.parent,
                    _ => return false,
                }
            }
        }

        /// The live nodes: views and texts, the root's holder aside.
        fn live(&self) -> Vec<NodeId> {
            self.nodes.keys().copied().filter(|&id| id != 0).collect()
        }

        fn views(&self) -> Vec<NodeId> {
            self.nodes
                .iter()
                .filter(|(id, n)| **id != 0 && n.text.is_none())
                .map(|(&id, _)| id)
                .collect()
        }

        /// The subtree of `id`, it first.
        fn subtree(&self, id: NodeId) -> Vec<NodeId> {
            let mut out = vec![id];
            let mut at = 0;
            while at < out.len() {
                out.extend(self.nodes[&out[at]].children.iter().copied());
                at += 1;
            }
            out
        }

        fn detach(&mut self, id: NodeId) -> NodeId {
            let parent = self.nodes[&id].parent;
            let holder = if parent == ROOT_ID { 0 } else { parent };
            self.nodes
                .get_mut(&holder)
                .unwrap()
                .children
                .retain(|&c| c != id);
            parent
        }

        fn attach(&mut self, id: NodeId, parent: NodeId, at: usize) -> Option<NodeId> {
            let holder = if parent == ROOT_ID { 0 } else { parent };
            let siblings = &mut self.nodes.get_mut(&holder).unwrap().children;
            let at = at.min(siblings.len());
            let before = siblings.get(at).copied();
            siblings.insert(at, id);
            self.nodes.get_mut(&id).unwrap().parent = parent;
            before
        }

        /// The ops that make `id` and what it holds, detached.
        fn create(&self, id: NodeId, ops: &mut Vec<Op>) {
            let node = &self.nodes[&id];
            ops.push(Op::Create {
                id,
                tag: if node.text.is_some() {
                    Tag::Text
                } else {
                    Tag::View
                },
            });
            ops.push(style_of(id, &node.style));
            if let Some((raw, content)) = &node.text {
                ops.push(Op::CreateText {
                    id: *raw,
                    text: content.as_str().into(),
                });
                ops.push(Op::Insert {
                    parent: id,
                    child: *raw,
                    before: None,
                });
            }
            for &child in &node.children {
                self.create(child, ops);
                ops.push(Op::Insert {
                    parent: id,
                    child,
                    before: None,
                });
            }
        }

        /// The ops that make the whole tree on a new core.
        fn build(&self) -> Vec<Op> {
            let mut ops = Vec::new();
            for &id in self.roots() {
                self.create(id, &mut ops);
                ops.push(Op::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                });
            }
            ops
        }
    }

    fn style_of(id: NodeId, style: &[(&'static str, Value)]) -> Op {
        let props: Vec<(&str, StyleValue<'_>)> = style
            .iter()
            .map(|&(k, v)| {
                (
                    k,
                    match v {
                        Value::N(n) => StyleValue::Number(n),
                        Value::S(s) => StyleValue::Str(s),
                    },
                )
            })
            .collect();
        style_op(id, &props)
    }

    /// A random style for a view (or, `text`, a text): sizes fixed,
    /// relative or free, flex and grid containers, absolute positions,
    /// `display: none`, clipping, minimums and maximums.
    fn random_style(rng: &mut Rng, text: bool, fractions: bool) -> Vec<(&'static str, Value)> {
        use Value::{N, S};
        // Fractional values, where rounding to whole points matters; the
        // same number of choices either way, so a seed makes the same tree
        // shapes.
        let f = |whole: Value, fraction: Value| if fractions { fraction } else { whole };
        let mut style = Vec::new();
        let mut maybe = |rng: &mut Rng, percent, key, values: &[Value]| {
            if rng.chance(percent) {
                style.push((key, rng.pick(values)));
            }
        };
        if !text {
            maybe(rng, 50, "flexDirection", &[S("row"), S("column")]);
            maybe(
                rng,
                15,
                "display",
                &[S("none"), S("grid"), S("block"), S("flex")],
            );
            maybe(rng, 30, "flexWrap", &[S("wrap"), S("nowrap")]);
            maybe(
                rng,
                30,
                "alignItems",
                &[S("center"), S("flex-start"), S("stretch"), S("flex-end")],
            );
            maybe(
                rng,
                30,
                "justifyContent",
                &[S("center"), S("space-between"), S("flex-end")],
            );
            maybe(rng, 30, "padding", &[N(4.0), f(N(10.0), N(4.5))]);
            maybe(rng, 30, "gap", &[N(3.0), f(N(8.0), N(2.5))]);
            maybe(rng, 15, "overflow", &[S("hidden")]);
            maybe(
                rng,
                15,
                "gridTemplateColumns",
                &[
                    S("repeat(2, 1fr)"),
                    S("40px 1fr"),
                    S("repeat(3, minmax(0, 1fr))"),
                ],
            );
            maybe(
                rng,
                40,
                "height",
                &[
                    N(24.0),
                    f(N(60.0), N(24.5)),
                    f(S("50%"), S("33.3%")),
                    S("auto"),
                ],
            );
        }
        maybe(
            rng,
            45,
            "width",
            &[
                N(40.0),
                f(N(120.0), N(37.5)),
                f(S("50%"), S("33.3%")),
                S("100%"),
                S("auto"),
            ],
        );
        maybe(rng, 25, "flexGrow", &[N(1.0), N(2.0)]);
        maybe(rng, 25, "flexShrink", &[N(1.0), N(0.0)]);
        maybe(rng, 15, "flexBasis", &[N(30.0), S("50%")]);
        maybe(rng, 20, "margin", &[N(2.0), f(N(6.0), N(2.5))]);
        maybe(rng, 15, "minWidth", &[N(20.0), N(90.0)]);
        maybe(rng, 15, "maxWidth", &[N(60.0), N(150.0)]);
        maybe(
            rng,
            15,
            "alignSelf",
            &[S("center"), S("stretch"), S("flex-end")],
        );
        if rng.chance(10) {
            style.push(("position", S("absolute")));
            style.push((
                "left",
                rng.pick(&[N(5.0), N(30.0), f(S("10%"), S("12.5%"))]),
            ));
            style.push(("top", rng.pick(&[N(4.0), N(50.0)])));
        }
        style
    }

    fn random_text(rng: &mut Rng) -> String {
        let words = [
            "a",
            "price",
            "12.50",
            "a longer label",
            "x",
            "quote board",
            "—",
        ];
        (0..1 + rng.below(4))
            .map(|_| rng.pick(&words))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The frames of every view the core laid out: what `batches` set,
    /// latest last.
    fn note_frames(frames: &mut HashMap<NodeId, Bounds<Points>>, batch: Option<MountBatch>) {
        for item in batch.iter().flat_map(|b| &b.items) {
            match item {
                MountItem::Frame { id, frame } => {
                    frames.insert(*id, *frame);
                }
                MountItem::Delete { id } => {
                    frames.remove(id);
                }
                _ => {}
            }
        }
    }

    /// One random change of the tree: its ops, and what it was.
    fn change(rng: &mut Rng, model: &mut Model, fractions: bool) -> (Vec<Op>, String) {
        let live = model.live();
        let views = model.views();
        let mut ops = Vec::new();
        let roll = if live.len() < 8 { 0 } else { rng.below(100) };
        let what = match roll {
            // Add a view or a text.
            0..=34 if live.len() < 70 => {
                let id = model.id();
                let text = rng.chance(45);
                let raw = text.then(|| model.id());
                model.nodes.insert(
                    id,
                    Node {
                        parent: ROOT_ID,
                        text: raw.map(|raw| (raw, random_text(rng))),
                        style: random_style(rng, text, fractions),
                        children: Vec::new(),
                    },
                );
                let parent = if views.is_empty() || rng.chance(10) {
                    ROOT_ID
                } else {
                    rng.pick(&views)
                };
                let at = rng.below(model.children(parent).len() + 1);
                model.create(id, &mut ops);
                let before = model.attach(id, parent, at);
                ops.push(Op::Insert {
                    parent,
                    child: id,
                    before,
                });
                format!("add {id} to {parent}")
            }
            // Change a style.
            0..=59 => {
                let id = rng.pick(&live);
                let text = model.nodes[&id].text.is_some();
                let style = random_style(rng, text, fractions);
                ops.push(style_of(id, &style));
                model.nodes.get_mut(&id).unwrap().style = style;
                format!("style {id}")
            }
            // Change a text.
            60..=74 => {
                let texts: Vec<NodeId> = live
                    .iter()
                    .copied()
                    .filter(|id| model.nodes[id].text.is_some())
                    .collect();
                if texts.is_empty() {
                    return (ops, "nothing".into());
                }
                let id = rng.pick(&texts);
                let content = random_text(rng);
                let raw = model.nodes[&id].text.as_ref().unwrap().0;
                ops.push(Op::SetText {
                    id: raw,
                    text: content.as_str().into(),
                });
                model.nodes.get_mut(&id).unwrap().text.as_mut().unwrap().1 = content;
                format!("text {id}")
            }
            // Move a node elsewhere.
            75..=89 => {
                let id = rng.pick(&live);
                let targets: Vec<NodeId> = views
                    .iter()
                    .copied()
                    .filter(|&v| !model.is_inside(v, id))
                    .chain([ROOT_ID])
                    .collect();
                let parent = rng.pick(&targets);
                let old = model.detach(id);
                ops.push(Op::Remove {
                    parent: old,
                    child: id,
                });
                let at = rng.below(model.children(parent).len() + 1);
                let before = model.attach(id, parent, at);
                ops.push(Op::Insert {
                    parent,
                    child: id,
                    before,
                });
                format!("move {id} from {old} to {parent}")
            }
            // Remove a node and what it holds.
            _ => {
                let id = rng.pick(&live);
                let parent = model.detach(id);
                ops.push(Op::Remove { parent, child: id });
                for gone in model.subtree(id) {
                    let node = model.nodes.remove(&gone).unwrap();
                    if let Some((raw, _)) = node.text {
                        ops.push(Op::Release { id: raw });
                    }
                    ops.push(Op::Release { id: gone });
                }
                format!("remove {id}")
            }
        };
        (ops, what)
    }

    /// `seed`'s run: `steps` commits of changes, each compared with a
    /// layout from scratch; with `fractions`, sizes and offsets that are
    /// not whole points.
    fn run(seed: u64, steps: usize, fractions: bool) {
        let mut rng = Rng::new(seed);
        let mut model = Model::default();
        model.nodes.insert(
            0,
            Node {
                parent: ROOT_ID,
                text: None,
                style: Vec::new(),
                children: Vec::new(),
            },
        );
        let mut c = core();
        let mut frames = HashMap::new();
        let mut log = Vec::new();
        for step in 0..steps {
            // A commit takes a few changes at once, as a turn does.
            let changes = 1 + rng.below(3);
            for _ in 0..changes {
                let (ops, what) = change(&mut rng, &mut model, fractions);
                apply(&mut c, ops);
                log.push(what);
            }
            note_frames(&mut frames, c.commit());
            let mut fresh = core();
            apply(&mut fresh, model.build());
            let mut expected = HashMap::new();
            note_frames(&mut expected, fresh.commit());
            for id in model.live() {
                let got = frames.get(&id).copied().unwrap_or_default();
                let want = expected.get(&id).copied().unwrap_or_default();
                assert_eq!(
                    got,
                    want,
                    "seed {seed}, step {step}: node {id} laid out incrementally at {got:?}, from \
                     scratch at {want:?}; the node and the views around it: {:?}; changes so far: \
                     {log:?}",
                    {
                        let mut chain = Vec::new();
                        let mut at = id;
                        while let Some(node) = model.nodes.get(&at) {
                            chain.push((at, node.style.clone(), node.text.clone()));
                            if node.parent == ROOT_ID {
                                break;
                            }
                            at = node.parent;
                        }
                        chain
                    }
                );
            }
        }
    }

    #[test]
    fn incremental_layout_equals_layout_from_scratch() {
        for seed in 0..24 {
            run(seed, 60, true);
        }
        // A view of a hidden subtree's absolutely positioned container
        // removed while the root was laid out again: Taffy's rounding pass
        // reached it through a list that still held it, and panicked.
        run(39, 70, false);
    }
}

/// A list's cells take its rounded cross size, as every other view's frame
/// is rounded: a list at a fractional place and size gives them whole
/// points.
#[test]
fn list_cells_take_the_rounded_cross_size() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::List,
            },
            style_op(
                2,
                &[
                    ("height", StyleValue::Number(400.0)),
                    ("width", StyleValue::Number(100.6)),
                    ("marginLeft", StyleValue::Number(0.3)),
                ],
            ),
            Op::SetProp {
                id: 2,
                prop: Prop::EstimatedItemSize(px(50.0)),
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Count(3),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let first = c.commit().unwrap();
    assert_eq!(frame_of(&first, 2).unwrap().size.width, px(101.0));
    let (mut next, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next, &mut cells, 50.0);
    let batch = c.commit().unwrap();
    assert!(!cells.is_empty());
    for &cell in &cells {
        assert_eq!(frame_of(&batch, cell).unwrap().size.width, px(101.0));
    }
}

#[test]
fn prose_respects_responsive_widths_and_inherited_font_updates() {
    let mut c = Core::new(SizedEngine, size_pt(2000.0, 480.0));
    for (id, tag, classes, parent) in [
        (2, Tag::View, "text-[20px]", ROOT_ID),
        (3, Tag::Text, "max-w-prose w-full h-[10px]", 2),
        (
            4,
            Tag::View,
            "text-[20px] max-w-prose md:max-w-[100px] w-full h-[10px]",
            2,
        ),
        (5, Tag::View, "text-[10px]", ROOT_ID),
    ] {
        c.apply(Op::Create { id, tag }).unwrap();
        c.apply(class_op(id, classes)).unwrap();
        c.apply(Op::Insert {
            parent,
            child: id,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    assert_eq!(c.measure(3).unwrap().frame.size.width, px(650.0));
    assert_eq!(c.measure(4).unwrap().frame.size.width, px(100.0));
    c.apply(class_op(2, "text-[10px]")).unwrap();
    c.commit().unwrap();
    assert_eq!(c.measure(3).unwrap().frame.size.width, px(325.0));
    c.apply(class_op(2, "text-[20px]")).unwrap();
    c.commit().unwrap();
    c.apply(Op::Insert {
        parent: 5,
        child: 3,
        before: None,
    })
    .unwrap();
    c.commit().unwrap();
    assert_eq!(c.measure(3).unwrap().frame.size.width, px(325.0));
}

#[test]
fn space_important_margins_win_over_normal_child_styles() {
    for (space, child, expected) in [
        ("space-x-[20px]", "mr-0", 30.0),
        ("space-x-[20px]!", "mr-0", 50.0),
        ("space-x-[20px]!", "mr-0!", 30.0),
    ] {
        let mut c = core();
        view_with_classes(
            &mut c,
            2,
            &format!("flex flex-row w-[200px] h-[40px] {space}"),
        );
        for id in [3, 4] {
            c.apply(Op::Create { id, tag: Tag::View }).unwrap();
            c.apply(class_op(
                id,
                &format!("w-[30px] h-[20px] {}", if id == 3 { child } else { "" }),
            ))
            .unwrap();
            c.apply(Op::Insert {
                parent: 2,
                child: id,
                before: None,
            })
            .unwrap();
        }
        c.commit().unwrap();
        assert_eq!(
            c.measure(4).unwrap().frame.origin.x,
            px(expected),
            "{space} {child}"
        );
    }
}

#[test]
fn percentage_line_heights_inherit_as_computed_lengths() {
    for (leading, expected) in [
        ("leading-[150%]", 30.0),
        ("leading-[1.5em]", 30.0),
        ("leading-[1.5]", 15.0),
    ] {
        let mut c = core();
        for (id, classes, parent) in [
            (2, format!("text-[20px] {leading}"), ROOT_ID),
            (3, "text-[10px]".to_owned(), 2),
        ] {
            c.apply(Op::Create { id, tag: Tag::Text }).unwrap();
            c.apply(class_op(id, &classes)).unwrap();
            c.apply(Op::Insert {
                parent,
                child: id,
                before: None,
            })
            .unwrap();
        }
        c.apply(Op::CreateText {
            id: 4,
            text: "small".to_owned(),
        })
        .unwrap();
        c.apply(Op::Insert {
            parent: 3,
            child: 4,
            before: None,
        })
        .unwrap();
        let batch = c.commit().unwrap();
        let text = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text { id: 2, text, .. } => Some(text),
                _ => None,
            })
            .unwrap();
        assert_eq!(text.spans[0].style.line_height, px(expected), "{leading}");
    }
}

#[test]
fn static_boxes_use_taffys_containing_block() {
    let mut c = core();
    for (id, classes, parent) in [
        (2, "relative w-[300px] h-[300px] p-[40px]", ROOT_ID),
        (3, "static w-[200px] h-[100px]", 2),
        (4, "absolute top-0 left-0 size-[10px]", 3),
    ] {
        c.apply(Op::Create { id, tag: Tag::View }).unwrap();
        c.apply(class_op(id, classes)).unwrap();
        c.apply(Op::Insert {
            parent,
            child: id,
            before: None,
        })
        .unwrap();
    }
    c.commit().unwrap();
    assert_eq!(c.measure(4).unwrap().page, point(px(0.0), px(0.0)));
    assert_eq!(
        c.measure(4).unwrap().frame.origin,
        point(px(-40.0), px(-40.0))
    );
    c.apply(class_op(3, "relative w-[200px] h-[100px]"))
        .unwrap();
    c.commit().unwrap();
    assert_eq!(c.measure(4).unwrap().page, point(px(40.0), px(40.0)));
}

#[test]
fn fixed_elements_keep_their_kind_and_mount_in_the_root() {
    for tag in [Tag::View, Tag::Text, Tag::Image, Tag::Input, Tag::Scroll] {
        let mut c = core();
        view_with_classes(&mut c, 2, "p-[40px] h-[200px]");
        c.apply(Op::Create { id: 3, tag }).unwrap();
        c.apply(class_op(3, "fixed top-0 left-0 w-[80px] h-[20px]"))
            .unwrap();
        c.apply(Op::Insert {
            parent: 2,
            child: 3,
            before: None,
        })
        .unwrap();
        let batch = c.commit().unwrap();
        assert!(inserts(&batch).contains(&(ROOT_ID, 3, None)), "{tag:?}");
        assert_eq!(
            c.measure(3).unwrap().page,
            point(px(0.0), px(0.0)),
            "{tag:?}"
        );
        assert_eq!(c.nodes[c.key(3).unwrap() as usize].kind, Kind::of(tag));
        c.apply(class_op(3, "relative w-[80px] h-[20px]")).unwrap();
        c.commit().unwrap();
        assert_eq!(
            c.measure(3).unwrap().page,
            point(px(40.0), px(40.0)),
            "{tag:?}"
        );
    }
}

#[test]
fn intrinsic_sizes_and_content_boxes_are_computed_by_taffy() {
    let mut c = core();
    for (id, classes) in [
        (2, "box-content w-[100px] h-[20px] p-[10px] border-2"),
        (3, "box-border w-[100px] h-[20px] p-[10px] border-2"),
    ] {
        view_with_classes(&mut c, id, classes);
    }
    c.commit().unwrap();
    assert_eq!(c.measure(2).unwrap().frame.size, size_pt(124.0, 44.0));
    assert_eq!(c.measure(3).unwrap().frame.size.width, px(100.0));

    for (classes, expected) in [("w-min", 48.0), ("w-max", 72.0), ("w-fit", 72.0)] {
        let mut c = core();
        c.apply(Op::Create {
            id: 2,
            tag: Tag::Text,
        })
        .unwrap();
        c.apply(class_op(2, classes)).unwrap();
        c.apply(Op::CreateText {
            id: 3,
            text: "longer hi".into(),
        })
        .unwrap();
        c.apply(Op::Insert {
            parent: 2,
            child: 3,
            before: None,
        })
        .unwrap();
        c.apply(Op::Insert {
            parent: ROOT_ID,
            child: 2,
            before: None,
        })
        .unwrap();
        c.commit().unwrap();
        assert_eq!(
            c.measure(2).unwrap().frame.size.width,
            px(expected),
            "{classes}"
        );
    }
}

#[test]
fn physical_text_alignment_survives_a_descendants_direction_change() {
    let mut c = core();
    view_with_classes(&mut c, 2, "text-left");
    c.apply(Op::Create {
        id: 3,
        tag: Tag::Text,
    })
    .unwrap();
    c.apply(style_op(3, &[("direction", StyleValue::Str("rtl"))]))
        .unwrap();
    c.apply(Op::CreateText {
        id: 4,
        text: "aligned".into(),
    })
    .unwrap();
    c.apply(Op::Insert {
        parent: 3,
        child: 4,
        before: None,
    })
    .unwrap();
    c.apply(Op::Insert {
        parent: 2,
        child: 3,
        before: None,
    })
    .unwrap();
    let batch = c.commit().unwrap();
    let align = batch.items.iter().find_map(|i| match i {
        MountItem::Text { id: 3, text, .. } => Some(text.align),
        _ => None,
    });
    assert_eq!(align, Some(TextAlign::Left));
}

#[test]
fn a_fixed_text_span_can_return_to_its_inline_parent() {
    let mut c = core();
    add(&mut c, 2, Tag::Text, ROOT_ID, &[]);
    add(&mut c, 3, Tag::Text, 2, &[]);
    c.commit();
    assert!(c.nodes[c.key(3).unwrap() as usize].inline);
    c.apply(class_op(3, "fixed top-0 left-0 w-[40px] h-[20px]"))
        .unwrap();
    let batch = c.commit().unwrap();
    assert!(inserts(&batch).contains(&(ROOT_ID, 3, None)));
    assert_eq!(c.measure(3).unwrap().page, point(px(0.0), px(0.0)));
    c.apply(class_op(3, "relative")).unwrap();
    c.commit();
    let node = &c.nodes[c.key(3).unwrap() as usize];
    assert!(node.inline);
    assert!(node.layout.is_none());
}

/// A view of `height` in `parent`, with `style` on top.
fn child_view(
    id: NodeId,
    parent: NodeId,
    height: f32,
    style: &[(&str, StyleValue<'_>)],
) -> Vec<Op> {
    let mut props = vec![("height", StyleValue::Number(height))];
    props.extend_from_slice(style);
    vec![
        Op::Create { id, tag: Tag::View },
        style_op(id, &props),
        Op::Insert {
            parent,
            child: id,
            before: None,
        },
    ]
}

#[test]
fn sticky_views_stick_in_the_viewport_of_the_scroll_view_around_them() {
    let mut c = core();
    let sticky = [
        ("position", StyleValue::Str("sticky")),
        ("top", StyleValue::Number(10.0)),
    ];
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        style_op(2, &[("height", StyleValue::Number(400.0))]),
    ];
    // A 100 pt header, a sticky bar of 40 sticking 10 below the top, then
    // a section of 500 whose heading (0 below its top) sticks within it.
    ops.extend(child_view(3, 2, 100.0, &[]));
    ops.extend(child_view(4, 2, 40.0, &sticky));
    ops.extend(child_view(6, 2, 500.0, &[]));
    ops.extend(child_view(
        7,
        6,
        40.0,
        &[
            ("position", StyleValue::Str("sticky")),
            ("top", StyleValue::Number(0.0)),
        ],
    ));
    ops.extend(child_view(8, 6, 460.0, &[]));
    ops.extend(child_view(5, 2, 2000.0, &[]));
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    let pinned = sticky_of(&batch, 2).expect("the scroll view's sticky views");
    // The bar sticks from 90 (its 100 less 10) until its bottom meets the
    // end of the content (2640); the heading from 140 until its bottom
    // meets its section's end (640).
    assert!(
        pinned.contains(&(4, 90.0, 90.0 + 2640.0 - 140.0)),
        "{pinned:?}"
    );
    assert!(pinned.contains(&(7, 140.0, 140.0 + 460.0)), "{pinned:?}");
    // They draw above their later siblings: made in one go, the views go
    // in in that order.
    let order = |parent: NodeId| -> Vec<NodeId> {
        batch
            .items
            .iter()
            .filter_map(|i| match i {
                MountItem::Insert {
                    parent: p,
                    child,
                    before: None,
                } if *p == parent => Some(*child),
                _ => None,
            })
            .collect()
    };
    assert_eq!(order(2), [3, 6, 5, 4]);
    assert_eq!(order(6), [8, 7]);
    // Its insets say where it sticks: it is laid out in the flow.
    assert_eq!(frame_of(&batch, 4), Some(rect(0.0, 100.0, 320.0, 40.0)));
    // A view added later goes below the bar.
    apply(&mut c, child_view(9, 2, 10.0, &[]));
    let batch = c.commit().unwrap();
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Insert {
            parent: 2,
            child: 9,
            before: Some(4)
        }
    )));
    // No longer sticky: the scroll view gets the heading alone.
    c.apply(style_op(4, &[("height", StyleValue::Number(40.0))]))
        .unwrap();
    let batch = c.commit().unwrap();
    assert_eq!(sticky_of(&batch, 2), Some(vec![(7, 140.0, 600.0)]));
}

#[test]
fn sticky_views_in_a_horizontal_scroll_view_stick_at_their_left() {
    let mut c = core();
    let mut ops = vec![
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        Op::SetProp {
            id: 2,
            prop: Prop::Horizontal(true),
        },
        style_op(2, &[("height", StyleValue::Number(100.0))]),
    ];
    for (id, style) in [
        (3, vec![("width", StyleValue::Number(50.0))]),
        (
            4,
            vec![
                ("width", StyleValue::Number(30.0)),
                ("position", StyleValue::Str("sticky")),
                ("left", StyleValue::Number(0.0)),
                // Not where it sticks in a horizontal scroll view.
                ("top", StyleValue::Number(5.0)),
            ],
        ),
        (5, vec![("width", StyleValue::Number(1000.0))]),
    ] {
        ops.extend([
            Op::Create { id, tag: Tag::View },
            style_op(id, &style),
            Op::Insert {
                parent: 2,
                child: id,
                before: None,
            },
        ]);
    }
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    assert_eq!(sticky_of(&batch, 2), Some(vec![(4, 50.0, 1050.0)]));
}

/// The animated offsets of the sticky cells sent to view `id` in `batch`.
fn sticky_offsets_of(batch: &MountBatch, id: NodeId) -> Option<Vec<(NodeId, Option<u32>)>> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::StickyCells { id: v, cells } if *v == id => {
            Some(cells.iter().map(|c| (c.cell, c.offset)).collect())
        }
        _ => None,
    })
}

#[test]
fn page_lists_stick_below_an_animated_offset() {
    let mut c = core();
    page(&mut c, 100.0, &[20]);
    apply(
        &mut c,
        vec![
            Op::Animation(AnimationOp::CreateValue {
                node: 2,
                value: 56.0,
            }),
            Op::SetProp {
                id: 4,
                prop: Prop::StickyIndices(vec![0, 10]),
            },
            Op::SetProp {
                id: 4,
                prop: Prop::StickyOffsetNode(Some(2)),
            },
        ],
    );
    c.commit();
    let (mut next_id, mut cells) = (100, Vec::new());
    render_binds(&mut c, &mut next_id, &mut cells, 50.0);
    let batch = c.commit().unwrap();
    // The ranges are the list's as without an offset (the platforms add
    // the value), and each cell carries the value's node.
    let row0 = cells[bound_slot(&c, 4, 0) as usize];
    assert!(
        sticky_of(&batch, 2)
            .unwrap()
            .contains(&(row0, 100.0, 550.0))
    );
    assert!(
        sticky_offsets_of(&batch, 2)
            .unwrap()
            .iter()
            .all(|&(_, n)| n == Some(2))
    );
    // A number again: no node.
    c.apply(Op::SetProp {
        id: 4,
        prop: Prop::StickyOffset(px(8.0)),
    })
    .unwrap();
    let batch = c.commit().unwrap();
    assert!(
        sticky_offsets_of(&batch, 2)
            .unwrap()
            .iter()
            .all(|&(_, n)| n.is_none())
    );
    assert!(sticky_of(&batch, 2).unwrap().contains(&(row0, 92.0, 542.0)));
}

#[test]
fn sticky_views_stick_at_an_animated_top() {
    let mut c = core();
    let mut ops = vec![
        Op::Animation(AnimationOp::CreateValue {
            node: 2,
            value: 40.0,
        }),
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        style_op(2, &[("height", StyleValue::Number(400.0))]),
    ];
    ops.extend(child_view(3, 2, 100.0, &[]));
    let mut style = Box::<Style>::default();
    let mut patch = StylePatch::default();
    patch
        .set(&mut style, "position", StyleValue::Str("sticky"))
        .unwrap();
    patch
        .set(&mut style, "height", StyleValue::Number(30.0))
        .unwrap();
    style.animated.push((AnimationProp::StickyTop, 2));
    ops.extend([
        Op::Create {
            id: 4,
            tag: Tag::View,
        },
        Op::SetStyle {
            id: 4,
            style,
            patch,
        },
        Op::Insert {
            parent: 2,
            child: 4,
            before: None,
        },
    ]);
    ops.extend(child_view(5, 2, 1000.0, &[]));
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    // It sticks from its place (the value added by the platforms), and the
    // value is the scroll view's, never the view's own binding.
    assert_eq!(sticky_of(&batch, 2), Some(vec![(4, 100.0, 1100.0)]));
    assert_eq!(sticky_offsets_of(&batch, 2), Some(vec![(4, Some(2))]));
    assert!(!batch.items.iter().any(|i| matches!(
        i,
        MountItem::AnimationBindings { id: 4, bindings } if !bindings.is_empty()
    )));
}

#[test]
fn an_animated_inset_across_the_scroll_axis_is_ignored() {
    let mut c = core();
    let mut ops = vec![
        Op::Animation(AnimationOp::CreateValue {
            node: 2,
            value: 40.0,
        }),
        Op::Create {
            id: 2,
            tag: Tag::Scroll,
        },
        style_op(2, &[("height", StyleValue::Number(400.0))]),
    ];
    ops.extend(child_view(3, 2, 100.0, &[]));
    let mut style = Box::<Style>::default();
    let mut patch = StylePatch::default();
    patch
        .set(&mut style, "position", StyleValue::Str("sticky"))
        .unwrap();
    patch
        .set(&mut style, "height", StyleValue::Number(30.0))
        .unwrap();
    // `left` in a vertical scroll view: it sticks nowhere.
    style.animated.push((AnimationProp::StickyLeft, 2));
    ops.extend([
        Op::Create {
            id: 4,
            tag: Tag::View,
        },
        Op::SetStyle {
            id: 4,
            style,
            patch,
        },
        Op::Insert {
            parent: 2,
            child: 4,
            before: None,
        },
    ]);
    ops.extend(child_view(5, 2, 1000.0, &[]));
    ops.push(Op::Insert {
        parent: ROOT_ID,
        child: 2,
        before: None,
    });
    apply(&mut c, ops);
    let batch = c.commit().unwrap();
    assert!(sticky_of(&batch, 2).is_none_or(|cells| cells.is_empty()));
}

#[test]
fn a_relayout_boundary_that_overflows_more_lays_its_parent_out_again() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Scroll,
            },
            style_op(2, &[("height", StyleValue::Number(200.0))]),
            Op::Create {
                id: 3,
                tag: Tag::View,
            },
            // A size of fixed points that does not shrink: a change inside
            // cannot change it.
            style_op(
                3,
                &[
                    ("width", StyleValue::Number(100.0)),
                    ("height", StyleValue::Number(50.0)),
                    ("flexShrink", StyleValue::Number(0.0)),
                ],
            ),
            Op::Create {
                id: 4,
                tag: Tag::View,
            },
            style_op(4, &[("height", StyleValue::Number(10.0))]),
            Op::Insert {
                parent: 3,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 3,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    c.commit();
    // Within the box: its parent's layout stands.
    apply(
        &mut c,
        vec![style_op(4, &[("height", StyleValue::Number(40.0))])],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 4).unwrap().size.height, px(40.0));
    assert!(frame_of(&batch, 3).is_none());
    // Out of it: the scroll view's content takes the overflow.
    apply(
        &mut c,
        vec![style_op(4, &[("height", StyleValue::Number(500.0))])],
    );
    let batch = c.commit().unwrap();
    assert_eq!(frame_of(&batch, 4).unwrap().size.height, px(500.0));
    let content = batch.items.iter().find_map(|i| match i {
        MountItem::ScrollContent { id: 2, size } => Some(size.height.0),
        _ => None,
    });
    assert_eq!(content, Some(500.0));
}

#[test]
fn a_text_that_measures_as_before_lays_nothing_out_again() {
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            style_op(2, &[("flexDirection", StyleValue::Str("row"))]),
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 5,
                text: "9.07".into(),
            },
            Op::Insert {
                parent: 4,
                child: 5,
                before: None,
            },
            Op::Create {
                id: 6,
                tag: Tag::View,
            },
            style_op(
                6,
                &[
                    ("width", StyleValue::Number(10.0)),
                    ("height", StyleValue::Number(10.0)),
                ],
            ),
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let first = c.commit().unwrap();
    let after = frame_of(&first, 6).unwrap().origin.x;
    let root = c.nodes[c.root as usize].layout.unwrap();
    // As wide as before (the tests' engine gives each character one width):
    // nothing to lay out again, the text mounted again.
    c.apply(Op::SetText {
        id: 5,
        text: "9.14".into(),
    })
    .unwrap();
    c.flush_dirty();
    assert!(!c.needs_layout && !c.layout.dirty(root));
    let batch = c.commit().unwrap();
    assert!(
        matches!(&batch.items[..], [MountItem::Text { id: 4, text, .. }] if text.text == "9.14")
    );
    // Wider: laid out again, and its sibling moves.
    c.apply(Op::SetText {
        id: 5,
        text: "+9.21".into(),
    })
    .unwrap();
    c.flush_dirty();
    assert!(c.needs_layout && c.layout.dirty(root));
    let batch = c.commit().unwrap();
    assert!(frame_of(&batch, 4).is_some());
    assert!(frame_of(&batch, 6).unwrap().origin.x > after);
}

#[test]
fn audio_session_reaches_the_video() {
    // A lesson's speech plays in silent mode: the prop reaches the
    // platform's player.
    let mut c = core();
    apply(
        &mut c,
        vec![
            Op::Create {
                id: 2,
                tag: Tag::Video,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Native(crate::NativeProp::AudioSession(
                    crate::AudioSession::Playback,
                )),
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ],
    );
    let items = c.commit().unwrap();
    let props = items
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::NativeProps {
                id: 2,
                props: crate::NativeProps::Video(v),
            } => Some(v),
            _ => None,
        })
        .expect("the video's props");
    assert_eq!(props.audio_session, crate::AudioSession::Playback);
}

#[test]
fn span_test_ids_reuse_fitted_and_hidden_layouts() {
    for (fit, hidden) in [(true, false), (false, true)] {
        let mut c = core();
        let mut ops = vec![
            Op::Create {
                id: 2,
                tag: Tag::Text,
            },
            style_op(
                2,
                &[
                    ("width", StyleValue::Number(30.0)),
                    ("height", StyleValue::Number(16.0)),
                    ("fontSize", StyleValue::Number(20.0)),
                ],
            ),
            Op::SetProp {
                id: 2,
                prop: Prop::AdjustsFontSizeToFit(fit),
            },
            Op::Create {
                id: 4,
                tag: Tag::Text,
            },
            Op::CreateText {
                id: 6,
                text: "long enough to shrink".into(),
            },
            Op::Insert {
                parent: 4,
                child: 6,
                before: None,
            },
            Op::Insert {
                parent: 2,
                child: 4,
                before: None,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
        ];
        if hidden {
            ops.push(style_op(2, &[("display", StyleValue::Str("none"))]));
        }
        apply(&mut c, ops);
        let batch = c.commit().unwrap();
        let (old_text, old_layout) = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text {
                    id: 2,
                    text,
                    layout,
                    ..
                } => Some((text.clone(), layout.clone())),
                _ => None,
            })
            .unwrap();
        let counts = (
            c.text_engine.prepares.get(),
            c.text_engine.layouts.get(),
            c.text_engine.measures.get(),
        );
        apply(
            &mut c,
            vec![Op::SetProp {
                id: 4,
                prop: Prop::TestId(Some("cached".into())),
            }],
        );
        let batch = c.commit().unwrap();
        let (text, layout) = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Text {
                    id: 2,
                    text,
                    layout,
                    ..
                } => Some((text, layout)),
                _ => None,
            })
            .unwrap();
        assert_eq!(text.test_ids[0].test_id.as_ref(), "cached");
        assert_eq!(
            text.spans, old_text.spans,
            "keep the actual drawn font size"
        );
        assert!(Arc::ptr_eq(&old_layout.0, &layout.0));
        assert_eq!(
            (
                c.text_engine.prepares.get(),
                c.text_engine.layouts.get(),
                c.text_engine.measures.get()
            ),
            counts
        );
    }
}
