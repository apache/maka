// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

//! Exercise the real component's CPU worker while its engine keeps rendering,
//! a table's grid takes the app's frame; typed root parts,
//! keyboard link navigation, and link press modifiers.

use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use nsh_base::{
    MarkdownPlugin, MarkdownPlugins, TextViewClasses, TextViewLinkPressEvent, TextViewPart,
    TextViewParts, TextViewTaskPressEvent, text_view,
    text_view::{Block, ParseContext, mdast},
};
use nsh_core::{
    Color, ListContentStyle, MountItem, NodeId, Size,
    element::{EngineContext, Root, engine_context},
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[component]
fn AnnotatedCode() -> impl IntoElement {
    use nsh_base::text_view::{
        Block, CodeBlock, CustomNode, Document, Inline, TextViewCodeAction, TextViewCodeActionEvent,
    };
    // Annotations are custom nodes shown as their content: spans of the
    // code's text, styled through the `custom` part.
    provide_context(TextViewParts::new().part(TextViewPart::Custom, |s| {
        s.font_weight(FontWeight::SEMIBOLD)
    }));
    let mut code = CodeBlock::new(None, "prefix 日本語 suffix");
    code.id = Some("annotated".into());
    code.wrap = true;
    code.content = vec![
        Inline::text("prefix "),
        Inline::Custom(CustomNode::new("mark").with_text("日本語")),
        Inline::text(" suffix"),
    ];
    let mut fallback = CodeBlock::new(None, "literal <tag>");
    fallback.id = Some("fallback".into());
    fallback.content = vec![Inline::text("replacement")];
    let pressed = signal(String::new());
    view()
        .child(
            text_view()
                .document(Document::new(vec![
                    Block::CodeBlock(code),
                    Block::CodeBlock(fallback),
                ]))
                .code_block_actions(vec![TextViewCodeAction::new("export").with_label("Export")])
                .on_code_block_action(move |e: &TextViewCodeActionEvent| {
                    pressed.set(format!(
                        "{} {}: {}",
                        e.id,
                        e.code.id.as_deref().unwrap_or_default(),
                        e.code.code
                    ));
                }),
        )
        .child(text(move || format!("Pressed {}", pressed.get())))
}

#[test]
fn annotated_code_shows_its_spans_and_hands_its_block_to_actions() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<AnnotatedCode>())).unwrap();
    app.wait_for("prefix 日本語 suffix").unwrap();
    assert_eq!(
        app.screen().span_style("text:日本語").unwrap().font_weight,
        600
    );
    assert_eq!(
        app.screen().span_style("text:prefix").unwrap().font_weight,
        400
    );
    app.press("label:Export >> nth=0").unwrap();
    app.wait_for("Pressed export annotated: prefix 日本語 suffix")
        .unwrap();
}

#[test]
fn code_content_that_does_not_spell_the_code_is_ignored() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<AnnotatedCode>())).unwrap();
    app.wait_for("literal <tag>").unwrap();
    assert!(!app.shows("replacement"));
}

#[derive(Default)]
struct Gate {
    state: Mutex<(Vec<String>, usize)>,
    wake: Condvar,
}
impl Gate {
    fn enter(&self, source: String) {
        let mut state = self.state.lock().unwrap();
        state.0.push(source);
        let call = state.0.len();
        self.wake.notify_all();
        while state.1 < call {
            state = self.wake.wait(state).unwrap();
        }
    }
    fn entered(&self, count: usize) {
        let state = self.state.lock().unwrap();
        let (state, result) = self
            .wake
            .wait_timeout_while(state, Duration::from_secs(5), |s| s.0.len() < count)
            .unwrap();
        let seen = state.0.clone();
        drop(state);
        assert!(
            !result.timed_out(),
            "parse {count} never started; saw {seen:?}"
        );
    }
    fn release(&self, count: usize) {
        self.state.lock().unwrap().1 = count;
        self.wake.notify_all();
    }
    fn sources(&self) -> Vec<String> {
        self.state.lock().unwrap().0.clone()
    }
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release(usize::MAX)
    }
}
struct Paused(Arc<Gate>);
impl MarkdownPlugin for Paused {
    fn name(&self) -> &str {
        "test CPU gate"
    }
    fn block(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Block> {
        if matches!(node, mdast::Node::Paragraph(_)) {
            self.0.enter(cx.source().to_owned());
        }
        None
    }
}
#[component]
fn Stream() -> impl IntoElement {
    provide_context((*engine_context::<MarkdownPlugins>().expect("test plugins")).clone());
    let source = signal(SharedString::from("**FIRST**"));
    let source_id = signal(SharedString::from("message"));
    let visible = signal(true);
    let status = signal(SharedString::from("ready"));
    view()
        .flex_col()
        .child(view().test_id("append1").h(px(20.0)).on_press(move || {
            source.set("**FIRST** tail1".into());
            status.set("append1 received".into());
        }))
        .child(view().test_id("append2").h(px(20.0)).on_press(move || {
            source.set("**FIRST** tail2".into());
            status.set("append2 received".into());
        }))
        .child(
            view()
                .test_id("replace")
                .h(px(20.0))
                .on_press(move || source.set("**REPLACED**".into())),
        )
        .child(
            view()
                .test_id("identity")
                .h(px(20.0))
                .on_press(move || source_id.set("another message".into())),
        )
        .child(view().test_id("dispose").h(px(20.0)).on_press(move || {
            visible.set(false);
            status.set("disposed".into());
        }))
        .child(
            view()
                .test_id("probe")
                .h(px(20.0))
                .on_press(move || status.set("probe received".into())),
        )
        .child(text(move || status.get()))
        .child(dynamic(move || {
            visible.get().then(|| {
                text_view()
                    .markdown(move || Some(source.get()))
                    .source_id(move || Some(source_id.get()))
                    .selectable(true)
            })
        }))
}
#[test]
fn one_worker_coalesces_and_publishes_a_real_prefix_without_crossing_identity_or_disposal() {
    let gate = Arc::new(Gate::default());
    let plugins = MarkdownPlugins::new().with(Paused(gate.clone()));
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(500.0), px(800.0)),
        context: EngineContext::default().with(plugins),
        ..EngineConfig::new(Root::of::<Stream>())
    })
    .unwrap();
    let _release = Release(gate.clone());
    app.wait_for("text:**FIRST**").unwrap();
    gate.entered(1);
    app.press("id:append1").unwrap();
    app.press("id:append2").unwrap();
    app.wait_for("append2 received").unwrap();
    assert_eq!(gate.sources(), ["**FIRST**"]);
    gate.release(1);
    gate.entered(2);
    app.wait_for("text:FIRST").unwrap();
    assert_eq!(gate.sources(), ["**FIRST**", "**FIRST** tail2"]);
    gate.release(2);
    app.wait_for("text:FIRST tail2").unwrap();
    app.press("id:replace").unwrap();
    gate.entered(3);
    app.press("id:identity").unwrap();
    gate.release(3);
    gate.entered(4);
    app.press("id:probe").unwrap();
    app.wait_for("probe received").unwrap();
    // The prior identity's completed parse must not replace this literal.
    app.wait_for("text:**REPLACED**").unwrap();
    assert!(!app.shows("REPLACED"));
    app.press("id:dispose").unwrap();
    gate.release(4);
    app.wait_for("disposed").unwrap();
    app.wait_for_gone("text:**REPLACED**", Duration::from_secs(5))
        .unwrap();
}

