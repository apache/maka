/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Which State Root the app opens, and remembering that choice.
//!
//! A State Root is the directory where a Runtime Host keeps everything:
//! sessions, settings, model connections. The app never picks one silently.
//! On first launch the shell proposes [`default_state_root`] and lets the
//! person choose another folder; the choice is kept by a [`StateRootStore`]
//! (in production a [`StateRootFile`] next to `client-instance-id`), and
//! `--root` overrides it for one launch without replacing it.
//!
//! Maka Desktop's data directory is never proposed and is refused as a
//! choice ([`check_state_root_choice`]): its live State Root must not be
//! shared with a development client.

use std::io;
use std::path::{Component, Path, PathBuf};

use futures_lite::future::Boxed;
use host_client::CLIENT_CONFIG_DIRECTORY;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config_file::{read_config_file, write_config_file};

/// The file under the client's config directory that remembers the choice.
pub const STATE_ROOT_CHOICE_FILE: &str = "state-root.json";

/// Remembering the choice is small and rare; a larger file is not ours.
const MAX_CHOICE_BYTES: u64 = 16 * 1024;

/// The folder first launch proposes: `state-root` in this client's data
/// directory (on macOS `~/Library/Application Support/maka-gpui/state-root`).
pub fn default_state_root() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(CLIENT_CONFIG_DIRECTORY).join("state-root"))
}

/// Maka Desktop's data directory, `resolveMakaClientDataRoot` in
/// `packages/storage/src/workspace-root.ts`: the Electron `userData`
/// directory of the `Maka` profile (on macOS
/// `~/Library/Application Support/Maka`). Its live State Root is
/// `workspaces/default` inside it (`deriveMakaDataRoots`), next to the
/// Host's owner locks.
pub fn desktop_data_directory() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("Maka"))
}

/// Why a folder cannot be the State Root.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum StateRootChoiceError {
    #[error("{} is not an absolute path", .0.display())]
    NotAbsolute(PathBuf),
    /// The folder is, contains, or lies inside Maka Desktop's data directory.
    #[error("{} holds Maka Desktop’s data", .0.display())]
    DesktopData(PathBuf),
}

/// Checks a folder the person chose. `desktop` is Maka Desktop's data
/// directory ([`desktop_data_directory`]); the folder may not be it, lie
/// inside it, or contain it. Paths compare without regard to case on macOS
/// and Windows, whose default file systems ignore it.
pub fn check_state_root_choice(
    choice: &Path,
    desktop: Option<&Path>,
) -> Result<(), StateRootChoiceError> {
    if !choice.is_absolute() {
        return Err(StateRootChoiceError::NotAbsolute(choice.to_owned()));
    }
    if let Some(desktop) = desktop {
        let choice_parts = comparable(choice);
        let desktop_parts = comparable(desktop);
        if choice_parts.starts_with(&desktop_parts) || desktop_parts.starts_with(&choice_parts) {
            return Err(StateRootChoiceError::DesktopData(choice.to_owned()));
        }
    }
    Ok(())
}

/// The normal components of `path`, folded to lower case where the file
/// system usually ignores case.
fn comparable(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            Component::ParentDir => Some("..".to_owned()),
            _ => None,
        })
        .map(
            |part| if cfg!(any(target_os = "macos", windows)) { part.to_lowercase() } else { part },
        )
        .collect()
}

/// Keeps the State Root choice across launches.
pub trait StateRootStore: 'static {
    /// The remembered folder, or `None` when there is none (yet).
    fn load(&self) -> Boxed<io::Result<Option<PathBuf>>>;
    /// Remembers `root` for later launches.
    fn remember(&self, root: PathBuf) -> Boxed<io::Result<()>>;
}

