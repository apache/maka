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
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum BrowserIdentity {
    Cdp {
        port: u16,
        debugger: String,
    },
    Extension {
        adapter: String,
        extension: String,
        instance: String,
        generation: String,
        host_pid: u32,
    },
}
impl BrowserIdentity {
    pub(super) fn new(provider: &BrowserConnection, generation: &str) -> Result<Self, ToolError> {
        let url = Cdp::url(generation, provider)?;
        Ok(Self::Cdp {
            port: url.port_or_known_default().unwrap(),
            debugger: match url.query() {
                Some(query) => format!("{}?{query}", url.path()),
                None => url.path().to_owned(),
            },
        })
    }
    pub(super) fn of(provider: &Provider, generation: &str) -> Result<Self, ToolError> {
        match provider {
            Provider::Cdp(provider) => Self::new(provider, generation),
            Provider::Extension { connection, .. } => {
                let actual = connection.identity();
                if actual.generation != generation {
                    return Err(failed("extension provider generation changed"));
                }
                Ok(Self::Extension {
                    adapter: actual.adapter.clone(),
                    extension: actual.extension_id.clone(),
                    instance: actual.instance_id.clone(),
                    generation: actual.generation.clone(),
                    host_pid: actual.host_pid,
                })
            }
        }
    }
    pub(super) fn tab(&self, id: &str) -> TabIdentity {
        TabIdentity {
            browser: self.clone(),
            target: id.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct TabIdentity {
    pub(super) browser: BrowserIdentity,
    pub(super) target: String,
}

#[derive(Clone)]
pub(super) struct Creator {
    pub(super) owner: uuid::Uuid,
    pub(super) turn: String,
    pub(super) provider: Provider,
    pub(super) generation: String,
}

pub(super) enum Disposition {
    Live,
    Closing,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Origin {
    AgentCreated,
    UserClaimed,
}

#[derive(Clone)]
pub(super) struct UncertainCreation {
    pub(super) creator: Creator,
    pub(super) extension: Option<cua_driver_core::browser::ExtensionCreationReceipt>,
}

pub(super) struct Lease {
    pub(super) viewport: Option<Option<crate::protocol::BrowserViewport>>,
    pub(super) input: Option<std::sync::Arc<super::owned_input::Resource>>,
    pub(super) extension_sequence: Option<u64>,
    pub(super) origin: Origin,
    pub(super) extension: Option<super::extension::ClaimState>,
    pub(super) creator: Creator,
    pub(super) disposition: Disposition,
}

#[derive(Default)]
pub(crate) struct Host {
    pub(super) tabs: HashMap<TabIdentity, Lease>,
    pub(super) extension: HashMap<(uuid::Uuid, BrowserIdentity), super::extension::ProviderState>,
    pub(super) next_extension_sequence: u64,
    pub(super) uncertain_creations: HashMap<(uuid::Uuid, BrowserIdentity), UncertainCreation>,
    pub(super) cursor_scopes: HashMap<(uuid::Uuid, TabIdentity), super::cursor::CursorEndpoint>,
    pub(super) download_metadata: super::downloads::Store,
}

impl Host {
    pub(super) fn known(&self, browser: &BrowserIdentity) -> Result<(), ToolError> {
        if self
            .uncertain_creations
            .keys()
            .any(|(_, current)| current == browser)
        {
            return Err(ToolError::CleanupUnconfirmed(
                "a browser tab creation has an unknown outcome; its targets cannot be reassigned"
                    .into(),
            ));
        }
        Ok(())
    }

    pub(super) fn visible(&self, tab: &TabIdentity, owner: uuid::Uuid) -> bool {
        self.tabs
            .get(tab)
            .is_none_or(|lease| lease.creator.owner == owner)
    }

    pub(super) fn use_tab(
        &mut self,
        tab: &TabIdentity,
        owner: uuid::Uuid,
        turn: &str,
    ) -> Result<(), ToolError> {
        self.known(&tab.browser)?;
        if let Some(lease) = self.tabs.get_mut(tab) {
            if lease.creator.owner != owner {
                return Err(failed("tab_owned_by_another_session"));
            }
            if matches!(lease.disposition, Disposition::Closing) {
                return Err(ToolError::CleanupUnconfirmed(
                    "the tab's previous close has not settled".into(),
                ));
            }
            if let Some(input) = &lease.input {
                input.check_settled()?;
            }
            // Extension cleanup ownership comes from an actual preparation or
            // creation receipt. Selecting metadata cannot move that obligation.
            if lease.extension.is_none() {
                lease.creator.turn = turn.to_owned();
            }
        }
        Ok(())
    }

    pub(super) fn check_owned_input(&self, identity: &TabIdentity) -> Result<(), ToolError> {
        if let Some(input) = self
            .tabs
            .get(identity)
            .and_then(|lease| lease.input.as_ref())
        {
            input.check_settled()?;
        }
        Ok(())
    }

    pub(super) fn reserve_owned_input(
        &mut self,
        identity: TabIdentity,
        owner: uuid::Uuid,
        turn: &str,
        provider: Provider,
        generation: String,
        input: std::sync::Arc<super::owned_input::Resource>,
    ) -> Result<(), ToolError> {
        self.use_tab(&identity, owner, turn)?;
        match self.tabs.entry(identity) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                entry.get_mut().input = Some(input);
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                if provider.extension().is_some() {
                    return Err(failed("owned input lost its actual extension lease"));
                }
                // Configured-CDP existing user tabs had no cleanup lease before
                // input. Record this admitted physical resource on the SAME
                // canonical map; Stop must preserve the user's physical tab.
                entry.insert(Lease {
                    viewport: None,
                    input: Some(input),
                    extension_sequence: None,
                    origin: Origin::UserClaimed,
                    extension: None,
                    creator: Creator {
                        owner,
                        turn: turn.to_owned(),
                        provider,
                        generation,
                    },
                    disposition: Disposition::Live,
                });
            }
        }
        Ok(())
    }

    pub(super) fn check_owned_inputs(
        &self,
        owner: uuid::Uuid,
        turn: Option<&str>,
        epoch: Option<crate::desktop::NativeEpochId>,
    ) -> Result<(), ToolError> {
        for lease in self
            .tabs
            .values()
            .filter(|lease| lease.creator.owner == owner)
        {
            if let Some(input) = &lease.input
                && input.belongs(turn, epoch)
            {
                input.check_settled()?;
            }
        }
        Ok(())
    }

    pub(super) fn created(
        &mut self,
        identity: TabIdentity,
        owner: uuid::Uuid,
        turn: &str,
        provider: impl Into<Provider>,
        generation: String,
    ) -> Result<(), ToolError> {
        let provider = provider.into();
        match self.tabs.entry(identity) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(Lease {
                    viewport: None,
                    input: None,
                    extension_sequence: None,
                    origin: Origin::AgentCreated,
                    extension: None,
                    creator: Creator {
                        owner,
                        turn: turn.to_owned(),
                        provider,
                        generation,
                    },
                    disposition: Disposition::Live,
                });
                Ok(())
            }
            std::collections::hash_map::Entry::Occupied(_) => Err(ToolError::CleanupUnconfirmed(
                "the browser returned an already-owned target ID for a new tab".into(),
            )),
        }
    }

