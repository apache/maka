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

import XCTest
@testable import HistoryCore

final class RecorderLifecycleTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testSavedPausePrecedesObservationAndAllWritesExceptIdentityBoundaries() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let control = RuntimeControlStore(homeURL: root)
        try control.writeControl(.paused)
        var lifecycle = RecorderLifecycle(control: control.readControl(), now: now)
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true))
        try assertPersistence(lifecycle, root: root)
        lifecycle.stop()
        try assertPersistence(lifecycle, root: root)
    }

    func testPauseResumeCannotReviveDelayedCallbacksOrCapturedEvents() {
        var lifecycle = RecorderLifecycle(control: nil)
        let pendingGeneration = lifecycle.generation
        let event = contentEvent(.selectionChanged)
        XCTAssertNotNil(lifecycle.eventForPersistence(event, parentAlive: true))
        lifecycle.reconcile(.init(state: .paused, updatedAt: now))
        XCTAssertNil(lifecycle.eventForPersistence(event, parentAlive: true))
        let resumed = RecorderControlRequest(state: .running, updatedAt: now.addingTimeInterval(1))
        lifecycle.reconcile(resumed)
        XCTAssertTrue(lifecycle.allowsObservation(parentAlive: true))
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true, generation: pendingGeneration))
        XCTAssertNil(lifecycle.eventForPersistence(
            event, parentAlive: true, generation: pendingGeneration
        ))
        lifecycle.stop()
        lifecycle.reconcile(.init(state: .running))
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true))
    }

    func testNewControlRequestFencesEvenIfPauseAndResumeOccurredBetweenPolls() {
        var lifecycle = RecorderLifecycle(control: .init(state: .running, updatedAt: now))
        let generation = lifecycle.generation
        let resumed = RecorderControlRequest(state: .running, updatedAt: now.addingTimeInterval(1))
        lifecycle.reconcile(resumed)
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true, generation: generation))
        let current = lifecycle.generation
        lifecycle.reconcile(resumed)
        XCTAssertEqual(lifecycle.generation, current)
        lifecycle.reconcile(.init(state: .running, updatedAt: resumed.updatedAt))
        XCTAssertNotEqual(lifecycle.generation, current)
    }

    func testTimedResumeAndParentLossAndSourceInvalidation() {
        let control = RecorderControlRequest(
            state: .paused, updatedAt: now, resumeAt: now.addingTimeInterval(10)
        )
        var lifecycle = RecorderLifecycle(control: control, now: now)
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true))
        lifecycle.reconcile(control, now: now.addingTimeInterval(10))
        XCTAssertTrue(lifecycle.allowsObservation(parentAlive: true))
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: false))
        XCTAssertNil(lifecycle.eventForPersistence(contentEvent(.keyboardTextInput), parentAlive: false))
        let generation = lifecycle.generation
        lifecycle.invalidatePendingWork()
        XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true, generation: generation))
        XCTAssertTrue(RecorderLifecycle(
            control: control, now: now.addingTimeInterval(11)
        ).allowsObservation(parentAlive: true))
    }

    private func assertPersistence(_ lifecycle: RecorderLifecycle, root: URL) throws {
        let store = try SegmentStore(homeURL: root)
        for kind in HistoryEventKind.allCases {
            if let projected = lifecycle.eventForPersistence(contentEvent(kind), parentAlive: true) {
                try store.append(projected, policy: ObservationPolicy(captureText: true))
            }
        }
        try store.finish(reason: "synthetic")
        let text = try String(contentsOf: store.eventsURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let events = try text.split(separator: "\n").map {
            try decoder.decode(HistoryEvent.self, from: Data($0.utf8))
        }
        XCTAssertEqual(events, [
            HistoryEvent(id: 1, timestamp: now, kind: .sessionStarted),
            HistoryEvent(id: 1, timestamp: now, kind: .sessionEnded),
        ])
        XCTAssertFalse(text.contains("SENSITIVE"))
    }

    private func contentEvent(_ kind: HistoryEventKind) -> HistoryEvent {
        HistoryEvent(
            id: 1, timestamp: now, kind: kind,
            window: .init(title: "SENSITIVE", url: nil, windowID: 1),
            ax: .init(mode: .fullTree, text: "SENSITIVE")
        )
    }
}
