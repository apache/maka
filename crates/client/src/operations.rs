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

use maka_protocol::{
    Operation, OperationErrorCode, OperationRegistry, Result, host, interaction, session,
    subscription,
};
use serde_json::Value;

/// Compose the same wire validators the Host uses. No Host runtime dependency.
pub struct Operations;
impl OperationRegistry for Operations {
    fn decode_input(&self, operation: Operation, value: &Value) -> Result<Value> {
        if operation == Operation::ModelProviderCatalogQuery {
            maka_protocol::model_provider::decode_query(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::RuntimePolicyQuery {
            maka_protocol::runtime_policy::decode_query_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::RuntimePolicyMutate {
            return serde_json::to_value(maka_protocol::runtime_policy::decode_mutation_input(
                value,
            )?)
            .map_err(|error| maka_protocol::ProtocolError::invalid(error.to_string()));
        }
        if maka_protocol::plugin::supports(operation) {
            maka_protocol::plugin::decode_input(operation, value)?;
            return Ok(value.clone());
        }
        if maka_protocol::artifact::supports(operation) {
            return maka_protocol::artifact::decode_input(operation, value);
        }
        if operation == Operation::ClientCapabilityReplace {
            maka_protocol::capability::decode_replace_input(value)?;
            return Ok(value.clone());
        }
        if maka_protocol::oauth::supports(operation) {
            return maka_protocol::oauth::decode_input(operation, value);
        }
        if operation == Operation::ConnectionTestRun {
            maka_protocol::connection_effects::decode_connection_test_run_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionModelsFetch {
            maka_protocol::connection_effects::decode_connection_model_fetch_input(value)?;
            return Ok(value.clone());
        }
        match operation {
            Operation::CredentialVaultQuery => {
                maka_protocol::configuration::decode_credential_query_input(value)?;
                return Ok(value.clone());
            }
            Operation::CredentialVaultSet => {
                maka_protocol::configuration::decode_set_credential_input(value)?;
                return Ok(value.clone());
            }
            Operation::CredentialVaultDelete => {
                maka_protocol::configuration::decode_delete_credential_input(value)?;
                return Ok(value.clone());
            }
            _ => {}
        }
        if operation == Operation::ConnectionCatalogSetDefaultTarget {
            maka_protocol::configuration::decode_set_default_target_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionCatalogCreate {
            maka_protocol::configuration::decode_create_connection_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionCatalogUpdate {
            maka_protocol::configuration::decode_update_connection_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionCatalogRemove {
            maka_protocol::configuration::decode_remove_connection_input(value)?;
            return Ok(value.clone());
        }
        if matches!(
            operation,
            Operation::ConnectionOnboardingVerify | Operation::ConnectionOnboardingSave
        ) {
            maka_protocol::onboarding::decode_input(
                value,
                operation == Operation::ConnectionOnboardingSave,
            )?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionCatalogQuery {
            maka_protocol::configuration::decode_catalog_query_input(value)?;
            return Ok(value.clone());
        }
        if maka_protocol::project::supports(operation) {
            return maka_protocol::project::decode_input(operation, value);
        }
        if operation == Operation::TurnStop {
            maka_protocol::turn::decode_turn_stop_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::TurnBatchStart {
            return serde_json::to_value(maka_protocol::turn::decode_turn_batch_start_input(
                value,
            )?)
            .map_err(|error| maka_protocol::ProtocolError::invalid(error.to_string()));
        }
        if operation == Operation::TurnStart {
            return serde_json::to_value(maka_protocol::turn::decode_turn_start_input(value)?)
                .map_err(|error| maka_protocol::ProtocolError::invalid(error.to_string()));
        }
        if operation == Operation::TurnQuery {
            maka_protocol::turn::decode_turn_query_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::TurnResumeQuery {
            maka_protocol::turn::decode_turn_resume_query_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::TurnResumeStart {
            maka_protocol::turn::decode_turn_resume_start_input(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ContextDiagnosticsQuery {
            maka_protocol::context::decode_context_diagnostics_input(value)?;
            return Ok(value.clone());
        }
        if interaction::supports(operation) {
            return interaction::decode_input(operation, value);
        }
        if maka_protocol::message::supports(operation) {
            maka_protocol::message::decode_input(operation, value)?;
            return Ok(value.clone());
        }
        if subscription::errors(operation).is_some() {
            subscription::decode_input(operation, value)
        } else if session::supports(operation) {
            session::decode_input(operation, value)
        } else {
            host::Operations.decode_input(operation, value)
        }
    }
    fn decode_output(&self, operation: Operation, value: &Value) -> Result<Value> {
        if operation == Operation::ModelProviderCatalogQuery {
            maka_protocol::model_provider::decode_page(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::RuntimePolicyQuery {
            return serde_json::to_value(maka_protocol::runtime_policy::decode_query_result(
                value,
            )?)
            .map_err(|error| maka_protocol::ProtocolError::invalid(error.to_string()));
        }
        if operation == Operation::RuntimePolicyMutate {
            return serde_json::to_value(maka_protocol::runtime_policy::decode_mutation_result(
                value,
            )?)
            .map_err(|error| maka_protocol::ProtocolError::invalid(error.to_string()));
        }
        if maka_protocol::plugin::supports(operation) {
            return maka_protocol::plugin::decode_output(operation, value);
        }
        if maka_protocol::artifact::supports(operation) {
            return maka_protocol::artifact::decode_output(operation, value);
        }
        if operation == Operation::ClientCapabilityReplace {
            maka_protocol::capability::decode_registration_result(value)?;
            return Ok(value.clone());
        }
        if maka_protocol::oauth::supports(operation) {
            return maka_protocol::oauth::decode_output(operation, value);
        }
        if operation == Operation::ConnectionTestRun {
            maka_protocol::connection_effects::decode_connection_test_run_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionModelsFetch {
            maka_protocol::connection_effects::decode_connection_model_fetch_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::CredentialVaultQuery {
            maka_protocol::configuration::decode_credential_query_result(value)?;
            return Ok(value.clone());
        }
        if matches!(
            operation,
            Operation::CredentialVaultSet | Operation::CredentialVaultDelete
        ) {
            maka_protocol::configuration::decode_credential_mutation_result(operation, value)?;
            return Ok(value.clone());
        }
        if matches!(
            operation,
            Operation::ConnectionCatalogCreate
                | Operation::ConnectionCatalogUpdate
                | Operation::ConnectionCatalogRemove
                | Operation::ConnectionCatalogSetDefaultTarget
        ) {
            maka_protocol::configuration::decode_catalog_mutation_result(operation, value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionOnboardingVerify {
            maka_protocol::onboarding::decode_verify_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionOnboardingSave {
            maka_protocol::onboarding::decode_save_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ConnectionCatalogQuery {
            return maka_protocol::configuration_pages::decode_catalog_query_result(value);
        }
        if maka_protocol::project::supports(operation) {
            return maka_protocol::project::decode_output(operation, value);
        }
        if matches!(operation, Operation::TurnStop | Operation::TurnQuery) {
            maka_protocol::turn::decode_turn_snapshot(value)?;
            return Ok(value.clone());
        }
        if matches!(operation, Operation::TurnStart | Operation::TurnBatchStart) {
            maka_protocol::turn::decode_turn_start_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::TurnResumeQuery {
            maka_protocol::turn::decode_turn_resume_plan(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::TurnResumeStart {
            maka_protocol::turn::decode_turn_resume_start_result(value)?;
            return Ok(value.clone());
        }
        if operation == Operation::ContextDiagnosticsQuery {
            maka_protocol::context::decode_context_diagnostics_result(value)?;
            return Ok(value.clone());
        }
        if interaction::supports(operation) {
            return interaction::decode_output(operation, value);
        }
        if maka_protocol::message::supports(operation) {
            maka_protocol::message::decode_output(operation, value)?;
            return Ok(value.clone());
        }
        if subscription::errors(operation).is_some() {
            subscription::decode_output(operation, value)
        } else if session::supports(operation) {
            session::decode_output(operation, value)
        } else {
            host::Operations.decode_output(operation, value)
        }
    }
    fn error_codes(&self, operation: Operation) -> Option<&[OperationErrorCode]> {
        if operation == Operation::ModelProviderCatalogQuery {
            return Some(maka_protocol::configuration::QUERY_ERRORS);
        }
        if operation == Operation::RuntimePolicyQuery {
            return Some(maka_protocol::runtime_policy::QUERY_ERRORS);
        }
        if operation == Operation::RuntimePolicyMutate {
            return Some(maka_protocol::runtime_policy::MUTATION_ERRORS);
        }
        if maka_protocol::plugin::supports(operation) {
            return Some(maka_protocol::plugin::ERRORS);
        }
        if let Some(errors) = maka_protocol::artifact::errors(operation) {
            return Some(errors);
        }
        if operation == Operation::ClientCapabilityReplace {
            return Some(&[
                OperationErrorCode::HostNotReady,
                OperationErrorCode::HostDraining,
                OperationErrorCode::OperationUnavailable,
                OperationErrorCode::InvalidRequest,
                OperationErrorCode::InternalFailure,
            ]);
        }
        if let Some(errors) = maka_protocol::oauth::errors(operation) {
            return Some(errors);
        }
        if operation == Operation::CredentialVaultQuery {
            return Some(maka_protocol::configuration::QUERY_ERRORS);
        }
        if matches!(
            operation,
            Operation::CredentialVaultSet | Operation::CredentialVaultDelete
        ) {
            return Some(maka_protocol::configuration::MUTATION_ERRORS);
        }
        if matches!(
            operation,
            Operation::ConnectionOnboardingVerify
                | Operation::ConnectionOnboardingSave
                | Operation::ConnectionModelsFetch
                | Operation::ConnectionTestRun
                | Operation::ConnectionCatalogCreate
                | Operation::ConnectionCatalogUpdate
                | Operation::ConnectionCatalogRemove
                | Operation::ConnectionCatalogSetDefaultTarget
        ) {
            return Some(maka_protocol::configuration::MUTATION_ERRORS);
        }
        if operation == Operation::ConnectionCatalogQuery {
            return Some(maka_protocol::configuration::QUERY_ERRORS);
        }
        match operation {
            Operation::ProjectCatalogQuery => return Some(maka_protocol::project::QUERY_ERRORS),
            Operation::ProjectCatalogMutate => {
                return Some(maka_protocol::project::MUTATION_ERRORS);
            }
            _ => {}
        }
        if operation == Operation::TurnStop {
            return Some(maka_protocol::turn::STOP_ERRORS);
        }
        if matches!(operation, Operation::TurnStart | Operation::TurnBatchStart) {
            return Some(maka_protocol::turn::START_ERRORS);
        }
        if operation == Operation::TurnQuery {
            return Some(maka_protocol::turn::QUERY_ERRORS);
        }
        if operation == Operation::TurnResumeStart {
            return Some(maka_protocol::turn::START_ERRORS);
        }
        if operation == Operation::TurnResumeQuery {
            return Some(&[
                OperationErrorCode::HostNotReady,
                OperationErrorCode::HostDraining,
                OperationErrorCode::OperationUnavailable,
                OperationErrorCode::NotFound,
                OperationErrorCode::SessionArchived,
                OperationErrorCode::InternalFailure,
            ]);
        }
        if operation == Operation::ContextDiagnosticsQuery {
            return Some(maka_protocol::context::DIAGNOSTICS_ERRORS);
        }
        if maka_protocol::message::supports(operation) {
            return Some(maka_protocol::message::ERRORS);
        }
        subscription::errors(operation)
            .or_else(|| interaction::errors(operation))
            .or_else(|| session::errors(operation))
            .or_else(|| host::Operations.error_codes(operation))
    }
}
