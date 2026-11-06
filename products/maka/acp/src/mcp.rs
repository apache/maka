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

use crate::{
    Error,
    client::{Client, Subscription},
};
use agent_client_protocol::{v1::schema as v1, v2::schema as v2};
use maka_agent_facts::configuration::mcp::{ServerConfiguration, Transport};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub fn valid_v1(value: &Value) -> bool {
    value.as_array().is_some_and(|servers| {
        servers
            .iter()
            .all(|server| match server.get("type").and_then(Value::as_str) {
                Some("http") => serde_json::from_value::<v1::McpServerHttp>(server.clone()).is_ok(),
                Some("stdio") | None if server.get("type").is_none_or(|value| value == "stdio") => {
                    serde_json::from_value::<v1::McpServerStdio>(server.clone()).is_ok()
                }
                _ => false,
            })
    })
}
pub fn valid_v2(value: &Value) -> bool {
    value.as_array().is_some_and(|servers| {
        servers
            .iter()
            .all(|server| match server.get("type").and_then(Value::as_str) {
                Some("http") => serde_json::from_value::<v2::McpServerHttp>(server.clone()).is_ok(),
                Some("stdio") => {
                    serde_json::from_value::<v2::McpServerStdio>(server.clone()).is_ok()
                }
                _ => false,
            })
    })
}
fn stdio(
    command: PathBuf,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Transport, Error> {
    if !command.is_absolute() {
        return Err("MCP command must be an absolute path".into());
    }
    Ok(Transport::Stdio {
        command: command
            .into_os_string()
            .into_string()
            .map_err(|_| "MCP command must be UTF-8")?,
        args,
        env,
        cwd: cwd.to_str().ok_or("MCP cwd must be UTF-8")?.into(),
        pass_env: Vec::new(),
    })
}
pub fn v1(servers: Vec<v1::McpServer>, cwd: &Path) -> Result<Vec<ServerConfiguration>, Error> {
    servers
        .into_iter()
        .map(|server| {
            let (name, transport) = match server {
                v1::McpServer::Stdio(server) => (
                    server.name,
                    stdio(
                        server.command,
                        server.args,
                        server.env.into_iter().map(|v| (v.name, v.value)).collect(),
                        cwd,
                    )?,
                ),
                v1::McpServer::Http(server) => (
                    server.name,
                    Transport::StreamableHttp {
                        url: server.url,
                        headers: server
                            .headers
                            .into_iter()
                            .map(|v| (v.name.to_ascii_lowercase(), v.value))
                            .collect(),
                        header_env: BTreeMap::new(),
                    },
                ),
                _ => return Err("Unsupported MCP transport".into()),
            };
            Ok(ServerConfiguration::new(name, transport))
        })
        .collect()
}
pub fn v2(servers: Vec<v2::McpServer>, cwd: &Path) -> Result<Vec<ServerConfiguration>, Error> {
    servers
        .into_iter()
        .map(|server| {
            let (name, transport) = match server {
                v2::McpServer::Stdio(server) => (
                    server.name,
                    stdio(
                        server.command.0,
                        server.args,
                        server.env.into_iter().map(|v| (v.name, v.value)).collect(),
                        cwd,
                    )?,
                ),
                v2::McpServer::Http(server) => (
                    server.name,
                    Transport::StreamableHttp {
                        url: server.url,
                        headers: server
                            .headers
                            .into_iter()
                            .map(|v| (v.name.to_ascii_lowercase(), v.value))
                            .collect(),
                        header_env: BTreeMap::new(),
                    },
                ),
                _ => return Err("Unsupported MCP transport".into()),
            };
            Ok(ServerConfiguration::new(name, transport))
        })
        .collect()
}
pub async fn attach(
    client: &Client,
    session: &str,
    servers: Vec<ServerConfiguration>,
) -> Result<Option<Subscription>, Error> {
    if servers.is_empty() {
        return Ok(None);
    }
    let mut lease = client
        .subscribe(
            "agent",
            "sessionMcp",
            serde_json::json!({"sessionId":session,"servers":servers}),
        )
        .await?;
    if let Err(error) = lease
        .next::<maka_agent_api::contract::SessionMcpAttached>()
        .await
    {
        lease.close().await?;
        return Err(error);
    }
    Ok(Some(lease))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn raw_transport_validation_cannot_downgrade_malformed_or_unknown_servers() {
        let command = std::env::current_exe().unwrap();
        let stdio = json!({"name":"lody","command":command,"args":[],"env":[]});
        assert!(valid_v1(&json!([stdio])));
        assert!(valid_v2(
            &json!([{"type":"stdio","name":"lody","command":command}])
        ));
        assert!(!valid_v1(
            &json!([{"type":"http","name":"lody","url":"http://localhost","headers":7,"command":command,"args":[],"env":[]}])
        ));
        assert!(!valid_v1(
            &json!([{"type":"future","name":"lody","command":command,"args":[],"env":[]}])
        ));
        assert!(!valid_v2(
            &json!([{"type":"stdio","name":"lody","command":null}])
        ));
        assert!(!valid_v2(&json!([{"type":"future","name":"lody"}])));
    }
    #[test]
    fn client_mcp_configuration_preserves_credentials_without_granting_tool_access() {
        let command = std::env::current_exe().unwrap();
        let cwd = command.parent().unwrap();
        let one = json!({"name":"lody","command":command,"args":["--serve"],"env":[{"name":"CLIENT_TOKEN","value":"secret"}]});
        let mut two = one.clone();
        two["type"] = json!("stdio");
        let first = v1(serde_json::from_value(json!([one])).unwrap(), cwd).unwrap();
        let second = v2(serde_json::from_value(json!([two])).unwrap(), cwd).unwrap();
        assert_eq!(first, second);
        assert!(!first[0].preapproved);
        assert!(first[0].read_only_tools.is_empty());
        let Transport::Stdio {
            env,
            args,
            pass_env,
            ..
        } = &first[0].transport
        else {
            panic!("stdio");
        };
        assert_eq!(env.get("CLIENT_TOKEN").unwrap(), "secret");
        assert_eq!(args, &["--serve"]);
        assert!(pass_env.is_empty());
        let config = v2(serde_json::from_value(json!([{"type":"http","name":"lody","url":"http://localhost/mcp","headers":[{"name":"Authorization","value":"Bearer token"}]}])).unwrap(),cwd).unwrap();
        let Transport::StreamableHttp {
            headers,
            header_env,
            ..
        } = &config[0].transport
        else {
            panic!("HTTP");
        };
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token");
        assert!(header_env.is_empty());
    }
}
