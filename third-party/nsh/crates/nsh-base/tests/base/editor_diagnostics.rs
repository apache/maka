//! `Editor`'s diagnostics as a language server reports them: `unnecessary`
//! code is faded and `deprecated` code struck through, in parts the app
//! restyles, and a hover carries a diagnostic's link, tags and related
//! information to the app.

use std::time::Duration;

use nsh_base::{
    editor::{
        EditorClasses, EditorDiagnostic, EditorDiagnosticCodeDescription,
        EditorDiagnosticRelatedInformation, EditorDiagnosticSeverity, EditorDiagnosticTag,
        EditorHoverEvent, EditorLocation, EditorPosition, EditorRange, editor,
    },
    theme,
};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

const TEXT: &str = "let unused = old();";

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The editor's `classes`.
    classes: EditorClasses,
}

fn range(line: u32, from: u32, to: u32) -> EditorRange {
    EditorRange::new(
        EditorPosition::new(line, from),
        EditorPosition::new(line, to),
    )
}

/// `unused` (columns 4..10) an unnecessary hint with a rule's page and a
/// related place, `old` (13..16) a deprecated warning.
fn diagnostics() -> Vec<EditorDiagnostic> {
    let mut unused = EditorDiagnostic::default();
    unused.range = range(0, 4, 10);
    unused.severity = EditorDiagnosticSeverity::Hint;
    unused.message = "never read".into();
    unused.code = Some("no-unused-vars".into());
    unused.code_description = Some(EditorDiagnosticCodeDescription::new(
        "https://eslint.org/docs/latest/rules/no-unused-vars",
    ));
    unused.tags = vec![EditorDiagnosticTag::Unnecessary];
    unused.related_information = vec![EditorDiagnosticRelatedInformation::new(
        EditorLocation::new(Some("file:///lib.ts".into()), range(2, 0, 6)),
        "declared here",
    )];
    let mut old = EditorDiagnostic::default();
    old.range = range(0, 13, 16);
    old.severity = EditorDiagnosticSeverity::Warning;
    old.message = "old is deprecated".into();
    old.tags = vec![EditorDiagnosticTag::Deprecated];
    vec![unused, old]
}

/// What the app heard of a hover's diagnostics: each one's message, tags,
/// link and related places.
fn hover_text(e: &EditorHoverEvent) -> String {
    let all: Vec<String> = e
        .diagnostics
        .iter()
        .map(|d| {
            let related: Vec<String> = d
                .related_information
                .iter()
                .map(|r| {
                    format!(
                        "{}@{}:{}",
                        r.message,
                        r.location.uri.as_deref().unwrap_or("-"),
                        r.location.range.start.line
                    )
                })
                .collect();
            format!(
                "{} tags={:?} href={} related={}",
                d.message,
                d.tags,
                d.code_description.as_ref().map_or("-", |c| c.href.as_str()),
                related.join(",")
            )
        })
        .collect();
    format!("Hover [{}]", all.join("; "))
}

/// An editor of 600 × 400 (in a view `editor`) showing [`TEXT`] with
/// [`diagnostics`], what it last reported hovering, and a text in the
/// theme's muted color to compare with.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let hovered = signal(String::from("Hover none"));
    view()
        .child(
            view().test_id("editor").w(px(600.0)).h(px(400.0)).child(
                editor()
                    .default_value(TEXT)
                    .diagnostics(diagnostics())
                    .classes(props.classes.clone())
                    .on_hover(move |e: &EditorHoverEvent| hovered.set(hover_text(e)))
                    .size_full(),
            ),
        )
        .child(text(move || hovered.get()))
        .child(text("Muted").text_color(move || theme().muted_foreground))
        .child(text("Plain"))
}

fn start(classes: EditorClasses) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps {
            classes: classes.clone(),
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Hover none").unwrap();
    app
}

#[test]
fn unnecessary_code_is_faded_and_deprecated_code_struck_through() {
    let app = start(EditorClasses::default());
    let screen = app.screen();
    let style = |selector: &str| screen.span_style(selector).unwrap();
    let muted = style("text:Muted").color;
    let unused = style("id:editor >> text:unused");
    assert_eq!(unused.color, muted);
    assert!(!unused.decoration.line_through);
    let old = style("id:editor >> text:old");
    assert!(old.decoration.line_through);
    assert_ne!(old.color, muted);
    // The text around them is drawn as it is.
    let rest = style("id:editor >> text:let");
    assert_ne!(rest.color, muted);
    assert!(!rest.decoration.line_through);
}

#[test]
fn the_apps_classes_restyle_the_tagged_text() {
    let mut classes = EditorClasses::default();
    classes.unnecessary_text = Some("italic".into());
    classes.deprecated_text = Some("no-underline font-bold".into());
    let app = start(classes);
    let screen = app.screen();
    let unused = screen.span_style("id:editor >> text:unused").unwrap();
    assert!(unused.italic);
    let old = screen.span_style("id:editor >> text:old").unwrap();
    assert_eq!(old.font_weight, 700);
    assert!(!old.decoration.line_through);
    assert!(!screen.span_style("id:editor >> text:let").unwrap().italic);
}

#[test]
fn a_hover_carries_the_diagnostics_link_tags_and_related_places() {
    let mut app = start(EditorClasses::default());
    // The middle of the row is in `unused`.
    app.hover(&format!("id:editor >> text:{TEXT}")).unwrap();
    app.wait(Duration::from_millis(400)).unwrap();
    app.wait_for(
        "text:Hover [never read tags=[Unnecessary] \
         href=https://eslint.org/docs/latest/rules/no-unused-vars \
         related=declared here@file:///lib.ts:2]",
    )
    .unwrap();
}
