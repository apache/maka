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

use maka_agent_facts::interaction::{ComputerAppDisplay, ComputerAppIdentity};
use serde::{Deserialize, Serialize};

/// Resolved by the selected desktop, before requesting or using app consent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerAppTarget {
    pub identity: ComputerAppIdentity,
    pub display: ComputerAppDisplay,
    pub allow_always: bool,
    /// A target without a selected live window has no binding yet.
    pub binding: Option<ComputerAppBinding>,
}

/// This selection's process/window provenance, separate from a stored app grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerAppBinding {
    pub pid: u32,
    pub window_id: u64,
    pub process_generation: String,
}

impl ComputerAppTarget {
    /// A cold approved app may acquire a live window while consent is pending.
    /// A previously selected live window must retain its exact provenance.
    pub fn matches_resolved(&self, observed: &Self) -> bool {
        self.identity == observed.identity
            && self.display == observed.display
            && self.allow_always == observed.allow_always
            && self
                .binding
                .as_ref()
                .is_none_or(|binding| observed.binding.as_ref() == Some(binding))
    }

    #[cfg(any(
        all(
            feature = "native-desktop",
            any(target_os = "macos", target_os = "windows")
        ),
        test
    ))]
    pub(crate) fn check_observed(
        &self,
        observed: &Self,
    ) -> Result<(), maka_agent_facts::tools::ToolError> {
        if self.identity != observed.identity
            || self.display.app_path != observed.display.app_path
            || self
                .binding
                .as_ref()
                .is_some_and(|binding| observed.binding.as_ref() != Some(binding))
        {
            return Err(maka_agent_facts::tools::ToolError::Failed(
                "application identity changed after approval; select and approve the app again"
                    .into(),
            ));
        }
        Ok(())
    }
}

