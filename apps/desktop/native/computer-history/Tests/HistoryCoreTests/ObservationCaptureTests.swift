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

import ApplicationServices
import XCTest
@testable import HistoryCore

final class ObservationCaptureTests: XCTestCase {
    func testDefaultDeniedWebsitesPersistAdmittedLocalTableWithoutUnsafeSiblingContent() throws {
        for text in [false, true] {
            let policy = localOnlyPolicy(captureText: text)
            let app = EventStreamApp(name: "Local app", secureInput: false,
                processIdentifier: nil, bundleIdentifier: "test.native")
            let ax = fixture(web: false)
            ax.add("table", role: "AXTable", parent: "window", value: "CANARY_AGGREGATE")
            ax.add("row", role: "AXRow", parent: "table", value: "CANARY_AGGREGATE")
            ax.add("label", role: "AXStaticText", parent: "row", value: "LOCAL_SELECTED_FACT")
            ax.selections["table"] = ["AXSelectedRows": ["row"]]
            ax.add("denied", role: "AXWebArea", parent: "window", url: "https://denied.example/private")
            ax.add("deniedText", role: "AXTextArea", parent: "denied", value: "CANARY_DENIED")
            ax.add("unknown", role: "AXWebArea", parent: "window")
            ax.add("unknownText", role: "AXTextArea", parent: "unknown", value: "CANARY_UNKNOWN")
            ax.add("protected", role: "AXGroup", parent: "window", value: "CANARY_PROTECTED")
            ax.roles["protected"] = .init("AXGroup", subrole: "AXSecureTextField")
            ax.add("protectedText", role: "AXTextArea", parent: "protected", value: "CANARY_PROTECTED_CHILD")
            ax.add("password", role: "AXTextField", parent: "window", value: "CANARY_PASSWORD")
            ax.roles["password"] = .init("AXTextField", subrole: "AXPasswordField")
            for node in ["deniedText", "unknownText", "protectedText"] {
                ax.visibleRanges[node] = .range(.init(location: 0, length: 6))
            }
            let observation = try XCTUnwrap(ObservationCapture(access: ax, policy: policy, now: { 0 })
                .capture(app: app, window: "window", target: "table", browser: false,
                    includeTree: true, includeSelectionItems: true))
            XCTAssertEqual(observation.contentState, text ? .available : .metadataOnly)
            XCTAssertEqual(observation.window?.title, "Ordinary document")
            XCTAssertNil(observation.window?.url)
            XCTAssertEqual(observation.selectedItemNodes, ["row"])
            XCTAssertEqual(observation.contentDomains, text ? [] : nil)
            let permittedReads: Set<String> = text ? ["window", "field", "label"] : ["window"]
            XCTAssertTrue(ax.contentReads.allSatisfy { permittedReads.contains($0.node) })
            XCTAssertTrue(ax.rangeReads.isEmpty)

            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
            let store = try SegmentStore(homeURL: root, now: timestamp, persistSuppressedEvents: true)
            XCTAssertTrue(try appendCapturedSelection(observation, app: app, policy: policy,
                store: store, id: 1, timestamp: timestamp))
            try store.finish(reason: "test", now: timestamp)
            let jsonl = try String(contentsOf: store.eventsURL)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let events = try jsonl.split(whereSeparator: \.isNewline).map {
                try decoder.decode(HistoryEvent.self, from: Data($0.utf8))
            }
            XCTAssertEqual(events.count, 1)
            let stored = try XCTUnwrap(events.first)
            XCTAssertEqual(stored.contentState, text ? .available : .metadataOnly)
            XCTAssertEqual(stored.selection?.target?.role, "AXTable")
            XCTAssertEqual(stored.selection?.selectedItems.map(\.role), ["AXRow"])
            XCTAssertEqual(stored.selection?.selectedItems.first?.value?.contains("LOCAL_SELECTED_FACT") == true, text)
            XCTAssertEqual(stored.ax?.text.contains("safe field") == true, text)
            XCTAssertEqual(stored.ax?.truncated, text ? true : nil)
            XCTAssertFalse(jsonl.contains("CANARY"))
            XCTAssertFalse(jsonl.contains("denied.example"))
            XCTAssertEqual(try String(contentsOf: XCTUnwrap(store.suppressedEventsURL)), "")
        }
    }

