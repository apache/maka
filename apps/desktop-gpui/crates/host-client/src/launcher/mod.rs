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

//! Starting a local Runtime Host when none is running for a State Root.
//!
//! [`connect_or_spawn`] is what an application calls: it prepares the State
//! Root, connects to its registered Host, and spawns a Host candidate when
//! nothing answers, following the TS launcher's election
//! (`packages/runtime-host/src/client/connect-or-spawn.ts`). A
//! [`crate::RootConnector`] built with [`crate::RootConnector::spawning`] runs
//! it for every attempt of a supervised connection, so a Host that exits or
//! crashes is started again.
//!
//! The pieces are public for tests and tools:
//!
//! - [`prepare_state_root`] creates a State Root and its marker;
//! - [`MakaInstallation`] and [`NodeRuntime`] find what a candidate runs;
//! - [`spawn_candidate`] starts one candidate process and returns a
//!   [`CandidateProcess`] with its pid and exit;
//! - [`StartupFailureReason`] and [`StartupDiagnostic`] explain a candidate
//!   that failed to start.
//!
//! A spawned Host is ephemeral: it exits by itself after its idle grace once
//! no client is connected. The application does nothing about it on quit.

mod candidate;
mod election;
mod installation;
mod startup;
mod state_root;

pub use candidate::{
    CANDIDATE_STDERR_MAX_BYTES, CandidateExit, CandidateProcess, CandidateSpec, STDERR_PIPE_ENV,
    display_command, new_startup_attempt_id, spawn_candidate,
};
pub use election::{
    CandidateSummary, ELECTION_DEADLINE_ENV, ElectionDiagnostic, IDLE_GRACE_ENV, LaunchError,
    LaunchObserver, LaunchOptions, Launched, connect_or_spawn,
};
pub use installation::{
    CANDIDATE_ENTRYPOINT, InstallationError, MAKA_NODE_ENV, MAKA_REPO_ENV, MINIMUM_NODE_VERSION,
    MakaInstallation, MissingCheckout, NodeError, NodeRuntime, NodeSource, NodeVersion, Searched,
    configured_maka_checkout,
};
pub use startup::{
    CANDIDATE_LOST_EXIT_CODE, SELECTED_STARTUP_DIAGNOSTIC_FILE, StartupDiagnostic,
    StartupErrorSummary, StartupFailureReason, clear_startup_diagnostic, read_startup_diagnostic,
    select_startup_diagnostic, startup_diagnostic_path,
};
pub use state_root::{PreparedRoot, StateRootError, prepare_state_root};

#[cfg(all(test, unix))]
mod tests;
