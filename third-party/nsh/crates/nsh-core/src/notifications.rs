//! System notifications and the app's badge (`nsh`'s `Notifications`).
//!
//! The app asks the core ([`crate::element::notification_permission`],
//! [`crate::element::show_notification`], ...), and the core asks the
//! platform with [`Command::Notification`](crate::Command::Notification)s on
//! the root ([`NotificationCommand`]), which it answers with the root's
//! [`EventKind::Notification`](crate::EventKind::Notification)
//! ([`NotificationEvent`] gives its payload's fields). Where
//! [`Environment::notifications`](crate::platform::Environment::notifications)
//! is false the core answers itself: `unavailable`, nothing shown.
//!
//! A notification the user pressed is reported the same way, without a
//! request. The press can start the app, so the platform keeps what it has
//! until the core sends [`NotificationCommand::Listen`], which it does once
//! the app listens, and the core keeps presses until the app's listener
//! takes them.
//!
//! The badge is a command of its own and is not answered: it works without a
//! notification on macOS (the Dock's tile) and in an installed web app; iOS
//! needs the user's permission, and Android has no count to set (launchers
//! mark an app that has notifications showing).

use crate::element::PropEnum;

/// Whether the user lets the app show notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum NotificationPermission {
    /// The user was not asked yet.
    #[default]
    Default,
    /// Notifications show.
    Granted,
    /// The user refused: only the system's settings change that.
    Denied,
    /// This platform or build shows none.
    Unavailable,
}

impl NotificationPermission {
    /// Its name in the platforms' answers.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Unavailable => "unavailable",
        }
    }

    /// The permission named `name` ([`Self::as_str`]).
    pub fn from_name(name: &str) -> Option<Self> {
        [
            Self::Default,
            Self::Granted,
            Self::Denied,
            Self::Unavailable,
        ]
        .into_iter()
        .find(|p| p.as_str() == name)
    }
}

/// A notification to show.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Notification {
    /// The app's name for it: showing another with the same id replaces
    /// it, and a press reports it.
    pub id: String,
    /// Its title.
    pub title: String,
    /// Its text, `""` for none.
    pub body: String,
    /// Shows it without a sound or vibration, as the web's `silent` does.
    pub silent: bool,
}

impl Notification {
    /// A notification called `id`, titled `title`, with `body`.
    pub fn new(id: impl Into<String>, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            silent: false,
        }
    }

    /// Shows it without a sound or vibration ([`Self::silent`]).
    pub fn silent(mut self, silent: bool) -> Self {
        self.silent = silent;
        self
    }
}

/// What the core asks of the platform (on the root,
/// [`crate::Command::Notification`]). Sent only where
/// [`Environment::notifications`](crate::platform::Environment::notifications)
/// holds, but for [`Self::SetBadge`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum NotificationCommand {
    /// Report the permission as request `id`; with `ask`, ask the user
    /// first when they were not asked yet.
    Permission {
        /// The request.
        id: u32,
        /// Show the system's prompt when it has not shown yet.
        ask: bool,
    },
    /// Show `notification` and report whether the system took it as
    /// request `id`.
    Show {
        /// The request.
        id: u32,
        /// What to show.
        notification: Notification,
    },
    /// Remove the notification called this, shown or waiting to show.
    Close(String),
    /// Report the notifications the user presses, those pressed before now
    /// (which started the app) first.
    Listen,
    /// Shows `count` on the app's icon; 0 clears it. Where the platform has
    /// no badge, nothing happens.
    SetBadge(u32),
}

/// The fields of a platform's [`EventKind::Notification`](crate::EventKind::Notification)
/// payload (an [`EventPayload::Map`](crate::EventPayload::Map)).
#[non_exhaustive]
pub struct NotificationEvent;

impl NotificationEvent {
    /// The answered request (a number), with [`Self::PERMISSION`] or
    /// [`Self::SHOWN`].
    pub const ID: &'static str = "id";
    /// The permission's name ([`NotificationPermission::as_str`]).
    pub const PERMISSION: &'static str = "permission";
    /// Whether the system took the notification (a boolean).
    pub const SHOWN: &'static str = "shown";
    /// The id of the notification the user pressed.
    pub const PRESSED: &'static str = "pressed";
}
