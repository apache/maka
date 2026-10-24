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

//! Durable workspace references and immutable permission evidence. Concrete
//! Workspace selections belong to the native API, not this dependency layer.
use serde::{Deserialize, Serialize};

use crate::interaction::MAX_SAFE_INTEGER;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRef {
    pub id: uuid::Uuid,
    pub permission_epoch_at_attach: u64,
    pub metadata_epoch_at_attach: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingStamp {
    pub id: uuid::Uuid,
    pub permission_epoch: u64,
}

/// Captured authority, never silently upgraded by resolving a current binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionBasis {
    pub boundary_revision: u64,
    pub binding: BindingStamp,
}

impl BindingRef {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil()
            || self.permission_epoch_at_attach > MAX_SAFE_INTEGER
            || self.metadata_epoch_at_attach > MAX_SAFE_INTEGER
        {
            return Err("invalid workspace binding reference");
        }
        Ok(())
    }

    pub fn boundary_revision(&self, local: u64, stamp: BindingStamp) -> Result<u64, &'static str> {
        self.validate()?;
        stamp.validate()?;
        if self.id != stamp.id {
            return Err("workspace binding identity changed");
        }
        effective_revision(
            local,
            stamp.permission_epoch,
            self.permission_epoch_at_attach,
        )
    }

    pub fn session_revision(&self, local: u64, metadata_epoch: u64) -> Result<u64, &'static str> {
        self.validate()?;
        effective_revision(local, metadata_epoch, self.metadata_epoch_at_attach)
    }
}

impl BindingStamp {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil() || self.permission_epoch > MAX_SAFE_INTEGER {
            return Err("invalid workspace binding stamp");
        }
        Ok(())
    }
}

impl PermissionBasis {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.binding.validate()?;
        if self.boundary_revision > MAX_SAFE_INTEGER {
            return Err("invalid workspace permission boundary");
        }
        Ok(())
    }
}

fn effective_revision(local: u64, current: u64, attached: u64) -> Result<u64, &'static str> {
    if current > MAX_SAFE_INTEGER {
        return Err("workspace epoch exhausted");
    }
    current
        .checked_sub(attached)
        .and_then(|delta| local.checked_add(delta))
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or("workspace revision is invalid or exhausted")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epochs_are_checked_and_binding_identity_is_part_of_authority() {
        let reference = BindingRef {
            id: uuid::Uuid::new_v4(),
            permission_epoch_at_attach: 2,
            metadata_epoch_at_attach: 4,
        };
        let stamp = BindingStamp {
            id: reference.id,
            permission_epoch: 3,
        };
        assert_eq!(reference.boundary_revision(7, stamp), Ok(8));
        assert_eq!(reference.session_revision(9, 6), Ok(11));
        assert!(reference.session_revision(MAX_SAFE_INTEGER, 5).is_err());
        assert!(reference.session_revision(9, 3).is_err());
        assert!(
            reference
                .boundary_revision(
                    7,
                    BindingStamp {
                        id: uuid::Uuid::new_v4(),
                        ..stamp
                    }
                )
                .is_err()
        );
    }
}
