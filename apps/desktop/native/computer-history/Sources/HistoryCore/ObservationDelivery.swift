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

/// Kernel lifetime identity also exists for apps launched without LaunchServices.
public struct ObservationProcessIdentity: Hashable {
    public let pid: pid_t
    private let seconds: UInt64
    private let microseconds: UInt64

    public static func read(_ pid: pid_t) -> Self? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_start_tvsec > 0,
              info.pbi_start_tvusec < 1_000_000 else { return nil }
        return Self(pid: pid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }
}

public struct OpaqueSourceRegistry<Key: Hashable> {
    private var entries: [(key: Key, id: String)] = []
    private let capacity: Int
    public init(capacity: Int = 128) { self.capacity = max(1, capacity) }

    public mutating func id(for key: Key) -> String {
        if let index = entries.firstIndex(where: { $0.key == key }) {
            let entry = entries.remove(at: index)
            entries.append(entry)
            return entry.id
        }
        let id = UUID().uuidString.lowercased()
        entries.append((key, id))
        if entries.count > capacity { entries.removeFirst() }
        return id
    }

    public mutating func remove(where predicate: (Key) -> Bool) {
        entries.removeAll { predicate($0.key) }
    }
}

/// Deduplication is an optimization only. Every retained payload is a complete
/// snapshot; failed/suppressed appends never become the retained fingerprint.
public struct ObservationDelivery {
    private var last: [String: Data] = [:]
    private var lastMetadata: Data?
    public init() {}

    /// Metadata and content advance together only after a retained write.
    /// Pending-input cancellation does not reset this retained state.
    @discardableResult
    public mutating func deliver(
        source: String, metadataFingerprint: Data, fingerprint: Data,
        kind: HistoryEventKind, write: (HistoryEventKind) throws -> Bool
    ) rethrows -> Bool {
        let windowChanged = metadataFingerprint != lastMetadata
        var next = self
        if windowChanged { next.reset() }
        guard try next.deliver(source: source, fingerprint: fingerprint, write: {
            try write(windowChanged ? .windowChanged : kind)
        }) else { return false }
        next.lastMetadata = metadataFingerprint
        self = next
        return true
    }

    @discardableResult
    public mutating func deliver(
        source: String, fingerprint: Data, write: () throws -> Bool
    ) rethrows -> Bool {
        if last[source] == fingerprint { return false }
        guard try write() else { return false }
        if last.count >= 128, last[source] == nil { last.removeAll() }
        last[source] = fingerprint
        return true
    }

    public mutating func reset() {
        last.removeAll()
        lastMetadata = nil
    }
}

/// Selection identity includes the actual control/document path. Clearing a
/// selection ends deduplication even though no empty event needs to be stored.
public struct SelectionDelivery {
    private var last: (source: TextInputSource, selection: EventStreamSelection, items: [AnyHashable])?
    public init() {}

    @discardableResult
    public mutating func deliver(
        source: TextInputSource, selection: EventStreamSelection,
        itemIdentities: [AnyHashable] = [], write: () throws -> Bool
    ) rethrows -> Bool {
        guard selection.selectedText?.isEmpty == false || (selection.selectedRange?.length ?? 0) > 0 ||
                !selection.selectedItems.isEmpty else {
            reset()
            return false
        }
        if let last, last.source.matches(source), last.selection == selection, last.items == itemIdentities { return false }
        guard try write() else { return false }
        last = (source, selection, itemIdentities)
        return true
    }

    public mutating func reset() { last = nil }
}

/// Delayed reads stay within one observer lifetime and actual source. Bounded
/// admission and first-event deadlines prevent streamed notifications starving
/// delivery indefinitely.
public struct ObservationCallbacks<Source: Hashable> {
    public struct Token: Equatable {
        public let epoch: UInt64
        public let source: Source
    }
    private var epoch: UInt64 = 0
    private var pending = Set<Source>()
    public init() {}

    public mutating func admit(_ source: Source) -> Token? {
        guard pending.count < 32, pending.insert(source).inserted else { return nil }
        return Token(epoch: epoch, source: source)
    }

    public mutating func take(_ token: Token) -> Bool {
        token.epoch == epoch && pending.remove(token.source) != nil
    }

    public mutating func invalidate() {
        epoch &+= 1
        pending.removeAll()
    }
}

/// One foreground window needs one full traversal, regardless of how many
/// controls reported a generic change. This schedules work, never caches text.
/// Failed/cancelled attempts retain dirty work until a verified capture settles it.
public struct ObservationSampling {
    public struct Token {
        fileprivate let revision: UInt64
    }
    private var revision: UInt64 = 0
    private var dirtySince: TimeInterval?
    private var lastAttempt: TimeInterval?
    public init() {}

    public mutating func request(now: TimeInterval) {
        revision &+= 1
        if dirtySince == nil { dirtySince = now }
    }

    public mutating func begin(now: TimeInterval) -> Token? {
        guard lastAttempt.map({ now - $0 >= 3 }) ?? true else { return nil }
        if let dirtySince {
            guard now - dirtySince >= 0.2 else { return nil }
        }
        lastAttempt = now
        return Token(revision: revision)
    }

    @discardableResult
    public mutating func complete(_ token: Token, settled: Bool) -> Bool {
        guard token.revision == revision else { return false }
        guard settled else { return false }
        dirtySince = nil
        return true
    }

    /// Direct semantic events still take fresh snapshots. They defer the next
    /// fallback, but cannot settle separately pending notification work.
    public mutating func observed(now: TimeInterval) {
        if dirtySince == nil { lastAttempt = now }
    }

    public mutating func invalidate() {
        revision &+= 1
        dirtySince = nil
    }
}
