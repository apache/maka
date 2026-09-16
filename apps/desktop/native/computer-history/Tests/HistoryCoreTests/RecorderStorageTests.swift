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
import ApplicationServices
import CoreGraphics
import XCTest
@testable import HistoryCore
@testable import OpenHistory

final class RecorderStorageTests: XCTestCase {
    private enum Failure: Error { case injected }

    func testNotificationRegistrationResumesBudgetWithoutRepeatingCompletedCalls() throws {
        let fixture = try MouseRecorderFixture()
        defer { fixture.close() }
        let node = AXNode(element: AXUIElementCreateApplication(getpid()))
        var clock = 0.0
        var attempted: [String] = []
        let add: (AXNode, String) -> AXError = { actual, notification in
            XCTAssertEqual(actual, node)
            attempted.append(notification)
            clock += 0.04
            return notification == kAXTitleChangedNotification ? .notificationUnsupported : .success
        }
        fixture.recorder.registerNotifications(on: node, deadline: clock + 0.1, now: { clock }, addNotification: add)
        let first = attempted
        XCTAssertFalse(first.isEmpty)
        XCTAssertFalse(first.contains("AXSelectedRowsChanged"), "The first budget must genuinely expire")
        for _ in 0..<8 {
            fixture.recorder.resumeNotificationRegistrations(now: { clock }, addNotification: add)
        }
        XCTAssertTrue(attempted.contains("AXSelectedChildrenChanged"))
        XCTAssertTrue(attempted.contains("AXSelectedRowsChanged"))
        XCTAssertTrue(attempted.contains("AXSelectedChildrenMoved"))
        XCTAssertEqual(attempted.count, Set(attempted).count, "Completed registrations must not replay")
        let complete = attempted
        fixture.recorder.resumeNotificationRegistrations(now: { clock }, addNotification: add)
        XCTAssertEqual(attempted, complete)
    }

    func testNotificationRegistrationQueuesNodesAfterBudgetAndStopsOnPause() throws {
        let fixture = try MouseRecorderFixture()
        defer { fixture.close() }
        let first = AXNode(element: AXUIElementCreateApplication(getpid()))
        let second = AXNode(element: AXUIElementCreateSystemWide())
        var clock = 0.0
        var attempts: [AXNode: [String]] = [:]
        let add: (AXNode, String) -> AXError = { node, notification in
            attempts[node, default: []].append(notification)
            clock += 0.04
            return .success
        }
        fixture.recorder.registerNotifications(on: first, deadline: 0.1, now: { clock }, addNotification: add)
        fixture.recorder.registerNotifications(on: second, deadline: 0.1, now: { clock }, addNotification: add)
        XCTAssertNil(attempts[second])
        let beforePause = attempts
        try fixture.control.writeControl(.paused)
        fixture.recorder.resumeNotificationRegistrations(now: { clock }, addNotification: add)
        XCTAssertEqual(attempts, beforePause)
        try fixture.control.writeControl(.running)
        for _ in 0..<10 {
            fixture.recorder.resumeNotificationRegistrations(now: { clock }, addNotification: add)
        }
        for node in [first, second] {
            let notifications = try XCTUnwrap(attempts[node])
            XCTAssertTrue(notifications.contains("AXSelectedRowsChanged"))
            XCTAssertEqual(notifications.count, Set(notifications).count)
        }
        fixture.recorder.stop(reason: "synthetic_test")
        let beforeStop = attempts
        fixture.recorder.resumeNotificationRegistrations(now: { clock }, addNotification: add)
        XCTAssertEqual(attempts, beforeStop)
    }

