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

//! The `maka-files` script module: a text file or a folder the user picks,
//! and the files the user attaches to a message.
//!
//! A gpui-shell manifest can grant reads only under the application's own
//! directories, and scripts have no file dialog. `openText` shows the
//! platform's open panel and reads the one file the user chose, so choosing
//! the file is the permission, as with a browser's file input. Nothing else
//! on disk becomes readable. `chooseFolder` shows the panel for one folder
//! and answers its path only; the Host, not the script, reads the folder.
//!
//! `chooseFiles` shows the panel for any number of files and registers each
//! one under an opaque handle, with its size and content digest. The script
//! gets the handle, never the path, and has no way to register a path itself:
//! here too the choice in the panel is the permission. `maka-host` reads a
//! registered file when a mutation names its handle as an attachment (the
//! `file` of `agent.uploadAttachment`), and `release` forgets it.
//!
//! `open` and `reveal` hand a path in a task's folder to the system: open it
//! with its default application, or show it in the file manager, as the
//! Files tool's menu offers. They read nothing and answer nothing about the
//! file; the path must be absolute and exist as an entry, which is checked
//! off the main thread.
use gpui_shell::{
    HostArguments, HostError, HostModule, HostObject, HostResult, HostValue,
    gpui::{App, PathPromptOptions, SharedString},
};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};
use uuid::Uuid;

pub const NAME: &str = "maka-files";
/// Read limit when the script does not give one.
const DEFAULT_MAX_BYTES: u64 = 1 << 20;
/// Largest limit a script may ask for.
const MAX_BYTES: u64 = 16 << 20;
/// Largest file `chooseFiles` registers: the Host's limit for an attachment
/// (`agent.uploadAttachment`, 52428800 bytes).
const MAX_ATTACHMENT_BYTES: u64 = 50 << 20;
/// How much of a file is read at a time while its digest is computed.
const DIGEST_CHUNK: usize = 64 * 1024;

const DECLARATIONS: &str = r#"/**
 * Shows the open panel for one file and reads it as UTF-8 text. Resolves with
 * null when the user cancels. Rejects when the file is larger than `maxBytes`
 * (default 1 MiB, at most 16 MiB) or is not UTF-8.
 */
export function openText(options?: {
  prompt?: string;
  maxBytes?: number;
}): Promise<{ path: string; text: string } | null>;

/**
 * Shows the open panel for one folder. Resolves with its path, or null when
 * the user cancels.
 */
export function chooseFolder(options?: { prompt?: string }): Promise<string | null>;

/**
 * One file chosen with `chooseFiles`. A registered file has a `handle`, its
 * size and its `digest` (`sha256:` and the lowercase hex SHA-256 of its
 * content). A file over 50 MiB (52428800 bytes, the Host's limit for an
 * attachment) is not registered and has `tooLarge`; one that cannot be read
 * is not registered and has `error`.
 */
export interface ChosenFile {
  name: string;
  bytes?: number;
  handle?: string;
  digest?: string;
  tooLarge?: boolean;
  error?: string;
}

/**
 * Shows the open panel for any number of files and registers each one that
 * can be attached. `maka-host`'s `mutate` reads a registered file when an
 * attachment names it as `{ file: handle }`. Sizes and digests are read off
 * the main thread. Resolves with [] when the user cancels.
 */
export function chooseFiles(): Promise<ChosenFile[]>;

/** Forgets registered files. A handle that is not registered is ignored. */
export function release(handles: string[]): void;

/**
 * Opens the file or folder at `path` with the system's default application.
 * Rejects when `path` is not absolute, has a `..` component, or does not
 * exist as an entry (a link counts, even one whose target is gone). Whether
 * the application then opened it is not reported.
 */
export function open(path: string): Promise<void>;

/** Shows the file or folder at `path` in the file manager. Rejects as `open` does. */
export function reveal(path: string): Promise<void>;
"#;

