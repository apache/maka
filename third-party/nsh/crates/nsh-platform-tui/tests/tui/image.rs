//! Image views: pictures drawn in half blocks, or through the kitty
//! graphics protocol's Unicode placeholders where the terminal has them.

use std::sync::Arc;

use nsh_core::{ResizeMode, prelude::*};
use nsh_platform_tui::{App, AppOptions, AppView, Graphics, MeasuredBackend, Root};
use ratatui_core::{backend::TestBackend, style::Color, terminal::Terminal};

use super::app::{draw_until, surface};

/// Draws through the measured backend until `done` holds for its screen.
fn draw_measured_until(
    view: &mut AppView,
    terminal: &mut Terminal<MeasuredBackend<TestBackend>>,
    rx: &crossbeam_channel::Receiver<()>,
    what: &str,
    done: impl Fn(&TestBackend) -> bool,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if done(terminal.backend().inner()) {
            return;
        }
        let rows: Vec<String> = (0..terminal.backend().inner().buffer().area.height)
            .map(|y| {
                (0..terminal.backend().inner().buffer().area.width)
                    .map(|x| {
                        terminal.backend().inner().buffer()[(x, y)]
                            .symbol()
                            .chars()
                            .last()
                            .unwrap_or(' ')
                    })
                    .collect()
            })
            .collect();
        assert!(rx.recv_deadline(deadline).is_ok(), "{what}: {rows:#?}");
    }
}

/// One pixel red over one pixel blue.
const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAADUlEQVR4nGP4zwAC/wEIAAH/2ZC7NQAAAABJRU5ErkJggg==";

const RED: Color = Color::Rgb(255, 0, 0);
const BLUE: Color = Color::Rgb(0, 0, 255);

#[component]
fn Picture() -> impl IntoElement {
    let shown = signal(true);
    let loaded = signal(String::new());
    view()
        .flex_1()
        .child(when(shown, move || {
            image(PNG)
                .object_fit(ResizeMode::Stretch)
                .w(px(80.0))
                .h(px(16.0))
                .on_load(
                    move |size: &nsh_core::Size<nsh_core::geometry::DevicePixels>| {
                        loaded.set(format!("{}x{}", size.width.0, size.height.0))
                    },
                )
        }))
        .child(
            view()
                .on_press(move |_: &()| shown.set(false))
                .child(text(move || format!("ready {}", loaded.get()))),
        )
}

#[test]
fn a_picture_is_drawn_in_half_blocks_and_reports_its_size() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Picture>(|| ()))).unwrap();
    // `onLoad` gives the picture's own pixels.
    draw_until(&mut view, &mut terminal, &rx, "ready 1x2");
    let buffer = terminal.backend().buffer();
    // 10 × 1 Cells, two pixels down: red over blue.
    for x in 0..10 {
        let cell = &buffer[(x, 0)];
        assert_eq!((cell.symbol(), cell.fg, cell.bg), ("▀", RED, BLUE), "{x}");
    }
    assert_eq!(buffer[(10, 0)].symbol(), " ", "only its box");
}

/// A picture transparent until it has loaded, as an avatar's is.
#[component]
fn Hidden() -> impl IntoElement {
    let loaded = signal(false);
    view().flex_1().child(
        image(PNG)
            .object_fit(ResizeMode::Stretch)
            .w(px(80.0))
            .h(px(16.0))
            .opacity(move || if loaded.get() { 1.0_f32 } else { 0.0 })
            .on_load(move |_: &nsh_core::Size<nsh_core::geometry::DevicePixels>| loaded.set(true)),
    )
}

#[test]
fn a_transparent_picture_loads_and_shows_once_it_has_loaded() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Hidden>(|| ()))).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if terminal.backend().buffer()[(0, 0)].symbol() == "▀" {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "never loaded");
    }
    let cell = &terminal.backend().buffer()[(0, 0)];
    assert_eq!((cell.fg, cell.bg), (RED, BLUE));
}

fn kitty() -> (AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = AppOptions::default();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    options.capabilities.graphics = Graphics::KittyPlaceholders;
    options.capabilities.cell_pixels = Some(nsh_core::Size::new(
        nsh_core::geometry::DevicePixels(10),
        nsh_core::geometry::DevicePixels(20),
    ));
    (AppView::new(options), rx)
}

