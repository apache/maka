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

use maka_agent_facts::context::ModelPurpose;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::usage::Query;
use std::time::{Duration, UNIX_EPOCH};

pub(crate) fn event(fact: Fact, micros: u64) -> EventWrite {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "source".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        fact,
    );
    event.recorded_at = UNIX_EPOCH + Duration::from_micros(micros);
    EventWrite::plain(event).unwrap()
}

pub(crate) fn request(id: &str, micros: u64) -> EventWrite {
    event(
        Fact::ModelRequested {
            context_breakdown: None,
            item_acceptance: false,
            step_id: id.into(),
            model_id: "model".into(),
            purpose: ModelPurpose::Main,
            source_scope: LogScope::Session {
                id: "source".into(),
            },
            source_high_water: 0,
            source_digest: "fixture".into(),
            input_digest: "frozen-input".into(),
            route_identity: "frozen-route".into(),
            checkpoint_event_id: None,
            context: None,
            effective_source_digest: None,
        },
        micros,
    )
}

pub(crate) fn query() -> Query {
    Query {
        from: 0.0,
        to: 100.0,
        session_id: None,
        through: None,
    }
}
