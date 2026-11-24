//! Provisioning profiles of iOS device packages (`nsh package --target ios
//! --profile`): one for the app and one for each of its app extensions,
//! each found by the bundle identifier it covers, and the entitlements a
//! bundle is signed with under its profile.

use std::{
    cell::Cell,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, bail};

use crate::ui;

/// A provisioning profile (`.mobileprovision`), read.
#[derive(Debug)]
pub(crate) struct Profile {
    /// The file, which a bundle carries as `embedded.mobileprovision`.
    pub(crate) path: PathBuf,
    /// Its `application-identifier` (`TEAMID.com.example.app`, or a
    /// wildcard such as `TEAMID.*`).
    app_id: String,
    /// The entitlements it grants.
    entitlements: plist::Dictionary,
    /// Whether [`Profile::choose`] chose it for a bundle.
    used: Cell<bool>,
}

impl Profile {
    /// Reads the profile at `path`.
    pub(crate) fn read(path: &Path) -> anyhow::Result<Self> {
        let output = Command::new("security")
            .args(["cms", "-D", "-i"])
            .arg(path)
            .output()
            .context("run security cms")?;
        if !output.status.success() {
            bail!("cannot read provisioning profile {}", path.display());
        }
        let profile = plist::Value::from_reader_xml(output.stdout.as_slice())?;
        let entitlements = profile
            .as_dictionary()
            .and_then(|d| d.get("Entitlements"))
            .and_then(|v| v.as_dictionary())
            .cloned()
            .with_context(|| {
                format!(
                    "the provisioning profile {} has no entitlements",
                    path.display()
                )
            })?;
        Ok(Self::new(path.to_owned(), entitlements))
    }

    fn new(path: PathBuf, entitlements: plist::Dictionary) -> Self {
        let app_id = entitlements
            .get("application-identifier")
            .and_then(|v| v.as_string())
            .unwrap_or_default()
            .to_owned();
        Profile {
            path,
            app_id,
            entitlements,
            used: Cell::new(false),
        }
    }

