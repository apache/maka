use std::collections::HashSet;

use crate::protocol::{BrokerLaunchRequest, launch_digest};

const MAX_REMEMBERED_NONCES: usize = 4096;

pub struct BrokerAuthorizer {
    allowed_profile_digests: HashSet<String>,
    used_nonces: HashSet<String>,
}

impl BrokerAuthorizer {
    pub fn new(allowed_profile_digests: impl IntoIterator<Item = String>) -> Self {
        Self {
            allowed_profile_digests: allowed_profile_digests
                .into_iter()
                .map(|digest| digest.to_ascii_lowercase())
                .collect(),
            used_nonces: HashSet::new(),
        }
    }

    pub fn authorize(
        &mut self,
        request: &BrokerLaunchRequest,
        connected_client_pid: u32,
    ) -> Result<(), BrokerAuthorizationError> {
        request
            .validate()
            .map_err(BrokerAuthorizationError::InvalidRequest)?;
        if request.client_pid != connected_client_pid {
            return Err(BrokerAuthorizationError::ClientPidMismatch);
        }
        let computed_digest =
            launch_digest(&request.launch).map_err(BrokerAuthorizationError::InvalidRequest)?;
        if !request
            .profile_digest
            .eq_ignore_ascii_case(&computed_digest)
        {
            return Err(BrokerAuthorizationError::ProfileDigestMismatch);
        }
        if !self
            .allowed_profile_digests
            .contains(&request.profile_digest.to_ascii_lowercase())
        {
            return Err(BrokerAuthorizationError::ProfileNotApproved);
        }
        let nonce = request.client_nonce.to_ascii_lowercase();
        if self.used_nonces.contains(&nonce) {
            return Err(BrokerAuthorizationError::NonceReplayed);
        }
        if self.used_nonces.len() >= MAX_REMEMBERED_NONCES {
            return Err(BrokerAuthorizationError::NonceCapacityExceeded);
        }
        self.used_nonces.insert(nonce);
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum BrokerAuthorizationError {
    InvalidRequest(String),
    ClientPidMismatch,
    ProfileNotApproved,
    ProfileDigestMismatch,
    NonceReplayed,
    NonceCapacityExceeded,
}

impl BrokerAuthorizationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "invalid_request",
            Self::ClientPidMismatch => "client_pid_mismatch",
            Self::ProfileNotApproved => "profile_not_approved",
            Self::ProfileDigestMismatch => "profile_digest_mismatch",
            Self::NonceReplayed => "nonce_replayed",
            Self::NonceCapacityExceeded => "nonce_capacity_exceeded",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::InvalidRequest(message) => message.clone(),
            Self::ClientPidMismatch => {
                "request clientPid does not match the connected pipe client".to_owned()
            }
            Self::ProfileNotApproved => "profileDigest is not approved by the broker".to_owned(),
            Self::ProfileDigestMismatch => {
                "profileDigest does not match the canonical launch policy".to_owned()
            }
            Self::NonceReplayed => "clientNonce has already been used".to_owned(),
            Self::NonceCapacityExceeded => {
                "broker nonce capacity is exhausted; restart is required".to_owned()
            }
        }
    }
}
