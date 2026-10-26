//! The engine's integration tests, one test binary: every module links the
//! bundler, QuickJS and the core, so separate binaries would each carry
//! their own copy (about a gigabyte of objects apiece in debug builds).
//!
//! Benchmarks are `#[ignore]`d tests, run in release one at a time (in
//! parallel they skew each other): `cargo test --release -p nsh-engine
//! --test engine bench_components -- --ignored --nocapture
//! --test-threads=1` (or `bench_gallery_scroll`).

use crossbeam_channel::Sender;
use nsh_core::MountBatch;
use nsh_engine::MountSink;

mod canvas;
mod class_bench;
mod clock;
mod compiled;
mod component_bench;
mod components;
mod counter;
mod errors;
mod external_wake;
mod fetch;
mod focus;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod fs;
mod handle_bench;
mod host;
mod host_channel;
mod host_modules;
mod hot;
mod hover;
mod images;
mod js_touch;
mod keymap;
mod list;
mod list_bench;
mod logs;
mod native;
mod net;
mod open_url;
mod package;
mod parity;
mod platform;
mod process;
mod rust_animation;
mod rust_app;
mod rust_classes;
mod rust_inputs;
mod rust_lists;
mod rust_media;
mod rust_platform;
mod rust_popups;
mod rust_renderers;
mod rust_scrolling;
mod rust_styles;
mod rust_touch;
mod shutdown;
mod split;
mod storage;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod system;
mod test_ui;
mod theme;
mod websocket;

/// Hands the engine's batches to the test.
struct ChannelSink(Sender<MountBatch>);

impl MountSink for ChannelSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }
}

/// Where tests make their files: `TMPDIR`, or `~/.cache/nsh-benchs-test-tmp`
/// where none is set (CI's runners), never `/tmp`.
fn temporary_root() -> std::path::PathBuf {
    let root = std::env::var_os("TMPDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("HOME").expect("HOME"))
                .join(".cache/nsh-benchs-test-tmp")
        });
    assert!(root.is_absolute() && !root.starts_with("/tmp"));
    root
}
