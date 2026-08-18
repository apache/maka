import XCTest
@testable import HistoryCore

final class HistoryMaintenanceTests: XCTestCase {
    func testClearLastTenMinutesFiltersEventsAndMemories() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let segment = root
            .appendingPathComponent("segments", isDirectory: true)
            .appendingPathComponent("fixture", isDirectory: true)
        let memories = root
            .appendingPathComponent("memories", isDirectory: true)
            .appendingPathComponent("resources", isDirectory: true)
        try FileManager.default.createDirectory(
            at: segment,
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: memories,
            withIntermediateDirectories: true
        )

        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let oldEvent = HistoryEvent(
            id: 1,
            timestamp: now.addingTimeInterval(-1_000),
            kind: .windowChanged
        )
        let recentEvent = HistoryEvent(
            id: 2,
            timestamp: now.addingTimeInterval(-60),
            kind: .windowChanged
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let eventLines = try [oldEvent, recentEvent]
            .map { String(decoding: try encoder.encode($0), as: UTF8.self) }
            .joined(separator: "\n") + "\n"
        try eventLines.write(
            to: segment.appendingPathComponent("events.jsonl"),
            atomically: true,
            encoding: .utf8
        )
        try "".write(
            to: segment.appendingPathComponent("suppressed.jsonl"),
            atomically: true,
            encoding: .utf8
        )
        let metadata = SegmentMetadata(
            id: "fixture",
            eventsPath: segment.appendingPathComponent("events.jsonl").path,
            startedAt: oldEvent.timestamp,
            endedAt: now,
            endReason: "test",
            eventCount: 2,
            suppressedEventCount: 0
        )
        try encoder.encode(metadata).write(
            to: segment.appendingPathComponent("metadata.json")
        )
        let memoryURL = memories.appendingPathComponent(
            "2023-11-14T22-12-20Z-abcd-10min-activity.md"
        )
        try "# memory".write(
            to: memoryURL,
            atomically: true,
            encoding: .utf8
        )

        let result = try HistoryMaintenance.clear(
            homeURL: root,
            scope: .lastTenMinutes,
            now: now
        )
        XCTAssertEqual(result.deletedEventCount, 1)
        let remaining = try String(
            contentsOf: segment.appendingPathComponent("events.jsonl")
        )
        XCTAssertTrue(remaining.contains("\"id\":1"))
        XCTAssertFalse(remaining.contains("\"id\":2"))
    }

    func testClearLatestApplicationSessionOnlyRemovesTargetApp() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let segment = root
            .appendingPathComponent("segments", isDirectory: true)
            .appendingPathComponent("fixture", isDirectory: true)
        try FileManager.default.createDirectory(
            at: segment,
            withIntermediateDirectories: true
        )
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        let editorApp = EventStreamApp(
            name: "Editor",
            secureInput: false,
            processIdentifier: 1,
            bundleIdentifier: "com.example.Editor"
        )
        let browserApp = EventStreamApp(
            name: "Browser",
            secureInput: false,
            processIdentifier: 2,
            bundleIdentifier: "com.example.Browser"
        )
        let events = [
            HistoryEvent(id: 1, timestamp: base, kind: .windowChanged, app: editorApp),
            HistoryEvent(
                id: 2,
                timestamp: base.addingTimeInterval(10),
                kind: .windowChanged,
                app: browserApp
            ),
            HistoryEvent(
                id: 3,
                timestamp: base.addingTimeInterval(20),
                kind: .windowChanged,
                app: editorApp
            ),
            HistoryEvent(
                id: 4,
                timestamp: base.addingTimeInterval(30),
                kind: .keyboardShortcut,
                app: editorApp
            ),
        ]
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let lines = try events.map {
            String(decoding: try encoder.encode($0), as: UTF8.self)
        }.joined(separator: "\n") + "\n"
        try lines.write(
            to: segment.appendingPathComponent("events.jsonl"),
            atomically: true,
            encoding: .utf8
        )
        try "".write(
            to: segment.appendingPathComponent("suppressed.jsonl"),
            atomically: true,
            encoding: .utf8
        )

        let result = try HistoryMaintenance.clear(
            homeURL: root,
            scope: .applicationSession(bundleIdentifier: "com.example.Editor"),
            now: base.addingTimeInterval(60)
        )
        XCTAssertEqual(result.deletedEventCount, 2)
        let remaining = try String(
            contentsOf: segment.appendingPathComponent("events.jsonl")
        )
        XCTAssertTrue(remaining.contains("\"id\":1"))
        XCTAssertTrue(remaining.contains("\"id\":2"))
        XCTAssertFalse(remaining.contains("\"id\":3"))
        XCTAssertFalse(remaining.contains("\"id\":4"))
    }
}
