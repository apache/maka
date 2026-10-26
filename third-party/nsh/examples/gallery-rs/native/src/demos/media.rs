//! Web and video: WKWebView / WebView, AVPlayer / MediaPlayer (as the TSX
//! gallery's `demos/Media.tsx`): an inline page in the gallery's colors
//! with messages both ways, a web site with its navigation state, back and
//! forward, and a video with controls of the demo's own or the system's.

use nsh_core::prelude::*;

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, Meter, RoundButton,
    Segment, Tone, caption, colors, icon, press, radius, segmented,
};

/// The web site of the second web view.
const SITE: &str = "https://nsh.dev";

/// The video.
const FLOWER: &str = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

/// `color` as CSS's `#rrggbb`.
fn css(color: Hsla) -> String {
    color.alpha(1.0).to_hex().to_ascii_lowercase()
}

/// The inline page in the gallery's colors for the appearance shown (the
/// page reloads when it changes).
fn page(dark: bool) -> String {
    let pick = |c: AdaptiveColor| css(if dark { c.dark } else { c.light });
    let (inset, text, muted, border, on_accent) = (
        pick(colors::INSET),
        pick(colors::TEXT),
        pick(colors::MUTED),
        pick(colors::BORDER),
        pick(colors::ON_ACCENT),
    );
    // The accent finish's gradient and highlight.
    let (gradient, highlight) = if dark {
        ("linear-gradient(180deg, #dbf893 0%, #b3dd4e 100%)", 0.45)
    } else {
        ("linear-gradient(180deg, #d8f88f 0%, #bde65a 100%)", 0.6)
    };
    format!(
        r#"<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html {{ -webkit-text-size-adjust: 100%; }}
  body {{ margin: 0; padding: 16px; background: {inset}; color: {text}; font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.4; }}
  h3 {{ margin: 0 0 4px; font-size: 17px; font-weight: 600; }}
  p {{ margin: 0 0 12px; color: {muted}; font-size: 15px; }}
  button {{ height: 44px; padding: 0 18px; border: 0; border-radius: 10px; background: {gradient}; color: {on_accent}; font-family: inherit; font-size: 15px; font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,{highlight}); }}
  #got {{ margin-top: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid {border}; color: {muted}; font-size: 15px; }}
</style></head>
<body>
<h3>An inline page</h3>
<p>HTML from a string. It sends messages to the app and receives them.</p>
<button onclick="window.nsh.postMessage('hello from the page')">Post to the app</button>
<div id="got">No message from the app yet.</div>
<script>window.addEventListener('message', (e) => {{ document.getElementById('got').textContent = 'From the app: ' + e.data; }});</script>
</body></html>"#
    )
}

/// `75.4` s → `"1:15"`.
fn clock(seconds: f32) -> String {
    let s = seconds.max(0.0) as u32;
    format!("{}:{:02}", s / 60, s % 60)
}

/// A web view's or the video's frame.
fn frame<S: Styled>(element: S) -> S {
    element
        .rounded(px(radius::CONTROL))
        .overflow_hidden()
        .border_1()
        .border_color(colors::BORDER)
}

/// The web site's host, from its last URL (`…` before one).
fn host(state: Option<&WebNavigation>) -> String {
    let url = state.map_or("", |s| s.url.as_str());
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        "…".to_owned()
    } else {
        host.to_owned()
    }
}

/// A web site with its navigation state, back and forward.
#[component]
fn Site() -> impl IntoElement {
    let site = element_ref();
    // The web site's last navigation state.
    let state = signal(None::<WebNavigation>);
    let loading = computed(move || state.with(|s| s.as_ref().is_some_and(|s| s.loading)));
    Card::new()
        .icon(IconName::Search)
        .title("A web site")
        .subtitle(move || {
            state.with(|s| {
                s.as_ref()
                    .map(|s| s.title.clone())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "Navigation state, back and forward".to_owned())
            })
        })
        .right(
            Badge::new(move || if loading.get() { "Loading" } else { "Loaded" })
                .tone(move || if loading.get() { Tone::Warn } else { Tone::Up }),
        )
        .child(
            view()
                .h(px(40.0))
                .flex_row()
                .items_center()
                .gap_2()
                .px(px(14.0))
                .rounded(px(20.0))
                .bg(colors::INSET)
                .finish(Finish::Track)
                .border_1()
                .border_color(colors::BORDER)
                .child(view().size(px(7.0)).rounded(px(3.5)).bg(move || {
                    if loading.get() {
                        colors::WARN
                    } else {
                        colors::UP
                    }
                }))
                .child(
                    text(move || state.with(|s| host(s.as_ref())))
                        .number_of_lines(1)
                        .ellipsize_mode(nsh_core::EllipsizeMode::Middle)
                        .flex_1()
                        .text_size(px(15.0))
                        .text_color(colors::MUTED),
                ),
        )
        .child(frame(
            web_view(SITE)
                .element_ref(&site)
                .h(px(340.0))
                .bg(colors::INSET)
                .on_navigation_state_change(move |s: &WebNavigation| state.set(Some(s.clone()))),
        ))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(10.0))
                .child(nav_button(
                    true,
                    "Back",
                    move || state.with(|s| s.as_ref().is_some_and(|s| s.can_go_back)),
                    move |_: &()| site.go_back(),
                ))
                .child(nav_button(
                    false,
                    "Forward",
                    move || state.with(|s| s.as_ref().is_some_and(|s| s.can_go_forward)),
                    move |_: &()| site.go_forward(),
                ))
                .child(view().flex_1())
                .child(
                    Button::new("Reload", move |_: &()| site.reload())
                        .variant(ButtonVariant::Secondary),
                ),
        )
}

