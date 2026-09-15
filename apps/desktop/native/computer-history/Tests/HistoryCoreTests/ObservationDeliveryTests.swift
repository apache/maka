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

final class ObservationDeliveryTests: XCTestCase {
    func testKernelProcessIdentitySurvivesDirectLaunchAndRejectsExitedProcess() throws {
        XCTAssertNil(ObservationProcessIdentity.read(-1))
        XCTAssertNil(ObservationProcessIdentity.read(0))
        let parent = try XCTUnwrap(ObservationProcessIdentity.read(getpid()))
        XCTAssertEqual(parent.pid, getpid())
        XCTAssertEqual(ObservationProcessIdentity.read(getpid()), parent)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        let launched = try XCTUnwrap(ObservationProcessIdentity.read(child.processIdentifier))
        XCTAssertEqual(launched.pid, child.processIdentifier)
        XCTAssertNotEqual(launched, parent)
        XCTAssertEqual(ObservationProcessIdentity.read(child.processIdentifier), launched)
        child.terminate()
        child.waitUntilExit()
        XCTAssertNotEqual(ObservationProcessIdentity.read(child.processIdentifier), launched)
    }

    func testOpaqueWindowIdentityDistinguishesEqualTitlesProcessReuseAndEviction() throws {
        struct Source: Hashable {
            let pid: Int
            let launched: Int
            let windowHandle: Int
        }
        var registry = OpaqueSourceRegistry<Source>(capacity: 2)
        let first = Source(pid: 1, launched: 10, windowHandle: 1)
        let other = Source(pid: 1, launched: 10, windowHandle: 2)
        let reused = Source(pid: 1, launched: 11, windowHandle: 1)
        let id = registry.id(for: first)
        XCTAssertNotNil(UUID(uuidString: id))
        let otherID = registry.id(for: other)
        XCTAssertNotEqual(id, otherID)
        XCTAssertEqual(registry.id(for: first), id)
        XCTAssertNotEqual(registry.id(for: reused), id)
        XCTAssertEqual(registry.id(for: first), id)
        XCTAssertNotEqual(registry.id(for: other), otherID)
        registry.remove { $0 == first }
        XCTAssertNotEqual(registry.id(for: first), id)
    }

    func testNotificationsCoalesceOnlySameSourceAndExpiredObserverCannotConsumeNewWork() throws {
        struct Source: Hashable {
            let window: Int
            let target: Int
            let notification: String
        }
        var callbacks = ObservationCallbacks<Source>()
        let first = Source(window: 1, target: 1, notification: "value")
        let old = try XCTUnwrap(callbacks.admit(first))
        for _ in 0..<1_000 { XCTAssertNil(callbacks.admit(first)) }
        let second = try XCTUnwrap(callbacks.admit(.init(window: 2, target: 1, notification: "value")))
        let third = try XCTUnwrap(callbacks.admit(.init(window: 1, target: 2, notification: "value")))
        XCTAssertTrue(callbacks.take(second))
        XCTAssertTrue(callbacks.take(third))
        XCTAssertTrue(callbacks.take(old))
        XCTAssertFalse(callbacks.take(old))
        _ = callbacks.admit(first)
        callbacks.invalidate()
        let current = try XCTUnwrap(callbacks.admit(first))
        XCTAssertFalse(callbacks.take(old))
        XCTAssertTrue(callbacks.take(current))

        var bounded = ObservationCallbacks<Int>()
        let tokens = (0..<64).compactMap { bounded.admit($0) }
        XCTAssertEqual(tokens.count, 32)
        XCTAssertTrue(bounded.take(tokens[0]))
        XCTAssertNotNil(bounded.admit(64))
        bounded.invalidate()
        XCTAssertFalse(bounded.take(tokens[1]))
    }

