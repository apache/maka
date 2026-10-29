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

use crate::{ComputerAppBinding, ComputerAppTarget};
use maka_agent_facts::{language::Language, tools::ToolError};
use platform_macos::apps::{self, AppInfo};
use std::path::Path;

pub(crate) enum Request {
    Name(String),
    // Raw computer calls approve the application, not a preselected window.
    RawApp(String),
    Window {
        window_id: u64,
        expected_process: Option<(u32, String)>,
    },
}

impl Request {
    pub(crate) fn resolve(self, language: Language) -> Result<ComputerAppTarget, ToolError> {
        super::require_desktop()?;
        let (app, binding) = match self {
            Self::RawApp(name) => {
                let selected = raw_app_candidate(&name, &apps::list_all_apps())?;
                let app = match selected {
                    Some((application_id, path)) => {
                        let name = path.to_str().ok_or_else(|| {
                            failed("application bundle path is not valid Unicode")
                        })?;
                        let app = apps::resolve_app_info(name).map_err(failed)?;
                        let actual_path = std::fs::canonicalize(
                            app.launch_path
                                .as_ref()
                                .ok_or_else(|| failed("application bundle path is unavailable"))?,
                        )
                        .map_err(failed)?;
                        if app.bundle_id.as_deref() != Some(application_id.as_str())
                            || actual_path != path
                        {
                            return Err(failed(
                                "application identity changed during app resolution",
                            ));
                        }
                        app
                    }
                    None => apps::resolve_app_info(&name).map_err(failed)?,
                };
                (app, None)
            }
            Self::Name(name) => {
                let requested_path = Path::new(&name)
                    .is_absolute()
                    .then(|| std::fs::canonicalize(&name))
                    .transpose()
                    .map_err(failed)?;
                let matches: Vec<_> = apps::list_all_apps()
                    .into_iter()
                    .filter(|app| {
                        app.name.eq_ignore_ascii_case(&name)
                            || app.bundle_id.as_deref() == Some(&name)
                            || requested_path.as_ref().is_some_and(|path| {
                                app.launch_path
                                    .as_ref()
                                    .and_then(|candidate| std::fs::canonicalize(candidate).ok())
                                    .as_ref()
                                    == Some(path)
                            })
                    })
                    .collect();
                let windows: Vec<_> = platform_macos::windows::all_windows()
                    .into_iter()
                    .filter(|window| matches.iter().any(|app| app.pid == window.pid))
                    .collect();
                match windows.len() {
                    0 => (apps::resolve_app_info(&name).map_err(failed)?, None),
                    1 => {
                        return Self::Window {
                            window_id: u64::from(windows[0].window_id),
                            expected_process: None,
                        }
                        .resolve(language);
                    }
                    _ => {
                        return Err(failed(
                            "application has multiple open windows; choose an exact window",
                        ));
                    }
                }
            }
            Self::Window {
                window_id,
                expected_process,
            } => {
                let window_id = u32::try_from(window_id).map_err(failed)?;
                let window = platform_macos::windows::window_info_by_id(window_id)
                    .ok_or_else(|| failed("stale_target: window is no longer available"))?;
                let pid = u32::try_from(window.pid).map_err(failed)?;
                let process = crate::identity::process(pid)?;
                if expected_process
                    .as_ref()
                    .is_some_and(|expected| expected != &(pid, process.clone()))
                {
                    return Err(failed("stale_target: application process changed"));
                }
                let application_id = apps::bundle_id_for_pid(window.pid).ok_or_else(|| {
                    failed("window owner has no resolved application bundle identity")
                })?;
                let mut matches = apps::list_all_apps().into_iter().filter(|app| {
                    app.pid == window.pid && app.bundle_id.as_deref() == Some(&application_id)
                });
                let app = matches.next().ok_or_else(|| {
                    failed("window owner has no resolved application bundle metadata")
                })?;
                if matches.next().is_some() {
                    return Err(failed("window owner application metadata is ambiguous"));
                }
                if crate::identity::process(pid)? != process
                    || platform_macos::windows::window_info_by_id(window_id)
                        .is_none_or(|current| current.pid != window.pid)
                {
                    return Err(failed(
                        "stale_target: window owner changed during app resolution",
                    ));
                }
                (
                    app,
                    Some(ComputerAppBinding {
                        pid,
                        window_id: u64::from(window_id),
                        process_generation: process,
                    }),
                )
            }
        };
        let mut target = subject(app, language)?;
        target.binding = binding;
        Ok(target)
    }
}

// Check app identity ambiguity without turning the number of open windows
// into an app permission rule. Process/window provenance is bound later by the
// existing native Controller, after this canonical app subject is approved.
fn raw_app_candidate(
    name: &str,
    candidates: &[AppInfo],
) -> Result<Option<(String, std::path::PathBuf)>, ToolError> {
    let requested_path = Path::new(name)
        .is_absolute()
        .then(|| std::fs::canonicalize(name))
        .transpose()
        .map_err(failed)?;
    let mut identities = std::collections::BTreeSet::new();
    for app in candidates {
        let matches = if let Some(requested) = &requested_path {
            app.launch_path
                .as_ref()
                .and_then(|path| std::fs::canonicalize(path).ok())
                .as_ref()
                == Some(requested)
        } else {
            app.name.eq_ignore_ascii_case(name)
                || app.bundle_id.as_deref() == Some(name)
                || app.launch_path.as_deref() == Some(name)
        };
        if !matches {
            continue;
        }
        let bundle = app
            .bundle_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| failed("matched application has no bundle identifier"))?;
        let path = std::fs::canonicalize(
            app.launch_path
                .as_ref()
                .ok_or_else(|| failed("matched application has no bundle path"))?,
        )
        .map_err(failed)?;
        identities.insert((bundle.to_owned(), path));
    }
    if identities.len() > 1 {
        return Err(failed(
            "application matches multiple installed copies; choose an exact app path or window",
        ));
    }
    Ok(identities.into_iter().next())
}

