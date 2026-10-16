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

//! The `maka-files` script module: a text file or a folder the user picks.
//!
//! A gpui-shell manifest can grant reads only under the application's own
//! directories, and scripts have no file dialog. `openText` shows the
//! platform's open panel and reads the one file the user chose, so choosing
//! the file is the permission, as with a browser's file input. Nothing else
//! on disk becomes readable. `chooseFolder` shows the panel for one folder
//! and answers its path only; the Host, not the script, reads the folder.
use gpui_shell::{
    HostArguments, HostError, HostModule, HostObject, HostValue,
    gpui::{PathPromptOptions, SharedString},
};
use std::{io::Read, path::Path};

pub const NAME: &str = "maka-files";
/// Read limit when the script does not give one.
const DEFAULT_MAX_BYTES: u64 = 1 << 20;
/// Largest limit a script may ask for.
const MAX_BYTES: u64 = 16 << 20;

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
}
