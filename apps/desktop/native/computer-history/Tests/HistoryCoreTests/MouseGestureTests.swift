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

import CoreGraphics
import XCTest
@testable import HistoryCore

final class MouseGestureTests: XCTestCase {
    private let buttons: [(CGEventType, CGEventType, CGEventType, Int64)] = [
        (.leftMouseDown, .leftMouseDragged, .leftMouseUp, 0),
        (.rightMouseDown, .rightMouseDragged, .rightMouseUp, 1),
        (.otherMouseDown, .otherMouseDragged, .otherMouseUp, 2),
        (.otherMouseDown, .otherMouseDragged, .otherMouseUp, 3),
    ]

    func testOverlappingButtonsMustAllReleaseBeforeRearming() throws {
        for (firstDown, _, firstUp, firstNumber) in buttons {
            for (nextDown, _, nextUp, nextNumber) in buttons where nextNumber != firstNumber {
                var state = MouseButtonState()
                var pending: MouseGesture?
                func press(_ type: CGEventType, _ number: Int64) {
                    if state.press(type: type, number: number, hasPendingGesture: pending != nil) {
                        pending = MouseGesture(type: type, number: number, point: .zero)
                    } else {
                        pending = nil
                    }
                }
                func release(_ type: CGEventType, _ number: Int64) -> HistoryEventKind? {
                    state.release(type: type, number: number)
                    defer { pending = nil }
                    return pending?.finish(type: type, number: number, point: .zero)
                }
                press(firstDown, firstNumber)
                XCTAssertNotNil(pending)
                press(nextDown, nextNumber)
                XCTAssertNil(pending)
                XCTAssertNil(release(nextUp, nextNumber))
                press(nextDown, nextNumber)
                XCTAssertNil(pending, "Rearmed with button \(firstNumber) still held")
                XCTAssertNil(release(nextUp, nextNumber), "False action during a cancelled chord")
                XCTAssertNil(release(firstUp, firstNumber))
                press(nextDown, nextNumber)
                XCTAssertEqual(release(nextUp, nextNumber), nextNumber == 1 ? .mouseContextMenu : .mouseClick)
            }
        }
    }

    func testDuplicateMalformedReleasesAndCancelledSnapshotsDoNotForgetHeldButtons() {
        var state = MouseButtonState()
        XCTAssertTrue(state.press(type: .leftMouseDown, number: 0, hasPendingGesture: false))
        // Snapshot admission failed or focus/rotation discarded its content.
        XCTAssertFalse(state.press(type: .leftMouseDown, number: 0, hasPendingGesture: false))
        state.release(type: .rightMouseUp, number: 0)
        state.release(type: .otherMouseUp, number: 64)
        state.release(type: .keyDown, number: 0)
        XCTAssertFalse(state.press(type: .rightMouseDown, number: 1, hasPendingGesture: false))
        state.release(type: .rightMouseUp, number: 1)
        XCTAssertFalse(state.press(type: .otherMouseDown, number: 63, hasPendingGesture: false))
        state.release(type: .otherMouseUp, number: 63)
        XCTAssertFalse(state.press(type: .otherMouseDown, number: 64, hasPendingGesture: false))
        state.release(type: .leftMouseUp, number: 0)
        XCTAssertTrue(state.press(type: .otherMouseDown, number: 63, hasPendingGesture: false))
        state.release(type: .otherMouseUp, number: 63)
        XCTAssertTrue(state.press(type: .rightMouseDown, number: 1, hasPendingGesture: false))
    }

    func testTapGapReseedingRequiresKnownHeldButtonsToReleaseAndRecoversMissedUps() {
        var state = MouseButtonState(heldButtons: 1 | (UInt64(1) << 63))
        XCTAssertFalse(state.press(type: .rightMouseDown, number: 1, hasPendingGesture: false))
        state.release(type: .rightMouseUp, number: 1)
        state.release(type: .leftMouseUp, number: 0)
        XCTAssertFalse(state.press(type: .leftMouseDown, number: 0, hasPendingGesture: false))
        state.release(type: .leftMouseUp, number: 0)
        state.release(type: .otherMouseUp, number: 63)
        XCTAssertTrue(state.press(type: .leftMouseDown, number: 0, hasPendingGesture: false))
        // Tap was disabled and the up was not delivered; native re-enable supplies current state.
        state = MouseButtonState(heldButtons: 0)
        XCTAssertTrue(state.press(type: .rightMouseDown, number: 1, hasPendingGesture: false))
    }