    func testItemSelectionCallbackPreservesOriginalSourceFlagAndPersistsOnlyAdmittedGeneration() throws {
        for text in [false, true] {
            for transition in ["none", "pauseBeforeDispatch", "revisionDuringRead", "observer", "stop"] {
                let fixture = try MouseRecorderFixture(captureText: text)
                defer { fixture.close() }
                let origin = try XCTUnwrap(fixture.snapshot.targetNode)
                let window = try XCTUnwrap(fixture.snapshot.windowNode)
                let item = EventStreamAXElement(role: "AXRow", subrole: nil, title: nil,
                    description: nil, value: "SYNTHETIC_SELECTED_DECISION", placeholder: nil, identifier: nil)
                fixture.snapshot = fixture.makeSnapshot(selectedItems: [item])
                var observed = 0
                var callbacks: [() -> Void] = []
                fixture.onSnapshotRead = { point, actualOrigin, actualWindow, tree, items in
                    observed += 1
                    XCTAssertNil(point)
                    XCTAssertEqual(actualOrigin, origin)
                    XCTAssertEqual(actualWindow, window)
                    XCTAssertFalse(tree)
                    XCTAssertTrue(items, "The reader must receive item-selection intent")
                }
                fixture.recorder.queueSelection(origin: origin, window: window, items: true,
                    isCurrentObserver: { transition != "observer" }, schedule: { callbacks.append($0) })
                XCTAssertEqual(callbacks.count, 1)
                XCTAssertEqual(observed, 0, "Capture is deferred but its origin must be retained")
                switch transition {
                case "pauseBeforeDispatch": try fixture.control.writeControl(.paused)
                case "stop": fixture.recorder.stop(reason: "synthetic_test")
                case "revisionDuringRead":
                    fixture.onRead = { _ in
                        do { try fixture.control.writeControl(.running) }
                        catch { XCTFail("Synthetic revision write failed: \(error)") }
                    }
                default: break
                }
                callbacks[0]()
                callbacks[0]()
                let events = try fixture.allEvents().filter { $0.kind == .selectionChanged }
                XCTAssertEqual(observed, transition == "none" || transition == "revisionDuringRead" ? 1 : 0, transition)
                XCTAssertEqual(events.count, transition == "none" ? 1 : 0, transition)
                if transition == "none" {
                    let retained = try XCTUnwrap(events.first)
                    XCTAssertEqual(retained.sourceId, "synthetic-window")
                    XCTAssertEqual(retained.window?.title, "Synthetic document")
                    XCTAssertEqual(retained.selection?.selectedItems.map(\.role), ["AXRow"])
                    XCTAssertEqual(retained.selection?.selectedItems.first?.value, text ? item.value : nil)
                    XCTAssertEqual(retained.contentState, text ? .available : .metadataOnly)
                    XCTAssertNil(retained.selection?.selectedText)
                    XCTAssertNil(retained.ax)
                }
            }
        }
    }

    func testTimedCompletionRetainsPendingInputOnceBeforeSealing() throws {
        for captureText in [false, true] {
            let fixture = try MouseRecorderFixture(captureText: captureText)
            defer { fixture.close() }
            try fixture.type("SYNTHETIC_LAST_BURST")
            XCTAssertTrue(try fixture.allEvents().isEmpty)
            fixture.recorder.complete()
            let retained = try fixture.allEvents()
            XCTAssertEqual(retained.map(\.kind), [.keyboardTextInput, .sessionEnded])
            XCTAssertEqual(retained.first?.keyboard?.text, captureText ? "SYNTHETIC_LAST_BURST" : nil)
            XCTAssertEqual(retained.first?.sourceId, "synthetic-window")
            XCTAssertTrue(fixture.store.sealed)
            fixture.recorder.complete()
            XCTAssertEqual(try fixture.allEvents(), retained)
        }
    }