    pub(super) fn begin_close(
        &mut self,
        identity: &TabIdentity,
        owner: uuid::Uuid,
        turn: &str,
    ) -> Result<(), ToolError> {
        self.use_tab(identity, owner, turn)?;
        if let Some(lease) = self.tabs.get_mut(identity) {
            lease.disposition = Disposition::Closing;
        }
        Ok(())
    }

    pub(super) fn creation_unknown(
        &mut self,
        identity: BrowserIdentity,
        owner: uuid::Uuid,
        turn: &str,
        provider: impl Into<Provider>,
        generation: String,
    ) {
        let provider = provider.into();
        self.uncertain_creations.insert(
            (owner, identity),
            UncertainCreation {
                creator: Creator {
                    owner,
                    turn: turn.to_owned(),
                    provider,
                    generation,
                },
                extension: None,
            },
        );
    }

    pub(super) async fn finish(
        &mut self,
        owner: uuid::Uuid,
        turn: Option<&str>,
    ) -> Result<Vec<TabIdentity>, ToolError> {
        self.check_owned_inputs(owner, turn, None)?;
        let extension_finished = self.finish_extension(owner, turn).await?;
        let belongs = |creator: &Creator| {
            creator.owner == owner && turn.is_none_or(|turn| creator.turn == turn)
        };
        let uncertain: Vec<_> = self
            .uncertain_creations
            .iter()
            .filter(|(_, uncertain)| belongs(&uncertain.creator))
            .map(|((_, identity), uncertain)| (identity.clone(), uncertain.clone()))
            .collect();
        for (identity, uncertain) in uncertain {
            let creator = uncertain.creator;
            let (generation, _) = creator.provider.inventory().await.map_err(cleanup)?;
            if BrowserIdentity::of(&creator.provider, &generation)? == identity {
                return Err(ToolError::CleanupUnconfirmed(
                    "the browser tab creation outcome remains unknown; creation was not replayed"
                        .into(),
                ));
            }
            self.uncertain_creations.remove(&(owner, identity));
        }
        let user_inputs: Vec<_> = self
            .tabs
            .iter()
            .filter(|(_, lease)| {
                belongs(&lease.creator)
                    && lease.extension.is_none()
                    && lease.origin == Origin::UserClaimed
                    && matches!(lease.disposition, Disposition::Live)
            })
            .map(|(identity, _)| identity.clone())
            .collect();
        // A Live user input resource needs no physical tab close. Closing user
        // leases instead follow the existing inventory/gone-proof path below:
        // input UP completion cannot erase an earlier explicit-close debt.
        for identity in &user_inputs {
            self.tabs.remove(identity);
        }
        let mut groups: HashMap<BrowserIdentity, Vec<TabIdentity>> = HashMap::new();
        for (identity, lease) in &self.tabs {
            if belongs(&lease.creator) && lease.extension.is_none() {
                groups
                    .entry(identity.browser.clone())
                    .or_default()
                    .push(identity.clone());
            }
        }
        let mut finished = extension_finished;
        finished.extend(user_inputs);
        for (browser, identities) in groups {
            let creator = self.tabs[&identities[0]].creator.clone();
            let (generation, tabs) = creator.provider.inventory().await.map_err(cleanup)?;
            if BrowserIdentity::of(&creator.provider, &generation)? != browser {
                for identity in identities {
                    self.tabs.remove(&identity);
                    finished.push(identity);
                }
                continue;
            }
            let existing: HashSet<_> = tabs.into_iter().map(|tab| tab.id).collect();
            let pending: Vec<_> = identities
                .iter()
                .filter(|identity| existing.contains(&identity.target))
                .collect();
            if !pending.is_empty() {
                if pending.iter().any(|identity| {
                    matches!(self.tabs[*identity].disposition, Disposition::Closing)
                }) {
                    return Err(ToolError::CleanupUnconfirmed(
                        "a previous tab close has not settled; close was not replayed".into(),
                    ));
                }
                let connection = Cdp::connect(&creator.generation, creator.provider.cdp()?)
                    .await
                    .map_err(cleanup)?;
                for identity in &pending {
                    self.tabs.get_mut(*identity).unwrap().disposition = Disposition::Closing;
                    let result = connection
                        .request("Target.closeTarget", json!({"targetId":identity.target}))
                        .await
                        .map_err(cleanup)?;
                    if result["success"] != true {
                        return Err(ToolError::CleanupUnconfirmed(
                            "the browser did not acknowledge closing its temporary tab".into(),
                        ));
                    }
                }
                let (generation, tabs) = creator.provider.inventory().await.map_err(cleanup)?;
                if BrowserIdentity::of(&creator.provider, &generation)? == browser
                    && tabs
                        .iter()
                        .any(|tab| pending.iter().any(|identity| identity.target == tab.id))
                {
                    return Err(ToolError::CleanupUnconfirmed(
                        "the temporary tab is still present after its close request".into(),
                    ));
                }
            }
            for identity in identities {
                self.tabs.remove(&identity);
                finished.push(identity);
            }
        }
        if turn.is_none() {
            self.download_metadata.close_owner(owner).await?;
        }
        Ok(finished)
    }
}

