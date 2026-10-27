//! The demos and the gallery's index.

mod animations;
mod canvas;
mod chat;
mod components;
mod file_drop;
mod form;
mod gestures;
mod images;
mod lists;
mod media;
mod navigation;
mod photos;
mod physics;
mod scrolling;
mod stocks;
mod storage;
mod styles;
mod system;
mod text_demo;
mod typed_styles;

use std::rc::Rc;

use nsh_base::nav_page;
use nsh_core::{
    element::{AnyElement, Screen},
    prelude::*,
};

use crate::{
    nav::{self, Route},
    ui::{
        IconName, IconTile, MONO, PageHeader, appear, colors, header, icon, press, radius, titled,
        with_header,
    },
};

/// A demo of the index: its name, what it shows, its icon and its
/// screen's content.
pub(crate) struct Demo {
    pub(crate) name: &'static str,
    pub(crate) detail: &'static str,
    pub(crate) icon: IconName,
    pub(crate) content: fn() -> AnyElement,
}

impl Demo {
    /// Its group's title.
    pub(crate) fn group(&'static self) -> &'static str {
        GROUPS
            .iter()
            .find(|g| g.demos.iter().any(|d| std::ptr::eq(d, self)))
            .map_or("", |g| g.title)
    }

    /// Its screen as the phone layout pushes it over the index: its name
    /// in the header over its content.
    pub(crate) fn route(&'static self) -> Route {
        let (name, content) = (self.name, self.content);
        Route {
            key: self.key().into(),
            screen: Rc::new(move || {
                titled(name).child(view().flex_1().bg(colors::BACKGROUND).child(content()))
            }),
        }
    }

    /// Its route's key: apart from the keys of the screens demos push.
    pub(crate) fn key(&self) -> String {
        format!("demo:{}", self.name)
    }
}

/// A group of the index.
pub(crate) struct Group {
    pub(crate) title: &'static str,
    pub(crate) demos: &'static [Demo],
}

/// The demos, by what they show (a static: the shell tells them apart by
/// address).
pub(crate) static GROUPS: &[Group] = &[
    Group {
        title: "Apps",
        demos: &[
            Demo {
                name: "Stocks",
                detail: "A live watchlist and a stock: candles, depth, the tape, a tick every 50 ms",
                icon: IconName::Stocks,
                content: || stocks::stocks().into_element(),
            },
            Demo {
                name: "AI Chat",
                detail: "Streaming replies, tools, reasoning, attachments, errors",
                icon: IconName::Chat,
                content: || chat::chat().into_element(),
            },
            Demo {
                name: "Photos",
                detail: "A long recycled list: images, pull to refresh, paging",
                icon: IconName::Photos,
                content: || photos::photos().into_element(),
            },
        ],
    },
    Group {
        title: "Layout and lists",
        demos: &[
            Demo {
                name: "Lists",
                detail: "Columns, sticky sections, a chat, horizontal lists",
                icon: IconName::Lists,
                content: || lists::lists().into_element(),
            },
            Demo {
                name: "Scrolling",
                detail: "Paging, snapping, zoom, scroll events, prepending, keyboard taps",
                icon: IconName::Scroll,
                content: || scrolling::scrolling().into_element(),
            },
            Demo {
                name: "Navigation",
                detail: "Header options, modals, the back button, safe areas",
                icon: IconName::Nav,
                content: || navigation::navigation().into_element(),
            },
            Demo {
                name: "Form",
                detail: "Inputs, keyboard types, the keyboard over the content",
                icon: IconName::Form,
                content: || form::form().into_element(),
            },
        ],
    },
    Group {
        title: "Touch and motion",
        demos: &[
            Demo {
                name: "File drops",
                detail: "Desktop file URLs, destination entry and exit",
                icon: IconName::Gestures,
                content: || file_drop::file_drop().into_element(),
            },
            Demo {
                name: "Gestures",
                detail: "Pinch, rotate, press states, hit slop, pointer events",
                icon: IconName::Gestures,
                content: || gestures::gestures().into_element(),
            },
            Demo {
                name: "Physics",
                detail: "Drags and springs on the UI thread",
                icon: IconName::Physics,
                content: || physics::physics().into_element(),
            },
            Demo {
                name: "Animations",
                detail: "Easing, sequence / parallel / stagger / loop, springs, interpolation",
                icon: IconName::Animation,
                content: || animations::animations().into_element(),
            },
        ],
    },
    Group {
        title: "Drawing and type",
        demos: &[
            Demo {
                name: "Canvas",
                detail: "2D context: paths, gradients, text, images, native animation",
                icon: IconName::Canvas,
                content: || canvas::canvas_demo().into_element(),
            },
            Demo {
                name: "Styles",
                detail: "Corners, borders, shadows, clipping, 3D transforms",
                icon: IconName::Styles,
                content: || styles::styles().into_element(),
            },
            Demo {
                name: "Typed styles",
                detail: "Tailwind's utilities as typed methods: variants, grid, shadows, motion",
                icon: IconName::Tailwind,
                content: || typed_styles::typed_styles().into_element(),
            },
            Demo {
                name: "Text",
                detail: "Fonts, spans, inline views and images, decorations, truncation, languages",
                icon: IconName::Text,
                content: || text_demo::text_demo().into_element(),
            },
            Demo {
                name: "Images",
                detail: "Resize modes, tint, GIF / WebP, placeholders, blur, fade",
                icon: IconName::Image,
                content: || images::images().into_element(),
            },
        ],
    },
    Group {
        title: "Platform",
        demos: &[
            Demo {
                name: "Components",
                detail: "Press feedback, sheet, layout animation, input accessory, modal options",
                icon: IconName::Components,
                content: || components::components().into_element(),
            },
            Demo {
                name: "Web and video",
                detail: "WKWebView / WebView, AVPlayer / MediaPlayer",
                icon: IconName::Media,
                content: || media::media().into_element(),
            },
            Demo {
                name: "System",
                detail: "Status bar, alerts, action sheets, environment, timers, HTTP",
                icon: IconName::System,
                content: || system::system().into_element(),
            },
            Demo {
                name: "Storage",
                detail: "Storage from Rust: a launch count, a note saved as you type, the stored keys",
                icon: IconName::Storage,
                content: || storage::storage_demo().into_element(),
            },
        ],
    },
];

/// A demo's row of the index: a tap pushes its screen.
fn demo_row(demo: &'static Demo, first: bool) -> AnyElement {
    let open = move |_: &()| nav::push_route(demo.route());
    press()
        .scale(0.98)
        .label(demo.name)
        .on_press(open)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(14.0))
                .p_3()
                .when(!first, |v| v.border_t_1().border_t_color(colors::LINE))
                .child(IconTile::new(demo.icon).size(38.0))
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(
                            text(demo.name)
                                .text_size(px(16.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text(demo.detail)
                                .number_of_lines(2)
                                .text_size(px(13.0))
                                .line_height(px(18.0))
                                .text_color(colors::MUTED),
                        ),
                )
                .child(
                    icon()
                        .name(IconName::Chevron)
                        .size(16.0)
                        .tint(colors::FAINT),
                ),
        )
        .into_element()
}

