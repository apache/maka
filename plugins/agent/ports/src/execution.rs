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

use crate::{Error, name};
use maka_agent_facts::input::MessageInput;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod attachment;
pub use attachment::CopyAttachment;
mod interaction;
pub use interaction::{OfferInteraction, Prompt};

/// Business identity belongs to package/scope and target Session, never an activation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submit {
    pub operation_id: String,
    pub session_id: String,
    pub content: MessageInput,
}

impl Submit {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.operation_id)?;
        name(&self.session_id)?;
        maka_agent_facts::message::validate_sources(&self.content, &[])
            .map_err(|reason| Error::Invalid(reason.into()))
    }

    pub fn digest(&self) -> Result<String, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|error| Error::Invalid(error.to_string()))?;
        Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
    }
}
