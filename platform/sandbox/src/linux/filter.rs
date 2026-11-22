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

use crate::{Error, Network};
use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};
use std::collections::BTreeMap;

pub(super) fn compile(network: &Network) -> Result<Vec<u8>, Error> {
    let mut rules = BTreeMap::new();
    for syscall in [
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_open_by_handle_at,
    ] {
        rules.insert(syscall, Vec::new());
    }
    let families: &[i32] = match network {
        Network::Denied => &[],
        Network::Allowed | Network::Restricted { .. } => &[libc::AF_INET, libc::AF_INET6],
    };
    let conditions = families
        .iter()
        .map(|family| {
            SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, *family as u64)
                .map_err(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    rules.insert(
        libc::SYS_socket,
        if conditions.is_empty() {
            Vec::new()
        } else {
            vec![SeccompRule::new(conditions).map_err(invalid)?]
        },
    );
    rules.insert(
        libc::SYS_socketpair,
        vec![
            SeccompRule::new(vec![
                SeccompCondition::new(
                    0,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::Ne,
                    libc::AF_UNIX as u64,
                )
                .map_err(invalid)?,
            ])
            .map_err(invalid)?,
            // Datagram socketpairs can override their peer with msg_name and
            // reach a Host pathname socket. Stream/seqpacket pairs retain IPC
            // (including sendmsg/SCM_RIGHTS) without a destination override.
            SeccompRule::new(
                [libc::SOCK_STREAM, libc::SOCK_SEQPACKET]
                    .into_iter()
                    .flat_map(|kind| {
                        [
                            0,
                            libc::SOCK_CLOEXEC,
                            libc::SOCK_NONBLOCK,
                            libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                        ]
                        .into_iter()
                        .map(move |flags| (kind | flags) as u64)
                    })
                    .map(|kind| {
                        SeccompCondition::new(1, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, kind)
                            .map_err(invalid)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .map_err(invalid)?,
        ],
    );
    if network == &Network::Denied {
        // Keep anonymous socketpairs for compiler/runtime IPC, but disallow
        // connecting to filesystem sockets in a shared Host mount.
        for syscall in [
            libc::SYS_connect,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_accept,
            libc::SYS_accept4,
            libc::SYS_sendmmsg,
        ] {
            rules.insert(syscall, Vec::new());
        }
        rules.insert(
            libc::SYS_sendto,
            vec![
                SeccompRule::new(vec![
                    SeccompCondition::new(4, SeccompCmpArgLen::Qword, SeccompCmpOp::Ne, 0)
                        .map_err(invalid)?,
                ])
                .map_err(invalid)?,
            ],
        );
    }
    rules.insert(
        libc::SYS_ioctl,
        [libc::TIOCSTI, libc::TIOCLINUX]
            .into_iter()
            .map(|request| {
                SeccompRule::new(vec![
                    SeccompCondition::new(1, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, request)
                        .map_err(invalid)?,
                ])
                .map_err(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?,
    );
    let program: BpfProgram = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH.try_into().map_err(invalid)?,
    )
    .map_err(invalid)?
    .try_into()
    .map_err(invalid)?;
    let mut bytes = Vec::with_capacity((program.len() + 6) * 8);
    #[cfg(target_arch = "x86_64")]
    {
        // x32 shares AUDIT_ARCH_X86_64, so the library's architecture check
        // alone cannot reject it. Also deny the legacy untagged x32 range.
        for (code, jt, jf, k) in [
            (0x20u16, 0u8, 0u8, 0u32), // LD seccomp_data.nr
            (0x35, 0, 2, 512),         // JGE legacy range start
            (0x25, 1, 0, 547),         // JGT legacy range end
            (0x06, 0, 0, 0x50000 | libc::ENOSYS as u32),
            (0x45, 0, 1, 0x40000000), // JSET __X32_SYSCALL_BIT
            (0x06, 0, 0, 0x50000 | libc::ENOSYS as u32),
        ] {
            bytes.extend(code.to_ne_bytes());
            bytes.extend([jt, jf]);
            bytes.extend(k.to_ne_bytes());
        }
    }
    // Kernel sock_filter layout: u16 code, u8 jt, u8 jf, u32 k. Serialize fields
    // explicitly instead of reading potentially uninitialized struct padding.
    for instruction in program {
        bytes.extend(instruction.code.to_ne_bytes());
        bytes.extend([instruction.jt, instruction.jf]);
        bytes.extend(instruction.k.to_ne_bytes());
    }
    Ok(bytes)
}

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("seccomp: {error}"))
}