    func testDefaultDeniedLocalAppUnsafeFocusCannotPersistContentAndSafeFocusRecovers() throws {
        for text in [false, true] {
            for condition in ["deniedWebsite", "unknownWebsite", "protectedAncestor", "password", "secureInput"] {
                let policy = localOnlyPolicy(captureText: text)
                let app = EventStreamApp(name: "Local app", secureInput: condition == "secureInput",
                    processIdentifier: nil, bundleIdentifier: "test.native")
                let ax = fixture(web: false)
                ax.attributes["field"]?["AXValue"] = "CANARY_VALUE"
                ax.attributes["field"]?["AXSelectedText"] = "CANARY_SELECTION"
                ax.roles["field"] = .init("AXTextArea")
                ax.visibleRanges["field"] = .range(.init(location: 0, length: 6))
                switch condition {
                case "deniedWebsite", "unknownWebsite":
                    ax.add("frame", role: "AXWebArea", parent: "window",
                        url: condition == "deniedWebsite" ? "https://denied.example/private" : nil)
                    ax.parents["field"] = "frame"
                    ax.childrenByNode["window"] = ["frame"]
                    ax.childrenByNode["frame"] = ["field"]
                case "protectedAncestor":
                    ax.add("protected", role: "AXGroup", parent: "window")
                    ax.roles["protected"] = .init("AXGroup", subrole: "AXSecureTextField")
                    ax.parents["field"] = "protected"
                    ax.childrenByNode["window"] = ["protected"]
                    ax.childrenByNode["protected"] = ["field"]
                case "password": ax.roles["field"] = .init("AXTextArea", subrole: "AXPasswordField")
                default: break
                }
                let observation = ObservationCapture(access: ax, policy: policy, now: { 0 })
                    .capture(app: app, window: "window", target: "field", browser: false, includeTree: true)
                if condition == "unknownWebsite" {
                    XCTAssertEqual(observation?.contentState, .unavailable)
                    XCTAssertNil(observation?.window)
                    XCTAssertNil(observation?.element)
                    XCTAssertNil(observation?.ax)
                    XCTAssertNil(observation?.selectedText)
                    XCTAssertNil(observation?.contentDomains)
                } else {
                    XCTAssertNil(observation, condition)
                }
                XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" }, condition)
                XCTAssertTrue(ax.rangeReads.isEmpty, condition)

                let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: root) }
                let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
                let store = try SegmentStore(homeURL: root, now: timestamp, persistSuppressedEvents: true)
                // Unknown ownership may retain an unavailable event, never the
                // target or window content. Explicitly denied capture is nil.
                XCTAssertEqual(try appendCapturedSelection(observation, app: app, policy: policy,
                    store: store, id: 1, timestamp: timestamp), condition == "unknownWebsite", condition)
                let safeApp = EventStreamApp(name: "Local app", secureInput: false,
                    processIdentifier: nil, bundleIdentifier: "test.native")
                let safe = try XCTUnwrap(ObservationCapture(access: fixture(web: false), policy: policy, now: { 0 })
                    .capture(app: safeApp, window: "window", target: "field", browser: false, includeTree: true))
                XCTAssertTrue(try appendCapturedSelection(safe, app: safeApp, policy: policy,
                    store: store, id: 2, timestamp: timestamp), condition)
                try store.finish(reason: "test", now: timestamp)
                let jsonl = try String(contentsOf: store.eventsURL)
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                let events = try jsonl.split(whereSeparator: \.isNewline).map {
                    try decoder.decode(HistoryEvent.self, from: Data($0.utf8))
                }
                XCTAssertEqual(events.map(\.id), condition == "unknownWebsite" ? [1, 2] : [2], condition)
                if condition == "unknownWebsite" {
                    XCTAssertEqual(events.first?.contentState, .unavailable)
                    XCTAssertNil(events.first?.window)
                    XCTAssertNil(events.first?.selection?.target)
                    XCTAssertNil(events.first?.ax)
                }
                XCTAssertEqual(events.last?.selection?.target?.role, "AXTextField")
                XCTAssertEqual(events.last?.contentState, text ? .available : .metadataOnly)
                XCTAssertEqual(jsonl.contains("safe field"), text)
                XCTAssertFalse(jsonl.contains("CANARY"), condition)
                XCTAssertFalse(jsonl.contains("denied.example"), condition)
                XCTAssertEqual(try String(contentsOf: XCTUnwrap(store.suppressedEventsURL)), "")
            }
        }
    }

    private func localOnlyPolicy(captureText: Bool) -> ObservationPolicy {
        ObservationPolicy(observation: .init(
            defaultApplicationBehavior: .doNotObserve,
            defaultURLBehavior: .doNotObserve,
            allowlist: [.init(scope: .application, bundleID: "test.native")]),
            captureText: captureText)
    }

    private func appendCapturedSelection(
        _ observation: CapturedObservation<String>?, app: EventStreamApp, policy: ObservationPolicy,
        store: SegmentStore, id: Int, timestamp: Date
    ) throws -> Bool {
        // Match HistoryRecorder's post-capture admission before real store projection.
        guard let observation, policy.allowsObservation(
            app: app, window: observation.window, element: observation.element
        ) else { return false }
        return try store.append(HistoryEvent(id: id, timestamp: timestamp, kind: .selectionChanged,
            app: app, window: observation.window,
            selection: .init(target: observation.element, selectedText: observation.selectedText,
                selectedRange: observation.selectedRange, selectedItems: observation.selectedItems,
                truncated: observation.selectedTextTruncated),
            ax: observation.ax, sourceId: "synthetic-local-window",
            contentState: observation.contentState, contentDomains: observation.contentDomains), policy: policy)
    }

    func testSelectedTextAreaRechecksSourceBetweenVisibleRangeAndTextRead() throws {
        for range in [ObservationVisibleRange.unsupported, .range(.init(location: 4, length: 6))] {
            let ax = itemFixture()
            ax.roles["label"] = .init("AXTextArea")
            ax.visibleRanges["label"] = range
            var changed = false
            ax.onVisibleRangeRead = { node in
                guard node == "label" else { return }
                changed = true
                ax.attributes["document"]?["AXURL"] = "https://blocked.example/private"
            }
            let result = try XCTUnwrap(capture(ax, target: "list",
                includeTree: false, includeSelectionItems: true))
            XCTAssertTrue(changed)
            XCTAssertEqual(result.contentState, .unavailable)
            XCTAssertTrue(result.selectedItems.isEmpty)
            XCTAssertTrue(ax.rangeReads.isEmpty, "Changed source must not reach AXStringForRange")
            XCTAssertFalse(ax.contentReads.contains { $0.node == "label" && $0.attribute == "AXValue" },
                "Unsupported visible range cannot bypass the new source check")
        }
    }

    func testSelectedLeafReadsStopWhenSourceChangesBeforeOrBetweenAttributes() throws {
        for boundary in ["before", "title", "description", "value"] {
            for mutation in ["document", "embeddedDocument", "parent", "secure", "foreign", "membership", "title"] {
                let ax = itemFixture()
                ax.add("frame", role: "AXWebArea", parent: "cell", url: "https://frame.example/item")
                ax.parents["label"] = "frame"
                ax.childrenByNode["cell"] = ["frame"]
                ax.childrenByNode["frame"] = ["label"]
                ax.add("later", role: "AXStaticText", parent: "row", value: "LATER_SECRET")
                ax.attributes["label"]?["AXTitle"] = "EARLY_TITLE"
                ax.attributes["label"]?["AXDescription"] = "EARLY_DESCRIPTION"
                var changed = false
                var readsAtChange = 0
                let change = {
                    guard !changed else { return }
                    changed = true
                    readsAtChange = ax.contentReads.count
                    switch mutation {
                    case "document": ax.attributes["document"]?["AXURL"] = "https://blocked.example/private"
                    case "embeddedDocument": ax.attributes["frame"]?["AXURL"] = "https://blocked.example/private"
                    case "parent": ax.parents["list"] = "otherWindow"
                    case "secure": ax.roles["document"] = .init("AXWebArea", subrole: "AXSecureTextField")
                    case "foreign": ax.foreign.insert("list")
                    case "membership": ax.selections["list"] = [:]
                    default: ax.attributes["window"]?["AXTitle"] = "Incognito"
                    }
                }
                if boundary == "before" {
                    ax.onChildren = { node in
                        if node == "later" { change() }
                    }
                } else {
                    let attribute = ["title": "AXTitle", "description": "AXDescription", "value": "AXValue"][boundary]
                    ax.onRead = { node, key in
                        if node == "label", key == attribute { change() }
                    }
                }
                let result = try XCTUnwrap(capture(ax, target: "list",
                    includeTree: false, includeSelectionItems: true))
                let context = "\(boundary):\(mutation)"
                XCTAssertTrue(changed, context)
                XCTAssertEqual(result.contentState, .unavailable, context)
                XCTAssertTrue(result.selectedItems.isEmpty, context)
                XCTAssertFalse(ax.contentReads.dropFirst(readsAtChange).contains {
                    ["label", "later"].contains($0.node)
                }, "No subsequent content API call after a changed source: \(context)")
            }
        }
        let recovered = try XCTUnwrap(capture(itemFixture(), target: "list",
            includeTree: false, includeSelectionItems: true))
        XCTAssertTrue(recovered.selectedItems.first?.value?.contains("EACCES") == true)
    }

    func testSelectedTextAreaUsesVisibleUTF16SliceWithoutReadingOffscreenValue() throws {
        let ax = itemFixture()
        let prefix = "OFFSCREEN_SECRET" + String(repeating: "\u{1F600}", count: 5_000)
        let tail = "VISIBLE_DECISION \u{1F680} e\u{301}" + String(repeating: "v", count: 600)
        ax.roles["label"] = .init("AXTextArea")
        ax.attributes["label"]?["AXValue"] = prefix + tail
        let visible = EventStreamTextRange(location: prefix.utf16.count, length: tail.utf16.count)
        ax.visibleRanges["label"] = .range(visible)
        let result = try XCTUnwrap(capture(ax, target: "list", includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(result.contentState, .available)
        let value = try XCTUnwrap(result.selectedItems.first?.value)
        XCTAssertTrue(value.contains("VISIBLE_DECISION \u{1F680} e\u{301}"))
        XCTAssertFalse(value.contains("OFFSCREEN_SECRET"))
        XCTAssertFalse(value.contains(String(repeating: "v", count: 513)))
        XCTAssertTrue(value.contains("[partial]"))
        XCTAssertEqual(ax.rangeReads.first?.range, visible)
        XCTAssertFalse(ax.contentReads.contains { $0.node == "label" && $0.attribute == "AXValue" })
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(result.selectedItems).count, 8_192)

        ax.rangeReads.removeAll()
        ax.contentReads.removeAll()
        let metadata = try XCTUnwrap(capture(ax, text: false, target: "list",
            includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(metadata.contentState, .metadataOnly)
        XCTAssertEqual(metadata.selectedItems.map(\.role), ["AXRow"])
        XCTAssertNil(metadata.selectedItems.first?.value)
        XCTAssertTrue(ax.rangeReads.isEmpty)
        XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" })
    }

    func testSelectedTextAreaRejectsUnavailableOrChangedVisibleRangeWithoutFallback() throws {
        for mutation in ["unavailable", "duringRead", "laterSibling"] {
            let ax = itemFixture()
            ax.roles["label"] = .init("AXTextArea")
            ax.attributes["label"]?["AXValue"] = "SECRET_PREFIX_VISIBLE"
            ax.visibleRanges["label"] = mutation == "unavailable" ? .unavailable
                : .range(.init(location: 14, length: 7))
            var changed = false
            let change = {
                changed = true
                ax.visibleRanges["label"] = .range(.init(location: 0, length: 7))
            }
            if mutation == "duringRead" { ax.onRangeRead = { _ in change() } }
            if mutation == "laterSibling" {
                ax.add("later", role: "AXStaticText", parent: "row", value: "LATER")
                ax.onRead = { node, attribute in
                    if node == "later", attribute == "AXValue" { change() }
                }
            }
            let result = try XCTUnwrap(capture(ax, target: "list",
                includeTree: false, includeSelectionItems: true))
            XCTAssertEqual(changed, mutation != "unavailable", mutation)
            XCTAssertEqual(result.contentState, .unavailable, mutation)
            XCTAssertTrue(result.selectedItems.isEmpty, mutation)
            XCTAssertNil(result.element, mutation)
            XCTAssertNil(result.contentDomains, mutation)
            XCTAssertFalse(ax.contentReads.contains { $0.node == "label" && $0.attribute == "AXValue" }, mutation)
        }
    }

    func testSelectedRowsRetainOwnedLeafFactsWithoutAggregateParentReads() throws {
        let ax = itemFixture()
        let result = try XCTUnwrap(capture(ax, target: "list", includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(result.contentState, .available)
        XCTAssertEqual(result.selectedItemNodes, ["row"])
        XCTAssertEqual(result.selectedItems.count, 1)
        XCTAssertTrue(result.selectedItems.first?.value?.contains("build-42 failed EACCES") == true)
        XCTAssertFalse(result.selectedItems.first?.value?.contains("UNSELECTED") == true)
        XCTAssertFalse(ax.contentReads.contains { ["list", "row", "cell", "unselected"].contains($0.node) })
        XCTAssertEqual(result.contentDomains, ["owner.example"])
        XCTAssertNil(result.selectedText)
        XCTAssertNil(result.selectedRange)
    }

    func testSelectedChildrenMetadataKeepsMembershipWithoutReadingLabels() throws {
        let ax = itemFixture()
        ax.selections["list"] = ["AXSelectedChildren": ["row"], "AXSelectedRows": ["row"]]
        let result = try XCTUnwrap(capture(ax, text: false, target: "list",
            includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(result.contentState, .metadataOnly)
        XCTAssertEqual(result.selectedItemNodes, ["row"])
        XCTAssertEqual(result.selectedItems.map(\.role), ["AXRow"])
        XCTAssertNil(result.selectedItems.first?.value)
        XCTAssertNil(result.contentDomains)
        XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" })
        ax.selectionReads.removeAll()
        _ = capture(ax, target: "list", includeTree: false)
        XCTAssertTrue(ax.selectionReads.isEmpty, "Ordinary snapshots must not enumerate selected items")
    }

    func testSelectedArrayReadRequiresConfirmedEmptyAndUsesBoundedRequestedAttribute() {
        let node = AXUIElementCreateSystemWide()
        for attribute in ["AXSelectedRows", "AXSelectedChildren"] {
            for count in [0, 1, 33] {
                var countRead = false
                let values = AXChildrenReader.read(node, attribute: attribute as CFString,
                    limit: 33, withinBudget: { true }, copyValues: { _, key, start, limit, _ in
                        XCTAssertEqual(key as String, attribute)
                        XCTAssertEqual(start, 0)
                        XCTAssertEqual(limit, 33)
                        return .illegalArgument
                    }, valueCount: { _, key, output in
                        XCTAssertEqual(key as String, attribute)
                        countRead = true
                        output.pointee = count
                        return .success
                    })
                XCTAssertTrue(countRead)
                XCTAssertEqual(values?.count, count == 0 ? 0 : nil)
            }
            for failure in [AXError.cannotComplete, .invalidUIElement, .failure] {
                XCTAssertNil(AXChildrenReader.read(node, attribute: attribute as CFString,
                    limit: 33, withinBudget: { true }, copyValues: { _, _, _, _, _ in failure }))
            }
        }
    }

    func testSelectedItemAdmissionRejectsForeignSecureUnknownAndDeniedSourcesBeforeLabels() {
        for text in [false, true] {
            for condition in ["foreign", "otherWindow", "nestedWindow", "secure", "secureChild", "blocked",
                "unknownDocument", "unreadable", "duplicate", "tooMany", "notImmediateChild"] {
                let ax = itemFixture()
                switch condition {
                case "foreign": ax.foreign.insert("label")
                case "otherWindow": ax.parents["row"] = "otherWindow"
                case "nestedWindow": ax.roles["cell"] = .init("AXWindow")
                case "secure": ax.roles["row"] = .init("AXRow", subrole: "AXSecureTextField")
                case "secureChild": ax.add("password", role: "AXSecureTextField", parent: "row", value: "SECRET")
                case "blocked", "unknownDocument":
                    ax.add("frame", role: "AXWebArea", parent: "row",
                        url: condition == "blocked" ? "https://blocked.example" : nil)
                    ax.add("secret", role: "AXStaticText", parent: "frame", value: "SECRET")
                case "unreadable": ax.unreadableSelection.insert("list")
                case "duplicate": ax.selections["list"] = ["AXSelectedRows": ["row", "row"]]
                case "tooMany": ax.selections["list"] = ["AXSelectedRows": (0..<33).map { "row\($0)" }]
                default: ax.selections["list"] = ["AXSelectedChildren": ["label"]]
                }
                let result = capture(ax, text: text, target: "list", includeTree: false, includeSelectionItems: true)
                XCTAssertEqual(result?.contentState, .unavailable, condition)
                XCTAssertTrue(result?.selectedItems.isEmpty == true, condition)
                XCTAssertTrue(result?.selectedItemNodes.isEmpty == true, condition)
                XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" }, condition)
            }
        }
    }

    func testSelectedItemFinalRevalidationRejectsMutationAfterLeafReadAndRecovers() throws {
        for mutation in ["membership", "parent", "secure", "foreign", "newChild", "document", "title"] {
            let ax = itemFixture()
            ax.add("frame", role: "AXWebArea", parent: "row", url: "https://frame.example/item")
            ax.add("frameLabel", role: "AXStaticText", parent: "frame", value: "FRAME_SELECTED")
            var changed = false
            ax.onRead = { node, attribute in
                guard node == "label", attribute == "AXValue", !changed else { return }
                changed = true
                switch mutation {
                case "membership": ax.selections["list"] = [:]
                case "parent": ax.parents["cell"] = "unselected"
                case "secure": ax.roles["row"] = .init("AXRow", subrole: "AXSecureTextField")
                case "foreign": ax.foreign.insert("row")
                case "newChild": ax.add("laterPassword", role: "AXSecureTextField", parent: "row", value: "SECRET")
                case "document": ax.attributes["frame"]?["AXURL"] = "https://blocked.example"
                default: ax.attributes["window"]?["AXTitle"] = "Changed window"
                }
            }
            let result = try XCTUnwrap(capture(ax, target: "list", includeTree: false, includeSelectionItems: true))
            XCTAssertTrue(changed, mutation)
            XCTAssertEqual(result.contentState, .unavailable, mutation)
            XCTAssertTrue(result.selectedItems.isEmpty, mutation)
            XCTAssertNil(result.contentDomains, mutation)
            XCTAssertNil(result.element, mutation)
            let restored = try XCTUnwrap(capture(itemFixture(), target: "list", includeTree: false, includeSelectionItems: true))
            XCTAssertEqual(restored.selectedItemNodes, ["row"])
            XCTAssertTrue(restored.selectedItems.first?.value?.contains("EACCES") == true)
        }
    }

    func testSelectedMembershipAndMetadataCannotChangeDuringRead() {
        for mutation in ["membership", "secure", "parent", "unreadable"] {
            let ax = itemFixture()
            var changed = false
            ax.onSelectionRead = { node, attribute in
                guard attribute == "AXSelectedRows", !changed else { return }
                changed = true
                switch mutation {
                case "membership": ax.selections[node] = [:]
                case "secure": ax.roles["row"] = .init("AXSecureTextField")
                case "parent": ax.parents["row"] = "otherWindow"
                default: ax.unreadableSelection.insert(node)
                }
            }
            let result = capture(ax, text: false, target: "list", includeTree: false, includeSelectionItems: true)
            XCTAssertTrue(changed)
            XCTAssertEqual(result?.contentState, .unavailable, mutation)
            XCTAssertTrue(result?.selectedItems.isEmpty == true)
            XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" })
        }
    }

    func testSelectedItemsKeepAllMembershipWithinEncodedBudgetAndBoundTraversal() throws {
        let ax = itemFixture()
        var selected: [String] = []
        for index in 0..<32 {
            let row = "selected\(index)"
            selected.append(row)
            ax.add(row, role: "AXRow", parent: "list")
            ax.add("label\(index)", role: "AXStaticText", parent: row,
                value: "TASK\(index) " + String(repeating: "\"\\\n\u{1F680}", count: 1_000))
        }
        ax.selections["list"] = ["AXSelectedRows": selected]
        let result = try XCTUnwrap(capture(ax, target: "list", includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(result.contentState, .available)
        XCTAssertEqual(result.selectedItemNodes, selected)
        XCTAssertEqual(result.selectedItems.count, 32)
        XCTAssertLessThanOrEqual(try JSONEncoder().encode(result.selectedItems).count, 8_192)
        for index in 0..<32 {
            XCTAssertTrue(result.selectedItems[index].value?.contains("TASK\(index) ") == true)
            XCTAssertFalse(result.selectedItems[index].value?.contains("\u{FFFD}") == true)
        }
        for index in 0..<129 {
            ax.add("wide\(index)", role: "AXStaticText", parent: "row", value: "DO_NOT_READ")
        }
        ax.selections["list"] = ["AXSelectedRows": ["row"]]
        ax.contentReads.removeAll()
        let oversized = capture(ax, target: "list", includeTree: false, includeSelectionItems: true)
        XCTAssertEqual(oversized?.contentState, .unavailable)
        XCTAssertTrue(ax.contentReads.allSatisfy { $0.node == "window" })
        var clock = 0.0
        let timed = itemFixture()
        timed.onSelectionRead = { _, _ in clock = 1 }
        let expired = capture(timed, target: "list", includeTree: false,
            includeSelectionItems: true, now: { clock })
        XCTAssertEqual(expired?.contentState, .unavailable)
        XCTAssertTrue(timed.contentReads.allSatisfy { $0.node == "window" })
    }

    func testSelectedItemDomainUnionAndMetadataAreEnforcedAtPersistence() throws {
        let ax = itemFixture()
        ax.add("frame", role: "AXWebArea", parent: "row", url: "https://frame.example/item")
        ax.add("frameLabel", role: "AXStaticText", parent: "frame", value: "FRAME_SELECTED")
        let result = try XCTUnwrap(capture(ax, target: "list", includeTree: false, includeSelectionItems: true))
        XCTAssertEqual(result.contentDomains, ["frame.example", "owner.example"])
        XCTAssertTrue(result.selectedItems.first?.value?.contains("FRAME_SELECTED") == true)
        let event = HistoryEvent(id: 1, timestamp: Date(), kind: .selectionChanged,
            app: .init(name: "Browser", secureInput: false, processIdentifier: nil, bundleIdentifier: "com.google.Chrome"),
            window: result.window,
            selection: .init(target: result.element, selectedText: nil, selectedRange: nil, selectedItems: result.selectedItems),
            sourceId: "synthetic-window", contentState: result.contentState, contentDomains: result.contentDomains)
        let permitted = try XCTUnwrap(ObservationPolicy().eventForPersistence(event))
        XCTAssertEqual(permitted.selection?.selectedItems, result.selectedItems)
        let blocked = ObservationPolicy(observation: .init(blocklist: [.init(scope: .url, urlDomain: "frame.example")]))
        XCTAssertNil(blocked.eventForPersistence(event))
        let metadata = try XCTUnwrap(ObservationPolicy(captureText: false).eventForPersistence(event))
        XCTAssertEqual(metadata.selection?.selectedItems.map(\.role), ["AXRow"])
        XCTAssertNil(metadata.selection?.selectedItems.first?.value)
        XCTAssertNil(metadata.contentDomains)
    }

    func testSelectionRangeMutationCannotRetainMismatchedTextOrOffsets() {
        for includeTree in [false, true] {
            for text in [false, true] {
                for mutation in ["move", "clear", "unavailable", "becomesAvailable"] {
                    let ax = fixture()
                    let original = EventStreamTextRange(location: 4, length: 8)
                    ax.selectedRanges["field"] = mutation == "becomesAvailable" ? nil : original
                    var changed = false
                    ax.onSelectedRangeRead = { node in
                        guard node == "field", !changed else { return }
                        changed = true
                        switch mutation {
                        case "move": ax.selectedRanges[node] = .init(location: 20, length: 3)
                        case "clear": ax.selectedRanges[node] = .init(location: 4, length: 0)
                        case "unavailable": ax.selectedRanges[node] = nil
                        default: ax.selectedRanges[node] = original
                        }
                        ax.attributes[node]?["AXSelectedText"] = "NEW"
                    }
                    let result = capture(ax, text: text, includeTree: includeTree)
                    XCTAssertTrue(changed)
                    XCTAssertEqual(result?.contentState, .unavailable, mutation)
                    XCTAssertNil(result?.selectedRange, mutation)
                    XCTAssertNil(result?.selectedText, mutation)
                    XCTAssertNil(result?.selectedTextTruncated, mutation)
                    XCTAssertNil(result?.element, mutation)
                    XCTAssertNil(result?.ax, mutation)
                    XCTAssertNil(result?.contentDomains, mutation)
                }
            }
        }
    }

    func testLaterTreeReadCannotInvalidateAnEarlierSelectionRange() {
        let ax = fixture()
        ax.selectedRanges["field"] = .init(location: 4, length: 8)
        ax.add("later", role: "AXStaticText", parent: "document", value: "later")
        var changed = false
        ax.onRead = { node, attribute in
            guard node == "later", attribute == "AXValue" else { return }
            changed = true
            ax.selectedRanges["field"] = .init(location: 30, length: 8)
        }
        let result = capture(ax)
        XCTAssertTrue(changed)
        XCTAssertEqual(result?.contentState, .unavailable)
        XCTAssertNil(result?.selectedRange)
        XCTAssertNil(result?.selectedText)
        XCTAssertNil(result?.selectedTextTruncated)
        XCTAssertNil(result?.ax)
    }

    func testClippedSelectionPersistsItsOriginalRangeAndPartialProvenance() throws {
        let ax = fixture()
        let selected = String(repeating: "\u{1F680}", count: 2_049)
        let range = EventStreamTextRange(location: 7, length: selected.utf16.count)
        ax.selectedRanges["field"] = range
        ax.attributes["field"]?["AXSelectedText"] = selected
        let result = try XCTUnwrap(capture(ax, includeTree: false))
        XCTAssertEqual(result.contentState, .available)
        XCTAssertEqual(result.selectedRange, range)
        XCTAssertEqual(result.selectedText?.utf8.count, 8_192)
        XCTAssertEqual(result.selectedTextTruncated, true)
        let selection = EventStreamSelection(target: result.element, selectedText: result.selectedText,
            selectedRange: result.selectedRange, selectedItems: [], truncated: result.selectedTextTruncated)
        let event = HistoryEvent(id: 1, timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            kind: .selectionChanged,
            app: .init(name: "Browser", secureInput: false, processIdentifier: nil, bundleIdentifier: "com.google.Chrome"),
            window: result.window, selection: selection, sourceId: UUID().uuidString.lowercased(),
            contentState: result.contentState, contentDomains: result.contentDomains)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try SegmentStore(homeURL: root)
        XCTAssertTrue(try store.append(event, policy: .init()))
        let data = try Data(contentsOf: store.eventsURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode(HistoryEvent.self, from: data), event)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((json["selection"] as? [String: Any])?["truncated"] as? Bool, true)
    }

    func testStableSelectionPreservesUTF16OffsetsAndDistinguishesMissingTextFromUnclippedText() throws {
        for selected in [nil, "", "\u{1F680}e\u{301}", String(repeating: "x", count: 8_192)] as [String?] {
            for range in [nil, EventStreamTextRange(location: 7, length: selected?.utf16.count ?? 0)] {
                let ax = fixture()
                ax.selectedRanges["field"] = range
                ax.attributes["field"]?["AXSelectedText"] = selected
                let result = try XCTUnwrap(capture(ax, includeTree: false))
                XCTAssertEqual(result.contentState, .available)
                XCTAssertEqual(result.selectedRange, range)
                XCTAssertEqual(result.selectedText, selected)
                XCTAssertEqual(result.selectedTextTruncated, selected == nil ? nil : false)
                let metadata = try XCTUnwrap(capture(ax, text: false, includeTree: false))
                XCTAssertEqual(metadata.contentState, .metadataOnly)
                XCTAssertEqual(metadata.selectedRange, range)
                XCTAssertNil(metadata.selectedText)
                XCTAssertNil(metadata.selectedTextTruncated)
            }
        }
    }

    func testDragUnavailableOriginCannotGainTextFromAvailableDestinationAndNestedDomainsStillFencePersistence() throws {
        let app = EventStreamApp(name: "Browser", secureInput: false, processIdentifier: nil,
            bundleIdentifier: "com.google.Chrome")
        let destinationAX = fixture()
        destinationAX.attributes["field"]?["AXValue"] = "DESTINATION_BODY"
        destinationAX.add("frame", role: "AXWebArea", parent: "document", url: "https://embedded.example/page")
        destinationAX.add("frameBody", role: "AXStaticText", parent: "frame", value: "EMBEDDED_BODY")
        let destination = try XCTUnwrap(capture(destinationAX))
        XCTAssertEqual(destination.contentState, .available)
        for condition in ["unknown", "changedDuringRead", "metadataOnly", "available"] {
            let originAX = fixture()
            originAX.attributes["field"]?["AXValue"] = "ORIGIN_BODY"
            if condition == "unknown" { originAX.attributes["document"]?["AXURL"] = nil }
            if condition == "changedDuringRead" {
                originAX.onRead = { node, attribute in
                    if node == "field", attribute == "AXValue" {
                        originAX.attributes["document"]?["AXURL"] = "https://changed.example"
                    }
                }
            }
            let origin = try XCTUnwrap(capture(originAX, text: condition != "metadataOnly", includeTree: false))
            if condition == "unknown" || condition == "changedDuringRead" {
                XCTAssertEqual(origin.contentState, .unavailable)
                XCTAssertNil(origin.element)
            }
            let event = HistoryEvent(id: 1, timestamp: Date(), kind: .mouseDrag,
                app: app, window: destination.window,
                mouse: EventStreamMouseInteraction(button: "left", clickCount: 1, modifiers: [],
                    target: nil,
                    origin: .init(app: app, window: origin.window, element: origin.element),
                    destination: .init(app: app, window: destination.window, element: destination.element)),
                ax: destination.ax, sourceId: "destination", contentState: destination.contentState,
                contentDomains: Array(Set((origin.contentDomains ?? []) + (destination.contentDomains ?? []))).sorted())
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = try SegmentStore(homeURL: root)
            XCTAssertTrue(try store.append(event, policy: .init()))
            let output = try String(contentsOf: store.eventsURL)
            XCTAssertEqual(output.contains("ORIGIN_BODY"), condition == "available")
            XCTAssertTrue(output.contains("DESTINATION_BODY"))
            XCTAssertTrue(output.contains("EMBEDDED_BODY"))
            XCTAssertEqual(store.eventCount, 1)
            let blocked = ObservationPolicy(observation: .init(blocklist: [
                .init(scope: .url, urlDomain: "embedded.example"),
            ]))
            XCTAssertFalse(try store.append(event, policy: blocked))
            XCTAssertEqual(store.eventCount, 1)
            XCTAssertEqual(try String(contentsOf: store.eventsURL), output)
        }
    }

    func testVisibleRangeReadsRetainScrolledUTF16TailWithoutFetchingWholeLeafValue() throws {
        let ax = fixture(web: false)
        let prefix = String(repeating: "\u{1F600}", count: 5_000)
        let tail = "VISIBLE_DECISION \u{1F680} e\u{301}"
        ax.add("body", role: "AXTextArea", parent: "window", value: prefix + tail)
        ax.visibleRanges["body"] = .range(.init(location: prefix.utf16.count, length: tail.utf16.count))
        let result = try XCTUnwrap(capture(ax, browser: false))
        XCTAssertTrue(result.ax?.text.contains("VISIBLE_DECISION") == true)
        XCTAssertTrue(result.ax?.text.contains("\u{1F680}") == true)
        XCTAssertTrue(result.ax?.text.contains("e\u{301}") == true)
        XCTAssertFalse(result.ax?.text.contains("\u{1F600}") == true)
        XCTAssertTrue(result.ax?.truncated == true)
        XCTAssertFalse(ax.contentReads.contains { $0.node == "body" && $0.attribute == "AXValue" })
        XCTAssertEqual(ax.rangeReads.first?.range.location, 10_000)
        let focused = try XCTUnwrap(capture(ax, browser: false, target: "body"))
        XCTAssertEqual(focused.element?.value, tail)

        ax.attributes["body"]?["AXValue"] = String(repeating: "\u{1F680}", count: 6_000)
        ax.visibleRanges["body"] = .range(.init(location: 1, length: 10_000))
        let clipped = try XCTUnwrap(capture(ax, browser: false, target: "body"))
        XCTAssertFalse(clipped.element?.value?.contains("\u{FFFD}") == true)
        XCTAssertLessThanOrEqual(try XCTUnwrap(clipped.element?.value).utf8.count, 8_192)
        XCTAssertEqual(ax.rangeReads.last?.range.length, 8_192)
        XCTAssertLessThanOrEqual(try XCTUnwrap(clipped.ax).text.utf8.count, 32_768)
    }

    func testVisibleRangeFailureOrMutationCannotFallBackOrRetainEarlierText() {
        for mutation in ["range", "secure", "parent", "document", "children", "failure", "overflow"] {
            let ax = fixture()
            ax.roles["field"] = ObservationRole("AXTextArea")
            ax.visibleRanges["field"] = .range(.init(location: 0, length: 10))
            if mutation == "failure" { ax.visibleRanges["field"] = .unavailable }
            if mutation == "overflow" { ax.visibleRanges["field"] = .range(.init(location: Int.max, length: 1)) }
            ax.onRangeRead = { node in
                switch mutation {
                case "range": ax.visibleRanges[node] = .range(.init(location: 1, length: 9))
                case "secure": ax.roles[node] = ObservationRole("AXSecureTextField")
                case "parent": ax.parents[node] = "otherWindow"
                case "document": ax.attributes["document"]?["AXURL"] = "https://blocked.example"
                case "children": ax.add("denied", role: "AXWebArea", parent: node, url: "https://blocked.example")
                default: break
                }
            }
            let result = capture(ax, includeTree: false)
            XCTAssertEqual(result?.contentState, .unavailable, mutation)
            XCTAssertNil(result?.element)
            XCTAssertNil(result?.ax)
            XCTAssertFalse(ax.contentReads.contains { $0.node == "field" && $0.attribute == "AXValue" }, mutation)
        }
        XCTAssertNil(ObservationTextRange.bounded(.init(location: -1, length: 1)))
        XCTAssertNil(ObservationTextRange.decode([0x41, 0xD800, 0x42]))
        XCTAssertEqual(ObservationTextRange.decode([0xDC00, 0x41, 0xD800]), "A")
    }

    func testVisibleRangeIsNeverReadFromDeniedSecureContainerOrMetadataOnlyContext() {
        for condition in ["blocked", "secure", "container", "metadata", "private"] {
            let ax = fixture()
            ax.roles["field"] = ObservationRole("AXTextArea")
            ax.visibleRanges["field"] = .range(.init(location: 0, length: 10))
            switch condition {
            case "blocked": ax.attributes["document"]?["AXURL"] = "https://blocked.example"
            case "secure": ax.roles["field"] = ObservationRole("AXTextArea", subrole: "AXSecureTextField")
            case "container": ax.add("child", role: "AXGroup", parent: "field")
            case "private": ax.attributes["window"]?["AXTitle"] = "Neutral [InPrivate]"
            default: break
            }
            _ = capture(ax, text: condition != "metadata")
            XCTAssertTrue(ax.rangeReads.isEmpty, condition)
        }
    }

    func testWindowBurstCoalescingMeasuresActualTraversalAndRetainsLatestBody() throws {
        let ax = fixture(web: false)
        for index in 0..<20 { ax.add("body\(index)", role: "AXStaticText", parent: "window", value: "old \(index)") }
        var traversals = 0
        ax.onChildren = { if $0 == "window" { traversals += 1 } }
        for _ in 0..<20 { _ = capture(ax, browser: false) }
        XCTAssertEqual(traversals, 20)
        traversals = 0
        var sampling = ObservationSampling()
        for index in 0..<20 {
            ax.attributes["body\(index)"]?["AXValue"] = "FINAL_DECISION_\(index)"
            sampling.request(now: Double(index) / 100)
        }
        let token = try XCTUnwrap(sampling.begin(now: 0.21))
        let result = try XCTUnwrap(capture(ax, browser: false))
        sampling.complete(token, settled: result.contentState == .available)
        XCTAssertEqual(traversals, 1)
        for index in 0..<20 { XCTAssertTrue(result.ax?.text.contains("FINAL_DECISION_\(index)") == true) }
        for tick in 1..<3 { XCTAssertNil(sampling.begin(now: Double(tick))) }
        XCTAssertEqual(traversals, 1)
        let retry = try XCTUnwrap(sampling.begin(now: 3.22))
        sampling.complete(retry, settled: false)
        XCTAssertNotNil(sampling.begin(now: 6.23))
    }

    func testRangedChildrenIllegalArgumentRequiresSuccessfulZeroCountWithinBudget() {
        let element = AXUIElementCreateSystemWide()
        for result in [AXError.illegalArgument, .cannotComplete, .invalidUIElement, .failure] {
            for countResult in [AXError.success, .cannotComplete, .illegalArgument] {
                for count in [0, 1] {
                    var countCalls = 0
                    let children = AXChildrenReader.read(element, withinBudget: { true }, copyValues: { _, _, index, limit, _ in
                        XCTAssertEqual(index, 0)
                        XCTAssertEqual(limit, 257)
                        return result
                    }, valueCount: { _, _, value in
                        countCalls += 1
                        value.pointee = count
                        return countResult
                    })
                    XCTAssertEqual(countCalls, result == .illegalArgument ? 1 : 0)
                    if result == .illegalArgument && countResult == .success && count == 0 {
                        XCTAssertEqual(children?.count, 0)
                    } else { XCTAssertNil(children) }
                }
            }
        }
        var budget = true
        XCTAssertNil(AXChildrenReader.read(element, withinBudget: { budget }, copyValues: { _, _, _, _, _ in
            .illegalArgument
        }, valueCount: { _, _, count in
            count.pointee = 0
            budget = false
            return .success
        }))
        for result in [AXError.success, .noValue, .attributeUnsupported] {
            let children = AXChildrenReader.read(element, withinBudget: { true }, copyValues: { _, _, _, _, values in
                values.pointee = [] as CFArray
                return result
            }, valueCount: { _, _, _ in
                XCTFail("No count query on the normal path")
                return .failure
            })
            XCTAssertEqual(children?.count, 0)
        }
    }

    func testZeroCountAXLeavesContributeTextButMessagingFailuresDoNot() {
        for result in [AXError.illegalArgument, .cannotComplete] {
            let ax = fixture(web: false)
            let handle = AXUIElementCreateSystemWide()
            ax.leafChildren = {
                AXChildrenReader.read(handle, withinBudget: { true }, copyValues: { _, _, _, _, _ in result },
                    valueCount: { _, _, count in count.pointee = 0; return .success })?.map { _ in "unexpected" }
            }
            let observation = capture(ax, browser: false)
            XCTAssertEqual(observation?.contentState, .available)
            XCTAssertEqual(observation?.ax?.text.contains("safe field"), result == .illegalArgument)
            XCTAssertEqual(observation?.element?.value, result == .illegalArgument ? "safe field" : nil)
            XCTAssertEqual(ax.contentReads.contains { $0.node == "field" }, result == .illegalArgument)
        }
    }

    func testDeniedOwnerCannotBeAuthorizedByAllowedTargetLink() {
        let ax = fixture()
        ax.attributes["document"]?["AXURL"] = "https://blocked.example/private"
        ax.attributes["field"]?["AXURL"] = "https://allowed.example/link"
        XCTAssertNil(capture(ax))
        XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
    }

    func testUnknownBrowserDocumentOrAncestryHidesWindowAndNeverReadsContent() {
        for mutation in ["missingURL", "fileURL", "missingRole", "unknownSecurity", "disconnected", "foreign"] {
            let ax = fixture()
            switch mutation {
            case "missingURL": ax.attributes["document"]?["AXURL"] = nil
            case "fileURL": ax.attributes["document"]?["AXURL"] = "file:///private/document"
            case "missingRole": ax.roles["field"] = nil
            case "unknownSecurity": ax.roles["document"] = nil
            case "disconnected": ax.parents["field"] = nil
            default: ax.foreign.insert("field")
            }
            let result = capture(ax)
            XCTAssertEqual(result?.contentState, .unavailable, mutation)
            XCTAssertNil(result?.window, mutation)
            XCTAssertNil(result?.ax, mutation)
            XCTAssertNil(result?.element, mutation)
            XCTAssertNil(result?.contentDomains, mutation)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" }, mutation)
        }
    }

    func testURLLessNativeWindowAndMissingAXStillAdmitMetadataWithoutTreeDependency() {
        let ax = fixture(web: false)
        ax.childrenByNode["window"] = nil
        let result = capture(ax, browser: false, text: false)
        XCTAssertEqual(result?.contentState, .metadataOnly)
        XCTAssertEqual(result?.window?.title, "Ordinary document")
        XCTAssertNil(result?.ax)
        XCTAssertNil(result?.contentDomains)
        XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })

        let missing = capture(ax, browser: false, target: nil)
        XCTAssertEqual(missing?.window?.title, "Ordinary document")
        XCTAssertEqual(missing?.contentState, .unavailable)
        XCTAssertNil(missing?.ax)
        XCTAssertNil(capture(ax, browser: false, window: nil, target: nil)?.window)
    }

    func testNativeFocusInsideUnknownEmbeddedDocumentHidesMetadataBeforeContentReads() {
        for url in [nil, "file://remote.example/local/app.html", "app://local/index.html", "custom://local/index.html"] as [String?] {
            let ax = fixture(web: false)
            ax.add("embedded", role: "AXWebArea", parent: "window", url: url)
            ax.add("embeddedField", role: "AXTextField", parent: "embedded", value: "CANARY_EMBEDDED")
            let result = capture(ax, browser: false, target: "embeddedField")
            XCTAssertEqual(result?.windowNode, "window")
            XCTAssertEqual(result?.contentState, .unavailable)
            XCTAssertNil(result?.window)
            XCTAssertNil(result?.ax)
            XCTAssertNil(result?.element)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
    }

    func testOwnedLocalDocumentsRetainUsefulTextWithoutPersistingDocumentPaths() throws {
        for url in ["file:///PRIVATE_LOCAL_PATH/app.html", "file://localhost/PRIVATE_LOCAL_PATH/app.html",
                    "app://local/PRIVATE_LOCAL_PATH/app.html"] {
            let ax = fixture()
            ax.attributes["document"]?["AXURL"] = url
            let observation = try XCTUnwrap(capture(ax, browser: false, bundleIdentifier: "com.openai.codex"))
            XCTAssertEqual(observation.contentState, .available)
            XCTAssertEqual(observation.element?.value, "safe field")
            XCTAssertTrue(observation.ax?.text.contains("safe field") == true)
            XCTAssertEqual(observation.contentDomains, [])
            XCTAssertNil(observation.window?.url)
            XCTAssertEqual(observation.documentURLs, [url])

            let app = EventStreamApp(name: "Local app", secureInput: false,
                processIdentifier: nil, bundleIdentifier: "com.openai.codex")
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let timestamp = Date(timeIntervalSince1970: 1_700_000_000)
            let store = try SegmentStore(homeURL: root, now: timestamp)
            let event = HistoryEvent(id: 1, timestamp: timestamp, kind: .uiChanged,
                app: app, window: observation.window, ax: observation.ax,
                sourceId: "local-window", contentState: observation.contentState, contentDomains: observation.contentDomains)
            XCTAssertTrue(try store.append(event, policy: .init()))
            let source = TextInputSource(app: app, window: observation.window, element: observation.element,
                processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
                sourceId: "local-window", contentState: observation.contentState, contentDomains: observation.contentDomains,
                sourcePath: observation.sourcePath.map(AnyHashable.init), documentURLs: observation.documentURLs)
            var buffer = TextInputBuffer()
            _ = buffer.append(characters: { "local typed text" }, source: source, policy: .init(), now: 0)
            XCTAssertTrue(try store.append(try XCTUnwrap(buffer.drain()).event(id: 2, timestamp: timestamp), policy: .init()))
            try store.finish(reason: "test", now: timestamp)
            let jsonl = try String(contentsOf: store.eventsURL)
            XCTAssertTrue(jsonl.contains("safe field"))
            XCTAssertTrue(jsonl.contains("local typed text"))
            XCTAssertFalse(jsonl.contains("PRIVATE_LOCAL_PATH"))
            XCTAssertFalse(jsonl.contains(url))
            XCTAssertFalse(jsonl.contains("documentURLs"))

            ax.contentReads.removeAll()
            let metadata = capture(ax, browser: false, text: false, bundleIdentifier: "com.openai.codex")
            XCTAssertEqual(metadata?.contentState, .metadataOnly)
            XCTAssertNil(metadata?.window?.url)
            XCTAssertNil(metadata?.ax)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
    }

    func testLocalDocumentAdmissionRejectsBrowsersUnknownAppsRemoteFilesAndOpaqueSchemes() {
        let cases: [(String?, Bool, String)] = [
            ("file:///local/app.html", true, "com.google.Chrome"),
            ("app://local/app.html", true, "com.openai.codex"),
            ("app://local/app.html", false, "test.native"),
            ("custom://local/app.html", false, "com.openai.codex"),
            ("file://remote.example/local/app.html", false, "com.openai.codex"),
            ("file:relative", false, "com.openai.codex"),
            ("app:opaque", false, "com.openai.codex"),
            ("file://user:password@localhost/path", false, "com.openai.codex"),
            (nil, false, "com.openai.codex"),
        ]
        for (url, browser, bundle) in cases {
            let ax = fixture()
            ax.attributes["document"]?["AXURL"] = url
            let result = capture(ax, browser: browser, bundleIdentifier: bundle)
            XCTAssertEqual(result?.contentState, .unavailable)
            XCTAssertNil(result?.window)
            XCTAssertNil(result?.ax)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
        let ax = fixture()
        ax.attributes["document"]?["AXURL"] = "file:///local/app.html"
        XCTAssertEqual(capture(ax, browser: false)?.contentState, .available)
    }

    func testLocalAppDocumentsCannotAuthorizeDeniedUnknownOrRemoteNestedLocalFrames() {
        for localURL in ["file:///local/app.html", "app://local/app.html"] {
            let ax = fixture()
            ax.attributes["document"]?["AXURL"] = localURL
            ax.add("allowedFrame", role: "AXWebArea", parent: "document", url: "https://allowed.example")
            ax.add("allowedText", role: "AXStaticText", parent: "allowedFrame", value: "ALLOWED_REMOTE")
            ax.add("deniedFrame", role: "AXWebArea", parent: "document", url: "https://blocked.example")
            ax.add("deniedText", role: "AXStaticText", parent: "deniedFrame", value: "CANARY_DENIED")
            ax.add("unknownFrame", role: "AXWebArea", parent: "document")
            ax.add("unknownText", role: "AXStaticText", parent: "unknownFrame", value: "CANARY_UNKNOWN")
            ax.add("nestedLocal", role: "AXWebArea", parent: "allowedFrame", url: localURL)
            ax.add("nestedText", role: "AXStaticText", parent: "nestedLocal", value: "CANARY_REMOTE_LOCAL")
            ax.add("secure", role: "AXSecureTextField", parent: "document", value: "CANARY_SECURE")
            let result = capture(ax, browser: false, bundleIdentifier: "com.openai.codex")
            XCTAssertEqual(result?.contentState, .available)
            XCTAssertNil(result?.window?.url)
            XCTAssertEqual(result?.contentDomains, ["allowed.example"])
            XCTAssertTrue(result?.ax?.text.contains("ALLOWED_REMOTE") == true)
            XCTAssertFalse(result?.ax?.text.contains("CANARY") == true)
            XCTAssertFalse(ax.contentReads.contains {
                ["deniedFrame", "deniedText", "unknownFrame", "unknownText", "nestedLocal", "nestedText", "secure"].contains($0.node)
            })

            let remoteFocus = capture(ax, browser: false, target: "allowedText", bundleIdentifier: "com.openai.codex")
            XCTAssertEqual(remoteFocus?.contentState, .available)
            XCTAssertNil(remoteFocus?.window?.url)
            XCTAssertEqual(remoteFocus?.documentURLs, ["https://allowed.example", localURL])

            ax.contentReads.removeAll()
            XCTAssertEqual(capture(ax, browser: false, target: "nestedText",
                bundleIdentifier: "com.openai.codex")?.contentState, .unavailable)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
            XCTAssertNil(capture(ax, browser: false, target: "deniedText", bundleIdentifier: "com.openai.codex"))
        }
    }

    func testLocalDocumentNavigationInvalidatesCaptureAndTypingAttribution() throws {
        for url in ["file:///local/first.html", "app://local/first.html"] {
            let ax = fixture()
            ax.attributes["document"]?["AXURL"] = url
            let before = try XCTUnwrap(capture(ax, browser: false, includeTree: false, bundleIdentifier: "com.openai.codex"))
            let next = url.replacingOccurrences(of: "first", with: "second")
            ax.attributes["document"]?["AXURL"] = next
            let after = try XCTUnwrap(capture(ax, browser: false, includeTree: false, bundleIdentifier: "com.openai.codex"))
            XCTAssertEqual(before.window, after.window)
            XCTAssertEqual(before.contentDomains, after.contentDomains)
            XCTAssertFalse(before.hasSameSource(as: after))
            func source(_ observation: CapturedObservation<String>) -> TextInputSource {
                TextInputSource(app: .init(name: "Local", secureInput: false,
                    processIdentifier: nil, bundleIdentifier: "com.openai.codex"),
                    window: observation.window, element: observation.element,
                    processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
                    sourceId: "local", contentState: observation.contentState, contentDomains: observation.contentDomains,
                    sourcePath: observation.sourcePath.map(AnyHashable.init), documentURLs: observation.documentURLs)
            }
            XCTAssertFalse(source(before).matches(source(after)))

            for mutation in ["url", "parent", "secure"] {
                let changed = fixture()
                changed.attributes["document"]?["AXURL"] = url
                changed.onRead = { node, attribute in
                    guard node == "field", attribute == "AXValue" else { return }
                    switch mutation {
                    case "url": changed.attributes["document"]?["AXURL"] = next
                    case "parent": changed.parents["document"] = "otherWindow"
                    default: changed.roles["document"] = ObservationRole("AXSecureTextField")
                    }
                }
                let result = capture(changed, browser: false, bundleIdentifier: "com.openai.codex")
                XCTAssertEqual(result?.contentState, .unavailable)
                XCTAssertNil(result?.window)
                XCTAssertNil(result?.ax)
                XCTAssertNil(result?.element)
            }
        }
    }

    func testTreeDeadlineCanRetainOnlyStructureBeforeReachingAnAllowedTextLeaf() {
        let ax = fixture()
        ax.childrenByNode["document"] = []
        for index in 0..<8 {
            ax.add("group\(index)", role: "AXGroup",
                parent: index == 0 ? "document" : "group\(index - 1)")
        }
        ax.add("text", role: "AXStaticText", parent: "group7", value: "USEFUL_TEXT")
        var clock = 0.0
        ax.onChildren = { _ in clock += 0.06 }
        let partial = capture(ax, target: "document", now: { clock })
        XCTAssertEqual(partial?.contentState, .available)
        XCTAssertEqual(partial?.ax?.truncated, true)
        XCTAssertTrue(partial?.ax?.text.contains("AXGroup") == true)
        XCTAssertFalse(partial?.ax?.text.contains("AXStaticText") == true)
        XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })

        ax.onChildren = nil
        let complete = capture(ax, target: "document")
        XCTAssertEqual(complete?.contentState, .available)
        XCTAssertEqual(complete?.ax?.truncated, false)
        XCTAssertTrue(complete?.ax?.text.contains("USEFUL_TEXT") == true)
    }

    func testStaticTextWithChildrenDoesNotBypassDescendantPrivacyChecks() {
        let ax = fixture()
        ax.add("text", role: "AXStaticText", parent: "document", value: "AGGREGATE_TEXT")
        ax.add("layout", role: "AXGroup", parent: "text")
        let structural = capture(ax, target: "text")
        XCTAssertEqual(structural?.contentState, .available)
        XCTAssertNil(structural?.element?.value)
        XCTAssertFalse(structural?.ax?.text.contains("AGGREGATE_TEXT") == true)
        XCTAssertFalse(ax.contentReads.contains { $0.node == "text" })

        ax.add("denied", role: "AXWebArea", parent: "text", url: "https://blocked.example")
        ax.add("secret", role: "AXStaticText", parent: "denied", value: "CANARY_SECRET")
        let pruned = capture(ax, target: "text")
        XCTAssertEqual(pruned?.contentState, .available)
        XCTAssertEqual(pruned?.ax?.truncated, true)
        XCTAssertFalse(pruned?.ax?.text.contains("CANARY") == true)
        XCTAssertFalse(ax.contentReads.contains { ["text", "denied", "secret"].contains($0.node) })
    }

    func testUnfocusedTextBodyRetainsTailAndReportsByteTruncation() throws {
        for role in ["AXTextArea", "AXStaticText"] {
            let ax = fixture(web: false)
            let body = String(repeating: "Reading ordinary document text. ", count: 40) + "BODY_TAIL"
            ax.add("body", role: role, parent: "window", value: body)
            let complete = try XCTUnwrap(capture(ax, browser: false))
            XCTAssertEqual(complete.element?.value, "safe field")
            XCTAssertTrue(complete.ax?.text.contains("BODY_TAIL") == true)
            XCTAssertEqual(complete.ax?.truncated, false)

            ax.attributes["body"]?["AXValue"] = String(repeating: "\u{6587}", count: 4_000) + "OMITTED_TAIL"
            let clipped = try XCTUnwrap(capture(ax, browser: false))
            XCTAssertEqual(clipped.contentState, .available)
            XCTAssertEqual(clipped.ax?.truncated, true)
            XCTAssertFalse(clipped.ax?.text.contains("OMITTED_TAIL") == true)
            XCTAssertLessThanOrEqual(try XCTUnwrap(clipped.ax).text.utf8.count, 32_768)
            let line = try XCTUnwrap(clipped.ax?.text.split(separator: "\n").first { $0.contains(role) })
            let value = try XCTUnwrap(line.range(of: "AXValue="))
            let encoded = Data(line[value.upperBound...].utf8)
            let decoded = try JSONDecoder().decode(String.self, from: encoded)
            XCTAssertEqual(decoded, String(repeating: "\u{6587}", count: 8_192 / 3))

            ax.attributes["body"]?["AXValue"] = "ESCAPED_BODY " + String(repeating: "\u{0001}", count: 6_000)
            let escaped = try XCTUnwrap(capture(ax, browser: false))
            let escapedTree = try XCTUnwrap(escaped.ax)
            XCTAssertEqual(escapedTree.truncated, true)
            XCTAssertTrue(escapedTree.text.contains("ESCAPED_BODY"))
            XCTAssertLessThanOrEqual(escapedTree.text.utf8.count, 32_768)
            let escapedLine = try XCTUnwrap(escapedTree.text.split(separator: "\n").first { $0.contains("ESCAPED_BODY") })
            let escapedStart = try XCTUnwrap(escapedLine.range(of: "AXValue="))
            let escapedValue = try JSONDecoder().decode(String.self, from: Data(escapedLine[escapedStart.upperBound...].utf8))
            XCTAssertTrue(escapedValue.hasPrefix("ESCAPED_BODY "))
            XCTAssertTrue(escapedValue.dropFirst("ESCAPED_BODY ".count).allSatisfy { $0 == "\u{0001}" })
            XCTAssertGreaterThan(escapedValue.count, 400)

            ax.roles["body"] = ObservationRole("AXSecureTextField")
            ax.contentReads.removeAll()
            let secure = try XCTUnwrap(capture(ax, browser: false))
            XCTAssertFalse(secure.ax?.text.contains("ESCAPED_BODY") == true)
            XCTAssertFalse(ax.contentReads.contains { $0.node == "body" })
        }
    }

    func testSecureAncestorAndUnreadableSecuritySubtreeAreExcludedBeforeTextReads() {
        for role in [ObservationRole("AXSecureTextField"), ObservationRole("AXTextField", subrole: "AXSecureTextField")] {
            let ax = fixture()
            ax.roles["document"] = role
            XCTAssertNil(capture(ax))
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
        let ax = fixture()
        ax.add("secret", role: "AXSecureTextField", parent: "document", value: "CANARY_SECURE")
        ax.add("unknown", role: nil, parent: "document", value: "CANARY_UNKNOWN")
        ax.add("secureChild", role: "AXStaticText", parent: "secret", value: "CANARY_CHILD")
        let result = capture(ax)
        XCTAssertEqual(result?.contentState, .available)
        XCTAssertTrue(result?.ax?.text.contains("safe field") == true)
        XCTAssertFalse(result?.ax?.text.contains("CANARY") == true)
        XCTAssertEqual(result?.ax?.truncated, true)
        XCTAssertFalse(ax.contentReads.contains { ["secret", "unknown", "secureChild"].contains($0.node) })
    }

    func testNestedDomainsCollectedAndDeniedOrUnknownSubtreesNeverContribute() {
        for browser in [true, false] {
            let ax = fixture(web: browser)
            let root = browser ? "document" : "window"
            ax.add("allowedFrame", role: "AXWebArea", parent: root, url: "https://WWW.Allowed-Frame.example./page")
            ax.add("allowedText", role: "AXStaticText", parent: "allowedFrame", value: "FRAME_ALLOWED")
            ax.add("sameDomain", role: "AXWebArea", parent: root, url: "https://www.allowed-frame.example/other")
            ax.add("sameText", role: "AXStaticText", parent: "sameDomain", value: "SAME_ALLOWED")
            ax.add("denied", role: "AXWebArea", parent: root, url: "https://blocked.example")
            ax.add("deniedText", role: "AXStaticText", parent: "denied", value: "CANARY_DENIED")
            ax.add("unknown", role: "AXWebArea", parent: root)
            ax.add("unknownText", role: "AXStaticText", parent: "unknown", value: "CANARY_UNKNOWN")
            ax.attributes[root]?["AXValue"] = "CANARY_AGGREGATE"
            let result = capture(ax, browser: browser)
            XCTAssertEqual(result?.contentDomains, browser
                ? ["owner.example", "www.allowed-frame.example"] : ["www.allowed-frame.example"])
            XCTAssertEqual(result?.window?.url, browser ? "https://owner.example/page" : nil)
            XCTAssertTrue(result?.ax?.text.contains("FRAME_ALLOWED") == true)
            XCTAssertTrue(result?.ax?.text.contains("SAME_ALLOWED") == true)
            XCTAssertFalse(result?.ax?.text.contains("CANARY") == true)
            XCTAssertEqual(result?.ax?.truncated, true)
            XCTAssertFalse(ax.contentReads.contains {
                ["denied", "deniedText", "unknown", "unknownText"].contains($0.node)
            })
        }
    }

    func testContainerTargetCannotLeakAggregatedDeniedFrameValueOrSelection() {
        let ax = fixture()
        ax.attributes["document"]?["AXValue"] = "CANARY_VALUE"
        ax.attributes["document"]?["AXSelectedText"] = "CANARY_SELECTED"
        ax.add("denied", role: "AXWebArea", parent: "document", url: "https://blocked.example")
        ax.add("deniedText", role: "AXStaticText", parent: "denied", value: "CANARY_FRAME")
        let result = capture(ax, target: "document")
        XCTAssertEqual(result?.contentState, .available)
        XCTAssertNil(result?.element?.value)
        XCTAssertNil(result?.selectedText)
        XCTAssertFalse(result?.ax?.text.contains("CANARY") == true)
    }

    func testMutatingDocumentFocusOrSecureContextDiscardsRichEvidence() {
        for mutation in ["url", "parent", "secure", "title", "nestedURL"] {
            let ax = fixture()
            if mutation == "nestedURL" {
                ax.add("nested", role: "AXWebArea", parent: "document", url: "https://frame.example")
                ax.add("nestedText", role: "AXStaticText", parent: "nested", value: "FRAME")
            }
            var changed = false
            ax.onRead = { node, attribute in
                guard !changed, node == (mutation == "nestedURL" ? "nestedText" : "field"), attribute == "AXValue" else { return }
                changed = true
                switch mutation {
                case "url": ax.attributes["document"]?["AXURL"] = "https://blocked.example"
                case "parent": ax.parents["field"] = "otherWindow"
                case "secure": ax.roles["field"] = ObservationRole("AXSecureTextField")
                case "title": ax.attributes["window"]?["AXTitle"] = "Incognito"
                default: ax.attributes["nested"]?["AXURL"] = "https://blocked.example"
                }
            }
            let result = capture(ax)
            XCTAssertTrue(changed)
            XCTAssertNotEqual(result?.contentState, .available, mutation)
            XCTAssertNil(result?.ax, mutation)
            XCTAssertNil(result?.element, mutation)
            XCTAssertNil(result?.selectedText, mutation)
            XCTAssertNil(result?.contentDomains, mutation)
            XCTAssertNil(result?.window, mutation)
        }
    }

    func testLaterSiblingCannotChangePreviouslyReadSecurityOrOwnership() {
        for mutation in ["secure", "parent", "leaf"] {
            let ax = fixture()
            ax.add("earlier", role: "AXTextField", parent: "document", value: "CANARY_EARLIER")
            ax.add("later", role: "AXStaticText", parent: "document", value: "later")
            var changed = false
            ax.onRead = { node, attribute in
                guard node == "later", attribute == "AXValue" else { return }
                changed = true
                switch mutation {
                case "secure": ax.roles["earlier"] = ObservationRole("AXSecureTextField")
                case "parent": ax.parents["earlier"] = "deniedDocument"
                default:
                    ax.add("deniedDocument", role: "AXWebArea", parent: "earlier", url: "https://blocked.example")
                }
            }
            let result = capture(ax)
            XCTAssertTrue(changed)
            XCTAssertEqual(result?.contentState, .unavailable, mutation)
            XCTAssertNil(result?.ax, mutation)
            XCTAssertNil(result?.window, mutation)
        }
    }

    func testMissingBrowserWindowTitleCannotEstablishPrivateBrowsingContext() {
        for title in [nil, "", "   "] as [String?] {
            let ax = fixture()
            ax.attributes["window"]?["AXTitle"] = title
            let result = capture(ax)
            XCTAssertEqual(result?.contentState, .unavailable)
            XCTAssertNil(result?.window)
            XCTAssertNil(result?.ax)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
    }

    func testTargetGainingDescendantsCannotRetainAggregateValueWithoutTreeCapture() {
        let ax = fixture()
        ax.onRead = { node, attribute in
            guard node == "field", attribute == "AXValue" else { return }
            ax.add("denied", role: "AXWebArea", parent: "field", url: "https://blocked.example")
        }
        let result = capture(ax, includeTree: false)
        XCTAssertEqual(result?.contentState, .unavailable)
        XCTAssertNil(result?.element)
        XCTAssertNil(result?.selectedText)
    }

    func testSameDomainEmbeddedNavigationCannotMergeTypingSources() throws {
        let ax = fixture()
        ax.add("frame", role: "AXWebArea", parent: "document", url: "https://frame.example/first")
        ax.add("input", role: "AXTextField", parent: "frame", value: "input")
        func source(_ observation: CapturedObservation<String>) -> TextInputSource {
            TextInputSource(
                app: .init(name: "Browser", secureInput: false, processIdentifier: nil, bundleIdentifier: "com.google.Chrome"),
                window: observation.window, element: observation.element,
                processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
                sourceId: "same-window", contentState: observation.contentState, contentDomains: observation.contentDomains,
                sourcePath: observation.sourcePath.map(AnyHashable.init), documentURLs: observation.documentURLs
            )
        }
        let first = source(try XCTUnwrap(capture(ax, target: "input", includeTree: false)))
        XCTAssertEqual(first.window?.url, "https://owner.example/page")
        XCTAssertEqual(first.documentURLs, ["https://frame.example/first", "https://owner.example/page"])
        ax.attributes["frame"]?["AXURL"] = "https://frame.example/second"
        let second = source(try XCTUnwrap(capture(ax, target: "input", includeTree: false)))
        XCTAssertEqual(first.window, second.window)
        XCTAssertEqual(first.contentDomains, second.contentDomains)
        XCTAssertFalse(first.matches(second))
        var buffer = TextInputBuffer()
        _ = buffer.append(characters: { "first" }, source: first, policy: .init(), now: 0)
        XCTAssertEqual(buffer.append(characters: { "second" }, source: second, policy: .init(), now: 0.1)?.text, "first")
        XCTAssertEqual(buffer.drain()?.text, "second")
    }

    func testFocusedSourceRecheckDistinguishesReplacementDocumentEvenWithIdenticalURL() throws {
        let ax = fixture()
        let before = try XCTUnwrap(capture(ax, text: false, includeTree: false))
        ax.add("replacement", role: "AXWebArea", parent: "window", url: "https://owner.example/page")
        ax.parents["field"] = "replacement"
        let after = try XCTUnwrap(capture(ax, text: false, includeTree: false))
        XCTAssertEqual(before.window, after.window)
        XCTAssertEqual(before.documentURLs, after.documentURLs)
        XCTAssertFalse(before.hasSameSource(as: after))
    }

    func testCaptureDeadlineIncludesFinalValidationAndRejectsUnverifiedPartialContent() {
        let ax = fixture()
        var clock = 0.0
        var valueRead = false
        ax.onRead = { node, attribute in
            if node == "field", attribute == "AXValue" { valueRead = true }
        }
        let result = capture(ax, includeTree: false, now: {
            if valueRead { clock += 0.4 }
            return clock
        })
        XCTAssertTrue(valueRead)
        XCTAssertEqual(result?.contentState, .unavailable)
        XCTAssertNil(result?.ax)
        XCTAssertNil(result?.element)
        XCTAssertNil(result?.window)
    }

    func testCapturedFramePolicyAndTypingAttributionSurviveActualPersistenceWithoutInternalPaths() throws {
        let ax = fixture()
        ax.add("allowedFrame", role: "AXWebArea", parent: "document", url: "https://frame.example/INTERNAL_FRAME_PATH")
        ax.add("frameText", role: "AXStaticText", parent: "allowedFrame", value: "FRAME_ALLOWED")
        ax.add("deniedFrame", role: "AXWebArea", parent: "document", url: "https://blocked.example")
        ax.add("deniedText", role: "AXStaticText", parent: "deniedFrame", value: "CANARY_DENIED")
        let observation = try XCTUnwrap(capture(ax, target: "frameText"))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let store = try SegmentStore(homeURL: root, now: now)
        let app = EventStreamApp(name: "Browser", secureInput: false, processIdentifier: nil, bundleIdentifier: "com.google.Chrome")
        let source = TextInputSource(app: app, window: observation.window, element: observation.element,
            processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
            sourceId: "same-window", contentState: observation.contentState, contentDomains: observation.contentDomains,
            sourcePath: observation.sourcePath.map(AnyHashable.init), documentURLs: observation.documentURLs)
        var buffer = TextInputBuffer()
        _ = buffer.append(characters: { "typed" }, source: source, policy: .init(), now: 0)
        let input = try XCTUnwrap(buffer.drain()).event(id: 1, timestamp: now)
        XCTAssertTrue(try store.append(input, policy: .init()))
        let tree = HistoryEvent(id: 2, timestamp: now, kind: .uiChanged,
            app: app, window: observation.window, ax: observation.ax,
            sourceId: source.sourceId, contentState: observation.contentState, contentDomains: observation.contentDomains)
        XCTAssertTrue(try store.append(tree, policy: .init()))
        try store.finish(reason: "test", now: now)
        let jsonl = try String(contentsOf: store.eventsURL)
        XCTAssertTrue(jsonl.contains("FRAME_ALLOWED"))
        XCTAssertTrue(jsonl.contains("typed"))
        XCTAssertTrue(jsonl.contains("frame.example"))
        XCTAssertFalse(jsonl.contains("CANARY"))
        XCTAssertFalse(jsonl.contains("blocked.example"))
        XCTAssertFalse(jsonl.contains("INTERNAL_FRAME_PATH"))
        XCTAssertFalse(jsonl.contains("sourcePath"))
        XCTAssertFalse(jsonl.contains("documentURLs"))
    }

    func testDomainsAreBoundedAndUnadmittedOverflowTextIsNotRead() {
        let ax = fixture()
        for index in 0..<70 {
            ax.add("frame\(index)", role: "AXWebArea", parent: "document", url: "https://frame\(index).example")
            ax.add("text\(index)", role: "AXStaticText", parent: "frame\(index)", value: "FRAME_\(index)")
        }
        let result = capture(ax)
        XCTAssertEqual(result?.contentDomains?.count, 64)
        XCTAssertTrue(result?.contentDomains?.contains("owner.example") == true)
        XCTAssertFalse(result?.contentDomains?.contains("frame63.example") == true)
        XCTAssertFalse(ax.contentReads.contains { $0.node == "text63" })
        XCTAssertEqual(result?.ax?.truncated, true)
    }

    func testNodeDepthByteAndDeadlineBudgetsProduceBoundedFullSnapshots() {
        for dimension in ["nodes", "depth", "bytes", "time"] {
            let ax = fixture()
            for index in 0..<300 {
                let parent = dimension == "depth" && index > 0 ? "extra\(index - 1)" : "document"
                ax.add("extra\(index)", role: "AXStaticText", parent: parent,
                    value: dimension == "bytes" ? String(repeating: "\u{4E2D}", count: 500) : "value \(index)")
                if dimension == "bytes" { ax.attributes["extra\(index)"]?["AXTitle"] = String(repeating: "x", count: 500) }
            }
            var clock = 0.0
            let result = capture(ax, now: {
                if dimension == "time" { clock += 0.005 }
                return clock
            })
            XCTAssertEqual(result?.ax?.mode, .fullTree, dimension)
            XCTAssertEqual(result?.ax?.truncated, true, dimension)
            XCTAssertLessThanOrEqual(result?.ax?.text.utf8.count ?? Int.max, 32_768, dimension)
            XCTAssertLessThanOrEqual(result?.ax?.text.split(separator: "\n").count ?? Int.max, 256, dimension)
        }
        XCTAssertEqual(boundedText("\u{1F600}\u{1F600}", bytes: 7), "\u{1F600}")
        XCTAssertEqual(boundedText("\u{4E2D}", bytes: 2), "")
    }

    func testMetadataOnlyNeverReadsElementTextAndAvailableNativeHasEmptyDomains() {
        for browser in [true, false] {
            let ax = fixture(web: browser)
            let result = capture(ax, browser: browser, text: false)
            XCTAssertEqual(result?.contentState, .metadataOnly)
            XCTAssertNil(result?.ax)
            XCTAssertNil(result?.element?.value)
            XCTAssertNil(result?.selectedText)
            XCTAssertNil(result?.contentDomains)
            XCTAssertFalse(ax.contentReads.contains { $0.node != "window" })
        }
        XCTAssertEqual(capture(fixture(web: false), browser: false)?.contentDomains, [])
    }

    private func capture(
        _ ax: SyntheticAX, browser: Bool = true, text: Bool = true,
        window: String? = "window", target: String? = "field",
        includeTree: Bool = true,
        includeSelectionItems: Bool = false,
        now: @escaping () -> TimeInterval = { 0 },
        bundleIdentifier: String? = nil
    ) -> CapturedObservation<String>? {
        ObservationCapture(
            access: ax,
            policy: ObservationPolicy(observation: .init(blocklist: [.init(scope: .url, urlDomain: "blocked.example")]),
                captureText: text),
            now: now
        ).capture(
            app: EventStreamApp(name: "App", secureInput: false, processIdentifier: nil,
                bundleIdentifier: bundleIdentifier ?? (browser ? "com.google.Chrome" : "test.native")),
            window: window, target: target, browser: browser, includeTree: includeTree,
            includeSelectionItems: includeSelectionItems
        )
    }

    private func fixture(web: Bool = true) -> SyntheticAX {
        let ax = SyntheticAX()
        ax.add("window", role: "AXWindow", title: "Ordinary document")
        if web { ax.add("document", role: "AXWebArea", parent: "window", url: "https://owner.example/page") }
        ax.add("field", role: "AXTextField", parent: web ? "document" : "window", value: "safe field")
        ax.attributes["field"]?["AXSelectedText"] = "selected"
        return ax
    }

    private func itemFixture() -> SyntheticAX {
        let ax = fixture()
        ax.add("list", role: "AXTable", parent: "document", value: "AGGREGATE_SECRET")
        ax.add("row", role: "AXRow", parent: "list", value: "AGGREGATE_SECRET")
        ax.add("cell", role: "AXCell", parent: "row", value: "AGGREGATE_SECRET")
        ax.add("label", role: "AXStaticText", parent: "cell", value: "build-42 failed EACCES")
        ax.add("unselected", role: "AXStaticText", parent: "list", value: "UNSELECTED")
        ax.selections["list"] = ["AXSelectedRows": ["row"]]
        return ax
    }
}

private final class SyntheticAX: ObservationAccessibility {
    var roles: [String: ObservationRole] = [:]
    var attributes: [String: [String: String]] = [:]
    var parents: [String: String] = [:]
    var childrenByNode: [String: [String]] = [:]
    var foreign = Set<String>()
    var contentReads: [(node: String, attribute: String)] = []
    var onRead: ((String, String) -> Void)?
    var onChildren: ((String) -> Void)?
    var leafChildren: (() -> [String]?)?
    var visibleRanges: [String: ObservationVisibleRange] = [:]
    var onVisibleRangeRead: ((String) -> Void)?
    var rangeReads: [(node: String, range: EventStreamTextRange)] = []
    var onRangeRead: ((String) -> Void)?
    var selectedRanges: [String: EventStreamTextRange] = [:]
    var onSelectedRangeRead: ((String) -> Void)?
    var selections: [String: [String: [String]]] = [:]
    var selectionReads: [(String, String)] = []
    var unreadableSelection = Set<String>()
    var onSelectionRead: ((String, String) -> Void)?

    func add(_ node: String, role: String?, parent: String? = nil,
             title: String? = nil, url: String? = nil, value: String? = nil) {
        roles[node] = role.map { ObservationRole($0) }
        attributes[node] = [:]
        attributes[node]?["AXTitle"] = title
        attributes[node]?["AXURL"] = url
        attributes[node]?["AXValue"] = value
        childrenByNode[node] = []
        if let parent {
            parents[node] = parent
            childrenByNode[parent, default: []].append(node)
        }
    }

    func role(_ node: String) -> ObservationRole? { roles[node] }
    func string(_ node: String, _ attribute: String) -> String? {
        if ["AXTitle", "AXValue", "AXDescription", "AXSelectedText", "AXIdentifier", "AXPlaceholderValue"].contains(attribute) {
            contentReads.append((node, attribute))
        }
        let value = attributes[node]?[attribute]
        onRead?(node, attribute)
        return value
    }
    func node(_ node: String, _ attribute: String) -> String? {
        attribute == "AXParent" ? parents[node] : nil
    }
    func children(_ node: String) -> [String]? {
        onChildren?(node)
        if childrenByNode[node]?.isEmpty == true, let leafChildren { return leafChildren() }
        return childrenByNode[node]
    }
    func owns(_ node: String) -> Bool { !foreign.contains(node) }
    func selectedRange(_ node: String) -> EventStreamTextRange? {
        let range = selectedRanges[node]
        onSelectedRangeRead?(node)
        return range
    }
    func selectedNodes(_ node: String, _ attribute: String) -> [String]? {
        selectionReads.append((node, attribute))
        let value = unreadableSelection.contains(node) ? nil : selections[node]?[attribute] ?? []
        onSelectionRead?(node, attribute)
        return value
    }
    func visibleRange(_ node: String) -> ObservationVisibleRange {
        let range = visibleRanges[node] ?? .unsupported
        onVisibleRangeRead?(node)
        return range
    }
    func text(_ node: String, in range: EventStreamTextRange) -> String? {
        rangeReads.append((node, range))
        defer { onRangeRead?(node) }
        guard let value = attributes[node]?["AXValue"] else { return nil }
        let units = Array(value.utf16)
        guard range.location <= units.count, range.length <= units.count - range.location else { return nil }
        return ObservationTextRange.decode(Array(units[range.location..<(range.location + range.length)]))
    }
}
