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

//! Exercise the real component's CPU worker while its engine keeps rendering.
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use nsh_base::{
    MarkdownPlugin, MarkdownPlugins, text_view,
    text_view::{Block, ParseContext, mdast},
};
use nsh_core::{
    ListContentStyle, MountItem, NodeId, Size,
    element::{EngineContext, Root, engine_context},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

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
                .child(text(move || format!("extent {:.0}", extent.get())).text_size(px(10.0))),
        )
        .child(
            scroll()
                .element_ref(&page)
                .h(px(200.0))
                .w_full()
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
    app.press("id:far").unwrap();
    app.wait_for_gone("text:/Paragraph00/", Duration::from_secs(5))
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
