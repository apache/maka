//! Native checks need AppKit on the process main thread and a desktop session.
//!
//! ```sh
//! cargo test -p nsh-platform-macos --test native -- --ignored
//! ```
//!
//! `mount.rs` also measures mounting rows that are not virtualized: with
//! `NSH_MOUNT_BENCH=1` after the checks, with `NSH_MOUNT_BENCH_ONLY=1`
//! alone (no other check runs first, so runs before and after a change
//! measure the same workload in the same process state):
//!
//! ```sh
//! NSH_MOUNT_BENCH_ONLY=1 cargo test --release -p nsh-platform-macos --test native -- --ignored
//! ```
#[cfg(target_os = "macos")]
mod canvas_bounds;
#[cfg(target_os = "macos")]
mod deleted_scroll;
#[cfg(target_os = "macos")]
mod download_redirect;
#[cfg(target_os = "macos")]
mod embedded_scroll;
#[cfg(target_os = "macos")]
mod fitting_input;
#[cfg(target_os = "macos")]
mod focus_selection;
#[cfg(target_os = "macos")]
mod fps_collapse;
#[cfg(target_os = "macos")]
mod hover_cursor;
#[cfg(target_os = "macos")]
mod ime;
#[cfg(target_os = "macos")]
mod input_clip;
#[cfg(target_os = "macos")]
mod input_focus;
#[cfg(target_os = "macos")]
mod input_hidden;
#[cfg(target_os = "macos")]
mod keyboard;
#[cfg(target_os = "macos")]
mod keymap_ime;
#[cfg(target_os = "macos")]
mod menu_labels;
#[cfg(target_os = "macos")]
mod menu_lifetime;
#[cfg(target_os = "macos")]
mod modal_fade;
#[cfg(target_os = "macos")]
mod modal_focus;
#[cfg(target_os = "macos")]
mod mount;
#[cfg(target_os = "macos")]
mod navigation_unmount;
#[cfg(target_os = "macos")]
mod press_momentum;
#[cfg(target_os = "macos")]
mod quit_requests;
#[cfg(target_os = "macos")]
mod scaled_input;
#[cfg(all(target_os = "macos", feature = "shader"))]
mod shader_content;
#[cfg(target_os = "macos")]
mod tap_feedback;
#[cfg(target_os = "macos")]
mod text_view_selection;
#[cfg(target_os = "macos")]
mod title_bar;
#[cfg(target_os = "macos")]
mod window_alert;
#[cfg(target_os = "macos")]
mod window_dialog;
#[cfg(target_os = "macos")]
mod window_focus;
#[cfg(target_os = "macos")]
mod window_frames;
#[cfg(target_os = "macos")]
mod window_hover;
#[cfg(target_os = "macos")]
mod window_layout;
#[cfg(target_os = "macos")]
mod window_press;
#[cfg(target_os = "macos")]
mod zoom;
fn main() {
    if !std::env::args().any(|arg| arg == "--ignored") {
        println!("Native AppKit checks skipped; run with --ignored in a desktop session.");
    } else {
        #[cfg(target_os = "macos")]
        {
            if std::env::var_os("NSH_WINDOW_FOCUS_CHECK_ONLY").is_some() {
                window_focus::run();
            } else if std::env::var_os("NSH_TAP_FEEDBACK_CHECK_ONLY").is_some() {
                tap_feedback::run();
            } else if std::env::var_os("NSH_TEXT_VIEW_SELECTION_CHECK_ONLY").is_some() {
                text_view_selection::run();
            } else if std::env::var_os("NSH_QUIT_CHECK_CASE").is_some() {
                quit_requests::run_case();
            } else if std::env::var_os("NSH_QUIT_CHECK_ONLY").is_some() {
                quit_requests::run();
            } else if std::env::var_os("NSH_TITLE_BAR_CHECK_ONLY").is_some() {
                title_bar::run();
            } else if std::env::var_os("NSH_MODAL_FADE_CHECK_ONLY").is_some() {
                modal_fade::run();
            } else if std::env::var_os("NSH_MODAL_FOCUS_CHECK_ONLY").is_some() {
                modal_focus::run();
            } else if std::env::var_os("NSH_NAVIGATION_UNMOUNT_CHECK_ONLY").is_some() {
                navigation_unmount::run();
            } else if std::env::var_os("NSH_SHADER_CONTENT_CHECK_ONLY").is_some() {
                #[cfg(feature = "shader")]
                shader_content::run();
            } else if mount::bench_only() {
                mount::bench_alone();
            } else if std::env::var_os("NSH_MENU_LABELS_CHECK_ONLY").is_some() {
                window_press::run();
                menu_labels::run();
            } else if std::env::var_os("NSH_MENU_LIFETIME_CHECK_ONLY").is_some() {
                window_press::run();
                menu_lifetime::run();
            } else if std::env::var_os("NSH_MOUNT_CHECK_ONLY").is_some() {
                mount::run();
            } else if std::env::var_os("NSH_WINDOW_DIALOG_CHECK_ONLY").is_some() {
                window_dialog::run();
            } else if std::env::var_os("NSH_WINDOW_FRAMES_CHECK_ONLY").is_some() {
                window_frames::run();
            } else if std::env::var_os("NSH_WINDOW_LAYOUT_CHECK_ONLY").is_some() {
                window_layout::run();
            } else if std::env::var_os("NSH_WINDOW_ALERT_CHECK_ONLY").is_some() {
                window_alert::run();
            } else if std::env::var_os("NSH_FOCUS_SELECTION_CHECK_ONLY").is_some() {
                focus_selection::run();
            } else if std::env::var_os("NSH_INPUT_FOCUS_CHECK_ONLY").is_some() {
                input_focus::run();
            } else if std::env::var_os("NSH_INPUT_CLIP_CHECK_ONLY").is_some() {
                input_clip::run();
            } else if std::env::var_os("NSH_INPUT_HIDDEN_CHECK_ONLY").is_some() {
                input_hidden::run();
            } else if std::env::var_os("NSH_FITTING_INPUT_CHECK_ONLY").is_some() {
                fitting_input::run();
            } else if std::env::var_os("NSH_FPS_COLLAPSE_CHECK_ONLY").is_some() {
                fps_collapse::run();
            } else if std::env::var_os("NSH_SCALED_INPUT_CHECK_ONLY").is_some() {
                scaled_input::run();
            } else if std::env::var_os("NSH_ZOOM_CHECK_ONLY").is_some()
                || std::env::var_os("NSH_ZOOM_PINCH_CHECK_ONLY").is_some()
            {
                zoom::run();
            } else if std::env::var_os("NSH_IME_CHECK_ONLY").is_some() {
                ime::run();
            } else if std::env::var_os("NSH_IME_KEYMAP_CHECK_ONLY").is_some() {
                keymap_ime::run();
            } else if std::env::var_os("NSH_KEYBOARD_CHECK_ONLY").is_some() {
                window_press::run();
                keyboard::run();
            } else if std::env::var_os("NSH_DELETED_SCROLL_CHECK_ONLY").is_some() {
                deleted_scroll::run();
            } else if std::env::var_os("NSH_DOWNLOAD_REDIRECT_CHECK_ONLY").is_some() {
                download_redirect::run();
            } else if std::env::var_os("NSH_EMBEDDED_SCROLL_CHECK_ONLY").is_some() {
                embedded_scroll::run();
            } else if std::env::var_os("NSH_VIEW_SCALE_CHECK_ONLY").is_some() {
                canvas_bounds::run_scale();
            } else if std::env::var_os("NSH_CANVAS_BOUNDS_CHECK_ONLY").is_some() {
                canvas_bounds::run();
            } else if std::env::var_os("NSH_HOVER_CURSOR_CHECK_ONLY").is_some() {
                hover_cursor::run();
            } else if std::env::var_os("NSH_PRESS_MOMENTUM_CHECK_ONLY").is_some() {
                press_momentum::run();
            } else {
                quit_requests::run();
                window_press::run();
                window_hover::run();
                title_bar::run();
                window_dialog::run();
                modal_fade::run();
                modal_focus::run();
                navigation_unmount::run();
                hover_cursor::run();
                #[cfg(feature = "shader")]
                shader_content::run();
                canvas_bounds::run();
                canvas_bounds::run_scale();
                menu_labels::run();
                menu_lifetime::run();
                window_frames::run();
                window_layout::run();
                keyboard::run();
                ime::run();
                input_hidden::run();
                input_clip::run();
                fitting_input::run();
                input_focus::run();
                focus_selection::run();
                text_view_selection::run();
                fps_collapse::run();
                scaled_input::run();
                zoom::run();
                deleted_scroll::run();
                download_redirect::run();
                mount::run();
                // Last: it makes the process an accessory app.
                embedded_scroll::run();
                // Last: it leaves the app an accessory, never activated.
                press_momentum::run();
                window_focus::run();
                tap_feedback::run();
            }
        }
    }
}
