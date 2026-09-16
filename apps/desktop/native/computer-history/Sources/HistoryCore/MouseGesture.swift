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

/// Admission for a press sequence, separate from its content-bearing snapshot.
public struct MouseButtonState {
    private var heldButtons: UInt64

    public init(heldButtons: UInt64 = 0) {
        self.heldButtons = heldButtons
    }

    public mutating func press(type: CGEventType, number: Int64, hasPendingGesture: Bool) -> Bool {
        guard let mask = Self.mask(type: type, number: number, down: true) else { return false }
        let admitted = heldButtons == 0 && !hasPendingGesture
        heldButtons |= mask
        return admitted
    }

    public mutating func release(type: CGEventType, number: Int64) {
        guard let mask = Self.mask(type: type, number: number, down: false) else { return }
        heldButtons &= ~mask
    }

    private static func mask(type: CGEventType, number: Int64, down: Bool) -> UInt64? {
        let types: [CGEventType] = down
            ? [.leftMouseDown, .rightMouseDown, .otherMouseDown]
            : [.leftMouseUp, .rightMouseUp, .otherMouseUp]
        guard types.contains(type), MouseGesture.button(type: type, number: number) != nil else { return nil }
        return UInt64(1) << number
    }
}

/// Tracks only mouse geometry and button identity, never observed content.
public struct MouseGesture {
    public let button: String
    private let number: Int64
    private let origin: CGPoint
    private var cancelled = false
    private var exceededDragThreshold = false

    public init?(type: CGEventType, number: Int64, point: CGPoint) {
        guard [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type),
              let button = Self.button(type: type, number: number),
              point.x.isFinite, point.y.isFinite else { return nil }
        self.button = button
        self.number = number
        self.origin = point
    }

    /// Mismatched events invalidate the entire pending gesture.
    public mutating func dragged(type: CGEventType, number: Int64, point: CGPoint) -> Bool {
        guard [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type),
              matches(type: type, number: number, point: point) else {
            cancelled = true
            return false
        }
        // Returning to the press location does not undo an observed excursion.
        exceededDragThreshold = exceededDragThreshold || hypot(point.x - origin.x, point.y - origin.y) > 6
        return true
    }

    /// Returns the observed gesture, not whether an application completed it.
    public mutating func finish(type: CGEventType, number: Int64, point: CGPoint) -> HistoryEventKind? {
        defer { cancelled = true }
        guard [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type),
              matches(type: type, number: number, point: point) else { return nil }
        if exceededDragThreshold || hypot(point.x - origin.x, point.y - origin.y) > 6 { return .mouseDrag }
        return button == "right" ? .mouseContextMenu : .mouseClick
    }

    private func matches(type: CGEventType, number: Int64, point: CGPoint) -> Bool {
        !cancelled && number == self.number && Self.button(type: type, number: number) == button &&
            point.x.isFinite && point.y.isFinite
    }

    fileprivate static func button(type: CGEventType, number: Int64) -> String? {
        switch type {
        case .leftMouseDown, .leftMouseDragged, .leftMouseUp:
            return number == 0 ? "left" : nil
        case .rightMouseDown, .rightMouseDragged, .rightMouseUp:
            return number == 1 ? "right" : nil
        case .otherMouseDown, .otherMouseDragged, .otherMouseUp:
            return (2..<64).contains(number) ? "other" : nil
        default:
            return nil
        }
    }
}