    func testTimedCompletionCannotFlushRevokedOrChangedInput() throws {
        for transition in ["pause", "stop", "revisionDuringRead", "source", "secure", "unavailable"] {
            let fixture = try MouseRecorderFixture()
            defer { fixture.close() }
            try fixture.type("SYNTHETIC_REVOKED_BURST")
            switch transition {
            case "pause": try fixture.control.writeControl(.paused)
            case "stop": fixture.recorder.stop(reason: "terminated")
            case "revisionDuringRead":
                fixture.onRead = { read in
                    guard read == .origin else { return }
                    do { try fixture.control.writeControl(.running) }
                    catch { XCTFail("Writing synthetic revision failed: \(error)") }
                }
            case "source": fixture.snapshot = fixture.makeSnapshot(source: "other-window")
            case "secure": fixture.snapshot = fixture.makeSnapshot(secure: true)
            default: fixture.snapshot = fixture.makeSnapshot(state: .unavailable)
            }
            fixture.recorder.complete()
            XCTAssertEqual(try fixture.allEvents().map(\.kind), [.sessionEnded], transition)
            XCTAssertTrue(fixture.store.sealed)
        }
    }

    func testPendingMouseGestureIsClearedByPauseTapLossRotationAndStop() throws {
        for transition in ["pause", "timeout", "disabled", "rotation", "stop", "secondDown", "wrongDrag", "wrongUp"] {
            let fixture = try MouseRecorderFixture()
            defer { fixture.close() }
            try fixture.drag()
            XCTAssertEqual(try fixture.mouseEvents().map(\.kind), [.mouseDrag])
            try fixture.pressAndMove()
            switch transition {
            case "pause":
                try fixture.control.writeControl(.paused)
            case "timeout":
                fixture.recorder.handleEventTap(type: .tapDisabledByTimeout, event: fixture.controlEvent)
            case "disabled":
                fixture.recorder.handleEventTap(type: .tapDisabledByUserInput, event: fixture.controlEvent)
            case "rotation":
                fixture.recorder.rotateSegment()
                XCTAssertTrue(fixture.store.sealed)
            case "stop":
                fixture.recorder.stop(reason: "synthetic_test")
            case "secondDown":
                try fixture.send(.leftMouseDown)
            case "wrongDrag":
                try fixture.send(.rightMouseDragged, button: .right)
            default:
                try fixture.send(.rightMouseUp, button: .right)
            }
            try fixture.send(.leftMouseUp)
            XCTAssertEqual(try fixture.mouseEvents().count, 1, transition)
            if transition == "pause" {
                try fixture.drag()
                XCTAssertEqual(try fixture.mouseEvents().count, 1)
                XCTAssertEqual(fixture.control.readRuntime()?.state, .paused)
                try fixture.control.writeControl(.running)
            }
            try fixture.drag()
            XCTAssertEqual(try fixture.mouseEvents().count, transition == "stop" ? 1 : 2, transition)
        }
    }

    func testUnavailablePressSnapshotCannotRestoreInvalidatedPendingGesture() throws {
        let fixture = try MouseRecorderFixture()
        defer { fixture.close() }
        try fixture.drag()
        fixture.snapshot = fixture.makeSnapshot(state: .unavailable)
        try fixture.pressAndMove()
        fixture.snapshot = fixture.makeSnapshot()
        let reads = fixture.reads.count
        try fixture.send(.leftMouseUp)
        XCTAssertEqual(fixture.reads.count, reads, "An invalidated press must not begin endpoint reads")
        XCTAssertEqual(try fixture.mouseEvents().count, 1)
        try fixture.drag()
        XCTAssertEqual(try fixture.mouseEvents().map(\.kind), [.mouseDrag, .mouseDrag])
    }