    func testFailedAndSuppressedWritesNeverCommitDedupAndRotationRetainsStandaloneSnapshot() throws {
        enum WriteFailure: Error { case failed }
        var delivery = ObservationDelivery()
        let source = UUID().uuidString.lowercased()
        let event = HistoryEvent(id: 1, timestamp: Date(timeIntervalSince1970: 1_700_000_000), kind: .uiChanged,
            app: .init(name: "Editor", secureInput: false, processIdentifier: nil, bundleIdentifier: "test.editor"),
            ax: .init(mode: .fullTree, text: "AXWindow\n  AXStaticText AXValue=\"complete snapshot\"", truncated: false),
            sourceId: source, contentState: .available, contentDomains: [])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let bytes = try encoder.encode(event)
        XCTAssertThrowsError(try delivery.deliver(source: source, fingerprint: bytes) { throw WriteFailure.failed })
        XCTAssertFalse(delivery.deliver(source: source, fingerprint: bytes) { false })

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try SegmentStore(homeURL: root, now: event.timestamp)
        let denied = ObservationPolicy(observation: .init(blocklist: [.init(scope: .application, bundleID: "test.editor")]))
        XCTAssertFalse(try delivery.deliver(source: source, fingerprint: bytes) { try first.append(event, policy: denied) })
        XCTAssertTrue(try delivery.deliver(source: source, fingerprint: bytes) { try first.append(event, policy: .init()) })
        var duplicateWritten = false
        XCTAssertFalse(delivery.deliver(source: source, fingerprint: bytes) { duplicateWritten = true; return true })
        XCTAssertFalse(duplicateWritten)
        try first.finish(reason: "rotation")
        let second = try SegmentStore(homeURL: root, now: event.timestamp.addingTimeInterval(600))
        delivery.reset()
        XCTAssertTrue(try delivery.deliver(source: source, fingerprint: bytes) { try second.append(event, policy: .init()) })
        try second.finish(reason: "test")
        for store in [first, second] {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let data = try Data(contentsOf: store.eventsURL)
            let retained = try decoder.decode(HistoryEvent.self, from: data)
            XCTAssertEqual(retained.ax?.mode, .fullTree)
            XCTAssertEqual(retained.ax?.text, event.ax?.text)
            XCTAssertEqual(retained.sourceId, source)
            XCTAssertEqual(retained.contentDomains, [])
        }
    }

    func testUnavailableMetadataDeduplicatesWhilePendingSensitiveWorkIsCancelled() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
        let store = try SegmentStore(homeURL: root, now: timestamp)
        let app = EventStreamApp(name: "Editor", secureInput: false,
            processIdentifier: nil, bundleIdentifier: "test.editor")
        let source = TextInputSource(app: app, window: nil, element: nil,
            processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
            sourceId: "window", contentState: .available, contentDomains: [])
        let unavailable = HistoryEvent(id: 0, timestamp: timestamp, kind: .uiChanged,
            app: app, sourceId: "window", contentState: .unavailable)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let fingerprint = try encoder.encode(unavailable)
        var delivery = ObservationDelivery()
        var lifecycle = RecorderLifecycle(control: nil)
        var callbacks = ObservationCallbacks<String>()
        var buffer = TextInputBuffer()
        var writes = 0

        for _ in 0..<20 {
            _ = buffer.append(characters: { "PENDING_SECRET" }, source: source, policy: .init())
            let generation = lifecycle.generation
            let callback = try XCTUnwrap(callbacks.admit("window"))
            lifecycle.invalidatePendingWork()
            buffer.discard()
            callbacks.invalidate()
            XCTAssertNil(buffer.drain())
            XCTAssertFalse(callbacks.take(callback))
            XCTAssertFalse(lifecycle.allowsObservation(parentAlive: true, generation: generation))

            _ = try delivery.deliver(source: "window", metadataFingerprint: fingerprint,
                fingerprint: fingerprint, kind: .uiChanged) { kind in
                writes += 1
                return try store.append(HistoryEvent(id: writes, timestamp: timestamp, kind: kind,
                    app: app, sourceId: "window", contentState: .unavailable), policy: .init())
            }
        }

