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

import Foundation

/// Main-queue lifecycle authority, shared by observation and persistence.
public struct RecorderLifecycle {
    public private(set) var state: RecorderState
    public private(set) var generation: UInt64 = 0
    public private(set) var stopped = false
    private var lastControl: RecorderControlRequest?

    public init(control: RecorderControlRequest?, now: Date = Date()) {
        state = Self.requestedState(control, now: now) ?? .running
        lastControl = control
    }

    public mutating func reconcile(_ control: RecorderControlRequest?, now: Date = Date()) {
        guard !stopped, let control,
              let requested = Self.requestedState(control, now: now) else { return }
        guard requested != state || control.updatedAt != lastControl?.updatedAt ||
            control.state != lastControl?.state || control.resumeAt != lastControl?.resumeAt ||
            control.revision != lastControl?.revision
        else { return }
        lastControl = control
        state = requested
        invalidatePendingWork()
    }

    public mutating func invalidatePendingWork() {
        generation &+= 1
    }

    public mutating func stop() {
        stopped = true
        state = .stopped
        invalidatePendingWork()
    }

    public func allowsObservation(parentAlive: Bool, generation: UInt64? = nil) -> Bool {
        !stopped && state == .running && parentAlive &&
            (generation == nil || generation == self.generation)
    }

    /// Boundaries never carry observed context, including shutdown while paused.
    public func eventForPersistence(
        _ event: HistoryEvent,
        parentAlive: Bool,
        generation: UInt64? = nil
    ) -> HistoryEvent? {
        if event.kind == .sessionStarted || event.kind == .sessionEnded {
            return event.persistenceIdentity
        }
        return allowsObservation(parentAlive: parentAlive, generation: generation) ? event : nil
    }

    private static func requestedState(
        _ control: RecorderControlRequest?,
        now: Date
    ) -> RecorderState? {
        guard let control else { return nil }
        if control.state == .paused, let resumeAt = control.resumeAt, resumeAt <= now {
            return .running
        }
        return control.state
    }
}
