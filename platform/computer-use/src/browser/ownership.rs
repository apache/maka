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
pub(super) struct BrowserIdentity {
    port: u16,
    debugger: String,
}

impl BrowserIdentity {
    pub(super) fn new(provider: &BrowserConnection, generation: &str) -> Result<Self, ToolError> {
        let url = Cdp::url(generation, provider)?;
        Ok(Self {
            port: url.port_or_known_default().unwrap(),
            debugger: match url.query() {
                Some(query) => format!("{}?{query}", url.path()),
                None => url.path().to_owned(),
            },
        })
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
struct Creator {
    owner: uuid::Uuid,
    turn: String,
    provider: BrowserConnection,
    generation: String,
}

enum Disposition {
    Live,
    Closing,
}

struct Lease {
    creator: Creator,
    disposition: Disposition,
}

#[derive(Default)]
pub(crate) struct Host {
    tabs: HashMap<TabIdentity, Lease>,
    uncertain_creations: HashMap<BrowserIdentity, Creator>,
    pub(super) cursor_scopes: HashMap<(uuid::Uuid, TabIdentity), super::cursor::CursorEndpoint>,
}

impl Host {
    pub(super) fn known(&self, browser: &BrowserIdentity) -> Result<(), ToolError> {
        if self.uncertain_creations.contains_key(browser) {
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
            lease.creator.turn = turn.to_owned();
        }
        Ok(())
    }

    pub(super) fn created(
        &mut self,
        identity: TabIdentity,
        owner: uuid::Uuid,
        turn: &str,
        provider: BrowserConnection,
        generation: String,
    ) -> Result<(), ToolError> {
        match self.tabs.entry(identity) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(Lease {
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
        provider: BrowserConnection,
        generation: String,
    ) {
        self.uncertain_creations.insert(
            identity,
            Creator {
                owner,
                turn: turn.to_owned(),
                provider,
                generation,
            },
        );
    }

    pub(super) async fn finish(
        &mut self,
        owner: uuid::Uuid,
        turn: Option<&str>,
    ) -> Result<Vec<TabIdentity>, ToolError> {
        let belongs = |creator: &Creator| {
            creator.owner == owner && turn.is_none_or(|turn| creator.turn == turn)
        };
        let uncertain: Vec<_> = self
            .uncertain_creations
            .iter()
            .filter(|(_, creator)| belongs(creator))
            .map(|(identity, creator)| (identity.clone(), creator.clone()))
            .collect();
        for (identity, creator) in uncertain {
            let (generation, _) = inventory(&creator.provider).await.map_err(cleanup)?;
            if BrowserIdentity::new(&creator.provider, &generation)? == identity {
                return Err(ToolError::CleanupUnconfirmed(
                    "the browser tab creation outcome remains unknown; creation was not replayed"
                        .into(),
                ));
            }
            self.uncertain_creations.remove(&identity);
        }
        let mut groups: HashMap<BrowserIdentity, Vec<TabIdentity>> = HashMap::new();
        for (identity, lease) in &self.tabs {
            if belongs(&lease.creator) {
                groups
                    .entry(identity.browser.clone())
                    .or_default()
                    .push(identity.clone());
            }
        }
        let mut finished = Vec::new();
        for (browser, identities) in groups {
            let creator = self.tabs[&identities[0]].creator.clone();
            let (generation, tabs) = inventory(&creator.provider).await.map_err(cleanup)?;
            if BrowserIdentity::new(&creator.provider, &generation)? != browser {
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
                let mut connection = Cdp::connect(&creator.generation, &creator.provider)
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
                let (generation, tabs) = inventory(&creator.provider).await.map_err(cleanup)?;
                if BrowserIdentity::new(&creator.provider, &generation)? == browser
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
        Ok(finished)
    }
}

fn cleanup(error: ToolError) -> ToolError {
    ToolError::CleanupUnconfirmed(error.to_string())
}
