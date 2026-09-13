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
            window: window, target: target, browser: browser, includeTree: includeTree
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
    func selectedRange(_ node: String) -> EventStreamTextRange? { nil }
}
