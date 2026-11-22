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

use super::{LocalMemory, checked};
use std::{io, ptr};
use uuid::Uuid;
use windows_sys::{
    Win32::{
        Foundation::{FWP_E_FILTER_NOT_FOUND, HANDLE},
        NetworkManagement::WindowsFilteringPlatform::*,
        Security::Authorization::*,
        System::Rpc::RPC_C_AUTHN_DEFAULT,
    },
    core::GUID,
};

const LAYERS: [(&str, GUID); 6] = [
    ("connect-v4", FWPM_LAYER_ALE_AUTH_CONNECT_V4),
    ("connect-v6", FWPM_LAYER_ALE_AUTH_CONNECT_V6),
    ("accept-v4", FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4),
    ("accept-v6", FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6),
    ("listen-v4", FWPM_LAYER_ALE_AUTH_LISTEN_V4),
    ("listen-v6", FWPM_LAYER_ALE_AUTH_LISTEN_V6),
];

/// Account-scoped, persistent network denial. The setup owner persists a unique
/// namespace and keeps the dedicated account disabled until installation commits.
/// Before removal it disables that account and drains its processes. Rules must
/// survive a Host crash; a dynamic WFP session would reopen networking too early.
pub struct NetworkRules {
    namespace: Uuid,
}

/// A provisioned account can reach only its own loopback gateway. A missing
/// port denies every network destination, including loopback.
pub struct AccountNetwork<'a> {
    pub sid: &'a str,
    pub proxy_port: Option<std::num::NonZeroU16>,
}

const MAX_ACCOUNTS: usize = 16;
const GATEWAY_RULES: [&str; 3] = ["remote-address", "remote-port", "protocol"];

impl NetworkRules {
    pub fn new(namespace: Uuid) -> Self {
        Self { namespace }
    }

    /// Atomic, persistent account rules. Online sandbox accounts are also
    /// forbidden from impersonating another execution's reserved gateway.
    pub fn install(&self, offline: &[AccountNetwork<'_>], online: &[&str]) -> io::Result<()> {
        if offline.is_empty() || offline.len() > MAX_ACCOUNTS || online.len() > MAX_ACCOUNTS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid sandbox account set",
            ));
        }
        let engine = Engine::open()?;
        engine.transaction(|| {
            self.remove_from(&engine)?;
            for (index, account) in offline.iter().enumerate() {
                let descriptor = descriptor(&[account.sid])?;
                let mut blob = descriptor.blob();
                let user = user_condition(&mut blob);
                for (name, layer) in LAYERS {
                    if name == "connect-v4" && account.proxy_port.is_some() {
                        continue;
                    }
                    self.block(&engine, &format!("{index}-{name}"), layer, &mut [user])?;
                }
                if let Some(port) = account.proxy_port {
                    let extras = [
                        FWPM_FILTER_CONDITION0 {
                            fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
                            matchType: FWP_MATCH_NOT_EQUAL,
                            conditionValue: FWP_CONDITION_VALUE0 {
                                r#type: FWP_UINT32,
                                Anonymous: FWP_CONDITION_VALUE0_0 {
                                    uint32: u32::from(std::net::Ipv4Addr::LOCALHOST),
                                },
                            },
                        },
                        FWPM_FILTER_CONDITION0 {
                            fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
                            matchType: FWP_MATCH_NOT_EQUAL,
                            conditionValue: FWP_CONDITION_VALUE0 {
                                r#type: FWP_UINT16,
                                Anonymous: FWP_CONDITION_VALUE0_0 { uint16: port.get() },
                            },
                        },
                        FWPM_FILTER_CONDITION0 {
                            fieldKey: FWPM_CONDITION_IP_PROTOCOL,
                            matchType: FWP_MATCH_NOT_EQUAL,
                            conditionValue: FWP_CONDITION_VALUE0 {
                                r#type: FWP_UINT8,
                                Anonymous: FWP_CONDITION_VALUE0_0 { uint8: 6 },
                            },
                        },
                    ];
                    for (name, condition) in GATEWAY_RULES.into_iter().zip(extras) {
                        self.block(
                            &engine,
                            &format!("{index}-{name}"),
                            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                            &mut [user, condition],
                        )?;
                    }
                }
            }
            // The user account retains ordinary networking. Only dedicated
            // sandbox accounts are prevented from binding gateway listeners.
            if !online.is_empty() {
                let descriptor = descriptor(online)?;
                let mut blob = descriptor.blob();
                let user = user_condition(&mut blob);
                for (index, account) in offline.iter().enumerate() {
                    if let Some(port) = account.proxy_port {
                        let port = FWPM_FILTER_CONDITION0 {
                            fieldKey: FWPM_CONDITION_IP_LOCAL_PORT,
                            matchType: FWP_MATCH_EQUAL,
                            conditionValue: FWP_CONDITION_VALUE0 {
                                r#type: FWP_UINT16,
                                Anonymous: FWP_CONDITION_VALUE0_0 { uint16: port.get() },
                            },
                        };
                        for (family, layer) in [
                            ("v4", FWPM_LAYER_ALE_AUTH_LISTEN_V4),
                            ("v6", FWPM_LAYER_ALE_AUTH_LISTEN_V6),
                        ] {
                            self.block(
                                &engine,
                                &format!("gateway-{index}-{family}"),
                                layer,
                                &mut [user, port],
                            )?;
                        }
                    }
                }
            }
            Ok(())
        })
    }

    fn block(
        &self,
        engine: &Engine,
        name: &str,
        layer: GUID,
        conditions: &mut [FWPM_FILTER_CONDITION0],
    ) -> io::Result<()> {
        let mut label: Vec<_> = format!("Maka sandbox {} {name}", self.namespace)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let filter = FWPM_FILTER0 {
            filterKey: self.key(name),
            displayData: FWPM_DISPLAY_DATA0 {
                name: label.as_mut_ptr(),
                description: ptr::null_mut(),
            },
            flags: FWPM_FILTER_FLAG_PERSISTENT,
            layerKey: layer,
            subLayerKey: FWPM_SUBLAYER_UNIVERSAL,
            numFilterConditions: conditions.len() as u32,
            filterCondition: conditions.as_mut_ptr(),
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: all filter storage remains alive; WFP copies it atomically.
        checked(unsafe { FwpmFilterAdd0(engine.0, &filter, ptr::null_mut(), ptr::null_mut()) })
    }

    pub fn remove(&self) -> io::Result<()> {
        let engine = Engine::open()?;
        engine.transaction(|| self.remove_from(&engine))
    }
    fn remove_from(&self, engine: &Engine) -> io::Result<()> {
        for index in 0..MAX_ACCOUNTS {
            for (name, _) in LAYERS {
                engine.remove(&self.key(&format!("{index}-{name}")))?;
            }
            for name in GATEWAY_RULES {
                engine.remove(&self.key(&format!("{index}-{name}")))?;
            }
            for family in ["v4", "v6"] {
                engine.remove(&self.key(&format!("gateway-{index}-{family}")))?;
            }
        }
        Ok(())
    }
    fn key(&self, name: &str) -> GUID {
        GUID::from_u128(Uuid::new_v5(&self.namespace, name.as_bytes()).as_u128())
    }
}