struct Failing;
impl MarkdownPlugin for Failing {
    fn name(&self) -> &str {
        "test parser failure"
    }
    fn block(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Block> {
        if matches!(node, mdast::Node::Paragraph(_)) && cx.source().contains("tail") {
            panic!("test parser failure");
        }
        None
    }
}
#[component]
fn Failure() -> impl IntoElement {
    provide_context((*engine_context::<MarkdownPlugins>().expect("test plugins")).clone());
    let source = signal(SharedString::from("**FIRST**"));
    let failure = signal(SharedString::from("no error"));
    view()
        .flex_col()
        .child(
            view()
                .test_id("fail")
                .h(px(20.0))
                .on_press(move || source.set("**FIRST** full tail".into())),
        )
        .child(
            view()
                .test_id("recover")
                .h(px(20.0))
                .on_press(move || source.set("**RECOVERED**".into())),
        )
        .child(text(move || failure.get()))
        .child(
            text_view()
                .markdown(move || Some(source.get()))
                .on_parse_error(move |reason: &Option<SharedString>| {
                    failure.set(if reason.is_some() {
                        "format failed".into()
                    } else {
                        "no error".into()
                    })
                }),
        )
}
#[test]
fn a_failed_append_shows_the_complete_latest_source_and_can_recover() {
    let plugins = MarkdownPlugins::new().with(Failing);
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(500.0), px(400.0)),
        context: EngineContext::default().with(plugins),
        ..EngineConfig::new(Root::of::<Failure>())
    })
    .unwrap();
    app.wait_for("text:FIRST").unwrap();
    app.press("id:fail").unwrap();
    app.wait_for("format failed").unwrap();
    app.wait_for("text:**FIRST** full tail").unwrap();
    app.press("id:recover").unwrap();
    app.wait_for("text:RECOVERED").unwrap();
    app.wait_for("no error").unwrap();
}

#[component]
fn NestedCode() -> impl IntoElement {
    let source = signal(SharedString::from("- item\n\n  ```txt\n  first\n"));
    view()
        .flex_col()
        .child(view().test_id("append").h(px(20.0)).on_press(move || {
            source.set("- item\n\n  ```txt\n  first\n  \tsecond  \n\n  ```".into())
        }))
        .child(
            text_view()
                .source_id("nested")
                .markdown(move || Some(source.get()))
                .selectable(true)
                .code_block_actions(vec![
                    nsh_base::TextViewCodeAction::new("wrap").with_label("Wrap code"),
                    nsh_base::TextViewCodeAction::new("copy").with_label("Copy code"),
                ]),
        )
}
#[test]
fn nested_code_keeps_the_wrap_control_and_copies_the_exact_grown_body() {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(500.0), px(500.0)),
        ..EngineConfig::new(Root::of::<NestedCode>())
    })
    .unwrap();
    app.wait_for("Wrap code").unwrap();
    let original = app.screen().press_target("Wrap code").unwrap().unwrap();
    assert!(app.screen().selected("Wrap code").unwrap());
    app.press("Wrap code").unwrap();
    assert!(!app.screen().selected("Wrap code").unwrap());
    app.press("id:append").unwrap();
    app.wait_for("text:/second/").unwrap();
    assert_eq!(
        app.screen().press_target("Wrap code").unwrap(),
        Some(original)
    );
    assert!(!app.screen().selected("Wrap code").unwrap());
    app.press("Copy code").unwrap();
    assert_eq!(app.screen().clipboard(), Some("first\n\tsecond  \n"));
}

#[component]
fn OffscreenParagraphs() -> impl IntoElement {
    provide_context((*engine_context::<MarkdownPlugins>().expect("test plugins")).clone());
    let page = element_ref();
    let extent = signal(0.0f32);
    let scrolled = signal(0.0f32);
    // The labels occupy one parsed line each. Their URLs make the actual
    // literal larger than all thirty parsed rows' initial size estimates,
    // including with the headless engine's approximate line wrapping.
    let path = "segment/".repeat(48);
    let source = (0..30)
        .map(|index| format!("[Paragraph{index:02}](https://example.invalid/{path}{index})"))
        .collect::<Vec<_>>()
        .join("\n\n");
    view()
        .flex_col()
        .w_full()
        .h_full()
        .child(
            view()
                .flex_row()
                .h(px(20.0))
                .child(
                    view()
                        .test_id("far")
                        .w(px(60.0))
                        .h(px(20.0))
                        .on_press(move || page.scroll_to_end(false))
                        .child(text("Far")),
                )
                .child(
                    view()
                        .test_id("top")
                        .w(px(60.0))
                        .h(px(20.0))
                        .on_press(move || {
                            page.scroll_to(nsh_core::geometry::point(px(0.0), px(0.0)), false)
                        })
                        .child(text("Top")),
                )
                .child(text(move || format!("extent {:.0}", extent.get())).text_size(px(10.0)))
                .child(text(move || format!("scrolled {:.0}", scrolled.get())).text_size(px(10.0))),
        )
        .child(
            scroll()
                .element_ref(&page)
                .h(px(200.0))
                .w_full()
                .on_scroll(move |event: &ScrollEvent| scrolled.set(event.offset.y.0))
                .child(
                    view()
                        .flex_col()
                        .w_full()
                        .on_layout(move |frame: &nsh_core::Bounds<Points>| {
                            extent.set(frame.size.height.0)
                        })
                        .child(
                            text_view()
                                .source_id("offscreen-paragraphs")
                                .markdown(source)
                                .content_style(ListContentStyle {
                                    row_gap: px(16.0),
                                    ..Default::default()
                                }),
                        ),
                )
                // Stay outside the 200pt viewport and its 200pt overscan
                // even when parsing adds 29 rows of 50pt plus 16pt gaps:
                // 2400 - 200 - 200 > 29 * (50 + 16).
                .child(view().h(px(2400.0))),
        )
}

#[derive(Default)]
struct ObservedParagraphs {
    literal: Option<NodeId>,
    first: Option<(NodeId, f32)>,
}

