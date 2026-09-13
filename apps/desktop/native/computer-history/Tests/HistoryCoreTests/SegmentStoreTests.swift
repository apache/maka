// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Tests/HistoryCoreTests/SegmentStoreTests.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import XCTest
@testable import HistoryCore

final class SegmentStoreTests: XCTestCase {
    func testSuppressedEventsAreCountedWithoutBeingPersisted() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = try SegmentStore(homeURL: root)
        let event = HistoryEvent(
            id: 1,
            timestamp: Date(),
            kind: .keyboardTextInput,
            app: EventStreamApp(
                name: "Fixture",
                secureInput: true,
                processIdentifier: nil,
                bundleIdentifier: "dev.opencomputerhistory.fixture"
            )
        )
        try store.appendSuppressed(event)
        try store.finish(reason: "test")

        XCTAssertNil(store.suppressedEventsURL)
        XCTAssertEqual(store.suppressedEventCount, 1)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let metadata = try decoder.decode(
            SegmentMetadata.self,
            from: Data(contentsOf: store.metadataURL)
        )
        XCTAssertEqual(metadata.suppressedEventCount, 1)
    }
}
