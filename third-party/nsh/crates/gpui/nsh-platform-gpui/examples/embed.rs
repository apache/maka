//! A GPUI app embedding nsh with a native component of its own: runs
//! `examples/embedded` (the app the iOS and Android embedding samples run),
//! whose badge (`embed.badge`) is a GPUI element this app draws.
//!
//! ```sh
//! cargo run -p nsh-cli -- build examples/embedded -o target/embedded
//! (cd crates/gpui && cargo run -p nsh-platform-gpui --example embed -- ../../target/embedded/bundle.nshc)
//! ```
//!
//! With feature `dev` it also takes a dev server's URL and reloads the app
//! as its sources change (`AppView::connect_dev_server`):
//!
//! ```sh
//! cargo run -p nsh-cli -- dev examples/embedded
//! (cd crates/gpui && cargo run -p nsh-platform-gpui --features dev --example embed -- ws://127.0.0.1:8790/ws)
//! ```
//!
//! The badge is laid out by nsh (sized to its text with
//! `ComponentContext::set_size`), takes its own clicks (GPUI's), emits
//! `tap` with the count and flashes on JS's `pulse` command. It takes the
//! keyboard: Tab reaches it among the app's text fields, Space or Enter
//! taps it. The view's channel (`AppView::host`, `nsh/host` in the app)
//! gives the app its launch parameters and a message, answers its "time"
//! call and hears its "tapped" posts.

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn main() {
    use std::{rc::Rc, time::Instant};

    use nsh_platform_gpui::{
        App, AppOptions, AppSource, AppView, Bundle, ComponentContext, NativeComponent,
        gpui::{
            self, AnyElement, AppContext, Bounds, FocusHandle, InteractiveElement, IntoElement,
            ParentElement, StatefulInteractiveElement, Styled, Window, WindowBounds, WindowOptions,
            div, px, rgb, size,
        },
    };
    use serde_json::{Value, json};

    /// How long the badge flashes after `pulse`.
    const PULSE: f32 = 0.35;

    /// The host app's badge: a label it draws, sized to its text.
    struct Badge {
        cx: ComponentContext,
        text: String,
        color: u32,
        taps: Rc<std::cell::Cell<u32>>,
        pulsed: Option<Instant>,
        /// The size reported to nsh.
        reported: (f32, f32),
        /// Its focus handle (made with the first frame): Tab reaches the
        /// badge, Space or Enter taps it.
        focus: Option<FocusHandle>,
    }

    impl NativeComponent for Badge {
        fn render(&mut self, window: &mut Window, cx: &mut gpui::App) -> Option<AnyElement> {
            let focus = self.focus.get_or_insert_with(|| cx.focus_handle()).clone();
            // Sized to the text: nsh lays the badge out with it.
            let run = gpui::TextRun {
                len: self.text.len(),
                font: window.text_style().font(),
                color: gpui::white(),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let line =
                window
                    .text_system()
                    .shape_line(self.text.clone().into(), px(15.0), &[run], None);
            let wanted = ((f32::from(line.width) + 32.0).ceil(), 40.0);
            if wanted != self.reported {
                self.reported = wanted;
                self.cx.set_size(wanted.0, wanted.1);
            }
            // A flash that fades out after `pulse`.
            let flash = self
                .pulsed
                .map(|t| 1.0 - t.elapsed().as_secs_f32() / PULSE)
                .filter(|f| *f > 0.0);
            if flash.is_some() {
                window.request_animation_frame();
            }
            let mut color = gpui::Hsla::from(rgb(self.color));
            if let Some(f) = flash {
                color.l = (color.l + 0.3 * f).min(1.0);
            }
            let (cx, taps) = (self.cx.clone(), self.taps.clone());
            let tap = move || {
                taps.set(taps.get() + 1);
                cx.emit("tap", json!({ "count": taps.get() }));
            };
            Some(
                div()
                    .id("badge")
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(color)
                    .text_color(gpui::white())
                    .text_size(px(15.0))
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.9))
                    .track_focus(&focus)
                    .focus(|s| s.border_2().border_color(gpui::white()))
                    .child(self.text.clone())
                    // Also Space and Enter while focused (GPUI's clicks).
                    .on_click(move |_, _, _| tap())
                    .into_any_element(),
            )
        }

        fn focus_handle(&self) -> Option<FocusHandle> {
            self.focus.clone()
        }

        fn set_prop(
            &mut self,
            name: &str,
            value: Option<&Value>,
            _window: &mut Window,
            _cx: &mut gpui::App,
        ) {
            match name {
                "text" => self.text = value.and_then(Value::as_str).unwrap_or("").to_owned(),
                "color" => {
                    let hex = value.and_then(Value::as_str).unwrap_or("#8250df");
                    self.color =
                        u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0x8250df);
                }
                _ => {}
            }
        }

        fn command(&mut self, name: &str, _args: &Value, window: &mut Window, _cx: &mut gpui::App) {
            if name == "pulse" {
                self.pulsed = Some(Instant::now());
                window.refresh();
            }
        }
    }

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "target/embedded/bundle.nshc".to_owned());
    let source = match path {
        #[cfg(feature = "dev")]
        url if url.starts_with("ws://") || url.starts_with("wss://") => AppSource::DevServer(url),
        // SAFETY: the bundle is the one the developer built and named.
        path => AppSource::Bundle(
            unsafe { Bundle::read_trusted(path.as_ref()) }.expect("a bundle built by `nsh build`"),
        ),
    };
    gpui_platform::application().run(move |cx| {
        let bounds = Bounds::centered(None, size(px(420.0), px(360.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // Full frame rate while unfocused too, as nsh's own windows.
            inactive_frame_interval: None,
            ..Default::default()
        };
        cx.open_window(options, move |window, cx| {
            cx.new(|cx| {
                let view = AppView::new(AppOptions::default(), window, cx);
                view.register_component(
                    "embed.badge",
                    Rc::new(|cx| {
                        Box::new(Badge {
                            cx,
                            text: String::new(),
                            color: 0x8250df,
                            taps: Default::default(),
                            pulsed: None,
                            reported: (0.0, 0.0),
                            focus: None,
                        })
                    }),
                );
                // The channel with the app (`nsh/host`): what it reads at
                // start, the call it makes, the posts it sends and an event.
                let host = view.host();
                let mut params = serde_json::Map::new();
                params.insert("user".into(), json!("Ada"));
                host.set_params(params);
                host.handle("time", |call| {
                    let secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_secs());
                    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
                    call.resolve(json!({ "time": format!("{h:02}:{m:02}:{s:02} UTC") }));
                });
                host.handle("tapped", |call| {
                    eprintln!("the app posted tapped: {}", call.data())
                });
                // Kept until the app listens.
                let _ = host.send("message", json!({ "text": "Hello from GPUI" }));
                // Also while a dev server shows them over the app.
                view.on_error(|message| eprintln!("embedded app: {message}"));
                match source {
                    AppSource::Bundle(bundle) => view.load(App::Js(bundle)),
                    #[cfg(feature = "dev")]
                    AppSource::DevServer(url) => view.connect_dev_server(url, cx),
                    AppSource::Rust(root) => view.load(App::Rust(root)),
                }
                view
            })
        })
        .expect("a window");
        cx.on_window_closed(|cx, _| cx.quit()).detach();
    });
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn main() {}