#[test]
fn an_offscreen_parsed_paragraph_does_not_inherit_the_whole_literal_rows_height() {
    let gate = Arc::new(Gate::default());
    let plugins = MarkdownPlugins::new().with(Paused(gate.clone()));
    let observed = Arc::new(Mutex::new(ObservedParagraphs::default()));
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(500.0), px(220.0)),
        context: EngineContext::default().with(plugins),
        ..EngineConfig::new(Root::of::<OffscreenParagraphs>())
    })
    .unwrap();
    let _release = Release(gate.clone());
    {
        let observed = observed.clone();
        app.observe(move |_, batch| {
            for item in &batch.items {
                if let MountItem::Text {
                    id, text, content, ..
                } = item
                {
                    let mut observed = observed.lock().unwrap();
                    if text.text.starts_with("[Paragraph00](") {
                        observed.literal.get_or_insert(*id);
                    } else if text.text == "Paragraph00" {
                        observed.first = Some((*id, content.size.height.0));
                    }
                }
            }
        });
    }
    let extent = |screen: &nsh_testing::Screen| {
        screen.texts().into_iter().find_map(|text| {
            text.strip_prefix("extent ")
                .and_then(|height| height.parse::<f32>().ok())
        })
    };
    // Thirty unmeasured parsed rows, plus their twenty-nine exact gaps.
    let parsed_upper = 30.0 * 50.0 + 29.0 * 16.0;
    gate.entered(1);
    app.wait_until(
        "the complete literal has its actual measured extent",
        Duration::from_secs(5),
        |screen| extent(screen).is_some_and(|height| height > parsed_upper),
    )
    .unwrap();
    let literal_extent = extent(app.screen()).unwrap();
    let literal_node = observed
        .lock()
        .unwrap()
        .literal
        .expect("the actual literal Text");
    let scrolled = |screen: &nsh_testing::Screen| {
        screen.texts().into_iter().find_map(|text| {
            text.strip_prefix("scrolled ")
                .and_then(|offset| offset.parse::<f32>().ok())
        })
    };
    app.press("id:far").unwrap();
    app.wait_until(
        "the scroll view moved past the literal row and overscan",
        Duration::from_secs(5),
        |screen| scrolled(screen).is_some_and(|offset| offset >= literal_extent + 2000.0),
    )
    .unwrap();

    gate.release(usize::MAX);
    gate.entered(30);
    // Wait for any actual layout publication, including the wrong larger
    // extent. The bound below is the assertion, rather than the wait target.
    app.wait_until(
        "the offscreen parsed document publishes its extent",
        Duration::from_secs(5),
        |screen| extent(screen).is_some_and(|height| height != literal_extent),
    )
    .unwrap();
    let parsed_extent = extent(app.screen()).unwrap();
    assert!(
        parsed_extent <= parsed_upper,
        "the offscreen parsed tree kept a literal measurement: raw {literal_extent}, parsed {parsed_extent}, upper {parsed_upper}"
    );
    assert_eq!(app.screen().matches("text:/Paragraph00/"), Ok(false));
    assert_eq!(app.screen().matches("text:Paragraph00"), Ok(false));

    app.press("id:top").unwrap();
    app.wait_for("text:Paragraph00").unwrap();
    let (first_node, first_height) = observed
        .lock()
        .unwrap()
        .first
        .expect("the parsed first Text");
    assert_ne!(
        first_node, literal_node,
        "the parsed row needs its own native owner"
    );
    assert!(
        first_height > 0.0 && first_height <= 50.0,
        "a single-line parsed paragraph has its actual small geometry: {first_height}"
    );
}

mod typed_root_parts {
    //! Typed root parts reach the document's text before classes and styles.

    use nsh_base::{TextViewClasses, TextViewPart, TextViewParts, TextViewStyles, text_view};
    use nsh_core::{
        StyleKey,
        element::{Root, Style},
        prelude::*,
    };
    use nsh_engine::EngineConfig;
    use nsh_testing::Headless;

    #[component]
    fn TypedRoot() -> impl IntoElement {
        provide_context(TextViewParts::new().part(TextViewPart::Root, |s| s.text_size(px(11.0))));
        text_view().markdown("Hello\n\nAnother paragraph")
    }

    #[component]
    fn RootOverrides() -> impl IntoElement {
        provide_context(TextViewParts::new().part(TextViewPart::Root, |s| s.text_size(px(11.0))));
        let classes = TextViewClasses {
            root: Some("text-[18px]".into()),
            ..Default::default()
        };
        let styles = TextViewStyles {
            root: Some(
                Style::default()
                    .with(
                        StyleKey::FontSize,
                        StyleKey::FontSize.number_value(23.0).unwrap(),
                    )
                    .into(),
            ),
            ..Default::default()
        };
        view()
            .child(text_view().markdown("Class wins").classes(classes.clone()))
            .child(
                text_view()
                    .markdown("Style wins")
                    .classes(classes)
                    .styles(styles),
            )
    }

    #[component]
    fn DefaultRoot() -> impl IntoElement {
        text_view().markdown("Default text")
    }

    #[test]
    fn typed_root_styles_are_inherited_by_paragraphs() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<TypedRoot>())).unwrap();
        app.wait_for("Another paragraph").unwrap();
        for text in ["Hello", "Another paragraph"] {
            assert_eq!(app.screen().span_style(text).unwrap().font_size, px(11.0));
        }
    }

    #[test]
    fn root_classes_override_typed_parts_and_inline_styles_override_classes() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<RootOverrides>())).unwrap();
        app.wait_for("Style wins").unwrap();
        assert_eq!(
            app.screen().span_style("Class wins").unwrap().font_size,
            px(18.0)
        );
        assert_eq!(
            app.screen().span_style("Style wins").unwrap().font_size,
            px(23.0)
        );
    }

    #[test]
    fn root_without_typed_parts_keeps_the_default_typography() {
        let mut app = Headless::start(EngineConfig::new(Root::of::<DefaultRoot>())).unwrap();
        app.wait_for("Default text").unwrap();
        assert_eq!(
            app.screen().span_style("Default text").unwrap().font_size,
            px(15.0)
        );
    }
}

/// A table whose grid the app frames by `classes`: a border on every
/// side and a background.
#[component]
fn FramedTable() -> impl IntoElement {
    text_view()
        .markdown("| Name | Size |\n|------|-----:|\n| Alpha | 12 |")
        .classes(TextViewClasses {
            table_grid: Some("border-2 border-[#ff0000] bg-[#00ff00]".into()),
            ..Default::default()
        })
}

#[test]
fn a_tables_grid_takes_the_apps_frame() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<FramedTable>())).unwrap();
    let styles = Arc::new(Mutex::new(Vec::new()));
    let into = styles.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item {
                into.lock().unwrap().push((*id, style.clone()));
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("Alpha").unwrap();
    let styles = styles.lock().unwrap();
    let grid: Vec<_> = styles
        .iter()
        .filter(|(_, style)| style.background_color == Color(0x00ff_00ff))
        .collect();
    // One view, the grid: not its cells or rows.
    assert!(!grid.is_empty(), "no view has the grid's background");
    assert!(grid.iter().all(|(id, _)| *id == grid[0].0), "{grid:?}");
    // The app's border on every side: over the top and left lines the
    // grid draws itself, and on the right and bottom, which it leaves to
    // the cells.
    let borders = &grid.last().unwrap().1.borders;
    assert_eq!(borders.colors, [Color(0xff00_00ff); 4]);
    let widths = borders.widths;
    assert_eq!(
        [widths.top, widths.right, widths.bottom, widths.left],
        [px(2.0); 4]
    );
}

