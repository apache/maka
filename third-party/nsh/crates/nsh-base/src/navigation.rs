//! Navigation and dialogs in Rust: the builders of TSX's `NavStack`,
//! `NavPage` and `Dialog` of `nsh/base`, so both faces import them from the
//! same layer. The elements are the core's host elements ([`Stack`],
//! [`Screen`], [`Modal`]); these are where apps make them.

use nsh_core::element::{Modal, Screen, Stack};

/// A native navigation stack (TSX: `NavStack`): its children are its
/// [`nav_page`]s, bottom to top. Put a page in to push it, leave it out to
/// pop it, and give each page a key (`Element::key`, its route) so the pages
/// below keep their state. UINavigationController on iOS (swipe back, the
/// system header), a stack with a toolbar and predictive back on Android,
/// the app's `header` on the desktops and the web.
pub fn nav_stack() -> Stack {
    nsh_core::element::stack()
}

/// One page of a [`nav_stack`] (TSX: `NavPage`): the page's content (its
/// children), its header on the desktops and the web, and the options of
/// the system header on iOS and Android. What it shows reads its insets
/// below the header (`Scope::insets`). `on_dismiss` tells the app the user
/// went back, for it to drop the route.
pub fn nav_page() -> Screen {
    nsh_core::element::screen()
}

/// A dialog (TSX: `Dialog`): presents its children over everything else,
/// the stack's header included, in its own native window layer. It has no
/// look of its own: what it shows (a popup, a backdrop) is the app's. Put it
/// in the view to present it (in a region: `If`), leave it out to dismiss
/// it; `on_cancel` tells the app the user tried to close it (Escape, the
/// Android back button, a press on the backdrop, a swipe down on an iOS
/// sheet).
pub fn dialog() -> Modal {
    nsh_core::element::modal()
}
