// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Tests/HistoryCoreTests/SegmentStoreTests.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import XCTest
@testable import HistoryCore

final class SegmentStoreTests: XCTestCase {
    private enum Failure: Error { case injected }

    private func metadata(_ store: SegmentStore) throws -> SegmentMetadata {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(SegmentMetadata.self, from: Data(contentsOf: store.metadataURL))
    }

    func testSealSynchronizesAllEventsBeforePublishingAndNeverAcceptsLaterAppends() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var operations: [String] = []
        var io = SegmentStore.IO()
        io.synchronize = { handle in operations.append("sync"); try handle.synchronize() }
        io.metadata = { data, url in
            operations.append("metadata")
            try data.write(to: url, options: .atomic)
        }
        let store = try SegmentStore(homeURL: root, persistSuppressedEvents: true, io: io)
        try store.append(HistoryEvent(id: 1, timestamp: Date(), kind: .sessionStarted), policy: .init())
        try store.appendSuppressed(HistoryEvent(id: 2, timestamp: Date(), kind: .uiChanged))
        operations.removeAll()
        try store.stop(event: HistoryEvent(id: 3, timestamp: Date(), kind: .sessionEnded),
            policy: .init(), reason: "test")
        XCTAssertEqual(operations, ["sync", "sync", "metadata"])
        let before = try Data(contentsOf: store.eventsURL)
        XCTAssertEqual(try metadata(store).eventCount, 2)
        XCTAssertEqual(try metadata(store).suppressedEventCount, 1)
        XCTAssertNotNil(try metadata(store).endedAt)
        XCTAssertTrue(store.sealed)
        XCTAssertThrowsError(try store.append(HistoryEvent(id: 4, timestamp: Date(), kind: .debugError), policy: .init()))
        XCTAssertThrowsError(try store.appendSuppressed(HistoryEvent(id: 5, timestamp: Date(), kind: .uiChanged)))
        try store.stop(event: HistoryEvent(id: 6, timestamp: Date(), kind: .sessionEnded), policy: .init(), reason: "again")
        XCTAssertEqual(try Data(contentsOf: store.eventsURL), before)
        XCTAssertEqual(operations.count, 3)
    }

    func testPartialEventWriteAndSealFailuresRemainUnsealedAndCannotBeRetriedAsSuccess() throws {
        for failurePoint in ["write", "eventSync", "suppressedSync", "metadata"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            var armed = false
            var syncCount = 0
            var io = SegmentStore.IO()
            io.write = { data, handle in
                if armed && failurePoint == "write" {
                    try handle.write(contentsOf: data.prefix(7))
                    throw Failure.injected
                }
                try handle.write(contentsOf: data)
            }
            io.synchronize = { handle in
                syncCount += 1
                if armed && ((failurePoint == "eventSync" && syncCount == 1) ||
                    (failurePoint == "suppressedSync" && syncCount == 2)) { throw Failure.injected }
                try handle.synchronize()
            }
            io.metadata = { data, url in
                if armed && failurePoint == "metadata" { throw Failure.injected }
                try data.write(to: url, options: .atomic)
            }
            let store = try SegmentStore(homeURL: root, persistSuppressedEvents: true, io: io)
            try store.append(HistoryEvent(id: 1, timestamp: Date(), kind: .sessionStarted), policy: .init())
            armed = true
            XCTAssertThrowsError(try store.stop(event: HistoryEvent(id: 2, timestamp: Date(), kind: .sessionEnded),
                policy: .init(), reason: "test"), failurePoint)
            let failedBytes = try Data(contentsOf: store.eventsURL)
            XCTAssertNil(try metadata(store).endedAt, failurePoint)
            XCTAssertFalse(store.sealed)
            armed = false
            XCTAssertThrowsError(try store.finish(reason: "retry"), failurePoint)
            XCTAssertThrowsError(try store.append(HistoryEvent(id: 3, timestamp: Date(), kind: .debugError), policy: .init()))
            XCTAssertEqual(try Data(contentsOf: store.eventsURL), failedBytes)
            XCTAssertNil(try metadata(store).endedAt)
            if failurePoint == "write" { XCTAssertEqual(store.eventCount, 1) }
        }
    }

    func testRotationAllocationFailureCannotAppendToSealedSegmentAndSuccessCreatesStandaloneStore() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let old = try SegmentStore(homeURL: root)
        try old.append(HistoryEvent(id: 1, timestamp: Date(), kind: .sessionStarted), policy: .init())
        var current = old
        XCTAssertThrowsError(current = try current.rotated(now: Date()) { throw Failure.injected })
        XCTAssertTrue(current === old)
        XCTAssertNotNil(try metadata(old).endedAt)
        let sealedBytes = try Data(contentsOf: old.eventsURL)
        XCTAssertThrowsError(try current.append(HistoryEvent(id: 2, timestamp: Date(), kind: .debugError), policy: .init()))
        try current.stop(event: HistoryEvent(id: 3, timestamp: Date(), kind: .sessionEnded), policy: .init(), reason: "failed")
        XCTAssertEqual(try Data(contentsOf: old.eventsURL), sealedBytes)
        XCTAssertThrowsError(try old.rotated())
        let healthy = try SegmentStore(homeURL: root)
        current = try healthy.rotated()
        XCTAssertNotEqual(current.segmentID, old.segmentID)
        XCTAssertTrue(healthy.sealed)
        XCTAssertNil(try metadata(current).endedAt)
        XCTAssertEqual(current.eventCount, 0)
        try current.stop(event: HistoryEvent(id: 4, timestamp: Date(), kind: .sessionEnded), policy: .init(), reason: "test")
        XCTAssertEqual(try metadata(current).eventCount, 1)
    }

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