#[test]
fn kitty_placeholders_place_the_transmitted_picture_and_delete_it_when_gone() {
    let (mut view, rx) = kitty();
    let backend = view.measure_backend(TestBackend::new(12, 4));
    let mut terminal = Terminal::new(backend).unwrap();
    view.load(App::Rust(Root::new::<Picture>(|| ()))).unwrap();
    let placed =
        |backend: &TestBackend| backend.buffer()[(1, 0)].symbol().starts_with('\u{10EEEE}');
    draw_measured_until(&mut view, &mut terminal, &rx, "the placeholders", placed);
    let buffer = terminal.backend().inner().buffer();
    // The first Cell drawn carries the transmission: a PNG with a virtual
    // placement of the box's 10 × 1 Cells, answers suppressed.
    let first = buffer[(0, 0)].symbol();
    assert!(
        first.starts_with("\x1b_Ga=T,U=1,f=100,t=d,q=2,i=1,c=10,r=1,"),
        "{first:?}"
    );
    assert!(
        first.ends_with("\x1b\\\u{10EEEE}\u{305}\u{305}"),
        "row 0, column 0"
    );
    // Each Cell names its row and column; image 1 is its foreground.
    let cell = &buffer[(3, 0)];
    assert_eq!(cell.symbol(), "\u{10EEEE}\u{305}\u{310}");
    assert_eq!(cell.fg, Color::Rgb(0, 0, 1));
    assert_eq!(buffer[(10, 0)].symbol(), " ", "only its box");
    // Gone: its data is deleted with the next frame drawn.
    for kind in [
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
    ] {
        assert_eq!(
            view.handle(super::app::mouse(kind, 1, 1)),
            nsh_platform_tui::Handled::Yes
        );
    }
    draw_measured_until(&mut view, &mut terminal, &rx, "the picture gone", |b| {
        !placed(b)
    });
    let drawn: String = terminal
        .backend()
        .inner()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(drawn.contains("\x1b_Ga=d,d=I,i=1,q=2\x1b\\"), "{drawn:?}");
}

#[component]
fn Missing() -> impl IntoElement {
    let error = signal(String::new());
    view()
        .flex_1()
        .child(
            image("asset:/missing.png")
                .w(px(80.0))
                .h(px(32.0))
                .on_error(move |message: &str| error.set(message.to_owned())),
        )
        .child(text(move || {
            format!(
                "ready {}",
                if error.get().is_empty() { "" } else { "failed" }
            )
        }))
}

#[test]
fn a_picture_that_cannot_load_reports_its_error_and_stays_blank() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 4)).unwrap();
    view.load(App::Rust(Root::new::<Missing>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready failed");
    let buffer = terminal.backend().buffer();
    assert!((0..10).all(|x| buffer[(x, 0)].symbol() == " "));
}

/// `Image.getSize` reads the picture's header in the terminal, as on every
/// platform; an image that cannot load rejects with its error.
#[cfg(feature = "js")]
#[test]
fn get_size_reads_the_picture() {
    let source = format!(
        r#"import {{ Image, mount, signal, Text }} from "nsh";
const shown = signal("waiting");
const settled = (p: Promise<{{ width: number; height: number }}>) =>
  p.then((s) => `${{s.width}}x${{s.height}}`, () => "rejected");
setTimeout(async () => {{
  const sizes = await Promise.all([settled(Image.getSize("{PNG}")), settled(Image.getSize("asset:/missing.png"))]);
  shown.set(sizes.join(" "));
}}, 0);
mount(() => <Text>{{shown()}}</Text>);
"#
    );
    let code = nsh_bundler::compile_module("Size.tsx", &source, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(30, 2)).unwrap();
    view.load(nsh_platform_tui::Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "1x2 rejected");
}

#[component]
fn Proportioned() -> impl IntoElement {
    // A box of no height and an aspect ratio, decoded here and measured by
    // a natural size it never gets there (a remote picture not loaded).
    let picture = |source: &'static str| image(source).w(px(80.0)).aspect_ratio(2.0);
    view()
        .flex_1()
        .child(picture(PNG))
        .child(text("decoded"))
        .child(picture("https://example.invalid/missing.png"))
        .child(text("remote"))
}

#[test]
fn an_image_of_one_side_takes_the_other_from_its_aspect_ratio() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(20, 12)).unwrap();
    view.load(App::Rust(Root::new::<Proportioned>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "remote");
    let buffer = terminal.backend().buffer();
    let line = |y: u16| -> String { (0..7).map(|x| buffer[(x, y)].symbol()).collect() };
    // 80pt wide is 10 columns; half of it, 40pt, is 2 rows of 16pt.
    assert_eq!(line(2), "decoded");
    assert_eq!(line(5), "remote ");
}

/// A list row led by a glyph-sized icon, then an avatar a little larger.
#[component]
fn IconRow() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .flex_row()
                .gap(px(8.0))
                .child(image(PNG).w(px(16.0)).h(px(16.0)))
                .child(text("Inbox")),
        )
        .child(
            view()
                .flex_row()
                .gap(px(8.0))
                .child(
                    image(PNG)
                        .object_fit(ResizeMode::Stretch)
                        .w(px(24.0))
                        .h(px(24.0)),
                )
                .child(text("Jason")),
        )
}

#[test]
fn an_icon_sized_picture_is_left_out_and_its_label_closes_up() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(12, 3)).unwrap();
    view.load(App::Rust(Root::new::<IconRow>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Jason");
    let buffer = terminal.backend().buffer();
    let row = |y: u16| -> String { (0..12).map(|x| buffer[(x, y)].symbol()).collect() };
    // Half blocks would show the icon only as a blot of color.
    assert_eq!(row(0), "Inbox       ");
    // The avatar keeps its picture, in front of its label.
    assert_eq!(buffer[(0, 1)].symbol(), "▀", "{:?}", row(1));
    assert!(row(1).contains("Jason"), "{:?}", row(1));
}