/// A paragraph with two links, and a stop after it; what the links
/// reported and where the focus came, on screen.
#[component]
fn Links() -> impl IntoElement {
    let pressed = signal(Vec::<String>::new());
    let after = signal(false);
    view()
        .child(
            text_view()
                .markdown("Read [the guide](https://example.com/guide) or [the notes](#notes).")
                .on_link_press(move |e: &TextViewLinkPressEvent| {
                    let url = e.url.to_string();
                    pressed.update(|p| p.push(url));
                }),
        )
        .child(
            view()
                .focusable(true)
                .on_focus(move || after.set(true))
                .child(text("After")),
        )
        .child(text(move || {
            format!("Pressed: {}", pressed.get().join(" "))
        }))
        .child(text(move || format!("After focused: {}", after.get())))
}

#[test]
fn tab_reaches_a_documents_links_in_order_and_return_presses_them() {
    let mut config = EngineConfig::new(Root::of::<Links>());
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).unwrap();
    app.wait_for("the guide").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Pressed: https://example.com/guide").unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Pressed: https://example.com/guide #notes")
        .unwrap();
    assert!(app.shows("After focused: false"), "the links came first");
    app.press_key("tab").unwrap();
    app.wait_for("After focused: true").unwrap();
    // Back from the stop after it: the last link.
    app.press_key("shift+tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("Pressed: https://example.com/guide #notes #notes")
        .unwrap();
}

/// A link with a title, a long link and a link to a heading of the
/// document, in one paragraph.
#[component]
fn HoveredLinks() -> impl IntoElement {
    text_view().markdown(
        "See [the guide](https://docs.example.com/guide \"Read the guide\"), [the archive](https://example.com/archive/2026/11/09/a-very-long-article-name-that-goes-on-and-on?utm_source=newsletter&page=2) or [the notes](#notes).",
    )
}

/// The archive's link: a path longer than a hint's line.
const LONG: &str = "https://example.com/archive/2026/11/09/a-very-long-article-name-that-goes-on-and-on?utm_source=newsletter&page=2";

fn desktop<C: Component<Props = ()>>() -> Headless {
    let mut config = EngineConfig::new(Root::of::<C>());
    config.clock = nsh_engine::Clock::manual(std::time::SystemTime::UNIX_EPOCH);
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app.wait(std::time::Duration::from_millis(32)).unwrap();
    app
}

#[test]
fn resting_on_a_link_shows_its_title_over_its_url() {
    let mut app = desktop::<HoveredLinks>();
    app.wait_for("the guide").unwrap();
    app.hover("the guide").unwrap();
    app.wait(std::time::Duration::from_millis(600)).unwrap();
    // One line of two parts: the scheme and host, then the rest (a URL
    // needs `text:`: its `https:` would be read as a selector's prefix).
    app.wait_for("text:https://docs.example.com").unwrap();
    assert!(app.shows("/guide"), "the path, after the host");
    assert!(app.shows("Read the guide"), "the title, above the URL");
    // Over a link to the document's own heading: the anchor shows too,
    // and the guide's hint is gone.
    app.hover("the notes").unwrap();
    app.wait(std::time::Duration::from_millis(1000)).unwrap();
    app.wait_for("text:#notes").unwrap();
    assert!(!app.shows("https://docs.example.com"));
    assert!(!app.shows("Read the guide"), "no stale title");
}

#[test]
fn a_long_links_hint_keeps_its_host_and_the_end_of_its_url() {
    let mut app = desktop::<HoveredLinks>();
    app.wait_for("the archive").unwrap();
    app.hover("the archive").unwrap();
    // 64 characters: the hint's budget.
    let (head, rest) = nsh_core::open_url::hint_url(LONG, 64).unwrap();
    assert_eq!(head, "https://example.com");
    assert!(rest.starts_with("/archive/"), "{rest}");
    assert!(rest.ends_with("page=2") && rest.contains('…'), "{rest}");
    app.wait(std::time::Duration::from_millis(600)).unwrap();
    app.wait_for(&format!("text:{head}")).unwrap();
    // `shows` compares texts as written (no selector): the rest's slashes
    // are not read as a regex.
    assert!(app.shows(&rest), "{rest}");
}

#[test]
fn a_phone_shows_no_hint_for_a_link() {
    let mut config = EngineConfig::new(Root::of::<HoveredLinks>());
    config.environment.os = Os::Web;
    config.environment.idiom = Idiom::Phone;
    let mut app = Headless::start(config).unwrap();
    app.wait_for("the guide").unwrap();
    app.hover("the guide").unwrap();
    app.wait(std::time::Duration::from_millis(1000)).unwrap();
    assert!(!app.shows("https://docs.example.com"));
}

/// An image in a link that has a title, on its own and in a line of text.
#[component]
fn LinkedImages() -> impl IntoElement {
    text_view().html(
        "<p><a href=\"https://example.com/home\" title=\"Home page\"><img src=\"https://example.com/logo.png\" alt=\"Logo\" width=\"40\" height=\"40\"></a></p>\
         <p>Go <a href=\"https://example.com/shop\"><img src=\"https://example.com/cart.png\" alt=\"Cart\" width=\"16\" height=\"16\"></a> now</p>",
    )
}

#[test]
fn resting_on_a_linked_image_shows_the_links_destination() {
    let mut app = desktop::<LinkedImages>();
    // A block image: the image taking the link's press is the anchor.
    app.wait_for("label:Logo").unwrap();
    app.hover("label:Logo").unwrap();
    app.wait(std::time::Duration::from_millis(600)).unwrap();
    app.wait_for("text:https://example.com").unwrap();
    assert!(app.shows("/home"), "the path, after the host");
    assert!(app.shows("Home page"), "the outer link's title");
    // An image in a line of text: the same, with its own link's URL.
    app.hover("label:Cart").unwrap();
    app.wait(std::time::Duration::from_millis(1000)).unwrap();
    assert!(app.shows("/shop"), "the inline image's link");
    assert!(!app.shows("/home"), "no stale destination");
    assert!(!app.shows("Home page"), "no stale title");
}

/// A link and a footnote reference; each press, with whether Command was
/// held, on screen.
#[component]
fn LinkModifiers() -> impl IntoElement {
    let pressed = signal(Vec::<String>::new());
    view()
        .child(
            text_view()
                .markdown("Read [the guide](https://example.com/guide)[^n].\n\n[^n]: A note.")
                .on_link_press(move |e: &TextViewLinkPressEvent| {
                    let held = if e.modifiers.cmd { "cmd" } else { "plain" };
                    let press = format!("{}:{held}", e.url);
                    pressed.update(|p| p.push(press));
                }),
        )
        .child(text(move || {
            format!("Pressed: {}", pressed.get().join(" "))
        }))
}

