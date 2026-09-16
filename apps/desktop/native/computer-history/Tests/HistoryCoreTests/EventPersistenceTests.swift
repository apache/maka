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

final class EventPersistenceTests: XCTestCase {
    private let timestamp = Date(timeIntervalSince1970: 1_700_000_000)

    func testDefaultDeniedWebsitesDoNotSuppressAdmittedLocalAppCapture() throws {
        for text in [false, true] {
            let policy = ObservationPolicy(observation: .init(
                defaultApplicationBehavior: .doNotObserve,
                defaultURLBehavior: .doNotObserve,
                allowlist: [.init(scope: .application, bundleID: "test.editor")]), captureText: text)
            let app = EventStreamApp(name: "Editor", secureInput: false,
                processIdentifier: nil, bundleIdentifier: "test.editor")
            let window = EventStreamWindow(title: "Local table", url: nil, windowID: nil)
            let item = EventStreamAXElement(role: "AXRow", subrole: nil, title: nil,
                description: nil, value: "CONTENT_SELECTED_ROW", placeholder: nil, identifier: nil)
            XCTAssertTrue(policy.allowsObservation(app: app, window: window, element: item))
            let selection = EventStreamSelection(target: nil, selectedText: nil,
                selectedRange: nil, selectedItems: [item])
            let event = HistoryEvent(id: 1, timestamp: timestamp, kind: .selectionChanged,
                app: app, window: window, selection: selection,
                ax: .init(mode: .fullTree, text: "CONTENT_LOCAL_BODY", truncated: false),
                sourceId: "local-window", contentState: text ? .available : .metadataOnly,
                contentDomains: [])
            let retained = try persist([event], policy: policy)
            XCTAssertEqual(retained.events.count, 1)
            XCTAssertEqual(retained.events.first?.selection?.selectedItems.map(\.role), ["AXRow"])
            XCTAssertEqual(retained.jsonl.contains("CONTENT_"), text)
            XCTAssertTrue(retained.suppressed.isEmpty)

            let remote = HistoryEvent(id: 2, timestamp: timestamp, kind: .uiChanged,
                app: app, window: window, ax: event.ax,
                sourceId: "local-window", contentState: .available,
                contentDomains: ["denied.example"])
            let blocked = try persist([remote], policy: policy)
            XCTAssertTrue(blocked.events.isEmpty)
            XCTAssertFalse(blocked.jsonl.contains("CONTENT_"))
            assertOnlyIdentity(blocked.suppressed, from: [remote])
            XCTAssertFalse(policy.allowsObservation(app: app,
                window: .init(title: "Remote table", url: "https://denied.example", windowID: nil),
                element: item))
        }
    }

