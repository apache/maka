//! `promptForUpdate`: NSH's built-in update prompt, as macOS apps' Sparkle
//! asks. The check, the user's choices kept between runs (a skipped version,
//! automatic installs) and the alert it falls back on are here; the window
//! it shows on the desktops is `nsh-base`'s (`updater_prompt`), which a UI
//! set installs with [`set_update_presenter`]: the core cannot draw it.

use std::{
    future::Future,
    path::{Path, PathBuf},
    rc::Rc,
};

use serde::{Deserialize, Serialize};

use super::{AppUpdate, UpdateProgress, native};
use crate::{
    element::{JsError, JsObject, System},
    ops::{Dialog, DialogButton, DialogButtonStyle},
};

/// Options of `promptForUpdate` ([`prompt_for_update`]).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct UpdatePromptOptions {
    /// As `checkForUpdate`'s: the channel in `nsh.json`'s
    /// `"updater": { "channels" }` to check instead of the default source.
    pub channel: Option<String>,
    /// As `checkForUpdate`'s: the language of the notes, when the manifest
    /// has them in it.
    pub locale: Option<String>,
    /// A check the user did not ask for (at startup, in the background):
    /// nothing shows when the app is up to date, the check fails or the
    /// user skipped the version, and an update installs as the app quits
    /// without asking once the user chose automatic updates. Default false:
    /// the user asked ("Check for Updates…") and hears every outcome.
    pub quiet: Option<bool>,
}

impl UpdatePromptOptions {
    /// Checks the channel `name` of `nsh.json`'s `"updater": { "channels" }`.
    pub fn channel(mut self, name: impl Into<String>) -> Self {
        self.channel = Some(name.into());
        self
    }

    /// The notes in `locale` (a BCP 47 tag such as `zh-TW`), when the
    /// manifest has them.
    pub fn locale(mut self, locale: impl Into<String>) -> Self {
        self.locale = Some(locale.into());
        self
    }

    /// Whether the check is one the user did not ask for
    /// ([`UpdatePromptOptions::quiet`]).
    pub fn quiet(mut self, quiet: bool) -> Self {
        self.quiet = Some(quiet);
        self
    }
}

/// Checks for a newer version and asks the user about it in NSH's built-in
/// prompt (TS: `promptForUpdate` of `nsh/updater`), to await in a task or
/// drop. Rust apps check with the engine's network and the configuration
/// `nsh package` left among the app's assets.
///
/// ```ignore
/// // At startup:
/// spawn(prompt_for_update(UpdatePromptOptions::default().quiet(true)));
/// // A "Check for Updates…" menu item:
/// spawn(prompt_for_update(UpdatePromptOptions::default()));
/// ```
pub fn prompt_for_update(options: UpdatePromptOptions) -> impl Future<Output = ()> + 'static {
    let mut sys = System::default().with_updater(crate::element::updater_host());
    sys.data_dir = crate::element::data_dir();
    run(sys, options)
}

/// What shows the prompt's window: `nsh-base`'s.
type Presenter = Rc<dyn Fn(&UpdatePrompt) -> bool>;

/// The engine's [`Presenter`], if a UI set installed one.
#[derive(Default, Clone)]
struct Presenters(Option<Presenter>);

/// Shows the built-in prompt with `present`, which returns whether it
/// showed it (else the system's alert asks). `nsh-base` installs its window
/// with it in each engine's setup.
#[doc(hidden)]
pub fn set_update_presenter(present: impl Fn(&UpdatePrompt) -> bool + 'static) {
    crate::element::global::<Presenters>().update(|p| p.0 = Some(Rc::new(present)));
}

/// An update to ask the user about, and what the prompt can do with it
/// ([`set_update_presenter`]).
#[doc(hidden)]
#[derive(Clone)]
#[non_exhaustive]
pub struct UpdatePrompt {
    /// The app's display name.
    pub app_name: String,
    /// The version that runs now.
    pub current_version: String,
    /// The newer version.
    pub version: String,
    /// What changed, as Markdown.
    pub notes: Option<String>,
    /// Whether the app installs it itself (else Install Update opens the
    /// update's page).
    pub can_install: bool,
    /// Whether the user chose to download and install updates
    /// automatically.
    pub automatic: bool,
    sys: System,
    url: String,
}

impl UpdatePrompt {
    /// Skips this version: quiet checks no longer offer it.
    pub fn skip(&self) {
        let dir = self.sys.data_dir.as_deref();
        let mut preferences = Preferences::load(dir);
        preferences.skipped = Some(self.version.clone());
        preferences.save(dir);
    }

