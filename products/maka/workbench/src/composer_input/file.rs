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

//! File text uses the same Markdown presentation as the composer, with ordinary document keys.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Props)]
pub(crate) struct MarkdownFileEditorProps {
    pub initial_value: Prop<String>,
    pub link_color: Prop<Color>,
    pub accessibility_label: Prop<String>,
    pub styles: Prop<RichEditorStyles>,
    pub render_diagram: Prop<Option<Renderer<String>>>,
}

#[derive(Clone, Debug, PartialEq, Event)]
pub(crate) enum MarkdownFileEditorEvent {
    #[args(value)]
    Change(String),
    Save,
    Find,
}

struct FileText(Scope<MarkdownFileEditorEvent>);
impl PluginSpec for FileText {
    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if event.mod_key && !event.alt && !event.shift {
            let command = match event.key.as_str() {
                "s" => Some(MarkdownFileEditorEvent::Save),
                "f" => Some(MarkdownFileEditorEvent::Find),
                _ => None,
            };
            if let Some(command) = command {
                self.0.emit(command);
                return true;
            }
        }
        history_key(state, event, dispatch)
    }
    fn clipboard_text_parser(
        &self,
        state: &EditorState,
        text: &str,
        _: &ResolvedPos,
        _: bool,
    ) -> Option<Slice> {
        let doc = model::file_document(state.schema(), text);
        Some(Slice::new(doc.content().clone(), 1, 1))
    }
    fn clipboard_text_serializer(&self, _: &EditorState, slice: &Slice) -> Option<String> {
        Some(model::fragment_source(&slice.content))
    }
}

struct FileParagraph(Prop<Option<Renderer<String>>>);
impl NodeView for FileParagraph {
    fn editable_content_slot(&self) -> bool {
        true
    }
    fn update(&self, _: &Node, _: &[nsh_base::rich_editor::state::Decoration]) -> bool {
        true
    }
    fn create(&self, cx: &NodeViewCx, _: &Node) -> AnyElement {
        let decorations = cx.decorations();
        let get_pos = cx.get_pos();
        let key = format!("diagram:{}", cx.pos().expect("mounted paragraph"));
        let diagram = computed(move || {
            decorations.with(|items| {
                items
                    .iter()
                    .find(|d| Some(d.from) == get_pos() && d.spec.contains_key("diagram"))
                    .and_then(|d| d.spec["diagram"].as_str().map(str::to_owned))
            })
        });
        let renderer = self.0;
        let position = cx.get_pos();
        let session = cx.session.clone();
        view()
            .child(
                view()
                    .app_class(move || {
                        diagram
                            .get()
                            .is_some()
                            .then(|| SharedString::from("hidden"))
                    })
                    .child(cx.take_content().expect("editable paragraph")),
            )
            .child(dynamic(move || {
                if let (Some(source), Some(renderer)) = (diagram.get(), renderer.get()) {
                    let (session, position) = (session.clone(), position.clone());
                    view()
                        .cursor(Cursor::Pointer)
                        .on_press(move |_: &()| {
                            if let Some(at) = position() {
                                let state = session.state();
                                let mut tr = state.tr();
                                tr.set_selection(
                                    nsh_base::rich_editor::state::TextSelection::create(
                                        state.doc(),
                                        at + 1,
                                        None,
                                    ),
                                );
                                session.dispatch(tr).expect("current paragraph selection");
                                session.focus();
                            }
                        })
                        .child(renderer.render(key.clone(), source))
                        .into_element()
                } else {
                    view().into_element()
                }
            }))
            .into_element()
    }
}

#[component]
pub(crate) fn MarkdownFileEditor(
    props: MarkdownFileEditorProps,
    cx: Scope<MarkdownFileEditorEvent>,
) -> impl IntoElement {
    let focused = signal(false);
    let schema = model::schema();
    let doc = model::file_document(&schema, &props.initial_value.get_untracked());
    let state = EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(vec![
        Arc::new(FileText(cx)),
        Arc::new(markdown::Formatting::file(
            props.link_color,
            focused.read_only(),
        )),
        history(Default::default()),
    ]))
    .expect("a file document contains text paragraphs");
    let session = EditorSession::new(
        state,
        NodeViews::new().with("paragraph", Arc::new(FileParagraph(props.render_diagram))),
    );
    let changed = session.clone();
    let set_focus = {
        let session = session.clone();
        move |value| {
            focused.set(value);
            let _ = session.dispatch(session.state().tr());
        }
    };
    let blur = set_focus.clone();
    rich_editor()
        .editor(session)
        .flex_1()
        .tab_navigation(true)
        .on_focus(move || set_focus(true))
        .on_blur(move || {
            blur(false);
            cx.emit(MarkdownFileEditorEvent::Save);
        })
        .accessibility_label(move || Some(props.accessibility_label.get().into()))
        .styles(move || props.styles.get())
        .on_change(move |_: &_| {
            cx.emit(MarkdownFileEditorEvent::Change(model::source(
                changed.state().doc(),
            )))
        })
}
