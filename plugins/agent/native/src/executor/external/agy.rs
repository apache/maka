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
#[cfg(windows)]
use junction::create as link_profile;
#[cfg(windows)]
use std::fs::remove_dir as unlink_profile;
use std::{
    fs,
    io::{self, Write},
    path::Path,
};
#[cfg(unix)]
use std::{fs::remove_file as unlink_profile, os::unix::fs::symlink as link_profile};

pub(super) const HOST_AGENT: &str = "maka";
const OWNERS: &str = "# Apache Maka installations: ";
const PROFILE: &str = "name: maka
description: Antigravity agent for Maka conversations
mainAgent: true
subagent: false
tools: [search_web, define_subagent, invoke_subagent, manage_subagents, send_message]
---
Use the Maka MCP tools for workspace operations, automation and conversation work.
";

fn agents_directory(home: &Path) -> PathBuf {
    home.join(".gemini/config/agents")
}

fn managed_directory(home: &Path) -> PathBuf {
    home.join(".maka/external-agents/antigravity")
}

pub(crate) async fn sync_host_agent(
    home: Option<PathBuf>,
    installation: String,
    enabled: bool,
) -> Result<(), String> {
    let Some(home) = home else {
        return if enabled {
            Err("Cannot locate the account home for Antigravity".into())
        } else {
            Ok(())
        };
    };
    tokio::task::spawn_blocking(move || {
        sync_profile(&home, &installation, enabled).map_err(|error| {
            format!(
                "Antigravity agent {}: {error}",
                agents_directory(&home).join(HOST_AGENT).display()
            )
        })
    })
    .await
    .map_err(|error| format!("Antigravity agent setup failed: {error}"))?
}

#[derive(PartialEq, Eq)]
enum Registration {
    Missing,
    Managed,
    User,
}

fn registration(path: &Path, target: &Path) -> io::Result<Registration> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() => {
            let link = fs::read_link(path)?;
            Ok(if dunce::simplified(&link) == dunce::simplified(target) {
                Registration::Managed
            } else {
                Registration::User
            })
        }
        Ok(_) => Ok(Registration::User),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Registration::Missing),
        Err(error) => Err(error),
    }
}

fn name_in_use() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "a user agent already uses the name maka",
    )
}

fn read_profile(path: &Path) -> io::Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::read_to_string(path).map(Some),
        Ok(_) => Err(name_in_use()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn profile_parts(profile: &str) -> Option<(&str, &str)> {
    let (owners, body) = profile.strip_prefix("---\n")?.split_once('\n')?;
    Some((owners.strip_prefix(OWNERS)?, body))
}

fn sync_profile(home: &Path, installation: &str, enabled: bool) -> io::Result<()> {
    let agents = agents_directory(home);
    let path = agents.join(HOST_AGENT);
    let directory = managed_directory(home);
    let target = directory.join("agent");
    let profile = target.join("agent.md");
    if !enabled && !profile.try_exists()? && registration(&path, &target)? != Registration::Managed
    {
        return Ok(());
    }
    fs::create_dir_all(&directory)?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("profile.lock"))?;
    lock.lock()?;

    let registration = registration(&path, &target)?;
    if enabled && (registration == Registration::User || agents.join("maka.md").try_exists()?) {
        return Err(name_in_use());
    }

    let current = read_profile(&profile)?;
    let mut owners = std::collections::BTreeSet::new();
    if let Some(current) = &current {
        let (ids, _) = profile_parts(current).ok_or_else(name_in_use)?;
        owners.extend(ids.split_whitespace());
    }
    if enabled {
        owners.insert(installation);
    } else if !owners.remove(installation)
        && (current.is_some() || registration != Registration::Managed)
    {
        return Ok(());
    }

    if owners.is_empty() {
        if registration == Registration::Managed {
            unlink_profile(&path)?;
        }
        if current.is_some() {
            fs::remove_file(profile)?;
        }
    } else {
        let rendered = format!(
            "---\n{OWNERS}{}\n{PROFILE}",
            owners.iter().copied().collect::<Vec<_>>().join(" ")
        );
        if current.as_deref() != Some(rendered.as_str()) {
            fs::create_dir_all(&target)?;
            let mut staging = tempfile::NamedTempFile::new_in(&directory)?;
            staging.write_all(rendered.as_bytes())?;
            if current.is_some() {
                staging.persist(&profile)?;
            } else {
                staging.persist_noclobber(&profile)?;
            }
        }
        if registration == Registration::Missing {
            fs::create_dir_all(&agents)?;
            link_profile(&target, &path)?;
        }
    }

    Ok(())
}

