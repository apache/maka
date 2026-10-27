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

//! Generates a fresh TypeScript project checking the real workbench sources.
//!
//! Pass a task-private output directory outside the checkout. It must not exist.
//! The entry and permission components use the current NSH and Host declarations.

use std::{
    env,
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
};

const USAGE: &str = "usage: cargo run -p maka-workbench --example ui_types -- OUTPUT_DIR\n\
OUTPUT_DIR must not exist; choose a task-private directory outside the checkout";
const SOURCES: &[&str] = &[
    "App.tsx",
    "ComputerAppControls.tsx",
    "ComputerAppRequest.tsx",
    "CapabilityRequest.tsx",
];

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let Some(output) = args.next() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE).into());
    };
    if args.next().is_some() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE).into());
    }
    if output == "--help" || output == "-h" {
        println!("{USAGE}");
        return Ok(());
    }
    let output = PathBuf::from(output);
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("app");
    let sources = SOURCES
        .iter()
        .map(|name| {
            let path = app.join(name);
            path.canonicalize()
                .map_err(|source| FileError::new("resolve source", &path, source))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let sources = serde_json::to_value(sources)?;
    if let Some(parent) = output.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|source| FileError::new("create parent", parent, source))?;
    }
    // A fresh tree prevents stale declarations from participating in the check.
    fs::create_dir(&output)
        .map_err(|source| FileError::new("create fresh output", &output, source))?;

    let ui_sets = [
        nsh_base::registry().into(),
        maka_workbench::bindings::ui_set_description(),
    ];
    let mut definitions = nsh_js::type_definitions(&ui_sets);
    definitions.extend(nsh_bundler::type_definitions());
    let tokens = nsh_base::Theme::default().into_tokens();
    definitions.push((
        "nsh/tokens.d.ts".to_owned(),
        nsh_bundler::tokens_declaration(&tokens),
    ));

    let types = output.join(".nsh/types");
    for (name, contents) in definitions {
        write(&types.join(name), contents.as_bytes())?;
    }
    write(
        &output.join(".nsh/tsconfig.json"),
        nsh_bundler::TSCONFIG_BASE.as_bytes(),
    )?;
    // Keep the base config's generated globals, assets and tokens in `files`.
    let config = serde_json::json!({
        "extends": "./.nsh/tsconfig.json",
        "compilerOptions": { "skipLibCheck": false },
        "include": sources,
    });
    let mut config = serde_json::to_vec_pretty(&config)?;
    config.push(b'\n');
    write(&output.join("tsconfig.json"), &config)?;
    println!("{}", output.join("tsconfig.json").display());
    Ok(())
}

fn write(path: &Path, contents: &[u8]) -> Result<(), FileError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|source| FileError::new("create directory", parent, source))?;
    }
    fs::write(path, contents).map_err(|source| FileError::new("write", path, source))
}

#[derive(Debug)]
struct FileError {
    action: &'static str,
    path: PathBuf,
    source: io::Error,
}

impl FileError {
    fn new(action: &'static str, path: &Path, source: io::Error) -> Self {
        Self {
            action,
            path: path.to_path_buf(),
            source,
        }
    }
}

impl fmt::Display for FileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} {}: {}",
            self.action,
            self.path.display(),
            self.source
        )
    }
}

impl Error for FileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.source)
    }
}
