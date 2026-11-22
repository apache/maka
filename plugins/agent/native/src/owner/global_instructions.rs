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

use super::*;
use cap_std::fs::{Dir, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

const FILE: &str = "AGENTS.md";

fn directory(source: GlobalInstructionSource) -> &'static str {
    match source {
        GlobalInstructionSource::Maka => ".maka",
        GlobalInstructionSource::Agents => ".agents",
    }
}
/// Only absence permits fallback. Empty, unreadable and invalid preferred files still win.
pub(super) fn selected(home: &Dir) -> io::Result<GlobalInstructionSource> {
    match home.symlink_metadata(".maka/AGENTS.md") {
        Ok(_) => Ok(GlobalInstructionSource::Maka),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(GlobalInstructionSource::Agents)
        }
        Err(error) => Err(error),
    }
}
pub(super) fn read_selected(
    home: &Dir,
    source: GlobalInstructionSource,
) -> io::Result<Option<Vec<u8>>> {
    let dir = match home.open_dir(directory(source)) {
        Ok(dir) => dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = match dir.open_with(FILE, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling symlink is an existing, unavailable file, not an absent one.
            if dir.symlink_metadata(FILE).is_ok() {
                return Err(io::Error::other("instruction unavailable"));
            }
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("instruction type invalid"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}
fn view(home: &Dir, home_path: &str) -> io::Result<GlobalInstructionsView> {
    let source = selected(home)?;
    let content = read_selected(home, source)?
        .map(String::from_utf8)
        .transpose()
        .map_err(|_| io::Error::other("instruction encoding invalid"))?;
    let path = Path::new(home_path)
        .join(directory(source))
        .join(FILE)
        .to_string_lossy()
        .into_owned();
    let revision =
        maka_agent_facts::artifact::content_digest(&serde_json::to_vec(&(&path, &content))?);
    Ok(GlobalInstructionsView::Available {
        source,
        path,
        revision,
        exists: content.is_some(),
        content: content.unwrap_or_default(),
    })
}
fn update(
    home: &Dir,
    home_path: &str,
    input: GlobalInstructionsUpdate,
) -> Result<GlobalInstructionsUpdated, String> {
    use GlobalInstructionsUpdated::*;
    let matches = |view: &GlobalInstructionsView| matches!(view, GlobalInstructionsView::Available { source, revision, .. } if *source == input.source && revision == &input.revision);
    let Ok(current) = view(home, home_path) else {
        return Ok(Unavailable);
    };
    if !matches(&current) {
        return Ok(Changed);
    }
    let source_dir = directory(input.source);
    match home.create_dir(source_dir) {
        Ok(()) =>
        {
            #[cfg(unix)]
            if home.open(".").and_then(|dir| dir.sync_all()).is_err() {
                return Ok(Unavailable);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Ok(Unavailable),
    }
    let Ok(dir) = home.open_dir(source_dir) else {
        return Ok(Unavailable);
    };
    // Separate opens give concurrent Agent owners a common advisory lock.
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .mode(0o600);
    }
    let Ok(lock) = dir.open_with(".AGENTS.md.lock", &options) else {
        return Ok(Unavailable);
    };
    let lock = lock.into_std();
    if !lock.metadata().is_ok_and(|m| m.is_file()) || lock.try_lock().is_err() {
        return Ok(Unavailable);
    }
    // Re-select after taking the lock, including a newly appeared preferred file.
    let Ok(current) = view(home, home_path) else {
        return Ok(Unavailable);
    };
    if !matches(&current) {
        return Ok(Changed);
    }
    let metadata = dir.symlink_metadata(FILE).ok();
    if metadata.as_ref().is_some_and(|m| !m.is_file()) {
        return Ok(Unavailable);
    }
    let temporary = format!(".AGENTS.md.{}.tmp", Uuid::new_v4());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let prepared = (|| -> io::Result<()> {
        let mut file = dir.open_with(&temporary, &options)?;
        if let Some(metadata) = metadata {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(input.content.as_bytes())?;
        file.sync_all()
    })();
    if prepared.is_err() {
        let _ = dir.remove_file(&temporary);
        return Ok(Unavailable);
    }
    let Ok(current) = view(home, home_path) else {
        let _ = dir.remove_file(&temporary);
        return Ok(Unavailable);
    };
    if !matches(&current) {
        let _ = dir.remove_file(&temporary);
        return Ok(Changed);
    }
    if dir.rename(&temporary, &dir, FILE).is_err() {
        let _ = dir.remove_file(&temporary);
        return Err("agent_global_instructions_effect_unknown".into());
    }
    #[cfg(unix)]
    dir.open(".")
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "agent_global_instructions_effect_unknown")?;
    Ok(Saved)
}
impl Owner {
    pub(crate) async fn global_instructions(
        self: &Arc<Self>,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<GlobalInstructionsView, String> {
        self.resource_work(scope, |owner, _scope| {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let Some(home) = &owner.instruction_home else {
                        return GlobalInstructionsView::Unavailable;
                    };
                    let path = owner
                        .settings
                        .assistant
                        .as_ref()
                        .and_then(|a| a.home.as_deref())
                        .unwrap_or_default();
                    view(home, path).unwrap_or(GlobalInstructionsView::Unavailable)
                })
                .await
                .map_err(|_| "agent_global_instructions_unavailable".into())
            })
        })
        .await
    }
    pub(crate) async fn update_global_instructions(
        self: &Arc<Self>,
        input: GlobalInstructionsUpdate,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<GlobalInstructionsUpdated, String> {
        self.resource_work(scope, move |owner, _scope| {
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let Some(home) = &owner.instruction_home else {
                        return Ok(GlobalInstructionsUpdated::Unavailable);
                    };
                    let path = owner
                        .settings
                        .assistant
                        .as_ref()
                        .and_then(|a| a.home.as_deref())
                        .unwrap_or_default();
                    update(home, path, input)
                })
                .await
                .map_err(|_| "agent_global_instructions_effect_unknown".to_owned())?
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_and_conflicts_preserve_actual_files() {
        let temp = tempfile::tempdir().unwrap();
        let home = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let path = temp.path().to_str().unwrap();
        let GlobalInstructionsView::Available {
            source,
            revision,
            exists,
            content,
            ..
        } = view(&home, path).unwrap()
        else {
            panic!()
        };
        assert_eq!(source, GlobalInstructionSource::Agents);
        assert!(!exists);
        assert!(content.is_empty());
        assert!(matches!(
            update(
                &home,
                path,
                GlobalInstructionsUpdate {
                    source,
                    revision: revision.clone(),
                    content: "new instructions".into()
                }
            )
            .unwrap(),
            GlobalInstructionsUpdated::Saved
        ));
        assert_eq!(
            std::fs::read_to_string(temp.path().join(".agents/AGENTS.md")).unwrap(),
            "new instructions"
        );
        assert!(matches!(
            update(
                &home,
                path,
                GlobalInstructionsUpdate {
                    source,
                    revision: revision.clone(),
                    content: "stale overwrite".into()
                }
            )
            .unwrap(),
            GlobalInstructionsUpdated::Changed
        ));
        home.create_dir_all(".maka/AGENTS.md").unwrap();
        assert_eq!(selected(&home).unwrap(), GlobalInstructionSource::Maka);
        assert!(
            view(&home, path).is_err(),
            "invalid preferred file cannot fall back"
        );
        assert!(read_selected(&home, GlobalInstructionSource::Maka).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_read_or_replace_outside_selected_instruction_directory() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private"), "PRIVATE").unwrap();
        std::fs::create_dir(temp.path().join(".maka")).unwrap();
        std::fs::create_dir(temp.path().join(".agents")).unwrap();
        std::fs::write(temp.path().join(".agents/AGENTS.md"), "fallback").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private"),
            temp.path().join(".maka/AGENTS.md"),
        )
        .unwrap();
        let home = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        assert_eq!(selected(&home).unwrap(), GlobalInstructionSource::Maka);
        assert!(view(&home, temp.path().to_str().unwrap()).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("private")).unwrap(),
            "PRIVATE"
        );
    }
}