pub(super) async fn require_host_agent() -> Result<(), Error> {
    let home = std::env::home_dir()
        .ok_or_else(|| Error::Invalid("Cannot locate the account home for Antigravity".into()))?;
    let path = agents_directory(&home).join(HOST_AGENT);
    let target = managed_directory(&home).join("agent");
    let link = tokio::fs::read_link(&path).await.map_err(|error| {
        Error::Invalid(format!(
            "Cannot read Antigravity agent link {}: {error}",
            path.display()
        ))
    })?;
    if dunce::simplified(&link) == dunce::simplified(&target) {
        let profile = path.join("agent.md");
        let text = tokio::fs::read_to_string(&profile).await.map_err(|error| {
            Error::Invalid(format!(
                "Cannot read Antigravity agent {}: {error}",
                profile.display()
            ))
        })?;
        if profile_parts(&text).is_some_and(|(_, body)| body == PROFILE) {
            return Ok(());
        }
    }
    Err(Error::Invalid(format!(
        "Antigravity agent {} does not match Maka's definition",
        path.display()
    )))
}

pub(super) async fn models(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let stdout = read_command(config, cwd, &["models"], cancellation).await?;
    let models = tokio::task::spawn_blocking(move || parse_models(&stdout))
        .await
        .map_err(|_| Error::Provider("agy model parser task failed".into()))??;
    Ok(serde_json::json!({
        "installation":{"kind":"available"},
        "authentication":{"kind":"unknown","source":"agy models"},
        "models":{"kind":"ok","models":models}
    }))
}

pub(super) async fn usage_limits(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let stdout = read_command(
        config,
        cwd,
        &["-p", "/usage", "--output-format", "stream-json"],
        cancellation,
    )
    .await?;
    tokio::task::spawn_blocking(move || parse_usage(&stdout))
        .await
        .map_err(|_| Error::Provider("agy usage parser task failed".into()))?
}

fn parse_usage(stdout: &[u8]) -> Result<Value, Error> {
    use maka_agent_api::external::ExternalUsageLimits;
    use maka_agent_ports::provider::{UsageLimit, UsagePeriod};

    #[derive(Deserialize)]
    struct ResultEnvelope {
        status: String,
        num_turns: u64,
        command: UsageCommand,
    }
    #[derive(Deserialize)]
    struct UsageCommand {
        name: String,
        data: Groups,
    }
    #[derive(Deserialize)]
    struct Groups {
        groups: Vec<Group>,
    }
    #[derive(Deserialize)]
    struct Group {
        name: String,
        buckets: Vec<Bucket>,
    }
    #[derive(Deserialize)]
    struct Bucket {
        window: Window,
        remaining_fraction: f64,
        reset_time: Option<String>,
        #[serde(default)]
        disabled: bool,
    }
    #[derive(Deserialize)]
    enum Window {
        #[serde(rename = "weekly")]
        Weekly,
        #[serde(rename = "5h")]
        FiveHours,
    }
    let invalid = || Error::Invalid("agy returned invalid usage limits".into());
    let output = std::str::from_utf8(stdout).map_err(|_| invalid())?;
    let mut result = None;
    for line in output.lines() {
        let mut event: Value = serde_json::from_str(line).map_err(|_| invalid())?;
        if event["event"] == "result" {
            if result.is_some() {
                return Err(invalid());
            }
            result = Some(
                serde_json::from_value::<ResultEnvelope>(event["result"].take())
                    .map_err(|_| invalid())?,
            );
        }
    }
    let result = result.ok_or_else(invalid)?;
    if result.status != "SUCCESS" || result.num_turns != 0 || result.command.name != "usage" {
        return Err(invalid());
    }
    let mut limits = Vec::new();
    for group in result.command.data.groups {
        let label = group.name.trim();
        if label.is_empty() || label.chars().any(char::is_control) {
            return Err(invalid());
        }
        for bucket in group.buckets {
            let period = UsagePeriod::Duration {
                seconds: match bucket.window {
                    Window::Weekly => 7 * 24 * 3600,
                    Window::FiveHours => 5 * 3600,
                },
            };
            if bucket.disabled {
                limits.push(UsageLimit::Disabled {
                    label: label.into(),
                    period,
                });
            } else {
                if !(0.0..=1.0).contains(&bucket.remaining_fraction) {
                    return Err(invalid());
                }
                let resets_at = bucket
                    .reset_time
                    .map(|reset| {
                        let timestamp: jiff::Timestamp = reset.parse().map_err(|_| invalid())?;
                        u64::try_from(timestamp.as_second()).map_err(|_| invalid())
                    })
                    .transpose()?;
                limits.push(UsageLimit::Window {
                    label: Some(label.into()),
                    period: Some(period),
                    resets_at,
                    used_percent: (1.0 - bucket.remaining_fraction) * 100.0,
                    quantity: None,
                });
            }
        }
    }
    serde_json::to_value(ExternalUsageLimits::Ready { limits }).map_err(|_| invalid())
}

