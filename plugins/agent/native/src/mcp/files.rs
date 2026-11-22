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

//! Portable MCP configuration is normalized once at the filesystem boundary.
use cap_std::fs::{Dir, OpenOptions};
use maka_agent_facts::configuration::mcp::{ServerConfiguration, Transport};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::{Path, PathBuf},
};

const FILENAME: &str = "mcp.json";

#[derive(Clone, Debug, Default, Serialize)]
pub(super) struct FileConfiguration {
    pub path: Option<PathBuf>,
    content_digest: Option<String>,
    // A disabled entry masks an inherited server with the same name.
    pub servers: BTreeMap<String, Option<ServerConfiguration>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(rename = "type")]
    transport: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    pass_env: Vec<String>,
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    header_env: BTreeMap<String, String>,
    #[serde(default)]
    disabled: bool,
    tools: Option<Vec<String>>,
    #[serde(default)]
    read_only_tools: Vec<String>,
    #[serde(default)]
    preapproved: bool,
    startup_timeout_ms: Option<u64>,
    call_timeout_ms: Option<u64>,
}

pub(crate) struct DocumentFile {
    pub value: serde_json::Value,
    pub revision: String,
}
pub(crate) fn document(dir: &Dir) -> Result<DocumentFile, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match dir.open_with(FILENAME, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if dir.symlink_metadata(FILENAME).is_ok() {
                return Err("MCP configuration is unavailable".into());
            }
            return Ok(DocumentFile {
                value: serde_json::json!({"mcpServers":{}}),
                revision: maka_agent_facts::artifact::content_digest(b""),
            });
        }
        Err(_) => return Err("MCP configuration is unavailable".into()),
    };
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err("MCP configuration must be a regular file".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .read_to_end(&mut bytes)
        .map_err(|_| "MCP configuration is unavailable")?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Invalid MCP configuration at line {}, column {}",
            error.line(),
            error.column()
        )
    })?;
    if !value.is_object()
        || value
            .get("mcpServers")
            .is_some_and(|servers| !servers.is_object())
    {
        return Err("MCP configuration must contain an object of mcpServers".into());
    }
    Ok(DocumentFile {
        value,
        revision: maka_agent_facts::artifact::content_digest(&bytes),
    })
}
pub(crate) fn validate_server(
    name: &str,
    value: serde_json::Value,
    directory: &Path,
) -> Result<(), String> {
    let entry: Entry =
        serde_json::from_value(value).map_err(|_| "Invalid MCP server configuration")?;
    if entry.disabled {
        return Ok(());
    }
    entry.normalize(name.into(), directory).map(|_| ())
}
fn configuration(documents: Vec<(PathBuf, DocumentFile)>) -> Result<FileConfiguration, String> {
    let mut result = FileConfiguration::default();
    let mut raw = BTreeMap::new();
    let mut revisions = Vec::new();
    for (directory, file) in documents {
        if file.revision == maka_agent_facts::artifact::content_digest(b"") {
            continue;
        }
        result.path = Some(directory.join(FILENAME));
        revisions.push((directory.clone(), file.revision));
        if let Some(servers) = file.value["mcpServers"].as_object() {
            for (name, value) in servers {
                raw.insert(name.clone(), (directory.clone(), value.clone()));
            }
        }
    }
    for (name, (directory, value)) in raw {
        let entry: Entry =
            serde_json::from_value(value).map_err(|_| "Invalid MCP server configuration")?;
        let server = if entry.disabled {
            None
        } else {
            Some(entry.normalize(name.clone(), &directory)?)
        };
        result.servers.insert(name, server);
    }
    result.content_digest = result.path.as_ref().map(|_| {
        maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(&revisions).expect("MCP file revisions"),
        )
    });
    Ok(result)
}
pub(super) fn global(home: Option<(&Dir, &Path)>) -> Result<FileConfiguration, String> {
    match home {
        Some((home, path)) => layered(home, path),
        None => Ok(FileConfiguration::default()),
    }
}
pub(super) fn layered(root: &Dir, path: &Path) -> Result<FileConfiguration, String> {
    use cap_fs_ext::DirExt;
    let mut documents = Vec::new();
    for name in [".agents", ".maka"] {
        let directory = match root.open_dir_nofollow(name) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err("MCP configuration directory is unavailable".into()),
        };
        documents.push((path.join(name), document(&directory)?));
    }
    configuration(documents)
}
impl Entry {
    fn normalize(self, name: String, directory: &Path) -> Result<ServerConfiguration, String> {
        let invalid = || "Invalid or unsupported MCP server transport configuration".to_owned();
        let transport = match (self.command, self.url) {
            (Some(command), None)
                if self.transport.as_deref().is_none_or(|kind| kind == "stdio")
                    && self.headers.is_empty()
                    && self.header_env.is_empty() =>
            {
                let cwd = self
                    .cwd
                    .map(PathBuf::from)
                    .unwrap_or_else(|| directory.to_owned());
                let cwd = if cwd.is_absolute() {
                    cwd
                } else {
                    directory.join(cwd)
                };
                let command_path = Path::new(&command);
                let command = if command_path.is_relative() && command_path.components().count() > 1
                {
                    cwd.join(command_path)
                        .to_str()
                        .ok_or_else(invalid)?
                        .to_owned()
                } else {
                    command
                };
                Transport::Stdio {
                    command,
                    args: self.args,
                    cwd: cwd.to_str().ok_or_else(invalid)?.into(),
                    env: self.env,
                    pass_env: self.pass_env,
                }
            }
            (None, Some(url))
                if self.transport.as_deref().is_none_or(|kind| {
                    matches!(kind, "http" | "streamable-http" | "streamable_http")
                }) && self.args.is_empty()
                    && self.cwd.is_none()
                    && self.env.is_empty()
                    && self.pass_env.is_empty() =>
            {
                Transport::StreamableHttp {
                    url,
                    headers: self.headers,
                    header_env: self.header_env,
                }
            }
            _ => return Err(invalid()),
        };
        let config = ServerConfiguration {
            name,
            transport,
            tools: self.tools,
            read_only_tools: self.read_only_tools,
            preapproved: self.preapproved,
            startup_timeout_ms: self.startup_timeout_ms.unwrap_or(10_000),
            call_timeout_ms: self.call_timeout_ms.unwrap_or(120_000),
        };
        maka_mcp::validate(&config)?;
        Ok(config)
    }
}

