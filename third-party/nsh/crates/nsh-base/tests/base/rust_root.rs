//! A Rust app's root served `nsh/base`'s core part only, as the web
//! runtime `nsh` builds for it serves it: the root makes components by
//! type, so those of the parts the set leaves out (`Select`, `TextView`)
//! render and work all the same, and the theme's tokens are there.

use nsh_base::{SelectEntry, SelectItem, parts, registry_of, select, text_view};
use nsh_core::{element::Root, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[component]
fn App() -> impl IntoElement {
    let chosen = signal(String::new());
    view()
        .child(
            select()
                .items(vec![
                    SelectItem::new("apple", "Apple"),
                    SelectItem::new("pear", "Pear"),
                ])
                .trigger(text("Fruit"))
                .render_item(|e: &SelectEntry| text(e.title.clone()))
                .on_change(move |v: &Option<SharedString>| {
                    chosen.set(v.as_deref().unwrap_or("none").to_owned());
                })
                .w(px(200.0)),
        )
        .child(text_view().markdown("Served by type"))
        .child(text(move || format!("Chosen {}", chosen.get())))
}

#[test]
fn components_of_parts_left_out_render_by_type() {
    let config = EngineConfig {
        ui_sets: vec![registry_of([parts::core as parts::Part])],
        ..EngineConfig::new(Root::of::<App>())
    };
    let mut app = Headless::start(config).unwrap();
    app.wait_for("Served by type").unwrap();
    app.press("role:combobox").unwrap();
    app.wait_for("role:listbox").unwrap();
    app.press("Pear").unwrap();
    app.wait_for("Chosen pear").unwrap();
}