#[test]
fn a_link_press_reports_the_modifier_keys_held() {
    let mut config = EngineConfig::new(Root::of::<LinkModifiers>());
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).unwrap();
    app.wait_for("the guide").unwrap();
    app.press("the guide").unwrap();
    app.wait_for("Pressed: https://example.com/guide:plain")
        .unwrap();
    app.hold_keys("mod", true).unwrap();
    app.press("the guide").unwrap();
    app.wait_for("Pressed: https://example.com/guide:plain https://example.com/guide:cmd")
        .unwrap();
    app.press("1").unwrap();
    app.wait_for(
        "Pressed: https://example.com/guide:plain https://example.com/guide:cmd #footnote-n:cmd",
    )
    .unwrap();
    // The keyboard holds no pointer's modifiers: Return presses with none.
    app.hold_keys("mod", false).unwrap();
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for(
        "Pressed: https://example.com/guide:plain https://example.com/guide:cmd \
         #footnote-n:cmd https://example.com/guide:plain",
    )
    .unwrap();
}

/// An image at the end of a paragraph that wraps in a narrow column.
#[component]
fn WrappedInlineImage() -> impl IntoElement {
    view().w(px(120.0)).child(text_view().html(
        "<p>A paragraph long enough to wrap onto several lines <img src=\"https://example.com/dot.png\" alt=\"Dot\" width=\"10\" height=\"10\"></p>",
    ))
}

#[test]
fn an_image_in_a_wrapped_line_is_inside_the_column() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<WrappedInlineImage>())).unwrap();
    app.wait_for("label:Dot").unwrap();
    let id = app.screen().id("label:Dot").unwrap();
    let nodes = app.screen().layout_nodes();
    let dot = nodes.iter().find(|n| n.id == id).unwrap().bounds;
    let text = nodes
        .iter()
        .find(|n| n.text.is_some())
        .expect("the paragraph")
        .bounds;
    assert!(dot.origin.x < px(120.0), "{dot:?}");
    // On the last line, not the first.
    assert!(
        dot.origin.y > text.origin.y + px(25.0),
        "{dot:?} in {text:?}"
    );
}

/// An app's own image as wide as it asks, at most its box: 400 points
/// wide in a column of 300, on its own and in a link.
fn wide_card(image: &nsh_base::text_view::Image) -> View {
    view()
        .test_id(&format!("card:{}", image.alt))
        .w(px(400.0))
        .max_w(relative(1.0))
        .h(px(40.0))
}

#[component]
fn WideCustomImages() -> impl IntoElement {
    view().w(px(300.0)).child(
        text_view()
            .markdown(
                "![Alone](https://example.com/a.png)\n\n\
                 [![Linked](https://example.com/b.png)](https://example.com)\n\n\
                 ![Full](https://example.com/d.png)\n\n\
                 ![Small](https://example.com/e.png)\n\n\
                 Text ![Inline](https://example.com/c.png) after\n\n\
                 | A | B |\n|---|---|\n| ![Cell](https://example.com/f.png) | x |",
            )
            .render_image(|context: &nsh_base::text_view::TextViewImageContext| {
                let image = &context.image;
                if image.alt == "Inline" {
                    view().test_id("card:Inline").w(px(20.0)).h(px(10.0))
                } else if image.alt == "Full" {
                    view().test_id("card:Full").w_full().h(px(40.0))
                } else if image.alt == "Cell" {
                    view().test_id("card:Cell").w(px(60.0)).h(px(20.0))
                } else if image.alt == "Small" {
                    view().test_id("card:Small").w(px(100.0)).h(px(40.0))
                } else {
                    wide_card(image)
                }
            }),
    )
}

/// A wide image of the document's own, on its own.
#[component]
fn WideImage() -> impl IntoElement {
    view().w(px(300.0)).child(text_view().html(
        "<p><img src=\"https://example.com/wide.png\" alt=\"Wide\" width=\"1200\" height=\"300\"></p>",
    ))
}

/// The bounds of the view with `test_id`.
fn bounds_of(app: &Headless, test_id: &str) -> Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some(test_id))
        .unwrap_or_else(|| panic!("a view {test_id}"))
        .bounds
}

#[test]
fn an_apps_image_on_its_own_is_at_most_as_wide_as_the_text() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<WideCustomImages>())).unwrap();
    app.wait_for("label:Inline").unwrap();
    for card in ["card:Alone", "card:Linked"] {
        let bounds = bounds_of(&app, card);
        assert_eq!(bounds.size.width, px(300.0), "{card}: {bounds:?}");
        assert!(
            bounds.origin.x + bounds.size.width <= px(300.0),
            "{card}: {bounds:?}"
        );
    }
    // One as wide as its box is as wide as the text, a narrow one keeps
    // its width.
    assert_eq!(bounds_of(&app, "card:Full").size.width, px(300.0));
    assert_eq!(bounds_of(&app, "card:Small").size.width, px(100.0));
    // In a table's cell, as wide as it asks.
    assert_eq!(bounds_of(&app, "card:Cell").size.width, px(60.0));
    // An image in a line of text keeps the size it asks for.
    let inline = bounds_of(&app, "card:Inline");
    assert_eq!(inline.size.width, px(20.0), "{inline:?}");
    assert_eq!(inline.size.height, px(10.0), "{inline:?}");
}

#[test]
fn a_wide_image_on_its_own_is_at_most_as_wide_as_the_text() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<WideImage>())).unwrap();
    app.wait_for("label:Wide").unwrap();
    let id = app.screen().id("label:Wide").unwrap();
    let bounds = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.id == id)
        .unwrap()
        .bounds;
    assert_eq!(bounds.size.width, px(300.0), "{bounds:?}");
    assert_eq!(
        bounds.size.height,
        px(75.0),
        "the aspect ratio kept: {bounds:?}"
    );
}

mod streaming {
    //! A reply arriving in a `TextView`, 24 bytes at a time: what each
    //! update costs from the press that adds the text to the batch of mount
    //! items (reading the Markdown, the rows, layout), and how many items
    //! it sends.

    use std::{
        cell::RefCell,
        time::{Duration, Instant},
    };

    use nsh_base::{MarkdownOptions, text_view};
    use nsh_core::{
        ApproxTextEngine, Core, EventKind, EventPayload, MountItem, ROOT_ID, Size, element::Root,
        prelude::*,
    };

    thread_local! {
        /// The reply the view streams.
        static REPLY: RefCell<String> = const { RefCell::new(String::new()) };
    }

    /// Shows 24 bytes more of [`REPLY`] with each press.
    #[component]
    fn Streamed() -> impl IntoElement {
        let shown = signal(0usize);
        view()
            .flex_1()
            .on_press(move || shown.update(|n| *n += 24))
            .child(
                text_view()
                    .markdown(move || {
                        let shown = shown.get();
                        Some(REPLY.with_borrow(|reply| {
                            SharedString::from(reply[..shown.min(reply.len())].to_owned())
                        }))
                    })
                    .options(MarkdownOptions {
                        streaming: true,
                        ..MarkdownOptions::default()
                    }),
            )
    }

    fn reply(bytes: usize) -> String {
        let section = "## Section\n\nSome **bold** text with `code`, a [link](https://example.com) and $x^2$.\n\n- item one\n- item two with *emphasis*\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> A note.\n\n";
        section.repeat(bytes / section.len() + 1)[..bytes].to_owned()
    }

