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

const FILENAMES: [&str; 2] = ["mcp.json", ".mcp.json"];

#[derive(Clone, Debug, Default, Serialize)]
pub(super) struct FileConfiguration {
    pub path: Option<PathBuf>,
    content_digest: Option<String>,
    // A disabled entry masks an inherited server with the same name.
    pub servers: BTreeMap<String, Option<ServerConfiguration>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    #[serde(default)]
    mcp_servers: BTreeMap<String, Entry>,
    #[serde(rename = "$schema")]
    _schema: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

pub(super) fn global(home: Option<(&Dir, &Path)>) -> Result<FileConfiguration, String> {
    let Some((home, path)) = home else {
        return Ok(FileConfiguration::default());
    };
    for directory in [".maka", ".agents"] {
        let dir = match home.open_dir(directory) {
            Ok(dir) => dir,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if home.symlink_metadata(directory).is_ok() {
                    return Err(format!(
                        "MCP configuration directory {directory} is unavailable"
                    ));
                }
                continue;
            }
            Err(_) => {
                return Err(format!(
                    "MCP configuration directory {directory} is unavailable"
                ));
            }
        };
        let found = read(&dir, &path.join(directory))?;
        if found.path.is_some() {
            return Ok(found);
        }
    }
    Ok(FileConfiguration::default())
}