#[cfg(any(
    all(
        feature = "native-desktop",
        any(target_os = "macos", target_os = "windows")
    ),
    test
))]
pub(crate) fn macos_target(
    name: String,
    application_id: String,
    app_path: String,
    language: maka_agent_facts::language::Language,
) -> Result<ComputerAppTarget, maka_agent_facts::tools::ToolError> {
    use maka_agent_facts::{
        interaction::{ComputerAppPlatform, ComputerAppRisk},
        language::Language,
        tools::ToolError,
    };
    if name.trim().is_empty() || application_id.trim().is_empty() || !app_path.starts_with('/') {
        return Err(ToolError::Failed(
            "application permission requires resolved bundle metadata".into(),
        ));
    }
    // Bounded historical native-policy observations, not an exhaustive classifier.
    if matches!(
        application_id.as_str(),
        "com.apple.Terminal"
            | "com.googlecode.iterm2"
            | "com.openai.codex"
            | "com.apple.UserNotificationCenter"
    ) {
        return Err(ToolError::Failed(format!(
            "Computer Use is not allowed to use {name} ({application_id})"
        )));
    }
    let risk = matches!(
        application_id.as_str(),
        "com.apple.Safari"
            | "com.google.Chrome"
            | "app.zen-browser.zen"
            | "com.apple.Passwords"
            | "com.apple.keychainaccess"
            | "com.apple.ScreenContinuity"
    )
    .then_some(ComputerAppRisk::High);
    let warning = Some(match (risk, language) {
        (Some(_), Language::En) => {
            "This app can expose sensitive information and perform actions on your behalf. Watch the agent while it uses the app."
        }
        (Some(_), Language::ZhCn) => "此应用可能展示敏感信息并代表你执行操作。请留意代理使用应用时的行为。",
        (Some(_), Language::ZhTw) => "此應用程式可能顯示敏感資訊並代表你執行操作。請留意代理使用應用程式時的行為。",
        (None, Language::En) => {
            "This app's risk classification has not been established. Approve access only if you trust the app and the requested work."
        }
        (None, Language::ZhCn) => "此应用的风险分类尚未确定。请仅在信任该应用和请求的操作时授权。",
        (None, Language::ZhTw) => "此應用程式的風險分類尚未確定。請僅在信任此應用程式和要求的操作時授權。",
    }.to_owned());
    Ok(ComputerAppTarget {
        identity: ComputerAppIdentity {
            platform: ComputerAppPlatform::Macos,
            application_id,
        },
        display: ComputerAppDisplay {
            name,
            app_path,
            risk,
            warning,
        },
        // The original per-app persistent-approval policy is not yet established.
        allow_always: false,
        binding: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{interaction::ComputerAppRisk, language::Language};

    #[test]
    fn policy_uses_observed_bundle_identity_without_guessing_unknown_risk() {
        let unknown = macos_target(
            "Safari".into(),
            "org.example.Editor".into(),
            "/Applications/Editor.app".into(),
            Language::En,
        )
        .unwrap();
        assert_eq!(unknown.identity.application_id, "org.example.Editor");
        assert_eq!(unknown.display.app_path, "/Applications/Editor.app");
        assert_eq!(unknown.display.risk, None);
        assert!(!unknown.allow_always);

        let browser = macos_target(
            "A localized browser name".into(),
            "com.apple.Safari".into(),
            "/Applications/Safari.app".into(),
            Language::En,
        )
        .unwrap();
        assert_eq!(browser.display.risk, Some(ComputerAppRisk::High));
        assert_eq!(browser.display.name, "A localized browser name");
    }

    #[test]
    fn known_forbidden_identity_cannot_be_renamed_to_request_consent() {
        let error = macos_target(
            "Notes".into(),
            "com.apple.Terminal".into(),
            "/Applications/Notes.app".into(),
            Language::En,
        )
        .unwrap_err();
        assert!(error.to_string().contains("com.apple.Terminal"));
        assert!(
            macos_target(
                "Editor".into(),
                String::new(),
                "/Applications/Editor.app".into(),
                Language::En,
            )
            .is_err()
        );
    }

    #[test]
    fn cold_consent_allows_a_new_live_binding_without_retargeting_the_app() {
        let approved = macos_target(
            "Editor".into(),
            "org.example.Editor".into(),
            "/Applications/Editor.app".into(),
            Language::En,
        )
        .unwrap();
        let mut running = approved.clone();
        running.binding = Some(ComputerAppBinding {
            pid: 42,
            window_id: 7,
            process_generation: "42:100:1".into(),
        });
        assert!(approved.matches_resolved(&running));
        approved.check_observed(&running).unwrap();
        assert!(!running.matches_resolved(&approved));

        let mut other_copy = running.clone();
        other_copy.display.app_path = "/Users/test/Applications/Editor.app".into();
        assert!(!approved.matches_resolved(&other_copy));
        assert!(approved.check_observed(&other_copy).is_err());
    }

    #[test]
    fn live_consent_refuses_reused_pid_window_and_process_generation() {
        let mut approved = macos_target(
            "Editor".into(),
            "org.example.Editor".into(),
            "/Applications/Editor.app".into(),
            Language::En,
        )
        .unwrap();
        approved.binding = Some(ComputerAppBinding {
            pid: 42,
            window_id: 7,
            process_generation: "42:100:1".into(),
        });
        assert!(approved.matches_resolved(&approved));
        approved.check_observed(&approved).unwrap();
        for binding in [
            ComputerAppBinding {
                pid: 99,
                window_id: 7,
                process_generation: "99:100:1".into(),
            },
            ComputerAppBinding {
                pid: 42,
                window_id: 8,
                process_generation: "42:100:1".into(),
            },
            ComputerAppBinding {
                pid: 42,
                window_id: 7,
                process_generation: "42:200:2".into(),
            },
        ] {
            let mut changed = approved.clone();
            changed.binding = Some(binding);
            assert!(!approved.matches_resolved(&changed));
            assert!(approved.check_observed(&changed).is_err());
        }
    }
}
