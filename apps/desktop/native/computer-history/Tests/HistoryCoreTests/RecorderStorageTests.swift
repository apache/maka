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
import XCTest
@testable import HistoryCore
@testable import OpenHistory

final class RecorderStorageTests: XCTestCase {
    private enum Failure: Error { case injected }

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
