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

//! The message composer owns plain source text; inline skill nodes only
//! determine its presentation and native editing boundaries.

mod message;
mod model;

use std::sync::{Arc, Mutex};

use nsh_base::rich_editor::{
    commands::split_block,
    extensions::history::{history, redo, undo},
    model::{Node, ResolvedPos, Slice},
    state::{
        EditorState, EditorStateConfig, KeyEvent, Plugin, PluginSpec, Transaction,
        TransactionOrigin,
    },
    view::{
        EditorSession, NodeView, NodeViewCx, NodeViews, RichEditorPastedFiles, RichEditorStyles,
        rich_editor,
    },
};
use nsh_core::{
    Color,
    canvas::{LineCap, LineJoin},
    keymap::{Key as NativeKey, Keystroke, Modifiers},
    prelude::*,
};

#[derive(Clone, Copy, Debug, PartialEq, Props)]
pub(crate) struct ComposerInputProps {
    pub value: Prop<String>,
    #[prop(default)]
    pub value_count: Prop<u32>,
    #[prop(default)]
    pub read_only: Prop<bool>,
    #[prop(default)]
    pub placeholder: Prop<String>,
    #[prop(default)]
    pub accessibility_label: Prop<String>,
    pub token_color: Prop<Color>,
    pub token_background_color: Prop<Color>,
    pub token_icon: Prop<String>,
    #[prop(default)]
    pub capture_keys: Prop<Vec<ComposerKeyCapture>>,
    #[prop(default)]
    pub styles: Prop<RichEditorStyles>,
    #[prop(default)]
    pub source_id: Prop<Option<SharedString>>,
    #[prop(default)]
    pub source_offset: Prop<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerKeyCapture {
    pub key: String,
    #[prop(default)]
    pub fallback: bool,
}

#[derive(Debug)]
struct Receipt {
    source: String,
    count: u32,
    pending: Option<(String, u32)>,
}

#[derive(Clone)]
struct Events {
    receipt: Arc<Mutex<Receipt>>,
    cx: Scope<ComposerInputEvent>,
}

impl Events {
    fn changed(&self, value: String) {
        let count = {
            let mut receipt = self.receipt.lock().expect("composer receipt lock poisoned");
            if receipt.source == value {
                return;
            }
            receipt.source.clone_from(&value);
            receipt.count = receipt
                .count
                .checked_add(1)
                .expect("composer edit receipt overflow");
            receipt.count
        };
        self.cx
            .emit(ComposerInputEvent::Change(ComposerChange { value, count }));
    }

    fn flush_state(&self, state: &EditorState) {
        let projection = model::Projection::new(state.doc());
        self.changed(projection.source.clone());
        self.cx.emit(ComposerInputEvent::SelectionChange(selection(
            state,
            &projection,
        )));
    }

    fn apply_value(
        &self,
        session: &EditorSession,
        schema: &nsh_base::rich_editor::model::Schema,
        plugins: &[Plugin],
        value: String,
        count: u32,
        source: &message::Source,
    ) {
        if session.composing() {
            self.receipt
                .lock()
                .expect("composer receipt lock poisoned")
                .pending = Some((value, count));
            return;
        }
        let current_state = session.state();
        let current = model::source(current_state.doc());
        {
            let mut receipt = self.receipt.lock().expect("composer receipt lock poisoned");
            if count < receipt.count || (current == value && source.matches(current_state.doc())) {
                return;
            }
            receipt.source.clone_from(&value);
            receipt.pending = None;
        }
        session.update_state(state(schema, &value, plugins.to_vec(), source));
    }

    fn apply_pending(
        &self,
        session: &EditorSession,
        schema: &nsh_base::rich_editor::model::Schema,
        plugins: &[Plugin],
        source: &message::Source,
    ) {
        let pending = self
            .receipt
            .lock()
            .expect("composer receipt lock poisoned")
            .pending
            .take();
        if let Some((value, count)) = pending {
            self.apply_value(session, schema, plugins, value, count, source);
        }
    }
}

#[class]
pub(crate) struct ComposerInputState {
    session: EditorSession,
}

#[class]
impl ComposerInputState {
    #[getter]
    pub fn composing(&self) -> bool {
        self.session.composing()
    }