pub(crate) fn matching_processes(
    name: &str,
    apps: &[cua_driver_contract::AppInfo],
    expected: Option<&ComputerAppTarget>,
) -> Result<Vec<u32>, ToolError> {
    let requested_path = Path::new(name)
        .is_absolute()
        .then(|| std::fs::canonicalize(name))
        .transpose()
        .map_err(failed)?;
    let mut identities = std::collections::BTreeSet::new();
    let mut pids = Vec::new();
    for app in apps {
        let path = if let Some(requested) = &requested_path {
            let Some(path) = app
                .launch_path
                .as_ref()
                .and_then(|path| std::fs::canonicalize(path).ok())
                .filter(|path| path == requested)
            else {
                continue;
            };
            path
        } else {
            if !app.name.eq_ignore_ascii_case(name)
                && app.bundle_id.as_deref() != Some(name)
                && app.launch_path.as_deref() != Some(name)
            {
                continue;
            }
            std::fs::canonicalize(
                app.launch_path
                    .as_ref()
                    .ok_or_else(|| failed("matched application has no bundle path"))?,
            )
            .map_err(failed)?
        };
        let application_id = app
            .bundle_id
            .as_ref()
            .ok_or_else(|| failed("matched application has no bundle identifier"))?;
        if expected.is_some_and(|expected| {
            expected.identity.application_id.as_str() != application_id.as_str()
                || Path::new(&expected.display.app_path) != path.as_path()
        }) {
            return Err(failed("application identity changed after approval"));
        }
        identities.insert((application_id, path));
        pids.push(app.pid);
    }
    if identities.len() > 1 {
        return Err(failed(
            "application matches multiple installed copies; choose an exact app path or window",
        ));
    }
    Ok(pids)
}

pub(crate) fn verify_launch(
    expected: &ComputerAppTarget,
    language: Language,
) -> Result<(), ToolError> {
    let observed = Request::Name(expected.display.app_path.clone()).resolve(language)?;
    expected.check_observed(&observed)
}

pub(crate) fn verify_window(
    expected: &ComputerAppTarget,
    pid: u32,
    window_id: u64,
    process: &str,
    language: Language,
) -> Result<(), ToolError> {
    let observed = Request::Window {
        window_id,
        expected_process: Some((pid, process.to_owned())),
    }
    .resolve(language)?;
    expected.check_observed(&observed)
}

fn subject(app: AppInfo, language: Language) -> Result<ComputerAppTarget, ToolError> {
    let application_id = app
        .bundle_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| failed("application bundle identifier is unavailable"))?;
    let path = app
        .launch_path
        .ok_or_else(|| failed("application bundle path is unavailable"))?;
    let path = std::fs::canonicalize(path).map_err(failed)?;
    let app_path = path
        .to_str()
        .ok_or_else(|| failed("application bundle path is not valid Unicode"))?
        .to_owned();
    crate::permission_subject::macos_target(app.name, application_id, app_path, language)
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_app_path_matches_an_inventory_alias_without_name_fallback() {
        let fixture = tempfile::tempdir().unwrap();
        let first = fixture.path().join("first/Editor.app");
        let second = fixture.path().join("second/Editor.app");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let alias = fixture.path().join("Editor.app");
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        let app = |pid, path: &Path| cua_driver_contract::AppInfo {
            pid,
            name: "Editor".into(),
            running: true,
            active: false,
            bundle_id: Some("org.example.Editor".into()),
            launch_path: Some(path.to_str().unwrap().into()),
            kind: Some("desktop".into()),
            last_used: None,
        };
        let apps = [app(42, &alias), app(99, &second)];
        let canonical = std::fs::canonicalize(&first).unwrap();
        let approved = crate::permission_subject::macos_target(
            "Editor".into(),
            "org.example.Editor".into(),
            canonical.to_str().unwrap().into(),
            Language::En,
        )
        .unwrap();
        assert_eq!(
            matching_processes(canonical.to_str().unwrap(), &apps, Some(&approved)).unwrap(),
            vec![42]
        );
        assert!(matching_processes("Editor", &apps, None).is_err());

        let mut changed = apps[0].clone();
        changed.bundle_id = Some("org.example.OtherApp".into());
        assert!(
            matching_processes(canonical.to_str().unwrap(), &[changed], Some(&approved)).is_err()
        );
    }

    #[test]
    fn raw_app_scope_deduplicates_aliases_but_refuses_distinct_installed_copies() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first/Editor.app");
        let second = directory.path().join("second/Editor.app");
        let alias = directory.path().join("Editor.app");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        let record = |pid, path: &Path| AppInfo {
            name: "Editor".into(),
            pid,
            bundle_id: Some("org.example.Editor".into()),
            running: true,
            active: false,
            launch_path: Some(path.to_str().unwrap().into()),
            kind: Some("desktop".into()),
            last_used: None,
        };
        let same_copy = [record(11, &first), record(11, &alias)];
        assert_eq!(
            raw_app_candidate("org.example.Editor", &same_copy).unwrap(),
            Some((
                "org.example.Editor".into(),
                std::fs::canonicalize(&first).unwrap()
            ))
        );
        let different_copies = [record(11, &alias), record(22, &second)];
        assert!(raw_app_candidate("org.example.Editor", &different_copies).is_err());
        assert_eq!(
            raw_app_candidate(first.to_str().unwrap(), &different_copies).unwrap(),
            Some((
                "org.example.Editor".into(),
                std::fs::canonicalize(&first).unwrap()
            ))
        );
    }
}