    func testMouseUpGenerationChangeBetweenEndpointReadsRejectsOldGestureAndRecovers() throws {
        for captureText in [false, true] {
            for boundary in [MouseRecorderFixture.Read.origin, .destination] {
                let fixture = try MouseRecorderFixture(captureText: captureText)
                defer { fixture.close() }
                try fixture.drag()
                let retained = try fixture.mouseEvents()
                XCTAssertEqual(retained.count, 1)
                XCTAssertEqual(retained.first?.mouse?.origin?.element?.value, captureText ? "SYNTHETIC_BODY" : nil)
                XCTAssertEqual(retained.first?.contentState, captureText ? .available : .metadataOnly)
                var changed = false
                fixture.onRead = { read in
                    guard read == boundary, !changed else { return }
                    changed = true
                    do { try fixture.control.writeControl(.running) }
                    catch { XCTFail("Writing synthetic control revision failed: \(error)") }
                }
                try fixture.drag()
                XCTAssertTrue(changed)
                XCTAssertEqual(fixture.control.readRuntime()?.state, .running)
                XCTAssertEqual(try fixture.mouseEvents(), retained, "\(boundary) must not reacquire the new generation")
                fixture.onRead = nil
                try fixture.drag()
                let recovered = try fixture.mouseEvents()
                XCTAssertEqual(recovered.map(\.kind), [.mouseDrag, .mouseDrag])
                XCTAssertEqual(recovered.last?.sourceId, retained.first?.sourceId)
                XCTAssertEqual(recovered.last?.mouse, retained.first?.mouse)
            }
        }
    }

    func testMouseUpRejectsChangedOriginAndSecureDestinationThenRecovers() throws {
        for secure in [false, true] {
            let fixture = try MouseRecorderFixture()
            defer { fixture.close() }
            try fixture.drag()
            let retained = try fixture.mouseEvents()
            fixture.onRead = { read in
                if read == (secure ? .destination : .origin) {
                    fixture.snapshot = fixture.makeSnapshot(source: secure ? "synthetic-window" : "changed-window",
                        secure: secure)
                }
            }
            try fixture.drag()
            XCTAssertEqual(try fixture.mouseEvents(), retained)
            fixture.onRead = nil
            fixture.snapshot = fixture.makeSnapshot()
            try fixture.drag()
            XCTAssertEqual(try fixture.mouseEvents().count, 2)
        }
    }

    /// Do not start the recorder: shutdown and its runtime contract require no
    /// AX permission, observer, event tap, or personal foreground reads.
    func testActualRecorderStopPublishesFailureAndDoesNotSealOrAppendOnRetry() throws {
        for fails in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let control = RuntimeControlStore(homeURL: root)
            try control.writeControl(.paused)
            var io = SegmentStore.IO()
            io.synchronize = { handle in
                if fails { throw Failure.injected }
                try handle.synchronize()
            }
            let store = try SegmentStore(homeURL: root, io: io)
            let recorder = HistoryRecorder(store: store, policy: .init(), parent: try RecorderParent(expected: getppid()))
            recorder.stop(reason: "synthetic_test")
            let status = try XCTUnwrap(control.readRuntime())
            XCTAssertEqual(status.state, .stopped)
            XCTAssertNil(status.processIdentifier)
            XCTAssertNotNil(status.endedAt)
            XCTAssertEqual(status.lastError, fails ? "storage_failure" : nil)
            XCTAssertEqual(recorder.failure != nil, fails)
            XCTAssertEqual(store.sealed, !fails)
            let bytes = try Data(contentsOf: store.eventsURL)
            let lines = try String(contentsOf: store.eventsURL).split(separator: "\n")
            XCTAssertEqual(lines.count, 1)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let event = try decoder.decode(HistoryEvent.self, from: Data(try XCTUnwrap(lines.first).utf8))
            XCTAssertEqual(event.kind, .sessionEnded)
            XCTAssertNil(event.app)
            XCTAssertNil(event.ax)
            let metadata = try decoder.decode(SegmentMetadata.self, from: Data(contentsOf: store.metadataURL))
            XCTAssertEqual(metadata.endedAt != nil, !fails)
            recorder.stop(reason: "again")
            XCTAssertEqual(try Data(contentsOf: store.eventsURL), bytes)
        }
    }
}