async fn read_command(
    config: &runtime::ResolvedCommand<'_>,
    cwd: &str,
    args: &[&str],
    cancellation: CancellationToken,
) -> Result<Vec<u8>, Error> {
    use tokio::io::AsyncWriteExt;
    if cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let mut command = config.command(cwd);
    command.args(args);
    let mut process = maka_process::pipe::spawn(command)
        .await
        .map_err(runtime::process_error)?;
    let observed = async {
        process
            .stdin
            .shutdown()
            .await
            .map_err(|_| Error::Provider("Could not close agy query input".into()))?;
        let status = async {
            process
                .child
                .wait()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)
        };
        tokio::try_join!(
            status,
            query_output(&mut process.stdout, true),
            query_output(&mut process.stderr, false),
        )
    };
    let observed = tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(runtime::SETUP_TIMEOUT, observed) => {
            result.unwrap_or_else(|_| Err(Error::Provider("agy query timed out".into())))
        }
    };
    let (status, stdout, _) = match observed {
        Ok(value) => value,
        Err(error) => {
            process
                .child
                .terminate()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
            tokio::time::timeout(std::time::Duration::from_secs(4), process.child.wait())
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            let drain = async {
                let mut stdout_sink = tokio::io::sink();
                let mut stderr_sink = tokio::io::sink();
                tokio::try_join!(
                    tokio::io::copy(&mut process.stdout, &mut stdout_sink),
                    tokio::io::copy(&mut process.stderr, &mut stderr_sink),
                )
            };
            tokio::time::timeout(std::time::Duration::from_secs(1), drain)
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            return Err(error);
        }
    };
    if !status.success() {
        // Native diagnostics may contain account information; they are never surfaced.
        return Err(Error::Provider("agy query failed".into()));
    }
    Ok(stdout)
}

async fn query_output(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    retain: bool,
) -> Result<Vec<u8>, Error> {
    use tokio::io::AsyncReadExt;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    let mut observed = 0usize;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| Error::Provider("Could not read agy query output".into()))?;
        if count == 0 {
            return Ok(result);
        }
        observed += count;
        if observed > runtime::MAX_MESSAGE_BYTES {
            return Err(Error::Invalid(
                "agy query output exceeds the 256 MiB observation budget".into(),
            ));
        }
        if retain {
            result.extend_from_slice(&buffer[..count]);
        }
    }
}

