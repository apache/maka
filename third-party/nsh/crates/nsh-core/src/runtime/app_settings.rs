//! `nsh/mobile`'s `AppSettings`: the app's own page in the system's
//! settings ([`crate::mobile::open_app_settings`]), where the user turns
//! back on a permission they denied. iOS and Android; elsewhere `open`
//! rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` at once. Needs the
//! `application` capability when the app declares capabilities.

use crate::element::{JsError, JsObject, module};

/// What `AppSettings.open` did.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct AppSettingsResult {
    /// Whether the system opened the app's page in its settings.
    pub(crate) opened: bool,
}

/// The app's page in the system's settings.
#[module]
pub(crate) struct AppSettings;

#[module]
impl AppSettings {
    /// Resolves with whether `open` opens the app's page in the system's
    /// settings here: on iOS and Android (not on a Mac, Mac Catalyst
    /// included), when the `application` capability is granted; `false`
    /// elsewhere, where `open` rejects. Ask it before showing an "Open
    /// Settings" button.
    pub(crate) async fn available() -> bool {
        crate::mobile::app_settings_available().await
    }

    /// Opens the app's own page in the system's settings, where the user
    /// turns back on a permission they denied (the camera, photos,
    /// notifications): iOS's Settings app at the app, Android's App info;
    /// the embedding app's page for an embedded view. Resolves with
    /// `{ opened }`: whether the system opened it. Rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform has no such
    /// page (`available()` is false), and with `ERR_ACCESS_DENIED`
    /// (`permission` `"application"`) for an app that declares capabilities
    /// without `application`.
    pub(crate) async fn open() -> Result<AppSettingsResult, JsError> {
        match crate::mobile::open_app_settings().await {
            Ok(opened) => Ok(AppSettingsResult { opened }),
            Err(error) => Err(error.js()),
        }
    }
}
