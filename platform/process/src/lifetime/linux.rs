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

use super::{Instance, LinuxOrigin, ProcessIdentity, Status, unobservable};
use std::{
    fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
};

pub(super) fn capture(pid: u32) -> io::Result<ProcessIdentity> {
    let origin = origin()?;
    let handle = open(pid)?.ok_or_else(|| io::Error::from_raw_os_error(libc::ESRCH))?;
    let first = start(pid)?;
    let second = start(pid)?;
    if first != second || exited(&handle)? || origin != self::origin()? {
        return Err(unobservable(
            "process or probe origin changed during capture",
        ));
    }
    Ok(ProcessIdentity {
        pid,
        instance: Instance::Linux {
            origin,
            start_ticks: first,
        },
    })
}

pub(super) fn observe(identity: &ProcessIdentity) -> io::Result<Status> {
    let Instance::Linux {
        origin: expected_origin,
        start_ticks,
    } = &identity.instance
    else {
        return Err(unobservable("process identity belongs to another platform"));
    };
    if origin()? != *expected_origin {
        return Err(unobservable(
            "process identity belongs to another boot or PID namespace",
        ));
    }
    let result = inspect(identity.pid, *start_ticks);
    if origin()? != *expected_origin {
        return Err(unobservable("probe origin changed during observation"));
    }
    result
}

fn inspect(pid: u32, expected: u64) -> io::Result<Status> {
    let Some(handle) = open(pid)? else {
        return Ok(Status::Gone);
    };
    // Never treat /proc ENOENT alone as absence: hidepid can conceal a live PID.
    let first = start(pid)?;
    let second = start(pid)?;
    if first != expected || second != expected || exited(&handle)? {
        return Ok(Status::Gone);
    }
    Ok(Status::Alive)
}

fn open(pid: u32) -> io::Result<Option<OwnedFd>> {
    // SAFETY: pidfd_open takes integer arguments and returns a fresh owned fd.
    // Unlike /proc visibility, ESRCH here refers to this actual PID namespace.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: successful pidfd_open transfers this descriptor exactly once.
    Ok(Some(unsafe { OwnedFd::from_raw_fd(fd as i32) }))
}

fn exited(handle: &OwnedFd) -> io::Result<bool> {
    let mut fd = libc::pollfd {
        fd: handle.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: a valid pollfd referring to our owned handle; zero timeout is read-only.
    let result = unsafe { libc::poll(&mut fd, 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if fd.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
        return Err(unobservable("pidfd could not be queried"));
    }
    Ok(fd.revents & (libc::POLLIN | libc::POLLHUP) != 0)
}

fn origin() -> io::Result<LinuxOrigin> {
    // Confirm /proc is kernel procfs, not a copied directory of descriptors.
    // SAFETY: zero is valid for statfs; valid NUL pathname and writable record.
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c"/proc".as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if stat.f_type as u64 != libc::PROC_SUPER_MAGIC as u64 {
        return Err(unobservable("process probe is not kernel procfs"));
    }
    let self_pid = fs::read_link("/proc/self")?;
    if self_pid.to_str() != Some(std::process::id().to_string().as_str()) {
        return Err(unobservable(
            "procfs PID view differs from the caller PID namespace",
        ));
    }
    let namespace = fs::metadata("/proc/self/ns/pid")?;
    // NSpid is relative to the namespace of the procfs mount. One entry means
    // this mount and pidfd_open use the same PID view; a parent mount lists more.
    // Only read our own status, so ordinary users need no access to PID 1.
    let status = fs::read_to_string("/proc/self/status")?;
    let mut pids = status
        .lines()
        .find_map(|line| line.strip_prefix("NSpid:"))
        .ok_or_else(|| unobservable("procfs does not expose its PID namespace view"))?
        .split_ascii_whitespace();
    let pid = pids.next().and_then(|pid| pid.parse::<u32>().ok());
    if pid != Some(std::process::id()) || pids.next().is_some() {
        return Err(unobservable("procfs is mounted for another PID namespace"));
    }
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let boot_id = boot_id.trim();
    if boot_id.len() != 36
        || !boot_id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err(unobservable("invalid kernel boot ID"));
    }
    Ok(LinuxOrigin {
        boot_id: boot_id.to_owned(),
        pid_namespace_device: namespace.dev(),
        pid_namespace_inode: namespace.ino(),
    })
}

fn start(pid: u32) -> io::Result<u64> {
    let bytes = fs::read(format!("/proc/{pid}/stat"))?;
    parse_start(pid, &bytes)
}

fn parse_start(pid: u32, bytes: &[u8]) -> io::Result<u64> {
    let invalid = || unobservable("truncated or invalid kernel process stat");
    let left = bytes.iter().position(|&b| b == b'(').ok_or_else(invalid)?;
    let right = bytes.iter().rposition(|&b| b == b')').ok_or_else(invalid)?;
    if right <= left || bytes.last() != Some(&b'\n') {
        return Err(invalid());
    }
    let reported_pid = std::str::from_utf8(&bytes[..left])
        .map_err(|_| invalid())?
        .trim()
        .parse::<u32>()
        .map_err(|_| invalid())?;
    if reported_pid != pid {
        return Err(invalid());
    }
    // comm may contain spaces, parentheses, newlines and non-UTF8 bytes. Only
    // parse fields after its final closing parenthesis. starttime is field 22.
    let fields: Vec<_> = bytes[right + 1..]
        .split(u8::is_ascii_whitespace)
        .filter(|field| !field.is_empty())
        .collect();
    if fields.len() < 50 || fields[0].len() != 1 {
        return Err(invalid());
    }
    std::str::from_utf8(fields[19])
        .map_err(|_| invalid())?
        .parse()
        .map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_comm_may_contain_closing_parentheses_and_non_utf8() {
        let mut bytes = b"42 (a) weird \xff) ".to_vec();
        let mut fields = vec!["0"; 50];
        fields[0] = "S";
        fields[19] = "123456";
        bytes.extend_from_slice(fields.join(" ").as_bytes());
        bytes.push(b'\n');
        assert_eq!(parse_start(42, &bytes).unwrap(), 123456);
        assert!(parse_start(43, &bytes).is_err());
        assert!(parse_start(42, &bytes[..bytes.len() - 2]).is_err());
        assert!(parse_start(42, b"42 (comm) S 1\n").is_err());
    }
}
