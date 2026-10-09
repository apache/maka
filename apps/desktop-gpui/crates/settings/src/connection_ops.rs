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

//! The Host operations the Models page runs on a connection, each with the
//! reads and retries Maka Desktop's main process wraps around them
//! (apps/desktop/src/main/runtime-host-connections-ipc-main.ts): a change
//! is built from the catalog as it now stands and sent at that revision; a
//! key is written against the status just read; a removal retries while
//! the connection keeps moving; a new connection whose key or headers
//! cannot be saved is removed again. Every failure comes back as the
//! sentence the page shows, never as the Host's words alone.

use gpui_kit::SharedString;
use host_protocol::{
    ConnectionCatalogCreate, ConnectionCatalogCreateInput, ConnectionCatalogEntryDraft,
    ConnectionCatalogEntryUpdate, ConnectionCatalogRemove, ConnectionCatalogRemoveInput,
    ConnectionCatalogUpdate, ConnectionCatalogUpdateInput, ConnectionEffectFailureClass,
    ConnectionEffectRejection, ConnectionModelsFetch, ConnectionModelsFetchInput,
    ConnectionModelsFetchResult, ConnectionRequestHeadersQuery, ConnectionRequestHeadersQueryInput,
    ConnectionRequestHeadersQueryResult, ConnectionRequestHeadersReplace,
    ConnectionRequestHeadersReplaceInput, ConnectionRequestHeadersReplaceResult,
    ConnectionTestProjection, ConnectionTestRun, ConnectionTestRunInput, ConnectionTestRunResult,
    ConnectionVersionBasis, CreateCatalogConnectionResult, CredentialKind, CredentialLocator,
    CredentialMutationResult, CredentialStatus, CredentialVaultQuery, CredentialVaultQueryInput,
    CredentialVaultQueryResult, CredentialVaultSet, CredentialVaultSetInput, ProviderDefinition,
    RemoveCatalogConnectionResult, RequestHeaderUpdate, UpdateCatalogConnectionResult,
};
use shared::copy::models as copy;
use shared::copy::settings as settings_copy;
use shared::copy::{Locale, Text};
use workspace::{ConnectionEntry, HostRequester, read_connections};

use crate::policy::host_error_reason;

/// How often a removal is tried while the connection keeps changing
/// (Desktop's `maxAttempts`).
const REMOVE_ATTEMPTS: usize = 6;

/// Why an operation did not do what was asked: the sentence to show.
pub(crate) type Failure = SharedString;

fn failure(text: Text, locale: Locale) -> Failure {
    text.in_locale(locale).into()
}

fn host_failure(error: &workspace::HostRequestError, locale: Locale) -> Failure {
    host_error_reason(error, locale).into()
}

/// The credential a connection keeps its key in (`connectionCredential`).
pub(crate) fn key_locator(connection_id: &str, provider_type: &str) -> CredentialLocator {
    let kind = match ProviderDefinition::find(provider_type) {
        Some(provider) if provider.is_account() => CredentialKind::OauthToken,
        _ => CredentialKind::ApiKey,
    };
    CredentialLocator::Connection { connection_id: connection_id.to_owned(), kind }
}

/// The key's status: configured or not, never the key.
pub(crate) async fn query_key(
    requester: &HostRequester,
    connection_id: &str,
    provider_type: &str,
    locale: Locale,
) -> Result<CredentialStatus, Failure> {
    let input = CredentialVaultQueryInput::new(key_locator(connection_id, provider_type));
    match requester.request::<CredentialVaultQuery>(&input).await {
        Ok(CredentialVaultQueryResult::Status { status }) => Ok(status),
        Ok(CredentialVaultQueryResult::ConnectionNotFound) => {
            Err(failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale))
        }
        Ok(_) => Err(failure(settings_copy::UNEXPECTED, locale)),
        Err(error) => Err(host_failure(&error, locale)),
    }
}

/// Saves `secret` as the connection's key, over the key it has now
/// (`updateCredential`).
pub(crate) async fn save_key(
    requester: &HostRequester,
    connection_id: &str,
    provider_type: &str,
    secret: String,
    locale: Locale,
) -> Result<CredentialStatus, Failure> {
    let current = query_key(requester, connection_id, provider_type, locale).await?;
    let input = CredentialVaultSetInput::new(
        key_locator(connection_id, provider_type),
        current.basis().as_ref(),
        secret,
    );
    log::info!("credential.vault.set for connection {connection_id}");
    credential_result(requester.request::<CredentialVaultSet>(&input).await, locale)
}

