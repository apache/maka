//! `nsh/base/plot` in a Rust app: rows made in Rust, marks styled with the
//! typed paint methods, and the row under the pointer reported to the app.

use nsh_base::plot::{Curve, SliceClass, area, grid, line, pie, plot};
use nsh_core::{
    Size,
    element::{Root, RowAccessor, Rows},
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A week of visitors and the day under the pointer.
#[component]
fn Week() -> impl IntoElement {
    let hovered = signal(None::<u32>);
    let rows = Rows::from_columns(
        7,
        [(
            "visitors".into(),
            vec![1820.0, 2140.0, 1960.0, 2480.0, 2310.0, 1290.0, 1180.0],
        )],
    );
    view()
        .child(
            plot()
                .data(rows)
                .y(RowAccessor::key("visitors"))
                .accessibility_label("Visitors per day")
                .w(px(300.0))
                .h(px(120.0))
                .stroke_width(px(2.0))
                .on_hover_change(move |index: &Option<u32>| hovered.set(*index))
                .child(
                    grid()
                        .y(vec![0.0, 1500.0, 3000.0])
                        .stroke_color(rgb(0xcccccc)),
                )
                .child(area().curve(Curve::Linear).fill_color(rgba(0x3366ff33)))
                .child(line().curve(Curve::Linear).stroke_color(rgb(0x3366ff))),
        )
        .child(text(move || match hovered.get() {
            Some(day) => format!("Day {day}"),
            None => "No day".to_owned(),
        }))
}

#[test]
fn a_rust_plot_reports_the_row_under_the_pointer() {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<Week>())
    };
    // A mouse to hover with: the desktop.
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.wait_for("No day").unwrap();
    // The middle of the plot: the fourth of seven days.
    app.hover("label:Visitors per day").unwrap();
    app.wait_for("Day 3").unwrap();
}

/// A pie of three shares and the slice under the pointer.
#[component]
fn Shares() -> impl IntoElement {
    let hovered = signal(None::<u32>);
    let rows = Rows::from_columns(3, [("share".into(), vec![1.0, 4.0, 3.0])]);
    view()
        .child(
            plot()
                .data(rows)
                .accessibility_label("Shares")
                .w(px(200.0))
                .h(px(200.0))
                .on_hover_change(move |index: &Option<u32>| hovered.set(*index))
                .child(
                    pie()
                        .value(RowAccessor::key("share"))
                        .inner_radius(relative(0.0))
                        .pad_angle(Radians(0.02))
                        .slice_class(SliceClass::from_fn(|i| match i {
                            0 => "fill-chart-1".into(),
                            _ => "fill-chart-2".into(),
                        }))
                        .stroke_color(rgb(0xffffff)),
                ),
        )
        .child(text(move || match hovered.get() {
            Some(slice) => format!("Slice {slice}"),
            None => "No slice".to_owned(),
        }))
}

#[test]
fn a_rust_pie_reports_the_slice_under_the_pointer() {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<Shares>())
    };
    config.environment.os = Os::MacOs;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.wait_for("No slice").unwrap();
    // The middle of a whole pie (no hole) reads as 3 o'clock: inside the second
    // slice, from an eighth of the turn to its half and more.
    app.hover("label:Shares").unwrap();
    app.wait_for("Slice 1").unwrap();
}
