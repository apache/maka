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

use crate::Error;
use crate::name;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyAttachment {
    pub target_session_id: String,
    pub attachment: AttachmentRef,
}
impl CopyAttachment {
    pub fn validate(&self) -> Result<(), Error> {
        name(&self.target_session_id)?;
        let StorageRef::SessionFile {
            session_id,
            relative_path,
        } = &self.attachment.storage_ref
        else {
            return Err(Error::Invalid(
                "only immutable Session attachments can be copied".into(),
            ));
        };
        name(session_id)?;
        name(relative_path)?;
        Ok(())
    }
}