/// Supplies already acquired synthetic snapshots; no AX attributes are queried,
/// events posted, observers installed or native recorder start invoked.
private final class MouseRecorderFixture {
    enum Read { case press, origin, destination }
    let root: URL
    let control: RuntimeControlStore
    let store: SegmentStore
    let controlEvent: CGEvent
    private let window = AXNode(element: AXUIElementCreateSystemWide())
    private let target = AXNode(element: AXUIElementCreateApplication(getpid()))
    var onRead: ((Read) -> Void)?
    var onSnapshotRead: ((CGPoint?, AXNode?, AXNode?, Bool, Bool) -> Void)?
    var reads: [Read] = []
    lazy var snapshot = makeSnapshot()
    private(set) var recorder: HistoryRecorder!

    init(captureText: Bool = true) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        control = RuntimeControlStore(homeURL: root)
        store = try SegmentStore(homeURL: root)
        controlEvent = try XCTUnwrap(CGEvent(source: nil))
        var policy = ObservationPolicy()
        policy.captureText = captureText
        recorder = HistoryRecorder(store: store, policy: policy, parent: try RecorderParent(expected: getppid()),
            snapshotReader: { [unowned self] point, origin, expectedWindow, includeTree, includeItems in
                onSnapshotRead?(point, origin, expectedWindow, includeTree, includeItems)
                let read: Read = origin != nil ? .origin : includeTree ? .destination : .press
                reads.append(read)
                onRead?(read)
                // Like native acquisition, reconcile control at entry and return
                // a snapshot obtained in that revision. This uses the real lifecycle.
                recorder.handleEventTap(type: .flagsChanged, event: controlEvent)
                return snapshot
            }, initialProcessIdentifier: getpid())
    }

    func close() {
        onRead = nil
        onSnapshotRead = nil
        recorder.stop(reason: "synthetic_test")
        try? FileManager.default.removeItem(at: root)
    }

    func makeSnapshot(
        state: HistoryEvent.ContentState = .available, source: String = "synthetic-window", secure: Bool = false,
        selectedItems: [EventStreamAXElement] = []
    ) -> AccessibilitySnapshot {
        AccessibilitySnapshot(
            app: .init(name: "Synthetic", secureInput: false, processIdentifier: nil,
                bundleIdentifier: "org.apache.maka.synthetic-review"),
            window: .init(title: "Synthetic document", url: nil, windowID: nil), sourceId: source,
            windowNode: window, targetNode: target, contentRoot: window,
            element: state == .unavailable ? nil : .init(role: "AXTextField",
                subrole: secure ? "AXSecureTextField" : nil, title: nil, description: nil,
                value: "SYNTHETIC_BODY", placeholder: nil, identifier: "field"),
            selectedText: nil, selectedRange: nil, selectedTextTruncated: nil, ax: nil,
            contentState: state, contentDomains: [], sourcePath: [target, window], documentURLs: [],
            selectedItems: selectedItems, selectedItemNodes: selectedItems.isEmpty ? [] : [target])
    }

    func send(_ type: CGEventType, button: CGMouseButton = .left, point: CGPoint = .zero) throws {
        let event = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: type,
            mouseCursorPosition: point, mouseButton: button))
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        recorder.handleEventTap(type: type, event: event)
    }

    func pressAndMove() throws {
        try send(.leftMouseDown)
        try send(.leftMouseDragged, point: .init(x: 30, y: 40))
        try send(.leftMouseDragged)
    }

    func drag() throws {
        try pressAndMove()
        try send(.leftMouseUp)
    }

    func type(_ text: String) throws {
        let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        let units = Array(text.utf16)
        units.withUnsafeBufferPointer {
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!)
        }
        recorder.handleEventTap(type: .keyDown, event: event)
    }

    func allEvents() throws -> [HistoryEvent] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let segments = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent("segments"), includingPropertiesForKeys: nil)
        return try segments.flatMap { segment in
            try String(contentsOf: segment.appendingPathComponent("events.jsonl")).split(separator: "\n")
                .map { try decoder.decode(HistoryEvent.self, from: Data($0.utf8)) }
        }.sorted { $0.id < $1.id }
    }

    func mouseEvents() throws -> [HistoryEvent] {
        try allEvents().filter { $0.mouse != nil }
    }
}
