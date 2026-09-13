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

final class TextInputBufferTests: XCTestCase {
    func testRejectedContextsNeverReadCharactersOrContaminateNextAllowedSource() {
        for captureText in [true, false] {
            let policy = ObservationPolicy(
                observation: .init(blocklist: [
                    .init(scope: .url, urlDomain: "blocked.example"),
                    .init(scope: .application, bundleID: "blocked.app"),
                ]), captureText: captureText
            )
            for rejected in [
                nil, source(url: "https://blocked.example"),
                source(bundle: "blocked.app"), source(title: "Incognito"),
                source(secure: true), source(subrole: "AXSecureTextField"),
            ] {
                var buffer = TextInputBuffer()
                _ = buffer.append(characters: { "before" }, source: source(), policy: policy)
                var readCharacters = false
                XCTAssertNil(buffer.append(characters: {
                    readCharacters = true
                    return "SECRET"
                }, source: rejected, policy: policy))
                XCTAssertFalse(readCharacters)
                XCTAssertNil(buffer.drain())
                _ = buffer.append(characters: { "allowed" }, source: source(), policy: policy)
                let result = buffer.drain()
                XCTAssertNotNil(result)
                XCTAssertEqual(result?.text, captureText ? "allowed" : nil)
            }
        }
    }

    func testEverySourceTransitionKeepsOldAttributionIncludingSameProcessTabsAndFields() {
        let first = source()
        for second in [
            source(url: "https://allowed.example/other"),
            source(title: "Second tab"),
            source(windowID: 2),
            source(focusID: 2),
            source(processID: 2),
            source(bundle: "com.apple.Safari"),
        ] {
            var buffer = TextInputBuffer()
            let policy = ObservationPolicy(captureText: true)
            _ = buffer.append(characters: { "first " }, source: first, policy: policy)
            _ = buffer.append(characters: { "field" }, source: first, policy: policy)
            let completed = buffer.append(characters: { "second" }, source: second, policy: policy)
            XCTAssertEqual(completed?.text, "first field")
            XCTAssertTrue(completed?.source.matches(first) == true)
            let pending = buffer.drain()
            XCTAssertEqual(pending?.text, "second")
            XCTAssertTrue(pending?.source.matches(second) == true)
        }
    }

    func testMetadataBurstDoesNotEvaluateTextAndDiscardClearsPendingContent() {
        var buffer = TextInputBuffer()
        var reads = 0
        _ = buffer.append(characters: { reads += 1; return "SECRET" },
                          source: source(), policy: ObservationPolicy(captureText: false))
        let event = buffer.drain()?.event(id: 1, timestamp: Date())
        XCTAssertEqual(reads, 0)
        XCTAssertNotNil(event?.keyboard)
        XCTAssertNil(event?.keyboard?.text)
        _ = buffer.append(characters: { "SECRET" },
                          source: source(), policy: ObservationPolicy(captureText: true))
        buffer.discard()
        XCTAssertNil(buffer.drain())
    }

    func testBurstByteAndAgeLimitsDoNotMergeIndefinitely() {
        var buffer = TextInputBuffer()
        let policy = ObservationPolicy(captureText: true)
        _ = buffer.append(characters: { String(repeating: "x", count: 8_190) }, source: source(), policy: policy, now: 0)
        let full = buffer.append(characters: { "\u{1F600}" }, source: source(), policy: policy, now: 0.1)
        XCTAssertEqual(full?.text?.utf8.count, 8_190)
        let aged = buffer.append(characters: { "next" }, source: source(), policy: policy, now: 2.1)
        XCTAssertEqual(aged?.text, "\u{1F600}")
        XCTAssertEqual(buffer.drain()?.text, "next")
        _ = buffer.append(characters: { String(repeating: "\u{1F600}", count: 10_000) },
            source: source(), policy: policy, now: 3)
        XCTAssertEqual(buffer.drain()?.text?.utf8.count, TextInputBuffer.maximumBytes)
    }

    func testBufferedEvidenceRetainsDomainsAndUnavailableInputDiscardsWithoutReading() throws {
        func marked(_ state: HistoryEvent.ContentState, domains: [String]) -> TextInputSource {
            let base = source()
            return TextInputSource(app: base.app, window: base.window, element: base.element,
                processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
                sourceId: "41f613a8-1b3e-4ca3-a001-e8c4f3a4ef46", contentState: state, contentDomains: domains)
        }
        var buffer = TextInputBuffer()
        let first = marked(.available, domains: ["first.example", "owner.example"])
        let second = marked(.available, domains: ["owner.example", "second.example"])
        _ = buffer.append(characters: { "first" }, source: first, policy: .init(), now: 0)
        let completed = buffer.append(characters: { "second" }, source: second, policy: .init(), now: 0.1)
        let event = try XCTUnwrap(completed).event(id: 1, timestamp: Date())
        XCTAssertEqual(event.contentDomains, first.contentDomains)
        XCTAssertEqual(event.sourceId, first.sourceId)
        XCTAssertEqual(event.contentState, .available)
        XCTAssertEqual(event.keyboard?.text, "first")
        var read = false
        _ = buffer.append(characters: { read = true; return "SECRET" },
            source: marked(.unavailable, domains: []), policy: .init(), now: 0.2)
        XCTAssertFalse(read)
        XCTAssertNil(buffer.drain())
    }

    func testBlockedEmbeddedDomainIsRejectedBeforeReadingCharacters() {
        let base = source()
        let blocked = TextInputSource(app: base.app, window: base.window, element: base.element,
            processIdentifier: 1, windowIdentifier: nil, focusIdentifier: 1,
            sourceId: "window", contentState: .available, contentDomains: ["allowed.example", "blocked.example"])
        let policy = ObservationPolicy(observation: .init(blocklist: [.init(scope: .url, urlDomain: "blocked.example")]))
        var buffer = TextInputBuffer()
        _ = buffer.append(characters: { "before" }, source: base, policy: policy)
        var reads = 0
        XCTAssertNil(buffer.append(characters: { reads += 1; return "CANARY" }, source: blocked, policy: policy))
        XCTAssertEqual(reads, 0)
        XCTAssertNil(buffer.drain())
    }

    private func source(
        bundle: String = "com.google.Chrome",
        title: String = "Ordinary tab",
        url: String = "https://allowed.example/first",
        secure: Bool = false,
        subrole: String? = nil,
        windowID: UInt32 = 1,
        focusID: UInt = 1,
        processID: Int32 = 1
    ) -> TextInputSource {
        TextInputSource(
            app: .init(name: "Browser", secureInput: secure,
                       processIdentifier: nil, bundleIdentifier: bundle),
            window: .init(title: title, url: url, windowID: nil),
            element: .init(role: "AXTextField", subrole: subrole, title: "Field",
                           description: nil, value: nil, placeholder: nil, identifier: nil),
            processIdentifier: processID, windowIdentifier: windowID, focusIdentifier: focusID
        )
    }
}
