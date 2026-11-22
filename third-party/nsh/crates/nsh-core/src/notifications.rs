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
    /// A sound the app ships, played instead of the system's default: its
    /// asset path (`sounds/ding.caf`, no `asset:/`). [`Self::silent`] wins
    /// over it, and a platform that cannot play it plays the default. See
    /// [`Self::sound`].
    pub sound: Option<String>,
}

impl Notification {
    /// A notification called `id`, titled `title`, with `body`.
    pub fn new(id: impl Into<String>, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            silent: false,
            sound: None,
        }
    }

    /// Shows it without a sound or vibration ([`Self::silent`]).
    pub fn silent(mut self, silent: bool) -> Self {
        self.silent = silent;
        self
    }

    /// Plays the app's sound `path` (an asset path, `asset:/` optional)
    /// instead of the system's default ([`Self::sound`]). `nsh package`
    /// copies the app's sounds where the system plays them from: macOS and
    /// iOS read `.caf`, `.aiff` and `.wav` files of at most 30 s by file
    /// name (so names must differ), Android `.ogg`, `.mp3` and `.wav` as raw
    /// resources (by name, lowercased, other characters as `_`), Linux the
    /// file itself. Windows (unpackaged) and the web play the default.
    pub fn sound(mut self, path: impl Into<String>) -> Self {
        let path: String = path.into();
        let path = path.strip_prefix("asset:").unwrap_or(&path);
        let path = path.trim_start_matches('/');
        self.sound = (!path.is_empty()).then(|| path.to_owned());
        self
    }

    /// The sound to play: [`Self::sound`] unless [`Self::silent`].
    pub fn sound_path(&self) -> Option<&str> {
        if self.silent {
            None
        } else {
            self.sound.as_deref()
        }
    }

    /// The sound's file name, `path`'s last component: Apple platforms
    /// play it by that, from the app's `Library/Sounds`.
    pub fn sound_file_name(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }

    /// The Android raw resource name of the sound at `path`
    /// ([`Self::sound_file_name`]).
    pub fn sound_resource_name(path: &str) -> String {
        let file = Self::sound_file_name(path);
        let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
        let mut name: String = stem
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
            name.insert(0, '_');
        }
        name
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
    /// Remove every notification of the app's, shown or waiting to show,
    /// those an earlier run of the app left included where the platform
    /// can reach them.
    CloseAll,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sound_is_an_asset_path_that_silent_overrides() {
        let n = Notification::new("a", "T", "").sound("asset:/sounds/Ding.caf");
        assert_eq!(n.sound.as_deref(), Some("sounds/Ding.caf"));
        assert_eq!(n.sound_path(), Some("sounds/Ding.caf"));
        assert_eq!(n.clone().silent(true).sound_path(), None);
        assert_eq!(Notification::new("a", "T", "").sound("").sound, None);
        assert_eq!(Notification::sound_file_name("sounds/Ding.caf"), "Ding.caf");
    }

    #[test]
    fn a_sound_s_android_name_is_a_valid_resource_name() {
        assert_eq!(
            Notification::sound_resource_name("sounds/New Message.ogg"),
            "new_message"
        );
        assert_eq!(Notification::sound_resource_name("1-up.wav"), "_1_up");
        assert_eq!(Notification::sound_resource_name("ding"), "ding");
    }
}