pub(super) fn merge(
    base: &[ServerConfiguration],
    layers: &[&FileConfiguration],
) -> Vec<ServerConfiguration> {
    let mut servers: BTreeMap<_, _> = base
        .iter()
        .cloned()
        .map(|config| (config.name.clone(), config))
        .collect();
    for layer in layers {
        for (name, config) in &layer.servers {
            match config {
                Some(config) => {
                    servers.insert(name.clone(), config.clone());
                }
                None => {
                    servers.remove(name);
                }
            }
        }
    }
    servers.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn dir(path: &Path) -> Dir {
        Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap()
    }
    fn document(path: &Path, value: serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    #[test]
    fn four_locations_override_whole_servers_and_fall_back_after_removal() {
        let temporary = tempfile::tempdir().unwrap();
        let home_path = temporary.path().join("home");
        let project_path = temporary.path().join("project");
        std::fs::create_dir(&home_path).unwrap();
        std::fs::create_dir(&project_path).unwrap();
        let home = dir(&home_path);
        let project = dir(&project_path);
        let files = [
            project_path.join(".maka/mcp.json"),
            project_path.join(".agents/mcp.json"),
            home_path.join(".maka/mcp.json"),
            home_path.join(".agents/mcp.json"),
        ];
        for (index, file) in files.iter().enumerate() {
            document(
                file,
                json!({"customRoot":{"keep":true},"mcpServers":{
                    "same":{"url":format!("https://example.com/{index}"),"headers":{"x-layer":index.to_string()},"customServer":"keep"}
                }}),
            );
        }
        for (index, file) in files.iter().enumerate() {
            let user = global(Some((&home, &home_path))).unwrap();
            let selected = layered(&project, &project_path).unwrap();
            let servers = merge(&[], &[&user, &selected]);
            assert_eq!(servers.len(), 1);
            assert!(
                matches!(&servers[0].transport, Transport::StreamableHttp { url, headers, .. } if url == &format!("https://example.com/{index}") && headers["x-layer"] == index.to_string())
            );
            std::fs::remove_file(file).unwrap();
        }
        document(
            &files[3],
            json!({"mcpServers":{"same":{"command":"node","env":{"ONLY_LOW":"value"}},"other":{"url":"https://example.com/other"}}}),
        );
        document(&files[0], json!({"mcpServers":{"same":{"disabled":true}}}));
        let servers = merge(
            &[],
            &[
                &global(Some((&home, &home_path))).unwrap(),
                &layered(&project, &project_path).unwrap(),
            ],
        );
        assert_eq!(
            servers
                .iter()
                .map(|server| server.name.as_str())
                .collect::<Vec<_>>(),
            ["other"]
        );
        document(&files[0], json!({"mcpServers":{}}));
        let servers = merge(
            &[],
            &[
                &global(Some((&home, &home_path))).unwrap(),
                &layered(&project, &project_path).unwrap(),
            ],
        );
        assert_eq!(
            servers.len(),
            2,
            "an empty higher file does not mask unrelated lower entries"
        );
    }
    #[test]
    fn rejects_invalid_formats_without_echoing_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let root = dir(temp.path());
        for value in [
            json!({"mcpServers":{"test":{"type":"sse","url":"https://example.com"}}}),
            json!({"mcpServers":{"test":{"command":"node","url":"https://example.com"}}}),
            json!({"mcpServers":{"test":{"command":"node","env":{"TOKEN":42},"SECRET":"SECRET"}}}),
        ] {
            document(&temp.path().join(".maka/mcp.json"), value);
            let error = layered(&root, temp.path()).unwrap_err();
            assert!(!error.contains("SECRET"));
        }
    }
    #[cfg(unix)]
    #[test]
    fn cannot_follow_an_escape_or_dangling_link_or_open_a_fifo() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir(temp.path());
        std::fs::create_dir(temp.path().join(".maka")).unwrap();
        document(&outside.path().join("private"), json!({"mcpServers":{}}));
        document(
            &temp.path().join(".agents/mcp.json"),
            json!({"mcpServers":{}}),
        );
        for target in [outside.path().join("private"), temp.path().join("missing")] {
            std::os::unix::fs::symlink(target, temp.path().join(".maka/mcp.json")).unwrap();
            assert!(layered(&root, temp.path()).is_err());
            root.remove_file(".maka/mcp.json").unwrap();
        }
        let path = std::ffi::CString::new(
            temp.path()
                .join(".maka/mcp.json")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(layered(&root, temp.path()).is_err());
    }
}

#[cfg(test)]
mod relative_command_tests {
    use super::*;
    #[test]
    fn command_with_a_relative_path_is_resolved_from_effective_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let directory = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        std::fs::create_dir(temp.path().join(".maka")).unwrap();
        std::fs::write(
            temp.path().join(".maka/mcp.json"),
            r#"{"mcpServers":{"my-server":{"command":"./.venv/bin/mcp","cwd":"server"}}}"#,
        )
        .unwrap();
        let config = layered(&directory, temp.path()).unwrap();
        let Transport::Stdio { command, cwd, .. } =
            &config.servers["my-server"].as_ref().unwrap().transport
        else {
            panic!()
        };
        assert_eq!(Path::new(cwd), temp.path().join(".maka/server"));
        assert_eq!(
            Path::new(command),
            temp.path().join(".maka/server/./.venv/bin/mcp")
        );
    }
}
