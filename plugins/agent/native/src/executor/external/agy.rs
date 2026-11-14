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
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

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

fn profile_path(home: &Path) -> PathBuf {
    home.join(".gemini")
        .join("config")
        .join("agents")
        .join("maka.md")
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
    let path = profile_path(&home);
    tokio::task::spawn_blocking(move || {
        sync_profile(&path, &installation, enabled)
            .map_err(|error| format!("Antigravity agent {}: {error}", path.display()))
    })
    .await
    .map_err(|error| format!("Antigravity agent setup failed: {error}"))?
}

fn read_profile(path: &Path) -> io::Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::read_to_string(path).map(Some),
        Ok(_) => Err(name_in_use()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn name_in_use() -> io::Error {
    io::Error::new(
        io::ErrorKind::AlreadyExists,
        "a user agent already uses the name maka",
    )
}

fn profile_owners(profile: &str) -> Option<&str> {
    profile.lines().nth(1)?.strip_prefix(OWNERS)
}

fn sync_profile(path: &Path, installation: &str, enabled: bool) -> io::Result<()> {
    if !enabled && !path.try_exists()? {
        return Ok(());
    }
    let directory = path.parent().expect("agent profile directory");
    if enabled {
        fs::create_dir_all(directory)?;
    }
    // Roots share the configuration file. Hold the lock only while reconciling it.
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.with_file_name(".maka.lock"))?;
    lock.lock()?;
    let current = match read_profile(path) {
        Ok(current) => current,
        Err(error)
            if !enabled
                && matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::InvalidData
                ) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let mut owners = std::collections::BTreeSet::new();
    if let Some(current) = current.as_deref() {
        match profile_owners(current) {
            Some(ids) => owners.extend(ids.split_whitespace()),
            None if enabled => return Err(name_in_use()),
            None => return Ok(()),
        }
    }
    if enabled {
        if directory.join(HOST_AGENT).join("agent.md").try_exists()? {
            return Err(name_in_use());
        }
        owners.insert(installation);
    } else if !owners.remove(installation) {
        return Ok(());
    }
    if owners.is_empty() {
        return fs::remove_file(path);
    }
    let rendered = format!(
        "---\n{OWNERS}{}\n{PROFILE}",
        owners.into_iter().collect::<Vec<_>>().join(" ")
    );
    if current.as_deref() == Some(rendered.as_str()) {
        return Ok(());
    }
    let mut staging = tempfile::NamedTempFile::new_in(directory)?;
    staging.write_all(rendered.as_bytes())?;
    if current.is_some() {
        staging.persist(path)?;
    } else {
        staging.persist_noclobber(path)?;
    }
    Ok(())
}

pub(super) async fn require_host_agent() -> Result<(), Error> {
    let home = std::env::home_dir()
        .ok_or_else(|| Error::Invalid("Cannot locate the account home for Antigravity".into()))?;
    let path = profile_path(&home);
    match tokio::fs::read_to_string(&path).await {
        Ok(text) if profile_owners(&text).is_some() && text.ends_with(PROFILE) => Ok(()),
        Ok(_) => Err(Error::Invalid(format!(
            "Antigravity agent {} does not match Maka's definition",
            path.display()
        ))),
        Err(error) => Err(Error::Invalid(format!(
            "Cannot read Antigravity agent {}: {error}",
            path.display()
        ))),
    }
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
        let profile = profile_path(home.path());
        sync_profile(&profile, "primary", true)?;
        sync_profile(&profile, "secondary", true)?;
        sync_profile(&profile, "primary", false)?;
        assert!(fs::read_to_string(&profile)?.contains("tools: [search_web"));
        sync_profile(&profile, "secondary", false)?;
        assert!(!profile.try_exists()?);
        Ok(())
    }

    #[test]
    fn a_user_agent_is_neither_replaced_nor_removed() -> io::Result<()> {
        let home = tempfile::tempdir()?;
        let profile = profile_path(home.path());
        fs::create_dir_all(profile.parent().unwrap())?;
        let user_agent = "---\nname: maka\ndescription: Custom agent\n---\n";
        fs::write(&profile, user_agent)?;
        assert_eq!(
            sync_profile(&profile, "primary", true).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        sync_profile(&profile, "primary", false)?;
        assert_eq!(fs::read_to_string(&profile)?, user_agent);
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
