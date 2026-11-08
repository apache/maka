//! `nsh/desktop`'s app functions (macOS, Windows, Linux; nothing happens
//! elsewhere). Windows and menus, which call the app's functions and live
//! in its reactive graph, are `nsh-js`'s.

use crate::{
    Command, ROOT_ID,
    desktop::DesktopCommand,
    element::{ModuleCx, module, task::Action},
};

fn desktop(cx: &mut ModuleCx, command: DesktopCommand) {
    cx.act(Action::Command(
        ROOT_ID,
        Command::Desktop(Box::new(command)),
    ));
}

/// The application as a whole (desktops; its functions do nothing elsewhere).
#[module]
pub(crate) struct Application;

#[module]
impl Application {
    /// Quits the app, as the application menu's `quit` role and the
    /// platform's quit key do: its windows close and the app stops as when
    /// its last window closes, then its run ends, also while closing the
    /// window alone would leave it running (a window kept hidden, a tray
    /// icon). A view embedded in another app leaves the app's lifecycle to
    /// that app.
    pub(crate) fn quit(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Quit);
    }

    /// Restarts the app: it quits as `quit` does, and once the app has
    /// exited it starts again with the arguments it was started with. For a
    /// setting that takes effect at the next start (the app's language, say):
    /// ask the user first, then call it. Standalone apps on macOS, Windows
    /// and Linux; a view embedded in another app leaves the app's lifecycle
    /// to that app.
    pub(crate) fn restart(cx: &mut ModuleCx) {
        desktop(cx, DesktopCommand::Restart);
    }
}