pub(super) fn read(dir: &Dir, directory: &Path) -> Result<FileConfiguration, String> {
    for name in FILENAMES {
        match dir.symlink_metadata(name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(format!("MCP configuration {name} is unavailable")),
            Ok(_) => {}
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let mut file = dir
            .open_with(name, &options)
            .map_err(|_| format!("MCP configuration {name} is unavailable"))?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Err(format!("MCP configuration {name} must be a regular file"));
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| format!("MCP configuration {name} is unavailable"))?;
        // Never include serde's input-dependent error text: it may contain secrets.
        let document: Document = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "Invalid MCP configuration {name} at line {}, column {}",
                error.line(),
                error.column()
            )
        })?;
        let mut servers = BTreeMap::new();
        for (server, entry) in document.mcp_servers {
            let config = if entry.disabled {
                None
            } else {
                Some(entry.normalize(server.clone(), directory)?)
            };
            servers.insert(server, config);
        }
        return Ok(FileConfiguration {
            path: Some(directory.join(name)),
            content_digest: Some(maka_agent_facts::artifact::content_digest(&bytes)),
            servers,
        });
    }
    Ok(FileConfiguration::default())
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
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    #[test]
    fn reads_complete_large_configuration_with_many_servers() {
        let temp = tempfile::tempdir().unwrap();
        let root = dir(temp.path());
        let entries = (0..65)
            .map(|index| {
                (
                    format!("server-{index}"),
                    json!({"command":"node","args":["x".repeat(17 * 1024)]}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        document(&temp.path().join("mcp.json"), json!({"mcpServers":entries}));
        let file = read(&root, temp.path()).unwrap();
        assert_eq!(file.servers.len(), 65);
        let Transport::Stdio { args, .. } = &file.servers["server-64"].as_ref().unwrap().transport
        else {
            panic!("stdio server")
        };
        assert_eq!(args.as_slice(), &["x".repeat(17 * 1024)]);
    }

    #[test]
    fn global_directory_and_filename_precedence_only_falls_back_when_absent() {
        let temp = tempfile::tempdir().unwrap();
        let home = dir(temp.path());
        home.create_dir_all(".agents").unwrap();
        home.create_dir_all(".maka").unwrap();
        document(
            &temp.path().join(".agents/.mcp.json"),
            json!({"mcpServers":{"fallback":{"command":"node"}}}),
        );
        let read_global = || global(Some((&home, temp.path())));
        assert!(read_global().unwrap().servers.contains_key("fallback"));
        document(
            &temp.path().join(".maka/.mcp.json"),
            json!({"mcpServers":{"preferred":{"url":"http://localhost/mcp"}}}),
        );
        assert!(read_global().unwrap().servers.contains_key("preferred"));
        document(
            &temp.path().join(".maka/mcp.json"),
            json!({"mcpServers":{}}),
        );
        assert!(read_global().unwrap().servers.is_empty());
        document(
            &temp.path().join(".maka/mcp.json"),
            json!({"$schema":"https://example.invalid/mcp.schema.json"}),
        );
        assert!(read_global().unwrap().servers.is_empty());
        std::fs::write(temp.path().join(".maka/mcp.json"), "bad").unwrap();
        assert!(read_global().is_err());
        home.remove_file(".maka/mcp.json").unwrap();
        home.create_dir(".maka/mcp.json").unwrap();
        assert!(read_global().is_err());
    }
    #[test]
    fn project_is_exact_root_and_replaces_whole_server_or_disables_it() {
        let temp = tempfile::tempdir().unwrap();
        let home = dir(temp.path());
        home.create_dir("child").unwrap();
        document(
            &temp.path().join("mcp.json"),
            json!({"mcpServers":{
                "same":{"command":"node","cwd":"servers","env":{"TOKEN":"SECRET"}},
                "removed":{"url":"https://example.com/mcp"}
            }}),
        );
        let base = read(&home, temp.path()).unwrap();
        let child = dir(&temp.path().join("child"));
        assert!(
            read(&child, &temp.path().join("child"))
                .unwrap()
                .path
                .is_none()
        );
        document(
            &temp.path().join("child/.mcp.json"),
            json!({"mcpServers":{
                "same":{"url":"http://localhost/mcp","type":"http"},"removed":{"disabled":true}
            }}),
        );
        let project = read(&child, &temp.path().join("child")).unwrap();
        let merged = merge(&[], &[&base, &project]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "same");
        assert!(
            matches!(&merged[0].transport, Transport::StreamableHttp{url,headers,..} if url == "http://localhost/mcp" && headers.is_empty())
        );
        assert!(
            matches!(&base.servers["same"].as_ref().unwrap().transport, Transport::Stdio{cwd,..} if Path::new(cwd) == temp.path().join("servers"))
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
            document(&temp.path().join("mcp.json"), value);
            let error = read(&root, temp.path()).unwrap_err();
            assert!(!error.contains("SECRET"));
        }
    }
    #[cfg(unix)]
    #[test]
    fn cannot_follow_an_escape_or_dangling_link_or_open_a_fifo() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir(temp.path());
        document(&outside.path().join("private"), json!({"mcpServers":{}}));
        document(&temp.path().join(".mcp.json"), json!({"mcpServers":{}}));
        for target in [outside.path().join("private"), temp.path().join("missing")] {
            std::os::unix::fs::symlink(target, temp.path().join("mcp.json")).unwrap();
            assert!(read(&root, temp.path()).is_err());
            root.remove_file("mcp.json").unwrap();
        }
        let path =
            std::ffi::CString::new(temp.path().join("mcp.json").as_os_str().as_encoded_bytes())
                .unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(read(&root, temp.path()).is_err());
    }
}

#[cfg(test)]
mod relative_command_tests {
    use super::*;
    #[test]
    fn command_with_a_relative_path_is_resolved_from_effective_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let directory = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        std::fs::write(
            temp.path().join("mcp.json"),
            r#"{"mcpServers":{"my-server":{"command":"./.venv/bin/mcp","cwd":"server"}}}"#,
        )
        .unwrap();
        let config = read(&directory, temp.path()).unwrap();
        let Transport::Stdio { command, cwd, .. } =
            &config.servers["my-server"].as_ref().unwrap().transport
        else {
            panic!()
        };
        assert_eq!(Path::new(cwd), temp.path().join("server"));
        assert_eq!(
            Path::new(command),
            temp.path().join("server/./.venv/bin/mcp")
        );
    }
}