    func testTextOffRemovesEveryContentSurfaceForEveryKindAndAXMode() throws {
        for mode in [EventStreamAXTree.Mode.fullTree, .diffFromPrevious] {
            let events = HistoryEventKind.allCases.map { fixture(kind: $0, mode: mode) }
            let result = try persist(events, policy: ObservationPolicy(captureText: false))
            XCTAssertEqual(result.events.count, events.count)
            XCTAssertFalse(result.jsonl.contains("CONTENT_"))
            XCTAssertTrue(result.suppressed.isEmpty)
            for (event, stored) in zip(events, result.events) {
                XCTAssertEqual(stored.id, event.id)
                XCTAssertEqual(stored.timestamp, event.timestamp)
                XCTAssertEqual(stored.kind, event.kind)
                XCTAssertEqual(stored.app, event.app)
                XCTAssertEqual(stored.window?.title, event.window?.title)
                XCTAssertEqual(stored.window?.windowID, event.window?.windowID)
                XCTAssertEqual(stored.window?.url, "https://window.example.com")
                XCTAssertEqual(stored.mouse?.button, "left")
                XCTAssertEqual(stored.mouse?.clickCount, 2)
                XCTAssertEqual(stored.mouse?.modifiers, ["shift"])
                XCTAssertEqual(stored.keyboard?.modifiers, ["option"])
                XCTAssertNil(stored.keyboard?.text)
                XCTAssertNil(stored.keyboard?.keyEquivalent)
                XCTAssertNil(stored.selection?.selectedText)
                XCTAssertNil(stored.selection?.truncated)
                XCTAssertEqual(stored.selection?.selectedRange, event.selection?.selectedRange)
                XCTAssertNil(stored.ax)
                XCTAssertNil(stored.diagnostic)
                for (endpoint, original) in [
                    (stored.mouse?.origin, event.mouse?.origin),
                    (stored.mouse?.destination, event.mouse?.destination),
                ] {
                    XCTAssertEqual(endpoint?.app, original?.app)
                    XCTAssertEqual(endpoint?.window?.title, original?.window?.title)
                    XCTAssertEqual(endpoint?.window?.windowID, original?.window?.windowID)
                }
                XCTAssertEqual(stored.mouse?.origin?.window?.url, "https://origin.example.com")
                XCTAssertEqual(stored.mouse?.destination?.window?.url, "https://destination.example.com")
                let elements = [
                    stored.mouse?.target,
                    stored.mouse?.origin?.element,
                    stored.mouse?.destination?.element,
                    stored.keyboard?.target,
                    stored.selection?.target,
                ] + (stored.selection?.selectedItems ?? []).map(Optional.some)
                XCTAssertEqual(elements.count, 7)
                for element in elements {
                    let element = try XCTUnwrap(element)
                    XCTAssertEqual(element.role, "AXTextArea")
                    XCTAssertEqual(element.subrole, "AXStandard")
                    XCTAssertNil(element.title)
                    XCTAssertNil(element.description)
                    XCTAssertNil(element.value)
                    XCTAssertNil(element.placeholder)
                    XCTAssertNil(element.identifier)
                }
            }
        }
    }

    func testTextOnRetainsAllOrdinaryContentForEveryKindAndAXMode() throws {
        for mode in [EventStreamAXTree.Mode.fullTree, .diffFromPrevious] {
            let events = HistoryEventKind.allCases.map { fixture(kind: $0, mode: mode) }
            let result = try persist(events, policy: ObservationPolicy(captureText: true))
            XCTAssertEqual(result.events, events)
            XCTAssertTrue(result.suppressed.isEmpty)
        }
    }

    func testSecureFlagsAndNestedSecureElementsSuppressWithEitherTextSetting() throws {
        for captureText in [false, true] {
            let events = ["app", "origin", "destination"].map { fixture(secureApp: $0) }
                + ["mouse", "keyboard", "selection", "origin", "destination", "item", "otherItem"]
                    .map { fixture(secureElement: $0) }
            let result = try persist(events, policy: ObservationPolicy(captureText: captureText))
            XCTAssertTrue(result.events.isEmpty)
            assertOnlyIdentity(result.suppressed, from: events)
            XCTAssertFalse(result.jsonl.contains("CONTENT_"))
        }
    }

    func testPrivateAndBlockedDragContextsSuppressWithEitherTextSetting() throws {
        for captureText in [false, true] {
            let privateEvents = ["window", "origin", "destination"].map { fixture(privateWindow: $0) }
            let result = try persist(
                privateEvents,
                policy: ObservationPolicy(captureText: captureText)
            )
            XCTAssertTrue(result.events.isEmpty)
            assertOnlyIdentity(result.suppressed, from: privateEvents)

            for context in ["window", "origin", "destination"] {
                let policy = ObservationPolicy(
                    observation: .init(blocklist: [
                        .init(scope: .url, urlDomain: "\(context).example.com"),
                    ]),
                    captureText: captureText
                )
                let event = fixture()
                let blocked = try persist([event], policy: policy)
                XCTAssertTrue(blocked.events.isEmpty, context)
                assertOnlyIdentity(blocked.suppressed, from: [event])
            }
            let blockedApp = try persist(
                [fixture()],
                policy: ObservationPolicy(
                    observation: .init(blocklist: [
                        .init(scope: .application, bundleID: "com.google.Chrome"),
                    ]),
                    captureText: captureText
                )
            )
            XCTAssertTrue(blockedApp.events.isEmpty)
            assertOnlyIdentity(blockedApp.suppressed, from: [fixture()])
        }
    }