fn credential_result(
    result: Result<CredentialMutationResult, workspace::HostRequestError>,
    locale: Locale,
) -> Result<CredentialStatus, Failure> {
    match result {
        Ok(CredentialMutationResult::Committed { status, .. }) => Ok(status),
        Ok(CredentialMutationResult::ConnectionNotFound) => {
            Err(failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale))
        }
        Ok(CredentialMutationResult::ConnectionStale { .. }) => {
            Err(failure(settings_copy::CONNECTION_CHANGED, locale))
        }
        Ok(CredentialMutationResult::CredentialStale { .. }) => {
            Err(failure(copy::CREDENTIAL_CHANGED, locale))
        }
        Ok(_) => Err(failure(settings_copy::UNEXPECTED, locale)),
        Err(error) => Err(host_failure(&error, locale)),
    }
}

/// The connection `connection_id` as the catalog now stands.
async fn current_connection(
    requester: &HostRequester,
    connection_id: &str,
    locale: Locale,
) -> Result<ConnectionEntry, Failure> {
    let list = read_connections(requester).await.map_err(|error| host_failure(&error, locale))?;
    list.connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale))
}

/// The change that sends a connection back as read: its name, service
/// URL, state, and enabled models, the parameters and the overlay left as
/// stored. `change` edits it.
pub(crate) fn unchanged(connection: &ConnectionEntry) -> ConnectionCatalogEntryUpdate {
    ConnectionCatalogEntryUpdate::new(
        connection.name.to_string(),
        connection.base_url.as_ref().map(ToString::to_string),
        connection.enabled,
        connection.enabled_model_ids(),
    )
}

/// Sends the change `change` makes of the connection as the catalog now
/// stands, at its revision; a stale answer reads it again and tries once
/// more. `change` may refuse (`Err`) when what it edits changed since the
/// page read it.
pub(crate) async fn update_connection(
    requester: &HostRequester,
    connection_id: &str,
    change: impl Fn(&ConnectionEntry) -> Result<ConnectionCatalogEntryUpdate, Failure>,
    locale: Locale,
) -> Result<(), Failure> {
    for attempt in 0..2 {
        let current = current_connection(requester, connection_id, locale).await?;
        let input = ConnectionCatalogUpdateInput::new(
            ConnectionVersionBasis::new(current.id.to_string(), current.revision),
            change(&current)?,
        );
        log::info!("connection.catalog.update {} at revision {}", current.slug, current.revision);
        match requester.request::<ConnectionCatalogUpdate>(&input).await {
            Ok(UpdateCatalogConnectionResult::Committed { catalog_revision, .. }) => {
                log::info!("connection.catalog.update committed at {catalog_revision}");
                return Ok(());
            }
            Ok(UpdateCatalogConnectionResult::ConnectionStale { .. }) if attempt == 0 => {}
            Ok(UpdateCatalogConnectionResult::ConnectionStale { .. }) => break,
            Ok(_) => return Err(failure(settings_copy::UNEXPECTED, locale)),
            Err(error) => return Err(host_failure(&error, locale)),
        }
    }
    Err(failure(settings_copy::CONNECTION_CHANGED, locale))
}

/// Removes the connection, reading it again while it keeps changing
/// (a test or a model refresh moves its revision under the page). A
/// connection already gone counts as removed.
pub(crate) async fn remove_connection(
    requester: &HostRequester,
    connection_id: &str,
    locale: Locale,
) -> Result<(), Failure> {
    for _ in 0..REMOVE_ATTEMPTS {
        let list =
            read_connections(requester).await.map_err(|error| host_failure(&error, locale))?;
        let Some(current) = list.connection(connection_id) else {
            return Ok(());
        };
        let input = ConnectionCatalogRemoveInput::new(ConnectionVersionBasis::new(
            current.id.to_string(),
            current.revision,
        ));
        log::info!("connection.catalog.remove {} at revision {}", current.slug, current.revision);
        match requester.request::<ConnectionCatalogRemove>(&input).await {
            Ok(RemoveCatalogConnectionResult::Committed { .. }) => return Ok(()),
            Ok(RemoveCatalogConnectionResult::ConnectionStale { .. }) => {}
            Ok(_) => return Err(failure(settings_copy::UNEXPECTED, locale)),
            Err(error) => return Err(host_failure(&error, locale)),
        }
    }
    Err(failure(settings_copy::CONNECTION_CHANGED, locale))
}