    /// Whether quiet checks download and install updates without asking.
    pub fn set_automatic(&self, automatic: bool) {
        let dir = self.sys.data_dir.as_deref();
        let mut preferences = Preferences::load(dir);
        preferences.automatic = automatic;
        preferences.save(dir);
    }

    /// Downloads the update, calling `on_progress` with the bytes received
    /// and the total when known.
    pub fn download(
        &self,
        on_progress: impl Fn(u64, Option<u64>) + 'static,
    ) -> impl Future<Output = Result<(), String>> + 'static {
        let progress = Box::new(move |p: UpdateProgress| {
            on_progress(p.received as u64, p.total.map(|t| t as u64))
        });
        let done = native::download(self.sys.clone(), Some(progress));
        async move { done.await.map_err(message) }
    }

    /// Installs the downloaded update and restarts the app into it.
    pub fn install_and_restart(&self) -> impl Future<Output = Result<(), String>> + 'static {
        let done = native::install(self.sys.clone());
        async move { done.await.map_err(message) }
    }

    /// Installs the downloaded update as the app quits.
    pub fn install_on_quit(&self) -> impl Future<Output = Result<(), String>> + 'static {
        let done = native::install_on_quit(self.sys.clone());
        async move { done.await.map_err(message) }
    }

    /// Opens the update's page (a store's, or the archive) outside the
    /// app.
    pub fn open_url(&self) -> impl Future<Output = bool> + 'static {
        crate::prelude::open_url(self.url.clone())
    }
}

fn message(e: JsError) -> String {
    match e {
        JsError::Error(m) | JsError::Type(m) => m,
        other => format!("{other:?}"),
    }
}

/// What the user chose, kept between runs in the app's data directory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Preferences {
    /// The version Skip This Version skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skipped: Option<String>,
    /// "Automatically download and install updates in the future".
    #[serde(default)]
    automatic: bool,
}

impl Preferences {
    fn path(dir: &Path) -> PathBuf {
        dir.join("updates").join("prompt.json")
    }

    /// What `dir` keeps; the defaults without a directory or a readable
    /// file.
    fn load(dir: Option<&Path>) -> Preferences {
        dir.and_then(|dir| std::fs::read(Self::path(dir)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: Option<&Path>) {
        let Some(dir) = dir else {
            return;
        };
        let path = Self::path(dir);
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, serde_json::to_vec(self).unwrap_or_default()));
        if let Err(e) = written {
            log::warn!("updater: cannot keep the prompt's preferences: {e}");
        }
    }
}

/// What a check that found `version` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    /// Nothing: a quiet check of a skipped version.
    Nothing,
    /// Downloads it and installs it as the app quits, without asking.
    InstallOnQuit,
    /// Asks the user.
    Ask,
}

fn next(preferences: &Preferences, version: &str, can_install: bool, quiet: bool) -> Next {
    if !quiet {
        return Next::Ask;
    }
    if preferences.skipped.as_deref() == Some(version) {
        Next::Nothing
    } else if preferences.automatic && can_install {
        Next::InstallOnQuit
    } else {
        Next::Ask
    }
}

pub(super) async fn run(sys: System, options: UpdatePromptOptions) {
    let quiet = options.quiet.unwrap_or(false);
    if sys.updater.is_none() {
        log::info!("updater: the app does not update here: no prompt");
        return;
    }
    let (name, current) = native::shipped(&sys).await;
    let app_name = name.unwrap_or_else(executable_name);
    let current_version = current.unwrap_or_default();
    let update = match native::check(sys.clone(), options.channel, options.locale).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if !quiet {
                alert(
                    "You're up to date!".into(),
                    format!(
                        "{app_name} {current_version} is currently the newest version available."
                    ),
                )
                .await;
            }
            return;
        }
        Err(e) => {
            let e = message(e);
            log::warn!("updater: check: {e}");
            if !quiet {
                alert(
                    "Update Error!".into(),
                    format!("An error occurred in retrieving update information. Please try again later.\n\n{e}"),
                )
                .await;
            }
            return;
        }
    };
    let AppUpdate {
        version,
        notes,
        url,
        can_install,
        ..
    } = update;
    let preferences = Preferences::load(sys.data_dir.as_deref());
    match next(&preferences, &version, can_install, quiet) {
        Next::Nothing => return,
        Next::InstallOnQuit => {
            let installed = async {
                native::download(sys.clone(), None).await?;
                native::install_on_quit(sys.clone()).await
            };
            match installed.await {
                Ok(()) => log::info!("updater: version {version} installs as the app quits"),
                Err(e) => log::warn!("updater: cannot install version {version}: {}", message(e)),
            }
            return;
        }
        Next::Ask => {}
    }
    let prompt = UpdatePrompt {
        app_name,
        current_version,
        version,
        notes,
        can_install,
        automatic: preferences.automatic,
        sys,
        url,
    };
    let presenter = crate::element::global::<Presenters>().with_untracked(|p| p.0.clone());
    let shown = crate::element::is_desktop() && presenter.is_some_and(|present| present(&prompt));
    if !shown {
        ask_in_alert(prompt).await;
    }
}