    func testSuppressedSessionBoundariesRetainOnlyIdentity() throws {
        for captureText in [false, true] {
            let events: [HistoryEvent] = [.sessionStarted, .sessionEnded].flatMap { kind in
                [
                    fixture(kind: kind, secureApp: "app"),
                    fixture(kind: kind, secureElement: "origin"),
                    fixture(kind: kind, privateWindow: "window"),
                ]
            }
            let result = try persist(events, policy: ObservationPolicy(captureText: captureText))
            assertOnlyIdentity(result.events, from: events)
            XCTAssertTrue(result.suppressed.isEmpty)
            XCTAssertFalse(result.jsonl.contains("CONTENT_"))
        }
    }

    func testTextOffOmitsNonWebAndUnparseableURLsWithoutRawFallback() throws {
        let urls = [
            "file:///Users/CONTENT_local/document",
            "CONTENT_unparseable",
            "https:///CONTENT_missing_host",
            "https://[CONTENT_invalid_host",
        ]
        let events = urls.map {
            HistoryEvent(
                id: 1,
                timestamp: timestamp,
                kind: .windowChanged,
                window: EventStreamWindow(title: "Document", url: $0, windowID: nil)
            )
        }
        let result = try persist(events, policy: ObservationPolicy(captureText: false))
        XCTAssertEqual(result.events.count, events.count)
        XCTAssertTrue(result.events.allSatisfy { $0.window?.url == nil })
        XCTAssertFalse(result.jsonl.contains("CONTENT_"))
    }

    func testExplicitSuppressionNeverWritesContentEvenWithDebugPersistenceEnabled() throws {
        let event = fixture()
        let result = try persist(
            [event],
            policy: ObservationPolicy(captureText: true),
            explicitlySuppressed: true
        )
        XCTAssertTrue(result.events.isEmpty)
        assertOnlyIdentity(result.suppressed, from: [event])
        XCTAssertFalse(result.jsonl.contains("CONTENT_"))
    }

    func testRichMarkersAndContributingDomainsSurviveOnlyPermittedContentPersistence() throws {
        for state in [HistoryEvent.ContentState.available, .metadataOnly, .unavailable] {
            let event = HistoryEvent(id: 1, timestamp: timestamp, kind: .uiChanged,
                app: .init(name: "Editor", secureInput: false, processIdentifier: nil, bundleIdentifier: "test.editor"),
                ax: .init(mode: .fullTree, text: "CONTENT_WEBVIEW", truncated: true),
                sourceId: UUID().uuidString.lowercased(), contentState: state,
                contentDomains: ["embedded.example", "owner.example"])
            let allowed = try persist([event], policy: .init(captureText: true))
            if state == .available {
                XCTAssertEqual(allowed.events, [event])
            } else {
                XCTAssertNil(allowed.events.first?.ax)
                XCTAssertNil(allowed.events.first?.contentDomains)
                XCTAssertFalse(allowed.jsonl.contains("CONTENT_"))
            }
            let textOff = try persist([event], policy: .init(captureText: false))
            XCTAssertEqual(textOff.events.first?.sourceId, event.sourceId)
            XCTAssertNil(textOff.events.first?.contentDomains)
            XCTAssertNil(textOff.events.first?.ax)
            let blocked = try persist([event], policy: .init(observation: .init(
                blocklist: [.init(scope: .url, urlDomain: "embedded.example")]), captureText: true))
            XCTAssertTrue(blocked.events.isEmpty)
            assertOnlyIdentity(blocked.suppressed, from: [event])
            XCTAssertFalse(blocked.jsonl.contains("embedded.example"))
            XCTAssertFalse(blocked.jsonl.contains("CONTENT_"))
        }
    }

    private func assertOnlyIdentity(
        _ stored: [HistoryEvent],
        from originals: [HistoryEvent],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(stored.count, originals.count, file: file, line: line)
        for (event, original) in zip(stored, originals) {
            XCTAssertEqual(
                event,
                HistoryEvent(id: original.id, timestamp: original.timestamp, kind: original.kind),
                file: file,
                line: line
            )
        }
    }

