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

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckpointMode {
    #[default]
    Standalone,
    PreTurn,
    MidTurn {
        anchor_event_id: String,
    },
}

impl<'de> Deserialize<'de> for CheckpointMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Serde's tagged unit variants ignore extra fields even with
        // deny_unknown_fields. Empty struct variants enforce the closed shape.
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum Wire {
            Standalone {},
            PreTurn {},
            MidTurn { anchor_event_id: String },
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::Standalone {} => Self::Standalone,
            Wire::PreTurn {} => Self::PreTurn,
            Wire::MidTurn { anchor_event_id } => Self::MidTurn { anchor_event_id },
        })
    }
}