    fn table(rows: usize) -> String {
        let mut text =
            String::from("Here are the fields:\n\n| Name | Type | Notes |\n|---|---|---|\n");
        for n in 0..rows {
            text.push_str(&format!("| `field_{n}` | `Option<u32>` | see `docs` |\n"));
        }
        text
    }

    fn list(items: usize) -> String {
        let mut text = String::from("Intro.\n\n");
        for n in 0..items {
            text.push_str(&format!("- `item_{n}`: calls `foo()` then `bar()`\n"));
        }
        text
    }

    fn program(lines: usize) -> String {
        let mut text = String::from("Here is the program:\n\n```rust\n");
        for n in 0..lines {
            text.push_str(&format!(
                "    let value_{n} = compute(&items[{n}], Some(\"x\"))?;\n"
            ));
        }
        text.push_str("```\n");
        text
    }

    /// `source` streamed: the time of every update and the mount items it
    /// sent.
    fn stream(source: &str) -> (Vec<Duration>, Vec<usize>) {
        REPLY.set(source.to_owned());
        let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
        core.mount_root(&Root::new::<Streamed>(|| ()));
        let batch = core.commit().expect("the first frame");
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
            .expect("the root's host");
        let (mut times, mut items) = (Vec::new(), Vec::new());
        for _ in 0..source.len().div_ceil(24) {
            let start = Instant::now();
            assert!(core.component_event(host, EventKind::Press, &EventPayload::None));
            let batch = core.commit();
            times.push(start.elapsed());
            items.push(batch.map_or(0, |b| b.items.len()));
        }
        (times, items)
    }

    /// `cargo test --release -p nsh-base --test base bench_text_view_streaming
    /// -- --ignored --nocapture`; the numbers are in `docs/dev/performance.md`.
    /// With `NSH_BENCH_ITEMS=<file>` the mount items of every update are
    /// written there, to compare two builds.
    #[test]
    #[ignore]
    fn bench_text_view_streaming() {
        let mut counts = String::new();
        println!("total ms over the stream / average ms of the last 10 updates / mount items");
        for (name, source) in [
            ("typical, 20 KB", reply(20_000)),
            ("typical, 40 KB", reply(40_000)),
            ("ends in a 400-row table", table(400)),
            ("ends in a 400-item list", list(400)),
            ("ends in 400 lines of code", program(400)),
        ] {
            let (times, items) = stream(&source);
            let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
            let total: f64 = times.iter().map(ms).sum();
            let last = &times[times.len().saturating_sub(10)..];
            let last: f64 = last.iter().map(ms).sum::<f64>() / last.len() as f64;
            println!(
                "{name:<26} {:>5} updates | {total:>9.1} / {last:>7.3} | {:>7} items",
                times.len(),
                items.iter().sum::<usize>()
            );
            counts.push_str(&format!("{name}: {items:?}\n"));
        }
        if let Ok(path) = std::env::var("NSH_BENCH_ITEMS") {
            std::fs::write(path, counts).unwrap();
        }
    }
}

mod word_fade {
    //! A paragraph whose words fade in as they arrive, as a chat app's
    //! streamed reply does: a plugin splits the newest text into word
    //! spans, hidden until their turn and then fading from transparent by
    //! their text color; a word done fading joins the plain text again.
    //! Measured on the engine thread, from the press that adds the words or
    //! advances a frame to the finished batch of mount items, with a text
    //! engine that draws colors from the text, as the desktop platforms'.