fn parse_models(bytes: &[u8]) -> Result<Vec<Value>, Error> {
    let catalog = std::str::from_utf8(bytes)
        .map_err(|_| Error::Invalid("agy models returned non-UTF-8 output".into()))?;
    let mut models = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for row in catalog.lines() {
        let (id, name) = row
            .split_once('\t')
            .filter(|(id, name)| !id.is_empty() && !name.is_empty() && !name.contains('\t'))
            .ok_or_else(|| Error::Invalid("agy models returned a malformed TSV row".into()))?;
        if !ids.insert(id) {
            return Err(Error::Invalid("agy models returned duplicate IDs".into()));
        }
        models.push(serde_json::json!({"id":id,"displayName":name}));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roots_share_the_profile_until_the_last_one_disables_antigravity() -> io::Result<()> {
        let home = tempfile::tempdir()?;
        let home = home.path();
        let link = home.join(".gemini/config/agents/maka");
        let target = home.join(".maka/external-agents/antigravity/agent");
        sync_profile(home, "primary", false)?;
        assert!(!home.join(".gemini").try_exists()?);
        assert!(!home.join(".maka").try_exists()?);
        sync_profile(home, "primary", true)?;
        sync_profile(home, "secondary", true)?;
        assert_eq!(
            dunce::simplified(&fs::read_link(&link)?),
            dunce::simplified(&target)
        );
        assert!(!home.join(".gemini/config/.maka.lock").try_exists()?);
        sync_profile(home, "primary", false)?;
        sync_profile(home, "primary", false)?;
        let definition = fs::read_to_string(link.join("agent.md"))?;
        assert!(definition.contains("# Apache Maka installations: secondary\n"));
        assert!(definition.contains("tools: [search_web"));
        sync_profile(home, "secondary", false)?;
        assert_eq!(
            fs::symlink_metadata(&link).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(!target.join("agent.md").try_exists()?);
        Ok(())
    }

    #[test]
    fn a_user_agent_is_neither_replaced_nor_removed() -> io::Result<()> {
        let home = tempfile::tempdir()?;
        let home = home.path();
        let agents = home.join(".gemini/config/agents");
        let profile = agents.join("maka.md");
        fs::create_dir_all(&agents)?;
        let user_agent = format!("---\n{OWNERS}primary\n{PROFILE}My own instructions.\n");
        fs::write(&profile, &user_agent)?;
        assert_eq!(
            sync_profile(home, "primary", true).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        sync_profile(home, "primary", false)?;
        assert_eq!(fs::read_to_string(&profile)?, user_agent);

        let user_target = home.join("user-agent");
        fs::create_dir(&user_target)?;
        fs::rename(&profile, user_target.join("agent.md"))?;
        let link = agents.join("maka");
        link_profile(&user_target, &link)?;
        assert_eq!(
            sync_profile(home, "primary", true).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        sync_profile(home, "primary", false)?;
        assert_eq!(
            dunce::simplified(&fs::read_link(&link)?),
            dunce::simplified(&user_target)
        );
        assert_eq!(fs::read_to_string(link.join("agent.md"))?, user_agent);
        Ok(())
    }

    #[test]
    fn headless_usage_keeps_account_groups_and_disabled_windows() {
        let output = br#"{"event":"command_result","command":{"name":"usage"}}
{"event":"result","result":{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"weekly","remaining_fraction":0,"reset_time":"2026-11-12T00:00:00Z"},{"window":"5h","remaining_fraction":0,"disabled":true}]},{"name":"Claude and GPT models","buckets":[{"window":"5h","remaining_fraction":0.75}]}]}}}}
"#;
        assert_eq!(
            parse_usage(output).unwrap(),
            json!({"kind":"ready","limits":[
                {"kind":"window","label":"Gemini Models","period":{"kind":"duration","seconds":604800},"usedPercent":100.0,"resetsAt":1794441600u64},
                {"kind":"disabled","label":"Gemini Models","period":{"kind":"duration","seconds":18000}},
                {"kind":"window","label":"Claude and GPT models","period":{"kind":"duration","seconds":18000},"usedPercent":25.0}
            ]})
        );
    }
}
