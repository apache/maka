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

import Darwin
import Foundation

public enum RecorderOwnershipError: Error {
    case alreadyActive
    case invalidParent
    case unsafeLock
    case system(Int32)
}

/// Never unlink the lock: all contenders must continue to address the same inode.
public final class RecorderOwnership {
    private let descriptor: Int32

    public init(homeURL: URL) throws {
        try FileManager.default.createDirectory(
            at: homeURL, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let fd = try Self.openLock(homeURL: homeURL, create: true)
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(fd)
            if code == EWOULDBLOCK { throw RecorderOwnershipError.alreadyActive }
            throw RecorderOwnershipError.system(code)
        }
        descriptor = fd
    }

    deinit { close(descriptor) }

    /// A read-only status probe never creates the home or the lock file. Errors
    /// other than absence must reach the caller, not masquerade as an idle home.
    public static func isActive(homeURL: URL) throws -> Bool {
        let fd: Int32
        do {
            fd = try openLock(homeURL: homeURL, create: false)
        } catch RecorderOwnershipError.system(ENOENT) {
            return false
        }
        defer { close(fd) }
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            _ = flock(fd, LOCK_UN)
            return false
        }
        if errno == EWOULDBLOCK { return true }
        throw RecorderOwnershipError.system(errno)
    }

    /// Lock the parent's inherited open-file description. Closing this child's
    /// duplicate must not unlock it; the parent closes its own descriptor last.
    public static func admitMaintenance(homeURL: URL, descriptor: Int32) throws {
        let expected = try openLock(homeURL: homeURL, create: false)
        defer { close(expected) }
        var actualInfo = stat()
        var expectedInfo = stat()
        guard fstat(descriptor, &actualInfo) == 0, fstat(expected, &expectedInfo) == 0,
              actualInfo.st_dev == expectedInfo.st_dev,
              actualInfo.st_ino == expectedInfo.st_ino,
              fcntl(descriptor, F_GETFL) & O_ACCMODE == O_RDWR else {
            throw RecorderOwnershipError.unsafeLock
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            if errno == EWOULDBLOCK { throw RecorderOwnershipError.alreadyActive }
            throw RecorderOwnershipError.system(errno)
        }
    }

    private static func openLock(homeURL: URL, create: Bool) throws -> Int32 {
        let path = homeURL.appendingPathComponent("recorder.lock").path
        let fd = open(path, O_RDWR | O_CLOEXEC | O_NOFOLLOW | (create ? O_CREAT : 0), 0o600)
        guard fd >= 0 else { throw RecorderOwnershipError.system(errno) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1 else {
            close(fd)
            throw RecorderOwnershipError.unsafeLock
        }
        return fd
    }
}

public struct RecorderParent {
    public let processIdentifier: Int32

    public init(expected: Int32, actual: Int32 = getppid()) throws {
        guard expected > 1, actual == expected else { throw RecorderOwnershipError.invalidParent }
        processIdentifier = expected
    }

    /// Reparenting permanently breaks this identity even if the old PID is reused.
    public func isAlive(actual: Int32 = getppid()) -> Bool {
        actual == processIdentifier
    }
}

/// Kernel process-exit notification; this does not inspect or signal the process.
public final class ProcessExitMonitor {
    private let source: DispatchSourceProcess

    public init(
        processIdentifier: Int32,
        queue: DispatchQueue = .main,
        onExit: @escaping () -> Void
    ) {
        source = DispatchSource.makeProcessSource(
            identifier: processIdentifier, eventMask: .exit, queue: queue
        )
        source.setEventHandler(handler: onExit)
        source.resume()
    }

    deinit { source.cancel() }
}