    use std::{
        cell::{Cell, RefCell},
        collections::BTreeMap,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use nsh_base::{
        MarkdownOptions, MarkdownPlugin, MarkdownPlugins, text_view,
        text_view::{CustomNode, Inline, ParseContext, mdast::Node},
    };
    use nsh_core::{
        ApproxTextEngine, AttributedText, Core, EventKind, EventPayload, MountItem, Points,
        ROOT_ID, Size, TextEngine, TextLayout, TextLine, element::Root, prelude::*,
    };

    /// [`ApproxTextEngine`] drawing the colors and hidden runs from the
    /// mounted text, as the macOS, Windows, Linux and GPUI engines do; it
    /// counts the characters it typesets ([`TYPESET`]), what a platform's
    /// engine spends its time on.
    struct ColorsAtDraw;

    thread_local! {
        /// Characters prepared and laid out by [`ColorsAtDraw`].
        static TYPESET: Cell<usize> = const { Cell::new(0) };
    }

    impl TextEngine for ColorsAtDraw {
        type Prepared = <ApproxTextEngine as TextEngine>::Prepared;

        fn prepare(&self, text: &AttributedText) -> Self::Prepared {
            TYPESET.set(TYPESET.get() + text.text.len());
            ApproxTextEngine.prepare(text)
        }

        fn measure(&self, prepared: &Self::Prepared, max_width: Option<Points>) -> Size<Points> {
            TYPESET.set(TYPESET.get() + prepared.0);
            ApproxTextEngine.measure(prepared, max_width)
        }

        fn draws_colors_from_text(&self) -> bool {
            true
        }

        fn breaks_lines_greedily(&self) -> bool {
            ApproxTextEngine.breaks_lines_greedily()
        }

        fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> TextLayout {
            TYPESET.set(TYPESET.get() + prepared.0);
            ApproxTextEngine.layout(prepared, size)
        }

        fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
            ApproxTextEngine.lines(layout)
        }

        fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
            ApproxTextEngine.attachments(layout)
        }
    }

    /// Milliseconds a frame (about 30 a second).
    const FRAME: f32 = 33.0;
    /// Milliseconds between two words' starts (60 words a second).
    const GAP: f32 = 1000.0 / 60.0;
    /// Milliseconds a word takes to fade in.
    const FADE: f32 = 280.0;
    const WORD: &str = "fade-word";
    const VOCABULARY: [&str; 8] = [
        "streamed ",
        "words ",
        "fade ",
        "in ",
        "one ",
        "after ",
        "another ",
        "here ",
    ];

    /// When each word (by its byte offset) starts, and up to where the
    /// text has been seen.
    #[derive(Default)]
    struct Pacer {
        starts: RefCell<BTreeMap<usize, f32>>,
        seen: Cell<usize>,
        last_start: Cell<f32>,
        now: Cell<f32>,
        fading: Cell<bool>,
    }

    impl Pacer {
        fn alpha(&self, start: usize) -> f32 {
            self.starts
                .borrow()
                .get(&start)
                .map_or(1.0, |&at| ((self.now.get() - at) / FADE).clamp(0.0, 1.0))
        }
    }

    struct Fade {
        pacer: Arc<Mutex<Pacer>>,
        frame: Signal<u64>,
    }

    impl MarkdownPlugin for Fade {
        fn name(&self) -> &str {
            "word-fade"
        }

        fn inline(&self, node: &Node, _: &mut ParseContext<'_>) -> Option<Inline> {
            let Node::Text(text) = node else {
                return None;
            };
            let base = text.position.as_ref().map_or(0, |p| p.start.offset);
            let pacer = self.pacer.lock().unwrap();
            let now = pacer.now.get();
            let mut starts = pacer.starts.borrow_mut();
            starts.retain(|_, at| now < *at + FADE);
            let mut out: Vec<Inline> = Vec::new();
            let mut at = 0;
            for piece in text.value.split_inclusive(' ') {
                let start = base + at;
                at += piece.len();
                if start >= pacer.seen.get() && pacer.fading.get() {
                    let begin = (pacer.last_start.get() + GAP).max(now);
                    pacer.last_start.set(begin);
                    starts.insert(start, begin);
                }
                if starts.contains_key(&start) {
                    out.push(Inline::Custom(
                        CustomNode::new(WORD)
                            .with_text(piece)
                            .with_attribute("start", start.to_string()),
                    ));
                } else if let Some(Inline::Text { text }) = out.last_mut() {
                    text.push_str(piece);
                } else {
                    out.push(Inline::text(piece));
                }
            }
            pacer
                .seen
                .set(pacer.seen.get().max(base + text.value.len()));
            match out.len() {
                1 => out.pop(),
                _ => Some(Inline::Custom(CustomNode::new("group").with_content(out))),
            }
        }

        fn render(&self, node: &CustomNode) -> Option<AnyElement> {
            if node.name != WORD {
                return None;
            }
            let start: usize = node.attributes.get("start")?.parse().ok()?;
            let (color, queued) = (self.pacer.clone(), self.pacer.clone());
            let frame = self.frame;
            Some(
                text(node.text.clone())
                    .test_id(&format!("word-{start}"))
                    .text_color(move || {
                        frame.get();
                        hsla(0.0, 0.0, 0.1, color.lock().unwrap().alpha(start))
                    })
                    .style_when(
                        move || {
                            frame.get();
                            queued.lock().unwrap().alpha(start) <= 0.0
                        },
                        |s| s.invisible(),
                    )
                    .into_element(),
            )
        }
    }

    thread_local! {
        static PACER: RefCell<Arc<Mutex<Pacer>>> = RefCell::new(Arc::default());
        static WORDS: Cell<usize> = const { Cell::new(0) };
    }

    /// A paragraph of [`WORDS`] words. Presses take turns: one adds two
    /// words, the next advances a frame.
    #[component]
    fn Paragraph() -> impl IntoElement {
        let pacer = PACER.with_borrow(Arc::clone);
        let frame = signal(0u64);
        let source = signal(
            (0..WORDS.get())
                .map(|i| VOCABULARY[i % VOCABULARY.len()])
                .collect::<String>(),
        );
        // What was there at first shows at once.
        pacer.lock().unwrap().seen.set(source.get_untracked().len());
        provide_context(MarkdownPlugins::new().with(Fade {
            pacer: pacer.clone(),
            frame,
        }));
        let added = Cell::new(WORDS.get());
        let words_next = Cell::new(true);
        view()
            .flex_1()
            .on_press(move || {
                if words_next.replace(!words_next.get()) {
                    source.update(|s| {
                        for _ in 0..2 {
                            s.push_str(VOCABULARY[added.get() % VOCABULARY.len()]);
                            added.set(added.get() + 1);
                        }
                    });
                } else {
                    {
                        let pacer = pacer.lock().unwrap();
                        pacer.now.set(pacer.now.get() + FRAME);
                    }
                    frame.update(|f| *f += 1);
                }
            })
            .child(
                text_view()
                    .markdown(move || Some(SharedString::from(source.get())))
                    .options(MarkdownOptions {
                        streaming: true,
                        ..MarkdownOptions::default()
                    }),
            )
    }

    /// What a frame costs on average: two words added, then a frame
    /// advanced.
    #[derive(Default, Clone, Copy)]
    struct Cost {
        /// Engine time of the words: reading the Markdown and building the
        /// elements, then the commit.
        event: Duration,
        commit: Duration,
        /// Engine time of the frame.
        tick: Duration,
        /// Characters typeset ([`TYPESET`]) for the words, for the frame.
        typeset_add: usize,
        typeset_tick: usize,
        /// Mount items of both.
        items: usize,
    }

    impl Cost {
        fn total(&self) -> Duration {
            self.event + self.commit + self.tick
        }
    }

    /// The average [`Cost`] of `frames` frames of a paragraph of `words`
    /// words at first, after a second of warming up (the words in flight
    /// reach their steady count).
    fn run(words: usize, fading: bool, frames: usize) -> Cost {
        WORDS.set(words);
        let pacer = Arc::new(Mutex::new(Pacer {
            fading: Cell::new(fading),
            last_start: Cell::new(f32::NEG_INFINITY),
            ..Pacer::default()
        }));
        PACER.with_borrow_mut(|p| *p = pacer);
        let mut core = Core::new(ColorsAtDraw, Size::new(px(720.0), px(900.0)));
        // This Core drives the same parser worker as an engine-backed view.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        core.set_task_runtime(runtime.handle().clone());
        let (notify, ready) = std::sync::mpsc::channel();
        core.set_task_notify(Arc::new(move || {
            let _ = notify.send(());
        }));
        let parsed = |core: &mut Core<ColorsAtDraw>| loop {
            core.run_component_tasks();
            if let Some(batch) = core.commit() {
                break batch;
            }
            ready
                .recv_timeout(Duration::from_secs(5))
                .expect("parser publication");
        };
        core.mount_root(&Root::new::<Paragraph>(|| ()));
        let batch = core.commit().expect("the first frame");
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
            .expect("the root's host");
        parsed(&mut core);
        let mut sum = Cost::default();
        let warm = 30;
        for f in 0..warm + frames {
            let (start, typeset) = (Instant::now(), TYPESET.get());
            core.component_event(host, EventKind::Press, &EventPayload::None);
            let event = start.elapsed();
            let queued = core.commit();
            let added = parsed(&mut core);
            let commit = start.elapsed() - event;
            let typeset_add = TYPESET.get() - typeset;
            let (start, typeset) = (Instant::now(), TYPESET.get());
            core.component_event(host, EventKind::Press, &EventPayload::None);
            let ticked = core.commit();
            let (tick, typeset_tick) = (start.elapsed(), TYPESET.get() - typeset);
            if f >= warm {
                sum.event += event;
                sum.commit += commit;
                sum.tick += tick;
                sum.typeset_add += typeset_add;
                sum.typeset_tick += typeset_tick;
                sum.items += queued.map_or(0, |b| b.items.len())
                    + added.items.len()
                    + ticked.map_or(0, |b| b.items.len());
            }
        }
        let n = frames as u32;
        Cost {
            event: sum.event / n,
            commit: sum.commit / n,
            tick: sum.tick / n,
            typeset_add: sum.typeset_add / frames,
            typeset_tick: sum.typeset_tick / frames,
            items: sum.items / frames,
        }
    }

    #[test]
    fn fading_words_typeset_the_paragraph_only_for_new_words() {
        let (off, on) = (run(400, false, 20), run(400, true, 20));
        // A frame only changes colors and hidden runs: the layout stands.
        assert_eq!(on.typeset_tick, 0);
        // New words typeset the paragraph once, as without fading.
        assert_eq!(on.typeset_add, off.typeset_add);
        // The frame mounts the text again, with the layout drawn.
        assert_eq!(on.items, off.items + 1);
    }

    /// `cargo test --release -p nsh-base --test base bench_word_fade -- --ignored --nocapture`;
    /// the numbers are in `docs/dev/performance.md`. Medians of three
    /// rounds, fading off and on in turn.
    #[test]
    #[ignore]
    fn bench_word_fade() {
        let frames = 90;
        let us = |d: Duration| d.as_secs_f64() * 1e6;
        println!(
            "words | fade | words: event + commit µs (chars typeset) | frame µs (chars typeset) | items | extra µs"
        );
        for words in [200, 800, 1600, 3200] {
            let mut rounds: Vec<(Cost, Cost)> = (0..3)
                .map(|_| (run(words, false, frames), run(words, true, frames)))
                .collect();
            rounds.sort_by_key(|(off, on)| on.total().saturating_sub(off.total()));
            let (off, on) = rounds[1];
            for (name, c) in [("off", off), ("on", on)] {
                print!(
                    "{words:>5} | {name:>4} | {:>7.1} + {:>6.1} ({:>6}) | {:>6.1} ({:>5}) | {:>5}",
                    us(c.event),
                    us(c.commit),
                    c.typeset_add,
                    us(c.tick),
                    c.typeset_tick,
                    c.items
                );
                match name {
                    "on" => println!(" | {:>+6.1}", us(on.total()) - us(off.total())),
                    _ => println!(" |"),
                }
            }
        }
    }
}