    private func fixture(
        kind: HistoryEventKind = .terminalValueChanged,
        mode: EventStreamAXTree.Mode = .fullTree,
        secureApp: String? = nil,
        secureElement: String? = nil,
        privateWindow: String? = nil
    ) -> HistoryEvent {
        func app(_ location: String) -> EventStreamApp {
            EventStreamApp(
                name: "Browser \(location)",
                secureInput: secureApp == location,
                processIdentifier: 42,
                bundleIdentifier: "com.google.Chrome"
            )
        }
        func window(_ location: String) -> EventStreamWindow {
            EventStreamWindow(
                title: privateWindow == location ? "New Incognito Tab" : "Document \(location)",
                url: "https://CONTENT_user:CONTENT_password@\(location).example.com:8443"
                    + "/CONTENT_document?query=CONTENT_search#CONTENT_fragment",
                windowID: 123
            )
        }
        func element(_ location: String) -> EventStreamAXElement {
            EventStreamAXElement(
                role: "AXTextArea",
                subrole: secureElement == location ? "AXSecureTextField" : "AXStandard",
                title: "CONTENT_\(location)_title",
                description: "CONTENT_\(location)_description",
                value: "CONTENT_\(location)_value",
                placeholder: "CONTENT_\(location)_placeholder",
                identifier: "CONTENT_\(location)_identifier"
            )
        }
        return HistoryEvent(
            id: 7,
            timestamp: timestamp,
            kind: kind,
            app: app("app"),
            window: window("window"),
            mouse: EventStreamMouseInteraction(
                button: "left",
                clickCount: 2,
                modifiers: ["shift"],
                target: element("mouse"),
                origin: EventStreamMouseDragEndpoint(
                    app: app("origin"), window: window("origin"), element: element("origin")
                ),
                destination: EventStreamMouseDragEndpoint(
                    app: app("destination"), window: window("destination"), element: element("destination")
                )
            ),
            keyboard: EventStreamKeyboardInteraction(
                text: "CONTENT_typed_or_terminal",
                keyEquivalent: "CONTENT_key",
                modifiers: ["option"],
                target: element("keyboard")
            ),
            selection: EventStreamSelection(
                target: element("selection"),
                selectedText: "CONTENT_selected",
                selectedRange: EventStreamTextRange(location: 4, length: 20),
                selectedItems: [element("item"), element("otherItem")],
                truncated: true
            ),
            ax: EventStreamAXTree(
                mode: mode,
                text: "AXWindow title=\"CONTENT_ax_title\"\n  AXTextArea value=\"CONTENT_ax_value\""
            ),
            diagnostic: EventStreamDiagnostic(message: "CONTENT_diagnostic")
        )
    }

    private func persist(
        _ events: [HistoryEvent],
        policy: ObservationPolicy,
        explicitlySuppressed: Bool = false
    ) throws -> (events: [HistoryEvent], suppressed: [HistoryEvent], jsonl: String) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try SegmentStore(homeURL: root, now: timestamp, persistSuppressedEvents: true)
        for event in events {
            if explicitlySuppressed {
                try store.appendSuppressed(event)
            } else {
                try store.append(event, policy: policy)
            }
        }
        try store.finish(reason: "test", now: timestamp)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        func read(_ url: URL) throws -> (events: [HistoryEvent], text: String) {
            let text = try String(contentsOf: url, encoding: .utf8)
            let events = try text.split(whereSeparator: \.isNewline).map {
                try decoder.decode(HistoryEvent.self, from: Data($0.utf8))
            }
            return (events, text)
        }
        let recorded = try read(store.eventsURL)
        let suppressed = try read(XCTUnwrap(store.suppressedEventsURL))
        let metadata = try decoder.decode(SegmentMetadata.self, from: Data(contentsOf: store.metadataURL))
        XCTAssertEqual(metadata.eventCount, recorded.events.count)
        XCTAssertEqual(metadata.suppressedEventCount, suppressed.events.count)
        XCTAssertEqual(recorded.events.count + suppressed.events.count, events.count)
        return (recorded.events, suppressed.events, recorded.text + suppressed.text)
    }
}
