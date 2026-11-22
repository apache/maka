//! The web backend's text rules, input encoding, event payloads and bound
//! animated values, off WebAssembly: the crate itself is empty there
//! (`lib.rs`), so this binary builds the modules that depend on nothing of
//! the browser from their sources.

#[path = "../../src/text/css.rs"]
#[allow(dead_code)]
mod css;

#[path = "../../src/text/hit.rs"]
#[allow(dead_code, reason = "the wasm-only layout uses the rest")]
mod hit;

#[path = "../../src/text/wrap.rs"]
#[allow(dead_code)]
mod wrap;

#[path = "../../src/encode/input.rs"]
mod input;

#[path = "../../src/event.rs"]
mod event;

#[path = "../../src/animation.rs"]
#[allow(dead_code, reason = "the wasm-only frame loop uses the rest")]
mod animation;

/// What `animation.rs` writes through (`src/encode.rs` needs the browser):
/// the `["a", view, prop, value]` items it makes, in order.
mod encode {
    use nsh_core::{Color, Transform};

    #[derive(Default)]
    pub(crate) struct Out(pub(crate) Vec<(u32, String, String)>);

    impl Out {
        pub(crate) fn animation(&mut self, id: u32, prop: &str, value: &str) {
            self.0.push((id, prop.to_owned(), value.to_owned()));
        }
    }

    pub(crate) fn css_color(c: Color) -> String {
        format!("#{:08x}", c.0)
    }

    pub(crate) fn css_transform(_: &Transform, value: impl Fn(usize) -> Option<f32>) -> String {
        format!("{:?}", value(0))
    }
}

mod animated;
mod events;
mod fonts;
mod hit_testing;
mod lines;
