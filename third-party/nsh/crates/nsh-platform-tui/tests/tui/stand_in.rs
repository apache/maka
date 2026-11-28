//! What a terminal cannot show (a video, a web page, a native component
//! with no terminal rendering) says so in its box instead of leaving it
//! blank.

use nsh_core::prelude::*;
use nsh_platform_tui::{App, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::{
    app::{draw_until, surface},
    dock::dump,
};

#[component]
fn Unsupported() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("top"))
        .child(video("https://example.com/a.mp4").w(px(200.0)).h(px(60.0)))
        .child(
            web_view("https://example.com")
                .label("Docs")
                .w(px(200.0))
                .h(px(60.0)),
        )
        .child(native("acme.gauge").w(px(300.0)).h(px(40.0)))
}

#[test]
fn unsupported_content_says_what_it_is() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
    view.load(App::Rust(Root::new::<Unsupported>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "acme.gauge");
    let screen = dump(&terminal);
    assert!(screen.contains("[Video: not available"), "{screen}");
    assert!(screen.contains("[Web page: Docs]"), "{screen}");
    assert!(screen.contains("[acme.gauge: not available"), "{screen}");
}
