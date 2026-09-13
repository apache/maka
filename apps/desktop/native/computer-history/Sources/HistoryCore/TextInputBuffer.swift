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

import Foundation

/// Source identity excludes the changing control value but includes focus and
/// URL, so typing in two tabs/fields cannot share an attribution.
public struct TextInputSource {
    public let app: EventStreamApp
    public let window: EventStreamWindow?
    public let element: EventStreamAXElement?
    public let processIdentifier: Int32
    public let windowIdentifier: UInt32?
    public let focusIdentifier: UInt?

    public init(
        app: EventStreamApp,
        window: EventStreamWindow?,
        element: EventStreamAXElement?,
        processIdentifier: Int32,
        windowIdentifier: UInt32?,
        focusIdentifier: UInt?
    ) {
        self.app = app
        self.window = window
        self.element = element
        self.processIdentifier = processIdentifier
        self.windowIdentifier = windowIdentifier
        self.focusIdentifier = focusIdentifier
    }

    func matches(_ other: Self) -> Bool {
        app == other.app && window == other.window &&
            processIdentifier == other.processIdentifier &&
            windowIdentifier == other.windowIdentifier &&
            focusIdentifier == other.focusIdentifier &&
            element?.role == other.element?.role &&
            element?.subrole == other.element?.subrole &&
            element?.identifier == other.element?.identifier &&
            element?.title == other.element?.title
    }
}

public struct BufferedTextInput {
    public let source: TextInputSource
    public fileprivate(set) var text: String?

    public func event(id: Int, timestamp: Date) -> HistoryEvent {
        HistoryEvent(
            id: id,
            timestamp: timestamp,
            kind: .keyboardTextInput,
            app: source.app,
            window: source.window,
            keyboard: EventStreamKeyboardInteraction(
                text: text, keyEquivalent: nil, modifiers: [], target: source.element
            )
        )
    }
}

public struct TextInputBuffer {
    private var pending: BufferedTextInput?

    public init() {}

    /// Admission precedes evaluating characters. Rejected input clears prior
    /// work; a source change returns the old burst under its original context.
    public mutating func append(
        characters: () -> String,
        source: TextInputSource?,
        policy: ObservationPolicy
    ) -> BufferedTextInput? {
        guard let source, policy.allowsObservation(
            app: source.app, window: source.window, element: source.element
        ) else {
            discard()
            return nil
        }
        let completed = pending.map {
            !$0.source.matches(source) || ($0.text != nil) != policy.captureText
        } == true ? drain() : nil
        if policy.captureText {
            let text = characters()
            if !text.isEmpty {
                if pending == nil { pending = BufferedTextInput(source: source, text: "") }
                pending?.text?.append(text)
            }
        } else if pending == nil {
            pending = BufferedTextInput(source: source, text: nil)
        }
        return completed
    }

    public mutating func drain() -> BufferedTextInput? {
        defer { pending = nil }
        return pending
    }

    public mutating func discard() {
        pending = nil
    }
}