pub fn module() -> HostModule {
    HostModule::new(NAME)
        .declarations(DECLARATIONS)
        .async_function("openText", |arguments| {
            let (prompt, limit) = options(arguments)?;
            let chosen = gpui_shell::with_current_app(|cx| {
                cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: false,
                    prompt,
                })
            })
            .ok_or_else(|| HostError::new("openText must be called from the application"))?;
            Ok(async move {
                let paths = chosen
                    .await
                    .map_err(|_| HostError::new("the open panel closed without an answer"))?
                    .map_err(|error| HostError::new(format!("the open panel failed: {error}")))?;
                let Some(path) = paths.and_then(|paths| paths.into_iter().next()) else {
                    return Ok(HostValue::Null);
                };
                let text = read_text(&path, limit)?;
                Ok(HostObject::new()
                    .field("path", path.to_string_lossy().into_owned())
                    .field("text", text)
                    .into())
            })
        })
        .async_function("chooseFolder", |arguments| {
            let prompt = folder_options(arguments)?;
            let chosen = gpui_shell::with_current_app(|cx| {
                cx.prompt_for_paths(PathPromptOptions {
                    files: false,
                    directories: true,
                    multiple: false,
                    prompt,
                })
            })
            .ok_or_else(|| HostError::new("chooseFolder must be called from the application"))?;
            Ok(async move {
                let paths = chosen
                    .await
                    .map_err(|_| HostError::new("the open panel closed without an answer"))?
                    .map_err(|error| HostError::new(format!("the open panel failed: {error}")))?;
                Ok(match paths.and_then(|paths| paths.into_iter().next()) {
                    Some(path) => path.to_string_lossy().into_owned().into(),
                    None => HostValue::Null,
                })
            })
        })
        .async_function("chooseFiles", |_| {
            let chosen = gpui_shell::with_current_app(|cx| {
                cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: true,
                    prompt: None,
                })
            })
            .ok_or_else(|| HostError::new("chooseFiles must be called from the application"))?;
            Ok(async move {
                let paths = chosen
                    .await
                    .map_err(|_| HostError::new("the open panel closed without an answer"))?
                    .map_err(|error| HostError::new(format!("the open panel failed: {error}")))?;
                match paths {
                    Some(paths) => register(paths).await,
                    None => Ok(HostValue::Array(Vec::new())),
                }
            })
        })
        .function("release", |arguments| {
            let handles = arguments
                .get(0)
                .and_then(HostValue::as_array)
                .ok_or_else(|| HostError::new("release(handles) needs an array of handles"))?
                .iter()
                .map(|handle| {
                    handle
                        .as_str()
                        .ok_or_else(|| HostError::new("a handle must be a string"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut files = chosen_files();
            for handle in handles {
                files.remove(handle);
            }
            Ok(HostValue::Null)
        })
        .async_function("open", |arguments| {
            hand_over(arguments, "open", |cx, path| cx.open_with_system(path))
        })
        .async_function("reveal", |arguments| {
            hand_over(arguments, "reveal", |cx, path| cx.reveal_path(path))
        })
}

/// `open` and `reveal` (`function`): checks the path's shape here, then, in
/// a task on the application, that it exists (on a background thread, so a
/// slow disk does not hold up the window) and hands it to `hand`. The
/// returned future answers when that is done.
fn hand_over(
    arguments: &HostArguments,
    function: &'static str,
    hand: fn(&App, &Path),
) -> Result<impl Future<Output = HostResult> + Send + use<>, HostError> {
    let path = absolute_path(arguments, function)?;
    let (answer, answered) = tokio::sync::oneshot::channel();
    gpui_shell::with_current_app(|cx| {
        cx.spawn(async move |cx| {
            let probe = path.clone();
            let found = cx
                .background_executor()
                .spawn(async move { exists(&probe) })
                .await;
            let result = found.map(|()| {
                cx.update(|cx| hand(cx, &path));
                HostValue::Null
            });
            let _ = answer.send(result);
        })
        .detach();
    })
    .ok_or_else(|| HostError::new(format!("{function} must be called from the application")))?;
    Ok(async move {
        answered
            .await
            .map_err(|_| HostError::new(format!("{function} stopped before it finished")))?
    })
}

/// The path `open` or `reveal` (`function`) was given: absolute and without
/// a `..` component. The system opens whatever a path resolves to, so one
/// that climbs out of a folder is refused rather than resolved here.
fn absolute_path(arguments: &HostArguments, function: &str) -> Result<PathBuf, HostError> {
    let path = arguments
        .get(0)
        .and_then(HostValue::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::new(format!("{function}(path) needs a path")))?;
    if !path.is_absolute() {
        return Err(HostError::new(format!(
            "{function}: {} is not an absolute path",
            path.display()
        )));
    }
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err(HostError::new(format!(
            "{function}: {} has a .. component",
            path.display()
        )));
    }
    Ok(path)
}

/// Whether `path` exists as an entry. A link counts as itself, even one
/// whose target is gone: it is not followed.
fn exists(path: &Path) -> Result<(), HostError> {
    std::fs::symlink_metadata(path)
        .map(|_| ())
        .map_err(|error| HostError::new(format!("{}: {error}", path.display())))
}

/// A file the user chose to attach: where it is, and its size and digest
/// when it was chosen.
#[derive(Clone)]
pub(crate) struct Chosen {
    pub path: PathBuf,
    pub bytes: u64,
    pub digest: String,
}

/// Registered files by handle, for the whole process: `maka-host` reads them.
static CHOSEN: Mutex<BTreeMap<String, Chosen>> = Mutex::new(BTreeMap::new());

fn chosen_files() -> MutexGuard<'static, BTreeMap<String, Chosen>> {
    CHOSEN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The file registered under `handle`, unless it was never registered or
/// has been released.
pub(crate) fn chosen(handle: &str) -> Option<Chosen> {
    chosen_files().get(handle).cloned()
}

/// What `chooseFiles` found out about one file.
enum Described {
    Ready(Chosen),
    TooLarge(u64),
    Unreadable(String),
}

/// Registers the files at `paths` as `chooseFiles` does, and resolves with
/// what it answers (see `ChosenFile` in the declarations). Only paths the
/// user chose in the panel may be handed here. The files are read on a
/// thread of their own: the digest of 50 MiB takes a while, and the executor
/// driving the call is not held meanwhile.
pub(crate) fn register(paths: Vec<PathBuf>) -> impl Future<Output = HostResult> + Send + 'static {
    let (answer, answered) = tokio::sync::oneshot::channel();
    let started = std::thread::Builder::new()
        .name("maka-files-digest".into())
        .spawn(move || {
            let described: Vec<_> = paths
                .iter()
                .map(|path| (name_of(path), describe(path)))
                .collect();
            let _ = answer.send(described);
        });
    async move {
        started
            .map_err(|error| HostError::new(format!("cannot read the chosen files: {error}")))?;
        let described = answered
            .await
            .map_err(|_| HostError::new("reading the chosen files stopped before it finished"))?;
        let mut files = Vec::with_capacity(described.len());
        for (name, described) in described {
            let file = HostObject::new().field("name", name);
            files.push(match described {
                Described::Ready(chosen) => {
                    let handle = Uuid::new_v4().to_string();
                    let file = file
                        .field("handle", handle.as_str())
                        .field("bytes", chosen.bytes)
                        .field("digest", chosen.digest.as_str());
                    chosen_files().insert(handle, chosen);
                    file.into()
                }
                Described::TooLarge(bytes) => {
                    file.field("bytes", bytes).field("tooLarge", true).into()
                }
                Described::Unreadable(error) => file.field("error", error).into(),
            });
        }
        Ok(HostValue::Array(files))
    }
}

/// The name a file is attached under: its last path component.
fn name_of(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// The size and digest of one file as it is now, unless it is over the
/// Host's limit or cannot be read.
fn describe(path: &Path) -> Described {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return Described::Unreadable(error.to_string()),
    };
    if !metadata.is_file() {
        return Described::Unreadable("not a regular file".into());
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Described::TooLarge(metadata.len());
    }
    match digest(path, metadata.len()) {
        Ok(digest) => Described::Ready(Chosen {
            path: path.to_owned(),
            bytes: metadata.len(),
            digest,
        }),
        Err(error) => Described::Unreadable(error),
    }
}

/// `sha256:` and the lowercase hex SHA-256 of the file, as the Host computes
/// an upload's digest (`content_digest`), read a chunk at a time. A file
/// that does not hold `bytes` bytes by the end changed while it was read.
fn digest(path: &Path, bytes: u64) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; DIGEST_CHUNK];
    let mut read = 0;
    while read <= bytes {
        let count = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        };
        hasher.update(&buffer[..count]);
        read += count as u64;
    }
    if read != bytes {
        return Err("the file changed while it was read".into());
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn folder_options(arguments: &HostArguments) -> Result<Option<SharedString>, HostError> {
    let Some(options) = arguments.get(0).filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    if options.as_object().is_none() {
        return Err(HostError::new("chooseFolder options must be an object"));
    }
    prompt(options)
}

fn options(arguments: &HostArguments) -> Result<(Option<SharedString>, u64), HostError> {
    let Some(options) = arguments.get(0).filter(|value| !value.is_null()) else {
        return Ok((None, DEFAULT_MAX_BYTES));
    };
    if options.as_object().is_none() {
        return Err(HostError::new("openText options must be an object"));
    }
    let prompt = prompt(options)?;
    let limit = match options.get("maxBytes") {
        None => DEFAULT_MAX_BYTES,
        Some(value) if value.is_null() => DEFAULT_MAX_BYTES,
        Some(value) => match value.as_number() {
            Some(n) if n.fract() == 0.0 && n >= 1.0 && n <= MAX_BYTES as f64 => n as u64,
            _ => {
                return Err(HostError::new(format!(
                    "`maxBytes` must be a whole number from 1 to {MAX_BYTES}"
                )));
            }
        },
    };
    Ok((prompt, limit))
}

/// The panel's button label, when the options give one.
fn prompt(options: &HostValue) -> Result<Option<SharedString>, HostError> {
    Ok(match options.get("prompt") {
        None => None,
        Some(value) if value.is_null() => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| HostError::new("`prompt` must be a string"))?
                .to_owned()
                .into(),
        ),
    })
}