/// Why an effect on a connection did not run.
pub(crate) fn effect_refusal(
    reason: &ConnectionEffectRejection,
    provider: &str,
    locale: Locale,
) -> Failure {
    match reason {
        ConnectionEffectRejection::ConnectionNotFound => {
            failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale)
        }
        ConnectionEffectRejection::ConnectionDisabled => {
            failure(copy::EFFECT_CONNECTION_DISABLED, locale)
        }
        ConnectionEffectRejection::CredentialNotConfigured => {
            settings_copy::api_key_missing(locale, provider).into()
        }
        _ => failure(copy::EFFECT_UNAVAILABLE, locale),
    }
}

/// What a refresh found: how many models the Host now lists.
pub(crate) async fn fetch_models(
    requester: &HostRequester,
    connection_id: &str,
    provider: &str,
    locale: Locale,
) -> Result<u64, ModelsFetchFailure> {
    log::info!("connection.models.fetch for {connection_id}");
    let input = ConnectionModelsFetchInput::new(connection_id);
    match requester.request::<ConnectionModelsFetch>(&input).await {
        Ok(ConnectionModelsFetchResult::Committed { model_count, source, .. }) => {
            log::info!("connection.models.fetch found {model_count} models ({source})");
            Ok(model_count)
        }
        Ok(ConnectionModelsFetchResult::Rejected { reason }) => {
            Err(ModelsFetchFailure::Refused(effect_refusal(&reason, provider, locale)))
        }
        Ok(ConnectionModelsFetchResult::Superseded { .. }) => {
            Err(ModelsFetchFailure::Refused(failure(copy::EFFECT_SUPERSEDED, locale)))
        }
        Ok(ConnectionModelsFetchResult::Failed { error_class }) => {
            log::info!("connection.models.fetch failed: {error_class}");
            Err(ModelsFetchFailure::Provider(error_class))
        }
        Ok(_) => Err(ModelsFetchFailure::Refused(failure(settings_copy::UNEXPECTED, locale))),
        Err(error) => Err(ModelsFetchFailure::Refused(host_failure(&error, locale))),
    }
}

/// Why a refresh listed nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelsFetchFailure {
    /// The Host did not run it (or could not be reached), with why.
    Refused(Failure),
    /// The provider could not be reached or refused.
    Provider(ConnectionEffectFailureClass),
}

/// The sentence a provider failure class reads as (`shared` failure copy).
pub(crate) fn provider_failure(class: &ConnectionEffectFailureClass, locale: Locale) -> Failure {
    let text = match class {
        ConnectionEffectFailureClass::Timeout => copy::TIMED_OUT,
        ConnectionEffectFailureClass::Network => copy::NETWORK_ERROR,
        ConnectionEffectFailureClass::Auth => settings_copy::FAILED_AUTH,
        ConnectionEffectFailureClass::InvalidResponse => settings_copy::FAILED_INVALID_RESPONSE,
        _ => copy::SERVICE_UNAVAILABLE,
    };
    failure(text, locale)
}

/// What a connection test found.
pub(crate) async fn test_connection(
    requester: &HostRequester,
    connection_id: &str,
    provider: &str,
    locale: Locale,
) -> Result<ConnectionTestProjection, Failure> {
    log::info!("connection.test.run for {connection_id}");
    let input = ConnectionTestRunInput::new(connection_id, None);
    match requester.request::<ConnectionTestRun>(&input).await {
        Ok(ConnectionTestRunResult::Committed { test, .. }) => Ok(test),
        Ok(ConnectionTestRunResult::Rejected { reason }) => {
            Err(effect_refusal(&reason, provider, locale))
        }
        Ok(ConnectionTestRunResult::Superseded { .. }) => {
            Err(failure(copy::EFFECT_SUPERSEDED, locale))
        }
        Ok(_) => Err(failure(settings_copy::UNEXPECTED, locale)),
        Err(error) => Err(host_failure(&error, locale)),
    }
}

/// The names of the connection's saved request headers.
pub(crate) async fn query_headers(
    requester: &HostRequester,
    connection_id: &str,
    locale: Locale,
) -> Result<Vec<SharedString>, Failure> {
    let input = ConnectionRequestHeadersQueryInput::new(connection_id);
    match requester.request::<ConnectionRequestHeadersQuery>(&input).await {
        Ok(ConnectionRequestHeadersQueryResult::Found { names }) => {
            Ok(names.into_iter().map(Into::into).collect())
        }
        Ok(ConnectionRequestHeadersQueryResult::ConnectionNotFound) => {
            Err(failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale))
        }
        Ok(_) => Err(failure(settings_copy::UNEXPECTED, locale)),
        Err(error) => Err(host_failure(&error, locale)),
    }
}