/// Remembers the choice in a small JSON file, `{"stateRoot": "<path>"}`.
#[derive(Debug, Clone)]
pub struct StateRootFile {
    path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChoiceFile {
    state_root: PathBuf,
}

impl StateRootFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// [`STATE_ROOT_CHOICE_FILE`] in the client's config directory, beside
    /// `client-instance-id` (on macOS
    /// `~/Library/Application Support/maka-gpui/state-root.json`).
    pub fn default_location() -> Option<Self> {
        Some(Self::new(
            dirs::config_dir()?.join(CLIENT_CONFIG_DIRECTORY).join(STATE_ROOT_CHOICE_FILE),
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl StateRootStore for StateRootFile {
    /// A file that is missing, too large, not JSON of the expected shape,
    /// or names a relative path counts as no choice: the person is asked
    /// again rather than stopped by a damaged preference.
    fn load(&self) -> Boxed<io::Result<Option<PathBuf>>> {
        let path = self.path.clone();
        Box::pin(async move {
            let Some(bytes) = read_config_file(&path, MAX_CHOICE_BYTES).await? else {
                return Ok(None);
            };
            match serde_json::from_slice::<ChoiceFile>(&bytes) {
                Ok(choice) if choice.state_root.is_absolute() => Ok(Some(choice.state_root)),
                _ => {
                    log::warn!("ignoring {}: no absolute stateRoot", path.display());
                    Ok(None)
                }
            }
        })
    }

    /// Writes a temporary file beside the target and renames it over, so a
    /// reader never sees half a choice.
    fn remember(&self, root: PathBuf) -> Boxed<io::Result<()>> {
        let path = self.path.clone();
        Box::pin(async move {
            let mut contents =
                serde_json::to_vec(&ChoiceFile { state_root: root }).map_err(io::Error::other)?;
            contents.push(b'\n');
            write_config_file(path, contents).await
        })
    }
}

#[cfg(test)]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("workspace-state-root-{name}-{}", crate::config_file::unique_suffix()));
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn the_proposal_is_this_clients_own_folder_not_maka_desktops() {
        let proposal = default_state_root().expect("data dir");
        assert!(proposal.ends_with(Path::new("maka-gpui/state-root")), "{proposal:?}");
        let desktop = desktop_data_directory().expect("config dir");
        assert_eq!(check_state_root_choice(&proposal, Some(&desktop)), Ok(()));
    }

    #[test]
    fn maka_desktops_data_is_refused_inside_out_and_in_any_case() {
        let desktop = Path::new("/Users/me/Library/Application Support/Maka");
        for refused in [
            "/Users/me/Library/Application Support/Maka",
            "/Users/me/Library/Application Support/Maka/workspaces/default",
            "/Users/me/Library/Application Support",
            "/Users/me",
        ] {
            assert_eq!(
                check_state_root_choice(Path::new(refused), Some(desktop)),
                Err(StateRootChoiceError::DesktopData(PathBuf::from(refused))),
                "{refused}"
            );
        }
        for allowed in [
            "/Users/me/Library/Application Support/maka-gpui/state-root",
            "/Users/me/Library/Application Support/Makara",
            "/Users/me/code/maka-gpui/.dev-root",
        ] {
            assert_eq!(
                check_state_root_choice(Path::new(allowed), Some(desktop)),
                Ok(()),
                "{allowed}"
            );
        }
        if cfg!(target_os = "macos") {
            assert!(
                check_state_root_choice(
                    Path::new("/Users/me/Library/Application Support/maka/workspaces"),
                    Some(desktop)
                )
                .is_err()
            );
        }
        assert!(matches!(
            check_state_root_choice(Path::new("relative/root"), None),
            Err(StateRootChoiceError::NotAbsolute(_))
        ));
    }

    #[test]
    fn the_choice_file_round_trips_and_damage_means_no_choice() {
        let dir = scratch("file");
        let store = StateRootFile::new(dir.join("maka-gpui").join(STATE_ROOT_CHOICE_FILE));
        assert_eq!(block_on(store.load()).expect("missing"), None);

        let root = PathBuf::from("/Users/me/Maka Data/state-root");
        block_on(store.remember(root.clone())).expect("remember");
        assert_eq!(block_on(store.load()).expect("load"), Some(root));
        let text = fs::read_to_string(store.path()).expect("text");
        assert_eq!(text, "{\"stateRoot\":\"/Users/me/Maka Data/state-root\"}\n");
        assert_eq!(fs::read_dir(store.path().parent().expect("dir")).expect("entries").count(), 1);

        for damaged in ["not json", r#"{"stateRoot":"relative"}"#, r#"{"other":1}"#] {
            fs::write(store.path(), damaged).expect("damage");
            assert_eq!(block_on(store.load()).expect("load"), None, "{damaged}");
        }
        fs::remove_dir_all(dir).ok();
    }
}
