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
use maka_agent_facts::display::Text;
use maka_tools::request::{BindingRequest, BoundTool, RequestBinding};
use std::collections::BTreeMap;

pub(super) fn schema(mut input: Value, titles: bool) -> Value {
    input["properties"]
        .as_object_mut()
        .expect("shell input properties")
        .remove("shell");
    if titles {
        input["properties"]["title"] = serde_json::json!({
            "type": "string",
            "description": "Short, user-facing description of what this command does, in the user's language. Describe the action, not an assumed result."
        });
    }
    input
}

fn guidance(
    input: &mut Value,
    shell: &maka_agent_facts::configuration::policy::ShellPolicy,
    available: bool,
) {
    #[cfg(windows)]
    {
        use maka_agent_facts::configuration::policy::ShellPreference;
        let dialect = match shell.preference {
            ShellPreference::Auto => {
                "On Windows, commands use the automatically selected PowerShell (or cmd fallback); write PowerShell syntax unless the Host selects cmd."
            }
            ShellPreference::GitBash if available => {
                "Commands use the configured Git Bash; write Bash syntax, not PowerShell syntax."
            }
            ShellPreference::GitBash => {
                "The configured Git Bash is unavailable. Repair the shell setting; commands fail rather than falling back to PowerShell."
            }
        };
        input["properties"]["command"]["description"] = serde_json::json!(dialect);
    }
    #[cfg(not(windows))]
    let _ = (input, shell, available);
}
pub(super) fn title(input: &Value) -> Option<Text> {
    input["title"]
        .as_str()
        .and_then(Text::single_line)
        .or_else(|| input["command"].as_str().and_then(Text::single_line))
}

pub(super) struct Binding {
    pub service: Service,
    pub configuration: Arc<maka_config::ConfigurationStore>,
    pub input: Value,
}
impl RequestBinding for Binding {
    fn bind(&self, _: BindingRequest) -> maka_tools::request::BindingFuture {
        let mut service = self.service.clone();
        let configuration = self.configuration.clone();
        let input = self.input.clone();
        Box::pin(async move {
            let shell = configuration
                .runtime_policy()
                .await
                .map_err(|error| ToolError::Failed(error.to_string()))?
                .policy
                .shell;
            service.shell = Some(shell.clone());
            let titles = shell.titles;
            let mut input = schema(input, titles);
            #[cfg(windows)]
            let available = if shell.preference
                == maka_agent_facts::configuration::policy::ShellPreference::GitBash
            {
                let path = std::path::PathBuf::from(&shell.executable);
                tokio::task::spawn_blocking(move || path.is_file())
                    .await
                    .map_err(|error| ToolError::Failed(error.to_string()))?
            } else {
                true
            };
            #[cfg(not(windows))]
            let available = true;
            guidance(&mut input, &shell, available);
            Ok(BTreeMap::from([(
                service.selection.name.clone(),
                BoundTool::Input {
                    handler: Arc::new(service),
                    schema: input,
                },
            )]))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_labels_preserve_complete_sanitized_text_with_command_fallback() {
        assert_eq!(title(&serde_json::json!({"command":"printf actual", "title":"  检查\n构建\u{202e}\u{0000}  "})).unwrap().fallback, "检查 构建");
        assert_eq!(
            title(&serde_json::json!({"command":"printf actual", "title":"  \n "}))
                .unwrap()
                .fallback,
            "printf actual"
        );
        assert_eq!(
            title(&serde_json::json!({"command":"printf actual"}))
                .unwrap()
                .fallback,
            "printf actual"
        );
        assert_eq!(
            title(&serde_json::json!({"command":"printf actual", "title":"界".repeat(100)}))
                .unwrap()
                .fallback,
            "界".repeat(100)
        );
        assert_eq!(
            title(
                &serde_json::json!({"command":"  printf\nactual\u{202e}\u{0000}  ", "title":" \n "})
            )
            .unwrap()
            .fallback,
            "printf actual"
        );
        assert!(
            title(&serde_json::json!({"command":"\u{0000}\u{202e}", "title":" \n "})).is_none()
        );
    }
}