/// Replaces the connection's request headers; the saved names come back.
pub(crate) async fn replace_headers(
    requester: &HostRequester,
    connection_id: &str,
    headers: Vec<RequestHeaderUpdate>,
    locale: Locale,
) -> Result<Vec<SharedString>, Failure> {
    let input = ConnectionRequestHeadersReplaceInput::new(connection_id, headers);
    log::info!(
        "connection.request-headers.replace for {connection_id}: {} headers",
        input.headers.len()
    );
    match requester.request::<ConnectionRequestHeadersReplace>(&input).await {
        Ok(
            ConnectionRequestHeadersReplaceResult::Committed { names }
            | ConnectionRequestHeadersReplaceResult::Unchanged { names },
        ) => Ok(names.into_iter().map(Into::into).collect()),
        Ok(ConnectionRequestHeadersReplaceResult::ConnectionNotFound) => {
            Err(failure(copy::EFFECT_CONNECTION_NOT_FOUND, locale))
        }
        Ok(_) => Err(failure(settings_copy::UNEXPECTED, locale)),
        Err(error) => Err(host_failure(&error, locale)),
    }
}

/// A connection the create path added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Created {
    pub(crate) connection_id: SharedString,
    /// Why its models could not be listed afterwards, when they could not:
    /// the connection exists either way.
    pub(crate) models_error: Option<ModelsFetchFailure>,
}

/// Why the create path added nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CreateFailure {
    /// Another connection has the identifier.
    SlugTaken,
    Refused(Failure),
}

/// Desktop's create path (`connections:create`, then `fetchModels`): adds
/// `draft` at the catalog's current revision (again once on a revision
/// conflict), saves its key and its request headers (and removes it again
/// when either fails), then lists its models when the provider can.
pub(crate) async fn create_connection(
    requester: &HostRequester,
    draft: ConnectionCatalogEntryDraft,
    api_key: Option<String>,
    headers: Vec<RequestHeaderUpdate>,
    locale: Locale,
) -> Result<Created, CreateFailure> {
    let refused = |text: Text| CreateFailure::Refused(failure(text, locale));
    let host =
        |error: workspace::HostRequestError| CreateFailure::Refused(host_failure(&error, locale));
    let mut created = None;
    for _ in 0..2 {
        let revision = read_connections(requester).await.map_err(host)?.revision;
        let input = ConnectionCatalogCreateInput::new(revision, draft.clone());
        log::info!(
            "connection.catalog.create {} ({}) at catalog revision {revision}",
            draft.slug,
            draft.provider_type
        );
        match requester.request::<ConnectionCatalogCreate>(&input).await.map_err(host)? {
            CreateCatalogConnectionResult::Committed { connection, .. } => {
                created = Some(connection);
                break;
            }
            CreateCatalogConnectionResult::ConnectionExists { .. } => {
                return Err(CreateFailure::SlugTaken);
            }
            CreateCatalogConnectionResult::RevisionConflict { .. } => {}
            _ => return Err(refused(settings_copy::UNEXPECTED)),
        }
    }
    let Some(basis) = created else {
        return Err(refused(copy::CATALOG_KEPT_CHANGING));
    };
    let connection_id = basis.connection_id.clone();
    let mut saved = true;
    if let Some(secret) = api_key {
        let input = CredentialVaultSetInput::new(
            key_locator(&connection_id, &draft.provider_type),
            None,
            secret,
        );
        log::info!("credential.vault.set for the new connection {}", draft.slug);
        saved = credential_result(requester.request::<CredentialVaultSet>(&input).await, locale)
            .inspect_err(|reason| log::warn!("the new connection's key was not saved: {reason}"))
            .is_ok();
    }
    if saved && !headers.is_empty() {
        saved = replace_headers(requester, &connection_id, headers, locale)
            .await
            .inspect_err(|reason| {
                log::warn!("the new connection's headers were not saved: {reason}")
            })
            .is_ok();
    }
    if !saved {
        let input = ConnectionCatalogRemoveInput::new(basis);
        requester.request::<ConnectionCatalogRemove>(&input).await.ok();
        return Err(refused(copy::CREATE_ROLLED_BACK));
    }
    let discovers = ProviderDefinition::find(&draft.provider_type)
        .is_some_and(ProviderDefinition::supports_model_discovery);
    let models_error = if discovers {
        let provider = shared::copy::providers::provider_name(locale, &draft.provider_type);
        fetch_models(requester, &connection_id, provider, locale).await.err()
    } else {
        None
    };
    Ok(Created { connection_id: connection_id.into(), models_error })
}
