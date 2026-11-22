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

//! Transfer a private-network listener from the trusted pre-exec helper to Host.
//! Only the listener crosses namespaces. The target inherits no Host socket.

use rustix::net::{
    RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags, SendAncillaryBuffer,
    SendAncillaryMessage, SendFlags,
};
use std::{
    io::{self, IoSlice, IoSliceMut},
    mem::MaybeUninit,
    net::{Ipv4Addr, TcpListener},
    os::{
        fd::{AsFd, FromRawFd, OwnedFd, RawFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    path::Path,
    time::Duration,
};

pub const HELPER: &str = "__maka-network-namespace";
const DEADLINE: Duration = Duration::from_secs(15);

pub(crate) fn prepare(
    network: maka_sandbox::Network,
    route: maka_network::Policy,
) -> io::Result<(std::fs::File, maka_network::proxy::Proxy)> {
    let (host, child) = UnixStream::pair()?;
    host.set_nonblocking(true)?;
    let host = tokio::net::UnixStream::from_std(host)?;
    let listener = async move {
        tokio::time::timeout(DEADLINE, async {
            let listener = loop {
                host.readable().await?;
                match host.try_io(tokio::io::Interest::READABLE, || receive(&host)) {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                    result => break result?,
                }
            };
            listener.set_nonblocking(true)?;
            let listener = tokio::net::TcpListener::from_std(listener)?;
            // A listener is owned by Host before the helper executes any user
            // code. The private channel is dropped on both sides after this ACK.
            loop {
                host.writable().await?;
                match host.try_write(&[1]) {
                    Ok(1) => break,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                    _ => return Err(io::Error::other("network namespace acknowledgement failed")),
                }
            }
            Ok(listener)
        })
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "network namespace handoff timed out",
            )
        })?
    };
    Ok((
        std::fs::File::from(OwnedFd::from(child)),
        maka_network::proxy::Proxy::serve(network, route, listener)?,
    ))
}

fn receive(channel: &tokio::net::UnixStream) -> io::Result<TcpListener> {
    let mut byte = [0];
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut control = RecvAncillaryBuffer::new(&mut storage);
    let result = rustix::net::recvmsg(
        channel,
        &mut [IoSliceMut::new(&mut byte)],
        &mut control,
        RecvFlags::CMSG_CLOEXEC,
    )?;
    let mut files = Vec::new();
    let mut unexpected = false;
    for message in control.drain() {
        match message {
            RecvAncillaryMessage::ScmRights(rights) => files.extend(rights),
            _ => unexpected = true,
        }
    }
    if result.bytes != 1
        || byte != [1]
        || result
            .flags
            .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
        || unexpected
        || files.len() != 1
    {
        return Err(io::Error::other("invalid network namespace listener"));
    }
    let listener = TcpListener::from(files.remove(0));
    if rustix::net::sockopt::socket_type(&listener)? != rustix::net::SocketType::STREAM
        || rustix::net::sockopt::socket_protocol(&listener)? != Some(rustix::net::ipproto::TCP)
        || !rustix::net::sockopt::socket_acceptconn(&listener)?
        || !matches!(listener.local_addr()?, std::net::SocketAddr::V4(address) if *address.ip() == Ipv4Addr::LOCALHOST && address.port() != 0)
    {
        return Err(io::Error::other(
            "network namespace requires a loopback TCP listener",
        ));
    }
    Ok(listener)
}

/// Run only in the single-threaded trusted CLI entry point, after bubblewrap
/// creates the namespaces and before starting the untrusted target.
///
/// # Safety
/// The descriptor is an exclusively owned inherited bootstrap socket, not an
/// existing Rust-owned descriptor. The process must not have other threads.
pub unsafe fn enter(
    control: RawFd,
    executable: &Path,
    args: Vec<std::ffi::OsString>,
) -> io::Result<()> {
    if control <= 2 || !executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid network namespace bootstrap",
        ));
    }
    // SAFETY: this entry point exclusively owns the inherited descriptor.
    let mut channel = unsafe { UnixStream::from_raw_fd(control) };
    channel.set_read_timeout(Some(DEADLINE))?;
    channel.set_write_timeout(Some(DEADLINE))?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let files = [listener.as_fd()];
    let mut storage = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
    let mut ancillary = SendAncillaryBuffer::new(&mut storage);
    if !ancillary.push(SendAncillaryMessage::ScmRights(&files)) {
        return Err(io::Error::other("network namespace descriptor buffer"));
    }
    let count = rustix::io::retry_on_intr(|| {
        rustix::net::sendmsg(
            &channel,
            &[IoSlice::new(&[1])],
            &mut ancillary,
            SendFlags::NOSIGNAL,
        )
    })?;
    if count != 1 {
        return Err(io::Error::other(
            "network namespace listener handoff failed",
        ));
    }
    use std::io::Read;
    let mut ack = [0];
    channel.read_exact(&mut ack)?;
    if ack != [1] {
        return Err(io::Error::other("network namespace listener refused"));
    }
    drop(channel);
    drop(listener);
    // All launcher descriptors are CLOEXEC before the target starts. This is
    // single-threaded and does not mutate the multithreaded Host's descriptor table.
    if unsafe {
        libc::syscall(
            libc::SYS_close_range,
            3u32,
            u32::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
            return Err(error);
        }
        let descriptors = std::fs::read_dir("/proc/self/fd")?
            .map(|entry| {
                entry?
                    .file_name()
                    .to_str()
                    .ok_or_else(|| io::Error::other("invalid descriptor filename"))?
                    .parse::<RawFd>()
                    .map_err(io::Error::other)
            })
            .collect::<io::Result<Vec<_>>>()?;
        for fd in descriptors.into_iter().filter(|fd| *fd > 2) {
            // SAFETY: setting CLOEXEC does not access memory or close the fd;
            // the single-threaded helper cannot race another fd allocator.
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::EBADF)
            {
                return Err(io::Error::last_os_error());
            }
        }
    }
    let mut command = std::process::Command::new(executable);
    command.args(args);
    let proxy = format!("http://127.0.0.1:{port}");
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        command.env(key, &proxy);
    }
    command.env("NO_PROXY", "").env("no_proxy", "");
    Err(command.exec())
}