/// The index: the demos by group; a tap pushes one.
pub(crate) fn index() -> Screen {
    let groups: Vec<AnyElement> = GROUPS
        .iter()
        .enumerate()
        .map(|(g, group)| {
            let rows: Vec<AnyElement> = group
                .demos
                .iter()
                .enumerate()
                .map(|(i, demo)| demo_row(demo, i == 0))
                .collect();
            appear()
                .index(g as u32 + 1)
                .child(
                    view()
                        .gap_2()
                        .child(
                            view()
                                .flex_row()
                                .items_baseline()
                                .px_1()
                                .child(
                                    text(group.title.to_uppercase())
                                        .flex_1()
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::MUTED)
                                        .letter_spacing(px(0.4)),
                                )
                                .child(
                                    text(group.demos.len().to_string())
                                        .text_size(px(12.0))
                                        .text_color(colors::FAINT)
                                        .font_family(MONO),
                                ),
                        )
                        .child(
                            view()
                                .bg(colors::SURFACE)
                                .rounded(px(radius::CARD))
                                .border_curve(BorderCurve::Continuous)
                                .border_1()
                                .border_color(colors::BORDER)
                                .overflow_hidden()
                                .children(rows),
                        ),
                )
                .into_element()
        })
        .collect();
    with_header(
        header(nav_page().key("index").title("Rust Gallery")),
        || PageHeader::new("Rust Gallery").back(false),
    )
    .child(
        scroll()
            .flex_1()
            .bg(colors::BACKGROUND)
            .child(view().p_4().pb(px(40.0)).gap_5().children(groups)),
    )
}
