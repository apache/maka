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

use super::{ContractId, Identity, Offer};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Historical selection evidence retained in durable execution records.
/// These values cannot register capabilities or grant live access.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientComposition {
    /// Includes unavailable Session owners, which still constrain future binding.
    pub session_bindings: BTreeMap<ContractId, PublicationIdentity>,
    pub offers: Vec<ClientOffer>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientOffer {
    Pinned {
        contract: ContractId,
        affinity: PinnedAffinity,
        publication: PublicationIdentity,
    },
    Call {
        offer: Offer,
        selector: Option<Identity>,
    },
}

/// Authentication authority and publication scope are independent identities.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationIdentity {
    pub identity: Identity,
    pub session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinnedAffinity {
    Session,
    Turn,
}
