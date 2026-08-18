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