        XCTAssertEqual(writes, 1)
        try store.finish(reason: "test", now: timestamp)
        let data = try Data(contentsOf: store.eventsURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let retained = try decoder.decode(HistoryEvent.self, from: data)
        XCTAssertEqual(retained.kind, .windowChanged)
        XCTAssertEqual(retained.contentState, .unavailable)
        XCTAssertNil(retained.ax)
        XCTAssertNil(retained.keyboard)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("PENDING_SECRET"))
    }

    func testMetadataDeliveryPreservesRecoverySourceChangesResetsAndWriteFailures() throws {
        enum WriteFailure: Error { case failed }
        var delivery = ObservationDelivery()
        var kinds: [HistoryEventKind] = []
        func retain(_ source: String, _ state: HistoryEvent.ContentState, _ content: String) -> Bool {
            delivery.deliver(source: source,
                metadataFingerprint: Data("\(source):\(state.rawValue)".utf8),
                fingerprint: Data(content.utf8), kind: .uiChanged) {
                kinds.append($0)
                return true
            }
        }

        XCTAssertTrue(retain("first", .available, "original"))
        XCTAssertTrue(retain("first", .available, "updated"))
        XCTAssertFalse(retain("first", .available, "updated"))
        XCTAssertTrue(retain("first", .unavailable, "unavailable"))
        XCTAssertFalse(retain("first", .unavailable, "unavailable"))
        XCTAssertTrue(retain("first", .available, "updated"))
        XCTAssertEqual(kinds, [.windowChanged, .uiChanged, .windowChanged, .windowChanged])

        XCTAssertThrowsError(try delivery.deliver(source: "second",
            metadataFingerprint: Data("second:unavailable".utf8),
            fingerprint: Data("unavailable".utf8), kind: .uiChanged) { _ in throw WriteFailure.failed })
        XCTAssertFalse(delivery.deliver(source: "second",
            metadataFingerprint: Data("second:unavailable".utf8),
            fingerprint: Data("unavailable".utf8), kind: .uiChanged) { _ in false })
        XCTAssertFalse(retain("first", .available, "updated"))
        XCTAssertTrue(retain("second", .unavailable, "unavailable"))
        XCTAssertEqual(kinds.last, .windowChanged)
        XCTAssertTrue(retain("first", .available, "updated"))
        XCTAssertEqual(kinds.last, .windowChanged)

        delivery.reset()
        XCTAssertTrue(retain("first", .available, "updated"))
        XCTAssertEqual(kinds.last, .windowChanged)
        XCTAssertTrue(retain("unknown-app", .unavailable, "app-only"))
        XCTAssertFalse(retain("unknown-app", .unavailable, "app-only"))
        delivery.reset()
        XCTAssertTrue(retain("unknown-app", .unavailable, "app-only"))
        XCTAssertEqual(kinds.last, .windowChanged)
    }

    func testSelectionDedupResetsOnDeselectionRotationAndSourceChangesAndRetriesFailedWrites() throws {
        enum WriteFailure: Error { case failed }
        func source(document: String = "https://frame.example/first", field: String = "field") -> TextInputSource {
            TextInputSource(
                app: .init(name: "Browser", secureInput: false, processIdentifier: nil, bundleIdentifier: "com.google.Chrome"),
                window: .init(title: "Same title", url: "https://owner.example", windowID: nil),
                element: nil, processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
                sourceId: "same-window", contentState: .available, contentDomains: ["frame.example", "owner.example"],
                sourcePath: [AnyHashable(field)], documentURLs: [document, "https://owner.example"]
            )
        }
        let selection = EventStreamSelection(target: nil, selectedText: "selected",
            selectedRange: .init(location: 1, length: 8), selectedItems: [])
        let empty = EventStreamSelection(target: nil, selectedText: nil,
            selectedRange: .init(location: 1, length: 0), selectedItems: [])
        var delivery = SelectionDelivery()
        XCTAssertThrowsError(try delivery.deliver(source: source(), selection: selection) { throw WriteFailure.failed })
        XCTAssertFalse(delivery.deliver(source: source(), selection: selection) { false })
        var writes = 0
        let write = { writes += 1; return true }
        XCTAssertTrue(delivery.deliver(source: source(), selection: selection, write: write))
        XCTAssertFalse(delivery.deliver(source: source(), selection: selection, write: write))
        XCTAssertFalse(delivery.deliver(source: source(), selection: empty, write: write))
        XCTAssertTrue(delivery.deliver(source: source(), selection: selection, write: write))
        delivery.reset()
        XCTAssertTrue(delivery.deliver(source: source(), selection: selection, write: write))
        XCTAssertTrue(delivery.deliver(source: source(document: "https://frame.example/second"), selection: selection, write: write))
        XCTAssertTrue(delivery.deliver(source: source(document: "https://frame.example/second", field: "replacement"), selection: selection, write: write))
        XCTAssertEqual(writes, 5)
    }
}