fn cleanup(error: ToolError) -> ToolError {
    ToolError::CleanupUnconfirmed(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_owner_creation_uncertainty_cannot_overwrite_another_owner() {
        let provider = BrowserConnection {
            id: "fixture".into(),
            endpoint: "http://127.0.0.1:9222".into(),
        };
        let generation = "ws://127.0.0.1:9222/devtools/browser/fixture";
        let browser = BrowserIdentity::new(&provider, generation).unwrap();
        let first = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let mut host = Host::default();
        host.creation_unknown(
            browser.clone(),
            first,
            "first",
            provider.clone(),
            generation.into(),
        );
        host.creation_unknown(
            browser.clone(),
            second,
            "second",
            provider,
            generation.into(),
        );
        assert_eq!(host.uncertain_creations.len(), 2);
        assert_eq!(
            host.uncertain_creations[&(first, browser.clone())]
                .creator
                .turn,
            "first"
        );
        assert_eq!(
            host.uncertain_creations[&(second, browser.clone())]
                .creator
                .turn,
            "second"
        );
        assert!(matches!(
            host.known(&browser),
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        host.uncertain_creations.remove(&(second, browser.clone()));
        assert!(matches!(
            host.known(&browser),
            Err(ToolError::CleanupUnconfirmed(_))
        ));
        host.uncertain_creations.remove(&(first, browser.clone()));
        host.known(&browser).unwrap();
    }
}