/// The video, with controls of the demo's own or the system's.
#[component]
fn Player() -> impl IntoElement {
    let player = element_ref();
    // The video shows the platform's controls.
    let system_controls = signal(false);
    // The video plays (it starts paused).
    let playing = signal(false);
    // The video's position and length, in seconds.
    let time = signal(0.0_f32);
    let duration = signal(0.0_f32);
    let buffering = signal(false);
    let status = computed(move || {
        if buffering.get() {
            ("Buffering", Tone::Warn)
        } else if !playing.get() {
            ("Paused", Tone::Neutral)
        } else {
            ("Playing", Tone::Accent)
        }
    });
    let controls = move || {
        view()
            .flex_row()
            .items_center()
            .gap_3()
            .child(RoundButton::new(
                move || {
                    if playing.get() {
                        IconName::Pause
                    } else {
                        IconName::Play
                    }
                },
                move || if playing.get() { "Pause" } else { "Play" },
                move |_: &()| playing.update(|p| *p = !*p),
            ))
            .child(
                view()
                    .flex_1()
                    .gap_2()
                    .child(Meter::new(move || {
                        let (time, duration) = (time.get(), duration.get());
                        if duration > 0.0 { time / duration } else { 0.0 }
                    }))
                    .child(
                        view()
                            .flex_row()
                            .child(
                                text(move || clock(time.get()))
                                    .flex_1()
                                    .text_size(px(13.0))
                                    .text_color(colors::MUTED)
                                    .tabular_nums(),
                            )
                            .child(
                                text(move || clock(duration.get()))
                                    .text_size(px(13.0))
                                    .text_color(colors::FAINT)
                                    .tabular_nums(),
                            ),
                    ),
            )
            .child(
                Button::new("Restart", move |_: &()| player.seek(0.0))
                    .variant(ButtonVariant::Secondary),
            )
    };
    Card::new()
        .icon(IconName::Play)
        .title("Video")
        .subtitle("AVPlayer / MediaPlayer")
        .right(Badge::new(move || status.get().0).tone(move || status.get().1))
        .child(frame(
            video(FLOWER)
                .element_ref(&player)
                .paused(move || !playing.get())
                .muted(true)
                .repeat(true)
                .controls(system_controls)
                .h(px(200.0))
                .bg(rgb(0x000000))
                .on_load(move |e: &VideoInfo| duration.set(e.duration))
                .on_buffer(move |b: &bool| buffering.set(*b))
                .on_progress(move |e: &VideoProgress| {
                    batch(|| {
                        time.set(e.current_time);
                        duration.set(e.duration);
                    });
                }),
        ))
        .child(when(move || !system_controls.get(), controls))
        .child(
            segmented()
                .options([
                    Segment::new("Own controls"),
                    Segment::new("System controls"),
                ])
                .selected(move || u32::from(system_controls.get()))
                .on_change(move |&i: &u32| {
                    system_controls.set(i == 1);
                }),
        )
}

/// A round chevron button, 44 pt (`flip`: pointing back), taking presses
/// while `enabled` holds.
fn nav_button(
    flip: bool,
    label: &'static str,
    enabled: impl Fn() -> bool + 'static,
    on_press: impl Into<Listener<()>>,
) -> impl IntoElement {
    let on_press: Listener<()> = on_press.into();
    press()
        .disabled(move || !enabled())
        .label(label)
        .hit_slop(4.0)
        .on_press(on_press)
        .child(
            view()
                .size(px(44.0))
                .rounded(px(22.0))
                .bg(colors::RAISED)
                .finish(Finish::Raised)
                .border_1()
                .border_color(colors::BORDER)
                .items_center()
                .justify_center()
                .when(flip, |v| v.rotate(deg(180.0)))
                .child(icon().name(IconName::Chevron).size(18.0).tint(colors::TEXT)),
        )
}

/// The inline page and the messages between it and the app. The page's
/// HTML follows the appearance (it reloads when it changes).
fn messaging() -> impl IntoElement {
    let web = element_ref();
    // What the inline page posted last.
    let message = signal(String::new());
    // What the app posted last (`hi #N`), 0 before.
    let sent = signal(0_u32);
    Card::new()
        .icon(IconName::Media)
        .title("Web view")
        .subtitle("Inline HTML, with messages both ways")
        .child(frame(
            web_view_html(move || page(dark()), None)
                .element_ref(&web)
                .h(px(210.0))
                .bg(colors::INSET)
                .on_message(move |data: &str| message.set(data.to_owned())),
        ))
        .child(caption(
            "From the page",
            Some(move || {
                message.with(|m| {
                    if m.is_empty() {
                        "—".to_owned()
                    } else {
                        m.clone()
                    }
                })
            }),
        ))
        .child(caption(
            "To the page",
            Some(move || {
                let sent = sent.get();
                if sent > 0 {
                    format!("hi #{sent}")
                } else {
                    "—".to_owned()
                }
            }),
        ))
        .child(Button::new("Post to the page", move |_: &()| {
            let n = (nsh_core::time::unix_ms() as u64 % 1000) as u32;
            sent.set(n);
            web.post_message(format!("hi #{n}"));
        }))
}

/// The demo's page: an inline page, a web site and a video, with what they
/// tell the app.
#[component]
pub(crate) fn Media() -> impl IntoElement {
    DemoPage::new().card(messaging).card(site).card(player)
}