    #[getter]
    pub fn selection(&self) -> ComposerSelection {
        let state = self.session.state();
        selection(&state, &model::Projection::new(state.doc()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerChange {
    pub value: String,
    pub count: u32,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerSelection {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerSubmit {
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerKey {
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Event)]
pub(crate) enum ComposerInputEvent {
    #[args(event)]
    Change(ComposerChange),
    #[args(event)]
    SelectionChange(ComposerSelection),
    #[args(composing)]
    CompositionChange(bool),
    #[args(event)]
    Submit(ComposerSubmit),
    #[args(event)]
    Key(ComposerKey),
    Focus,
    Blur,
    #[args(event)]
    PasteFiles(RichEditorPastedFiles),
}

#[derive(Clone, Debug, Default, PartialEq, JsObject)]
pub(crate) struct ComposerReplacement {
    pub start: u32,
    pub end: u32,
    pub text: String,
    pub expected_text: String,
    pub expected_selection: ComposerSelection,
}

pub(crate) struct ComposerInputApi {
    session: EditorSession,
    props: ComposerInputProps,
}

#[methods]
impl ComposerInputApi {
    pub fn focus(&self) {
        self.session.focus();
    }
    pub fn blur(&self) {
        self.session.blur();
    }
    pub fn status(&self) -> Instance<ComposerInputState> {
        Instance::new(ComposerInputState {
            session: self.session.clone(),
        })
    }
    pub fn caret_bounds(&self) -> Option<Bounds<Points>> {
        self.session
            .page_coords_at_pos(self.session.state().selection().head())
    }
    pub fn content_height(&self) -> Option<Points> {
        let state = self.session.state();
        let first = self.session.coords_at_pos(1)?;
        let last = self
            .session
            .coords_at_pos(state.doc().content().size().checked_sub(1)?)?;
        Some(last.origin.y + last.size.height - first.origin.y)
    }
    pub fn replace_range(&self, request: ComposerReplacement) -> bool {
        if self.props.read_only.get_untracked() || self.session.composing() {
            return false;
        }
        let state = self.session.state();
        let projection = model::Projection::new(state.doc());
        if projection.source != request.expected_text
            || selection(&state, &projection) != request.expected_selection
        {
            return false;
        }
        let Some(mut tr) = model::replace(&state, request.start, request.end, &request.text) else {
            return false;
        };
        tr.set_origin(TransactionOrigin::User).scroll_into_view();
        self.session.dispatch(tr).is_ok()
    }
}

const SKILL_LINE_HEIGHT: Points = px(16.0);

struct SkillView(ComposerInputProps);

impl NodeView for SkillView {
    fn create(&self, _cx: &NodeViewCx, node: &Node) -> AnyElement {
        let props = self.0;
        let name = node.attrs()["name"]
            .as_str()
            .expect("a skill node's name is text")
            .to_owned();
        let icon_size = 13.0;
        let icon = if nsh_base::terminal::is_terminal() {
            text("📖").into_element()
        } else {
            canvas(move || {
                Painter::new()
                    .scale(icon_size / 24.0, icon_size / 24.0)
                    .stroke_color(Hsla::from(props.token_color.get()))
                    .line_width(2.0)
                    .line_cap(LineCap::Round)
                    .line_join(LineJoin::Round)
                    .stroke_svg(&props.token_icon.get())
            })
            .w(px(icon_size))
            .h(px(icon_size))
            .into_element()
        };
        let chip = view()
            .flex_row()
            .items_center()
            .align_text_bottom()
            .gap(px(4.0))
            .px(move || px(if props.read_only.get() { 0.0 } else { 4.0 }))
            .rounded(px(4.0))
            .bg(move || {
                if props.read_only.get() {
                    AdaptiveColor::TRANSPARENT
                } else {
                    AdaptiveColor::from(Hsla::from(props.token_background_color.get()))
                }
            })
            .text_color(move || AdaptiveColor::from(Hsla::from(props.token_color.get())))
            .pointer_events(PointerEvents::None)
            .child(icon)
            .child(text(name).line_height(SKILL_LINE_HEIGHT));
        message::attachment(node, chip.into_element())
    }
}

struct ComposerBehavior {
    props: ComposerInputProps,
    events: Events,
}

impl PluginSpec for ComposerBehavior {
    fn append_transaction(
        &self,
        trs: &[Transaction],
        _old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        if self.props.read_only.get_untracked() {
            return None;
        }
        if !trs.iter().any(|tr| tr.doc_changed() || tr.selection_set()) {
            return None;
        }
        model::tokenize(new)
    }

    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if self.props.read_only.get_untracked() {
            return false;
        }
        if let Some(stroke) = keystroke(event) {
            let apple = apple_keys();
            let ctrl_for_command = apple && key_label("mod+c") == key_label("ctrl+c");
            for binding in self.props.capture_keys.get_untracked() {
                if binding.fallback && !state.selection().empty() {
                    continue;
                }
                if Keystroke::parse_with(&binding.key, apple).is_ok_and(|candidate| {
                    candidate == stroke
                        || (ctrl_for_command
                            && candidate.modifiers.ctrl
                            && !candidate.modifiers.cmd
                            && Keystroke {
                                modifiers: Modifiers {
                                    ctrl: false,
                                    cmd: true,
                                    ..candidate.modifiers
                                },
                                ..candidate
                            } == stroke)
                }) {
                    self.events.flush_state(state);
                    self.events
                        .cx
                        .emit(ComposerInputEvent::Key(ComposerKey { key: binding.key }));
                    return true;
                }
            }
        }
        if matches!(event.key.as_str(), "Backspace" | "Delete")
            && !event.mod_key
            && !event.ctrl
            && !event.alt
            && !(event.shift && event.key == "Delete")
            && let Some(tr) = model::delete_atom(state, event.key == "Delete")
        {
            dispatch(tr);
            return true;
        }
        if event.key == "Enter" {
            if event.shift || event.alt {
                return split_block(state, Some(dispatch));
            }
            let source = model::source(state.doc());
            self.events.changed(source.clone());
            self.events
                .cx
                .emit(ComposerInputEvent::Submit(ComposerSubmit { text: source }));
            return true;
        }
        if event.mod_key && !event.alt && event.key.eq_ignore_ascii_case("z") {
            return if event.shift {
                redo(state, Some(dispatch))
            } else {
                undo(state, Some(dispatch))
            };
        }
        if event.mod_key && !event.alt && event.key.eq_ignore_ascii_case("y") {
            return redo(state, Some(dispatch));
        }
        false
    }

    fn handle_paste(
        &self,
        state: &EditorState,
        slice: &Slice,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let text = model::fragment_source(&slice.content);
        if let Some(uris) = nsh_core::platform::clipboard::files_from_text(&text) {
            self.events.flush_state(state);
            let mut paste = RichEditorPastedFiles::default();
            paste.uris = uris;
            self.events.cx.emit(ComposerInputEvent::PasteFiles(paste));
            return true;
        }
        let projection = model::Projection::new(state.doc());
        let selected = selection(state, &projection);
        let Some(mut tr) = model::replace(state, selected.start, selected.end, &text) else {
            return false;
        };
        tr.set_origin(TransactionOrigin::Paste).scroll_into_view();
        dispatch(tr);
        true
    }

    fn transform_pasted_html(&self, _state: &EditorState, _html: String) -> String {
        String::new()
    }

    fn clipboard_text_parser(
        &self,
        state: &EditorState,
        text: &str,
        _context: &ResolvedPos,
        _plain: bool,
    ) -> Option<Slice> {
        Some(model::slice(state.schema(), text))
    }

    fn mark_views(&self) -> Vec<(String, nsh_base::rich_editor::state::ViewFactory)> {
        message::mark_views()
    }

    fn clipboard_text_serializer(&self, _state: &EditorState, slice: &Slice) -> Option<String> {
        Some(model::fragment_source(&slice.content))
    }
}

fn keystroke(event: &KeyEvent) -> Option<Keystroke> {
    let key = match event.key.as_str() {
        "Enter" => NativeKey::Enter,
        "Escape" => NativeKey::Escape,
        "Tab" => NativeKey::Tab,
        "Backspace" => NativeKey::Backspace,
        "Delete" => NativeKey::Delete,
        "ArrowLeft" => NativeKey::Left,
        "ArrowRight" => NativeKey::Right,
        "ArrowUp" => NativeKey::Up,
        "ArrowDown" => NativeKey::Down,
        "Home" => NativeKey::Home,
        "End" => NativeKey::End,
        "PageUp" => NativeKey::PageUp,
        "PageDown" => NativeKey::PageDown,
        value if value.chars().count() == 1 => {
            NativeKey::Char(value.chars().next()?.to_ascii_lowercase())
        }
        _ => return None,
    };
    Some(Keystroke {
        key,
        modifiers: Modifiers {
            ctrl: event.ctrl,
            alt: event.alt,
            shift: event.shift,
            cmd: event.meta,
        },
    })
}

fn selection(state: &EditorState, projection: &model::Projection) -> ComposerSelection {
    ComposerSelection {
        start: projection.source_at(state.selection().from()),
        end: projection.source_at(state.selection().to()),
    }
}

fn state(
    schema: &nsh_base::rich_editor::model::Schema,
    source: &str,
    plugins: Vec<Plugin>,
    annotation: &message::Source,
) -> EditorState {
    let doc = annotation.annotate(schema, model::document(schema, source));
    let end = model::Projection::new(&doc)
        .doc_at(source.encode_utf16().count() as u32, true)
        .expect("the source end is a valid caret");
    let selection = nsh_base::rich_editor::state::TextSelection::create(&doc, end, None);
    EditorState::create(
        EditorStateConfig::new(schema.clone())
            .doc(doc)
            .selection(selection)
            .plugins(plugins),
    )
    .expect("the composer creates a valid plain-text document")
}

#[component(methods = ComposerInputApi)]
pub(crate) fn ComposerInput(
    props: ComposerInputProps,
    cx: Scope<ComposerInputEvent>,
) -> impl IntoElement {
    let schema = model::schema();
    let initial = props.value.get_untracked();
    let events = Events {
        receipt: Arc::new(Mutex::new(Receipt {
            source: initial.clone(),
            count: props.value_count.get_untracked(),
            pending: None,
        })),
        cx,
    };
    let plugins: Vec<Plugin> = vec![
        Arc::new(ComposerBehavior {
            props,
            events: events.clone(),
        }),
        history(Default::default()),
    ];
    let session = EditorSession::new(
        state(&schema, &initial, plugins.clone(), &source(props)),
        NodeViews::new().with("skill", Arc::new(SkillView(props))),
    );
    cx.methods(ComposerInputApi {
        session: session.clone(),
        props,
    });
    {
        let (session, events, schema, plugins) = (
            session.clone(),
            events.clone(),
            schema.clone(),
            plugins.clone(),
        );
        effect(move || {
            props.value.get();
            props.value_count.get();
            props.source_id.get();
            props.source_offset.get();
            let (session, events, schema, plugins) = (
                session.clone(),
                events.clone(),
                schema.clone(),
                plugins.clone(),
            );
            after_answer(move || {
                events.apply_value(
                    &session,
                    &schema,
                    &plugins,
                    props.value.get_untracked(),
                    props.value_count.get_untracked(),
                    &message::Source {
                        id: props.source_id.get_untracked(),
                        offset: props.source_offset.get_untracked(),
                    },
                );
            });
        });
    }
    let changed = session.clone();
    let selected = session.clone();
    let composing = session.clone();
    let change_events = events.clone();
    let pasted = session.clone();
    let paste_events = events.clone();
    rich_editor()
        .editor(session)
        .flex_1()
        .editable(move || !props.read_only.get())
        .tab_navigation(true)
        .placeholder(move || Some(props.placeholder.get().into()))
        .accessibility_label(move || Some(props.accessibility_label.get().into()))
        .styles(move || props.styles.get())
        .on_change(move |_: &_| {
            change_events.changed(model::source(changed.state().doc()));
        })
        .on_selection_change(move |_: &_| {
            let state = selected.state();
            cx.emit(ComposerInputEvent::SelectionChange(selection(
                &state,
                &model::Projection::new(state.doc()),
            )));
        })
        .on_composition_change(move |active: &bool| {
            if !active {
                events.changed(model::source(composing.state().doc()));
                events.apply_pending(&composing, &schema, &plugins, &source(props));
            }
            cx.emit(ComposerInputEvent::CompositionChange(*active));
        })
        .on_focus(move || cx.emit(ComposerInputEvent::Focus))
        .on_blur(move || cx.emit(ComposerInputEvent::Blur))
        .on_paste_files(move |event: &RichEditorPastedFiles| {
            paste_events.flush_state(&pasted.state());
            cx.emit(ComposerInputEvent::PasteFiles(event.clone()))
        })
}

fn source(props: ComposerInputProps) -> message::Source {
    message::Source {
        id: props.source_id.get(),
        offset: props.source_offset.get(),
    }
}