    /// The profile of `profiles` for bundle id `id`: the one whose
    /// application identifier names it, else the narrowest wildcard that
    /// covers it (`TEAMID.com.example.*` before `TEAMID.*`). Two equally
    /// close profiles are an error, as is none; when `id` is an app
    /// extension's (`extension`), whose profile a command line with only the
    /// app's leaves out, the error says to pass it.
    pub(crate) fn choose<'p>(
        profiles: &'p [Profile],
        id: &str,
        extension: bool,
    ) -> anyhow::Result<&'p Profile> {
        // Exact before wildcard, then the longer pattern.
        let closeness = |profile: &Profile| {
            let pattern = profile.app_id.split_once('.').map_or("", |(_, p)| p);
            (!pattern.ends_with('*'), pattern.len())
        };
        let covering: Vec<&Profile> = profiles
            .iter()
            .filter(|p| profile_allows(&p.app_id, id))
            .collect();
        let Some(best) = covering.iter().map(|p| closeness(p)).max() else {
            return Err(match profiles {
                [profile] if extension => anyhow::anyhow!(
                    "the provisioning profile is for {}, not {id}: pass its profile with another --profile",
                    profile.app_id
                ),
                [profile] => anyhow::anyhow!(
                    "the provisioning profile is for {}, not {id}",
                    profile.app_id
                ),
                _ => anyhow::anyhow!(
                    "none of the provisioning profiles is for {id} (they are for {}): pass its profile with another --profile",
                    profiles
                        .iter()
                        .map(|p| p.app_id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        };
        let mut closest = covering.into_iter().filter(|p| closeness(p) == best);
        let profile = closest.next().expect("the closest profile is one of them");
        if let Some(other) = closest.next() {
            bail!(
                "{} and {} are both provisioning profiles for {id}: pass one of them",
                profile.path.display(),
                other.path.display()
            );
        }
        profile.used.set(true);
        Ok(profile)
    }

    /// The entitlements bundle id `id` is signed with under this profile:
    /// those it grants, with the bundle's own (`requested`, `nsh.json`
    /// `section`) in place of its values, each checked against what it
    /// grants.
    pub(crate) fn entitlements(
        &self,
        id: &str,
        requested: plist::Dictionary,
        section: &str,
    ) -> anyhow::Result<plist::Value> {
        if !profile_allows(&self.app_id, id) {
            bail!("the provisioning profile is for {}, not {id}", self.app_id);
        }
        let mut entitlements = self.entitlements.clone();
        crate::apple::grant(&mut entitlements, requested, section)?;
        // A wildcard profile (`TEAMID.*`) signs the bundle as `TEAMID.<id>`,
        // as Xcode does: devices refuse a bundle signed with the wildcard
        // itself.
        entitlements.insert(
            "application-identifier".to_owned(),
            plist::Value::String(signed_app_id(&self.app_id, id)),
        );
        Ok(plist::Value::Dictionary(entitlements))
    }
}

/// The profiles [`Profile::choose`] chose for no bundle.
fn unused(profiles: &[Profile]) -> impl Iterator<Item = &Profile> {
    profiles.iter().filter(|p| !p.used.get())
}

/// Warns of each `--profile` the package signed no bundle with: a profile
/// meant for a bundle whose identifier it does not cover, or one too many.
pub(crate) fn warn_unused(profiles: &[Profile]) {
    for profile in unused(profiles) {
        ui::warn(format!(
            "--profile {} is for {}, which no bundle of the package is, so nothing is signed with it",
            profile.path.display(),
            profile.app_id
        ));
    }
}

/// The `application-identifier` a bundle with id `id` is signed with under
/// a profile's (`TEAMID.com.example.app` or a wildcard such as `TEAMID.*`),
/// which covers it.
fn signed_app_id(app_id: &str, id: &str) -> String {
    match app_id.split_once('.') {
        Some((team, pattern)) if pattern.ends_with('*') => format!("{team}.{id}"),
        _ => app_id.to_owned(),
    }
}

/// Whether a profile's `application-identifier` (`TEAMID.com.example.app`,
/// or a wildcard such as `TEAMID.*`) covers bundle id `id`.
fn profile_allows(app_id: &str, id: &str) -> bool {
    app_id
        .split_once('.')
        .map(|(_, pattern)| match pattern.strip_suffix('*') {
            Some(prefix) => id.starts_with(prefix),
            None => pattern == id,
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(file: &str, app_id: &str) -> Profile {
        let mut entitlements = plist::Dictionary::new();
        entitlements.insert("application-identifier".into(), app_id.into());
        entitlements.insert("aps-environment".into(), "production".into());
        Profile::new(file.into(), entitlements)
    }

    #[test]
    fn profiles_match_bundle_ids() {
        assert!(profile_allows(
            "ABCDE12345.com.example.app",
            "com.example.app"
        ));
        assert!(!profile_allows(
            "ABCDE12345.com.example.app",
            "com.example.other"
        ));
        assert!(profile_allows("ABCDE12345.*", "com.example.app"));
        assert!(profile_allows(
            "ABCDE12345.com.example.*",
            "com.example.app"
        ));
        assert!(!profile_allows("ABCDE12345.com.other.*", "com.example.app"));
        assert!(!profile_allows("", "com.example.app"));
    }

    #[test]
    fn wildcard_profiles_sign_the_bundle_id() {
        assert_eq!(
            signed_app_id("ABCDE12345.*", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
        assert_eq!(
            signed_app_id("ABCDE12345.com.example.*", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
        assert_eq!(
            signed_app_id("ABCDE12345.com.example.app", "com.example.app"),
            "ABCDE12345.com.example.app"
        );
    }

    /// The app and each extension take the profile that names them, else
    /// the narrowest wildcard covering them.
    #[test]
    fn each_bundle_takes_the_closest_profile() {
        let profiles = [
            profile("all.mobileprovision", "TEAM.*"),
            profile("app.mobileprovision", "TEAM.com.example.app"),
            profile("widget.mobileprovision", "TEAM.com.example.app.Widget"),
            profile("example.mobileprovision", "TEAM.com.example.*"),
        ];
        let chosen = |id| {
            Profile::choose(&profiles, id, id != "com.example.app")
                .unwrap()
                .path
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(chosen("com.example.app"), "app.mobileprovision");
        assert_eq!(chosen("com.example.app.Widget"), "widget.mobileprovision");
        assert_eq!(chosen("com.example.app.Service"), "example.mobileprovision");
        assert_eq!(chosen("org.other.app"), "all.mobileprovision");
        assert_eq!(unused(&profiles).count(), 0);
    }

    /// A profile no bundle took is left over, which packaging warns of.
    #[test]
    fn profiles_no_bundle_takes_are_left_over() {
        let profiles = [
            profile("app.mobileprovision", "TEAM.com.example.app"),
            profile("widget.mobileprovision", "TEAM.com.example.app.Widget"),
            profile("old.mobileprovision", "TEAM.com.example.app.Old"),
        ];
        Profile::choose(&profiles, "com.example.app.Widget", true).unwrap();
        Profile::choose(&profiles, "com.example.app", false).unwrap();
        let left: Vec<_> = unused(&profiles).map(|p| p.app_id.as_str()).collect();
        assert_eq!(left, ["TEAM.com.example.app.Old"]);
    }

    #[test]
    fn a_bundle_without_a_profile_or_with_two_is_an_error() {
        let one = [profile("app.mobileprovision", "TEAM.com.example.app")];
        // The app's error stays as it was; an extension's says what to do.
        assert_eq!(
            Profile::choose(&one, "com.other.app", false)
                .unwrap_err()
                .to_string(),
            "the provisioning profile is for TEAM.com.example.app, not com.other.app"
        );
        assert_eq!(
            Profile::choose(&one, "com.example.app.Widget", true)
                .unwrap_err()
                .to_string(),
            "the provisioning profile is for TEAM.com.example.app, not com.example.app.Widget: \
             pass its profile with another --profile"
        );
        let two = [
            profile("app.mobileprovision", "TEAM.com.example.app"),
            profile("other.mobileprovision", "TEAM.com.example.other"),
        ];
        let error = Profile::choose(&two, "com.example.app.Widget", true)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("none of the provisioning profiles is for com.example.app.Widget")
                && error.contains("TEAM.com.example.app, TEAM.com.example.other"),
            "{error}"
        );
        let same = [
            profile("dev.mobileprovision", "TEAM.com.example.app"),
            profile("dist.mobileprovision", "TEAM.com.example.app"),
        ];
        let error = Profile::choose(&same, "com.example.app", false)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("are both provisioning profiles for com.example.app"),
            "{error}"
        );
    }

    #[test]
    fn a_bundle_is_signed_as_its_own_id_with_its_own_entitlements() {
        let all = profile("all.mobileprovision", "TEAM.*");
        let entitlements = all
            .entitlements(
                "com.example.app.Widget",
                plist::Dictionary::new(),
                "ios.extensions[0].entitlements",
            )
            .unwrap();
        let entitlements = entitlements.as_dictionary().unwrap();
        assert_eq!(
            entitlements["application-identifier"],
            plist::Value::String("TEAM.com.example.app.Widget".into())
        );
        assert_eq!(
            entitlements["aps-environment"],
            plist::Value::String("production".into())
        );
        let mut requested = plist::Dictionary::new();
        requested.insert("com.apple.developer.healthkit".into(), true.into());
        let error = all
            .entitlements(
                "com.example.app.Widget",
                requested,
                "ios.extensions[0].entitlements",
            )
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("(nsh.json ios.extensions[0].entitlements)"),
            "{error}"
        );
    }
}