/// Reads at most `limit` bytes; a longer file is refused rather than cut.
fn read_text(path: &Path, limit: u64) -> Result<String, HostError> {
    let name = path.display();
    let file =
        std::fs::File::open(path).map_err(|error| HostError::new(format!("{name}: {error}")))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| HostError::new(format!("{name}: {error}")))?;
    if bytes.len() as u64 > limit {
        return Err(HostError::new(format!(
            "{name} is larger than {limit} bytes"
        )));
    }
    String::from_utf8(bytes).map_err(|_| HostError::new(format!("{name} is not UTF-8 text")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: Vec<HostValue>) -> HostArguments {
        HostArguments::new(values)
    }

    #[test]
    fn options_default_and_bounds() {
        assert_eq!(
            options(&arguments(vec![])).unwrap(),
            (None, DEFAULT_MAX_BYTES)
        );
        let given = HostObject::new()
            .field("prompt", "Import")
            .field("maxBytes", 4096.0)
            .into();
        let (prompt, limit) = options(&arguments(vec![given])).unwrap();
        assert_eq!(prompt.as_deref(), Some("Import"));
        assert_eq!(limit, 4096);
        for bad in [0.0, 1.5, (MAX_BYTES + 1) as f64] {
            let value = HostObject::new().field("maxBytes", bad).into();
            assert!(options(&arguments(vec![value])).is_err(), "{bad}");
        }
        assert!(options(&arguments(vec![HostValue::from("x")])).is_err());
    }

    #[test]
    fn folder_options_take_a_prompt_only_from_an_object() {
        assert_eq!(folder_options(&arguments(vec![])).unwrap(), None);
        assert_eq!(
            folder_options(&arguments(vec![HostValue::Null])).unwrap(),
            None
        );
        let given = HostObject::new().field("prompt", "Choose").into();
        assert_eq!(
            folder_options(&arguments(vec![given])).unwrap().as_deref(),
            Some("Choose")
        );
        let bad = HostObject::new().field("prompt", 1.0).into();
        assert!(folder_options(&arguments(vec![bad])).is_err());
        assert!(folder_options(&arguments(vec![HostValue::from("x")])).is_err());
    }

    #[test]
    fn read_text_refuses_large_and_binary_files() {
        let directory = std::env::temp_dir().join(format!("maka-files-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let text = directory.join("a.json");
        std::fs::write(&text, "{\"é\":1}").unwrap();
        // Eight bytes: `é` takes two.
        assert_eq!(read_text(&text, 8).unwrap(), "{\"é\":1}");
        assert!(
            read_text(&text, 7)
                .unwrap_err()
                .message()
                .contains("larger than 7")
        );
        let binary = directory.join("b.bin");
        std::fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert!(
            read_text(&binary, 16)
                .unwrap_err()
                .message()
                .contains("not UTF-8")
        );
        assert!(read_text(&directory.join("missing"), 16).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn declarations_name_exactly_the_registered_functions() {
        let module = module();
        module.validate().unwrap();
        assert_eq!(
            module.function_names(),
            [
                "chooseFiles",
                "chooseFolder",
                "open",
                "openText",
                "release",
                "reveal"
            ]
        );
        assert!(!module.is_async("release"));
        assert!(module.is_async("open"));
        assert!(module.is_async("reveal"));
    }

    #[test]
    fn open_and_reveal_take_an_absolute_existing_path_only() {
        let directory = std::env::temp_dir().join(format!("maka-files-open-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("a.txt");
        std::fs::write(&file, "a").unwrap();
        let begin = |function: &str, path: &str| match module()
            .begin(function, &arguments(vec![HostValue::from(path)]))
        {
            Ok(_) => panic!("{function}({path}) began"),
            Err(error) => error.message().to_owned(),
        };
        for function in ["open", "reveal"] {
            assert!(begin(function, "a.txt").contains("not an absolute path"));
            let up = format!("{}/../a.txt", directory.join("sub").display());
            assert!(begin(function, &up).contains(".. component"));
            // A path that passes is handed to the application, which a test
            // does not have.
            assert!(
                begin(function, &file.to_string_lossy())
                    .contains("must be called from the application")
            );
            assert!(module().begin(function, &arguments(vec![])).is_err());
        }
        // Whether it exists is checked in the application's task.
        assert!(exists(&file).is_ok());
        #[cfg(unix)]
        {
            let link = directory.join("gone");
            std::os::unix::fs::symlink(directory.join("missing"), &link).unwrap();
            assert!(exists(&link).is_ok(), "a dangling link exists as an entry");
        }
        assert!(
            exists(&directory.join("missing"))
                .unwrap_err()
                .message()
                .contains("missing")
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn chosen_files_are_registered_unless_too_large_or_unreadable() {
        let directory = std::env::temp_dir().join(format!("maka-files-chosen-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let small = directory.join("abc.txt");
        std::fs::write(&small, "abc").unwrap();
        // Sparse: one byte over the limit without writing 50 MiB.
        let large = directory.join("large.bin");
        std::fs::File::create(&large)
            .unwrap()
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let answered = runtime
            .block_on(register(vec![
                small.clone(),
                large,
                directory.clone(),
                directory.join("missing"),
            ]))
            .unwrap();
        let files = answered.as_array().unwrap();
        assert_eq!(files.len(), 4);

        assert_eq!(files[0].get("name"), Some(&HostValue::from("abc.txt")));
        assert_eq!(files[0].get("bytes"), Some(&HostValue::Number(3.0)));
        let handle = files[0].get("handle").and_then(HostValue::as_str).unwrap();
        let registered = chosen(handle).unwrap();
        assert_eq!(registered.path, small);
        assert_eq!(registered.bytes, 3);
        assert_eq!(
            files[0].get("digest").and_then(HostValue::as_str),
            Some(registered.digest.as_str())
        );

        assert_eq!(files[1].get("name"), Some(&HostValue::from("large.bin")));
        assert_eq!(files[1].get("tooLarge"), Some(&HostValue::Bool(true)));
        assert_eq!(
            files[1].get("bytes"),
            Some(&HostValue::Number((MAX_ATTACHMENT_BYTES + 1) as f64))
        );
        assert!(files[1].get("handle").is_none());
        assert_eq!(
            files[2].get("error"),
            Some(&HostValue::from("not a regular file"))
        );
        assert!(files[3].get("error").is_some() && files[3].get("handle").is_none());

        // Released, a handle names nothing; an unknown one is ignored.
        let release = |handles: Vec<HostValue>| {
            module().call("release", &HostArguments::new([HostValue::Array(handles)]))
        };
        release(vec![HostValue::from(handle), HostValue::from("unknown")]).unwrap();
        assert!(chosen(handle).is_none());
        assert!(release(vec![HostValue::Number(1.0)]).is_err());
        assert!(module().call("release", &arguments(vec![])).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_file_that_changes_while_it_is_read_is_refused() {
        let directory = std::env::temp_dir().join(format!("maka-files-digest-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("a.txt");
        std::fs::write(&path, "abcd").unwrap();
        assert_eq!(
            digest(&path, 3).unwrap_err(),
            "the file changed while it was read"
        );
        assert_eq!(
            digest(&path, 5).unwrap_err(),
            "the file changed while it was read"
        );
        assert!(digest(&path, 4).unwrap().starts_with("sha256:"));
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
