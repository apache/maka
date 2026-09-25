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

mod access_expiry;
mod artifact_boundary;
mod artifact_interop;
mod attachment_consumption;
mod auto_context;
mod background_health_plugin;
mod client_access;
mod client_anthropic_options;
mod client_capability;
mod client_connection_test;
mod client_forms;
mod client_interactions;
mod client_interop;
mod client_live_provider;
mod client_model_fetch;
mod client_onboarding;
mod client_openai_options;
mod client_patch;
mod client_plugins;
mod client_pricing;
mod client_questions;
mod client_remote_access;
mod client_shell;
mod client_tools;
mod client_write;
mod compatible_chat;
mod connection_multiplex;
mod context_compaction;
mod execution_boundary;
mod execution_drain;
mod goal_plugin;
mod graph_plugin;
mod handoff;
mod host_drain;
mod input_plugin;
mod insights_plugin;
mod javascript_plugins;
mod jev_plugin;
mod large_outputs;
mod live_pipes;
mod live_pty_stream;
mod live_shell;
mod message_interrupt;
mod message_queue;
mod message_recovery;
mod message_submit;
mod model_adapters;
mod model_overrides;
mod model_providers;
mod oauth;
mod oauth_execution;
mod plan_plugin;
mod plugin_authorization;
mod plugin_clients;
mod plugin_commands;
mod plugin_files;
mod plugin_http;
mod plugin_remote;
mod projects;
mod pruning;
mod question_boundary;
mod read_pages;
mod recall_plugin;
mod relay_options;
mod remote_capacity;
mod resume;
mod retirement;
mod runtime_policy;
mod scheduler_plugin;
mod session_bundle;
mod session_history;
mod session_recap_plugin;
mod session_removal;
mod skills_management;
mod skills_plugin;
mod system_prompt;
mod todo_plugin;
mod transcript_limits;
mod transcript_pager;
mod web_plugin;
mod workhub_public;
mod workspace_images;

mod support {
    #[cfg(unix)]
    pub(crate) mod attachment_client;
    pub(crate) mod client_probe;
    #[cfg(unix)]
    pub(crate) mod execution_drain;
    #[cfg(unix)]
    pub(crate) mod execution_fixture;
    pub(crate) mod message_recovery;
    pub(crate) mod model_connection;
    pub(crate) mod peer;
    #[cfg(unix)]
    pub(crate) mod question_model;
    pub(crate) mod shell_resources;
}