/// An alert with an OK button.
async fn alert(title: String, message: String) {
    let _ = crate::element::dialog(Dialog {
        id: 0,
        title: Some(title),
        message: Some(message),
        buttons: vec![DialogButton {
            text: "OK".into(),
            style: DialogButtonStyle::Default,
        }],
        cancelable: true,
        sheet: false,
        input: None,
    })
    .await;
}

/// The longest notes the alert shows: an alert does not scroll everywhere.
const ALERT_NOTES: usize = 600;

/// The prompt as the system's alert: where no window shows it (iOS,
/// Android, an app without `nsh-base`).
async fn ask_in_alert(prompt: UpdatePrompt) {
    let mut message = format!(
        "{} {} is now available\u{2014}you have {}.",
        prompt.app_name, prompt.version, prompt.current_version
    );
    if let Some(notes) = prompt
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        message.push_str("\n\n");
        let mut chars = notes.chars();
        message.extend(chars.by_ref().take(ALERT_NOTES));
        if chars.next().is_some() {
            message.push('\u{2026}');
        }
    }
    let button = |text: &str, style| DialogButton {
        text: text.into(),
        style,
    };
    let answer = crate::element::dialog(Dialog {
        id: 0,
        title: Some(format!(
            "A new version of {} is available!",
            prompt.app_name
        )),
        message: Some(message),
        buttons: vec![
            button(
                if prompt.can_install {
                    "Install Update"
                } else {
                    "Update"
                },
                DialogButtonStyle::Default,
            ),
            button("Skip This Version", DialogButtonStyle::Default),
            button("Remind Me Later", DialogButtonStyle::Cancel),
        ],
        cancelable: true,
        sheet: false,
        input: None,
    })
    .await;
    match answer.index {
        0 if prompt.can_install => {
            let installed = async {
                prompt.download(|_, _| {}).await?;
                prompt.install_and_restart().await
            };
            if let Err(e) = installed.await {
                alert("Update Error!".into(), e).await;
            }
        }
        0 => {
            prompt.open_url().await;
        }
        1 => prompt.skip(),
        _ => {}
    }
}

/// The app's name where its package did not say it: the `.app` bundle's on
/// macOS, else the executable's.
fn executable_name() -> String {
    let exe = std::env::current_exe().ok();
    let bundle = exe.as_deref().and_then(|exe| {
        exe.ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .and_then(Path::file_stem)
    });
    bundle
        .or_else(|| exe.as_deref().and_then(Path::file_stem))
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "The app".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_are_kept_in_the_data_directory() {
        let dir = std::env::temp_dir().join(format!("nsh-prompt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(Preferences::load(Some(&dir)), Preferences::default());
        let kept = Preferences {
            skipped: Some("1.2.0".into()),
            automatic: true,
        };
        kept.save(Some(&dir));
        assert_eq!(Preferences::load(Some(&dir)), kept);
        // Without a directory nothing is kept, and nothing fails.
        kept.save(None);
        assert_eq!(Preferences::load(None), Preferences::default());
        std::fs::write(Preferences::path(&dir), b"not json").unwrap();
        assert_eq!(Preferences::load(Some(&dir)), Preferences::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quiet_checks_respect_the_users_choices() {
        let skipped = Preferences {
            skipped: Some("1.2.0".into()),
            automatic: false,
        };
        assert_eq!(next(&skipped, "1.2.0", true, true), Next::Nothing);
        // A newer version than the skipped one asks again.
        assert_eq!(next(&skipped, "1.3.0", true, true), Next::Ask);
        // The user asked: a skipped version shows all the same.
        assert_eq!(next(&skipped, "1.2.0", true, false), Next::Ask);

        let automatic = Preferences {
            skipped: None,
            automatic: true,
        };
        assert_eq!(next(&automatic, "1.2.0", true, true), Next::InstallOnQuit);
        // Where the app cannot install itself it asks.
        assert_eq!(next(&automatic, "1.2.0", false, true), Next::Ask);
        assert_eq!(next(&automatic, "1.2.0", true, false), Next::Ask);
    }
}