struct Descriptor {
    memory: LocalMemory,
    size: u32,
}
impl Descriptor {
    fn blob(&self) -> FWP_BYTE_BLOB {
        FWP_BYTE_BLOB {
            size: self.size,
            data: self.memory.0.cast(),
        }
    }
}
fn descriptor(accounts: &[&str]) -> io::Result<Descriptor> {
    let sids = accounts
        .iter()
        .map(|sid| super::sid(sid))
        .collect::<io::Result<Vec<_>>>()?;
    let access: Vec<_> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: FWP_ACTRL_MATCH_FILTER,
            grfAccessMode: GRANT_ACCESS,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.0.cast(),
                ..Default::default()
            },
            ..Default::default()
        })
        .collect();
    let mut descriptor = ptr::null_mut();
    let mut size = 0;
    // SAFETY: input SIDs/access entries and output pointers are valid.
    checked(unsafe {
        BuildSecurityDescriptorW(
            ptr::null(),
            ptr::null(),
            access.len() as u32,
            access.as_ptr(),
            0,
            ptr::null(),
            ptr::null_mut(),
            &mut size,
            &mut descriptor,
        )
    })?;
    Ok(Descriptor {
        memory: LocalMemory(descriptor),
        size,
    })
}
fn user_condition(blob: &mut FWP_BYTE_BLOB) -> FWPM_FILTER_CONDITION0 {
    FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_USER_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SECURITY_DESCRIPTOR_TYPE,
            Anonymous: FWP_CONDITION_VALUE0_0 { sd: blob },
        },
    }
}
struct Engine(HANDLE);
impl Engine {
    fn open() -> io::Result<Self> {
        let session = FWPM_SESSION0 {
            txnWaitTimeoutInMSec: 5_000,
            ..Default::default()
        };
        let mut handle = ptr::null_mut();
        // SAFETY: local authenticated engine and live session/output pointers.
        checked(unsafe {
            FwpmEngineOpen0(
                ptr::null(),
                RPC_C_AUTHN_DEFAULT as u32,
                ptr::null(),
                &session,
                &mut handle,
            )
        })?;
        Ok(Self(handle))
    }

    fn remove(&self, key: &GUID) -> io::Result<()> {
        // SAFETY: live engine and filter key, scoped to our namespace.
        let status = unsafe { FwpmFilterDeleteByKey0(self.0, key) };
        if status == FWP_E_FILTER_NOT_FOUND as u32 {
            Ok(())
        } else {
            checked(status)
        }
    }

    fn transaction(&self, apply: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
        // SAFETY: this engine is private to one synchronous setup operation.
        checked(unsafe { FwpmTransactionBegin0(self.0, 0) })?;
        apply()?;
        checked(unsafe { FwpmTransactionCommit0(self.0) })
        // An error drops the engine, aborting its uncommitted transaction.
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: closes the owned engine, not a process HANDLE.
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