const TASKS: &str = "- [ ] first\n- [x] second\n  - [ ] nested\n\n<details>\n<summary>More</summary>\n\n\
                     - [x] hidden\n\n</details>\n\n> - [ ] last";

/// Task items at the top, nested, in a closed disclosure and in a quote
/// after it; what their boxes' presses reported.
#[component]
fn PressableTasks() -> impl IntoElement {
    let pressed = signal(Vec::<String>::new());
    view()
        .child(
            text_view()
                .markdown(TASKS)
                .on_task_press(move |e: &TextViewTaskPressEvent| {
                    let report = format!("{}:{}", e.index, e.checked);
                    pressed.update(|p| p.push(report));
                }),
        )
        .child(text(move || {
            format!("Pressed: {}", pressed.get().join(" "))
        }))
}

#[test]
fn a_pressed_task_box_reports_its_place_in_the_document_and_the_state_asked_for() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<PressableTasks>())).unwrap();
    app.wait_for("first").unwrap();
    app.press("label:second").unwrap();
    app.press("label:nested").unwrap();
    // The closed disclosure's task keeps its place before the one after it.
    app.press("label:last").unwrap();
    app.wait_for("Pressed: 1:false 2:true 4:true").unwrap();
    // Opened, closed and opened again, its task is counted from the same place.
    app.press("More").unwrap();
    app.press("label:hidden").unwrap();
    app.press("More").unwrap();
    app.press("More").unwrap();
    app.press("label:hidden").unwrap();
    app.press("label:first").unwrap();
    app.wait_for("Pressed: 1:false 2:true 4:true 3:false 3:false 0:true")
        .unwrap();
}

/// A numbered list with a bulleted one nested in its second item.
#[component]
fn NestedLists() -> impl IntoElement {
    view().child(text_view().markdown("1. one\n2. two\n   - nested\n3. three"))
}

#[test]
fn a_lists_markers_come_before_their_items_in_tree_order() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<NestedLists>())).unwrap();
    app.wait_for("three").unwrap();
    // A selection across the view takes the texts in this order: a drag
    // from a number selects on into its item, and a copy reads each
    // marker before its item's text and its nested list.
    assert_eq!(
        app.screen().texts(),
        ["1.", "one", "2.", "two", "◦", "nested", "3.", "three"]
    );
}

mod large_document {
    //! A long Markdown document opened at once in a scroll view: reading
    //! it, and mounting its blocks, each a row of the same parent.

    use std::{
        cell::RefCell,
        time::{Duration, Instant},
    };

    use nsh_base::{
        text_view,
        text_view::{Document, Parser},
    };
    use nsh_core::{ApproxTextEngine, Core, Size, element::Root, prelude::*};

    thread_local! {
        static SOURCE: RefCell<Option<String>> = const { RefCell::new(None) };
        static DOCUMENT: RefCell<Option<Document>> = const { RefCell::new(None) };
    }

    /// [`SOURCE`] read by the view, or [`DOCUMENT`] read before.
    #[component]
    fn Opened() -> impl IntoElement {
        let view = match SOURCE.take() {
            Some(source) => text_view().markdown(SharedString::from(source)),
            None => text_view().document(DOCUMENT.take().expect("a document")),
        };
        scroll().size_full().child(view)
    }

    /// Sections of a heading, a paragraph with bold words and a link, and
    /// a list of two items, about 50 bytes a block.
    fn document(bytes: usize) -> String {
        let mut text = String::with_capacity(bytes + 200);
        let mut n = 0;
        while text.len() < bytes {
            n += 1;
            text.push_str(&format!(
                "## Section {n}\n\nSome **bold** text and a [link](https://example.com/{n}), with a few more words in each paragraph.\n\n- the first item of the list\n- the second item\n\n"
            ));
        }
        text
    }

    fn mount(culling: bool) -> (Duration, usize) {
        let mut core = Core::new(ApproxTextEngine, Size::new(px(390.0), px(844.0)));
        core.set_content_culling(culling);
        let start = Instant::now();
        core.mount_root(&Root::new::<Opened>(|| ()));
        let mut items = 0;
        // What waits for later turns is made too, as a test driver has it.
        for _ in 0..if culling { 1 } else { 8 } {
            match core.commit() {
                Some(batch) => items += batch.items.len(),
                None => break,
            }
        }
        (start.elapsed(), items)
    }

    /// `cargo test --release -p nsh-base --test base bench_large_document
    /// -- --ignored --nocapture`; the numbers are in `docs/dev/performance.md`.
    #[test]
    #[ignore]
    fn bench_large_document() {
        let ms = |d: Duration| d.as_secs_f64() * 1e3;
        println!("ms to read | ms to mount the read document, culling on / off | both, culling on");
        for kb in [190, 475, 950, 1_900] {
            let source = document(kb * 1_000);
            let start = Instant::now();
            let document = Parser::new().markdown(&source);
            let read = start.elapsed();
            let blocks = document.blocks.len();
            let mut shown = Vec::new();
            for culling in [true, false] {
                DOCUMENT.set(Some(document.clone()));
                shown.push(mount(culling));
            }
            SOURCE.set(Some(source));
            let both = mount(true);
            println!(
                "{kb:>5} KB {blocks:>6} blocks | {:>8.1} | {:>8.1} ({} items) / {:>8.1} ({} items) | {:>8.1}",
                ms(read),
                ms(shown[0].0),
                shown[0].1,
                ms(shown[1].0),
                shown[1].1,
                ms(both.0),
            );
        }
    }
}