    func testAwayThenBackRemainsDragForEveryButtonFamily() throws {
        for (down, drag, up, number) in buttons {
            var gesture = try XCTUnwrap(MouseGesture(type: down, number: number, point: .zero))
            XCTAssertTrue(gesture.dragged(type: drag, number: number, point: .init(x: 30, y: 40)))
            XCTAssertTrue(gesture.dragged(type: drag, number: number, point: .zero))
            XCTAssertEqual(gesture.finish(type: up, number: number, point: .zero), .mouseDrag)
            XCTAssertNil(gesture.finish(type: up, number: number, point: .zero))
        }
    }

    func testStationaryAndThresholdJitterRemainClicksButEndpointExcursionIsDrag() throws {
        for (down, drag, up, number) in buttons {
            for point in [CGPoint.zero, CGPoint(x: 6, y: 0), CGPoint(x: 6.01, y: 0)] {
                var gesture = try XCTUnwrap(MouseGesture(type: down, number: number, point: .zero))
                XCTAssertTrue(gesture.dragged(type: drag, number: number, point: .zero))
                XCTAssertTrue(gesture.dragged(type: drag, number: number, point: .init(x: 6, y: 0)))
                let expected: HistoryEventKind = point.x > 6 ? .mouseDrag
                    : number == 1 ? .mouseContextMenu : .mouseClick
                XCTAssertEqual(gesture.finish(type: up, number: number, point: point), expected)
            }
        }
    }

    func testMalformedButtonsAndOutOfSequenceEventsCancelWithoutRecovery() throws {
        for (type, number) in [
            (CGEventType.leftMouseDown, Int64(1)), (.rightMouseDown, 0),
            (.otherMouseDown, 0), (.otherMouseDown, -1), (.otherMouseDown, 64), (.otherMouseDown, Int64.max),
            (.leftMouseDragged, 0), (.leftMouseUp, 0), (.keyDown, 0),
        ] {
            XCTAssertNil(MouseGesture(type: type, number: number, point: .zero))
        }
        for (type, number) in [
            (CGEventType.leftMouseDragged, Int64(1)), (.rightMouseDragged, 0),
            (.otherMouseDragged, 3), (.leftMouseUp, 2), (.keyDown, 2),
        ] {
            var gesture = try XCTUnwrap(MouseGesture(type: .otherMouseDown, number: 2, point: .zero))
            XCTAssertFalse(gesture.dragged(type: type, number: number, point: .zero))
            XCTAssertFalse(gesture.dragged(type: .otherMouseDragged, number: 2, point: .init(x: 30, y: 40)))
            XCTAssertNil(gesture.finish(type: .otherMouseUp, number: 2, point: .zero))
        }
        for (type, number) in [
            (CGEventType.rightMouseUp, Int64(1)), (.leftMouseUp, 0),
            (.otherMouseUp, 3), (.otherMouseUp, -1), (.otherMouseDragged, 2),
        ] {
            var gesture = try XCTUnwrap(MouseGesture(type: .otherMouseDown, number: 2, point: .zero))
            XCTAssertNil(gesture.finish(type: type, number: number, point: .zero))
            XCTAssertNil(gesture.finish(type: .otherMouseUp, number: 2, point: .zero))
        }
    }

    func testNonFiniteGeometryCancelsAndNewGestureStartsCleanly() throws {
        for point in [CGPoint(x: CGFloat.nan, y: 0), CGPoint(x: 0, y: CGFloat.infinity)] {
            XCTAssertNil(MouseGesture(type: .leftMouseDown, number: 0, point: point))
            var gesture = try XCTUnwrap(MouseGesture(type: .leftMouseDown, number: 0, point: .zero))
            XCTAssertFalse(gesture.dragged(type: .leftMouseDragged, number: 0, point: point))
            XCTAssertNil(gesture.finish(type: .leftMouseUp, number: 0, point: .zero))
            gesture = try XCTUnwrap(MouseGesture(type: .leftMouseDown, number: 0, point: .zero))
            XCTAssertNil(gesture.finish(type: .leftMouseUp, number: 0, point: point))
            gesture = try XCTUnwrap(MouseGesture(type: .leftMouseDown, number: 0, point: .zero))
            XCTAssertEqual(gesture.finish(type: .leftMouseUp, number: 0, point: .zero), .mouseClick)
        }
    }
}
