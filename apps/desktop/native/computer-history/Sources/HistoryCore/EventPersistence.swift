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

extension ObservationPolicy {
    /// Reject sensitive contexts before a producer retains delayed content.
    public func allowsObservation(
        app: EventStreamApp?,
        window: EventStreamWindow?,
        element: EventStreamAXElement?
    ) -> Bool {
        app != nil && !suppressesContext(app: app, window: window) &&
            !Self.isSecureRole(element?.role, subrole: element?.subrole)
    }

    /// Projects the complete event immediately before persistence. A nil result
    /// suppresses the event; session boundaries retain only their identity.
    func eventForPersistence(_ event: HistoryEvent) -> HistoryEvent? {
        let endpoints = [event.mouse?.origin, event.mouse?.destination].compactMap { $0 }
        let elements = [
            event.mouse?.target,
            event.keyboard?.target,
            event.selection?.target,
        ].compactMap { $0 }
            + endpoints.compactMap(\.element)
            + (event.selection?.selectedItems ?? [])
        let suppressed = suppressesContext(app: event.app, window: event.window)
            || endpoints.contains {
                suppressesContext(app: $0.app ?? event.app, window: $0.window)
            }
            || elements.contains {
                Self.isSecureRole($0.role, subrole: $0.subrole)
            }
        if suppressed {
            return event.kind == .sessionStarted || event.kind == .sessionEnded
                ? event.persistenceIdentity
                : nil
        }
        guard !captureText else {
            return event
        }

        return HistoryEvent(
            id: event.id,
            timestamp: event.timestamp,
            kind: event.kind,
            app: event.app,
            window: event.window.map(Self.metadataWindow),
            mouse: event.mouse.map {
                EventStreamMouseInteraction(
                    button: $0.button,
                    clickCount: $0.clickCount,
                    modifiers: $0.modifiers,
                    target: $0.target.map(Self.metadataElement),
                    origin: $0.origin.map(Self.metadataEndpoint),
                    destination: $0.destination.map(Self.metadataEndpoint)
                )
            },
            keyboard: event.keyboard.map {
                EventStreamKeyboardInteraction(
                    text: nil,
                    keyEquivalent: nil,
                    modifiers: $0.modifiers,
                    target: $0.target.map(Self.metadataElement)
                )
            },
            selection: event.selection.map {
                EventStreamSelection(
                    target: $0.target.map(Self.metadataElement),
                    selectedText: nil,
                    selectedRange: $0.selectedRange,
                    selectedItems: $0.selectedItems.map(Self.metadataElement)
                )
            }
        )
    }

    private func suppressesContext(
        app: EventStreamApp?,
        window: EventStreamWindow?
    ) -> Bool {
        app?.secureInput == true || shouldSuppress(
            bundleIdentifier: app?.bundleIdentifier ?? "",
            windowTitle: window?.title,
            urlDomain: Self.normalizedDomain(window?.url),
            role: nil,
            subrole: nil
        ) != nil
    }

    private static func metadataElement(_ element: EventStreamAXElement) -> EventStreamAXElement {
        EventStreamAXElement(
            role: element.role,
            subrole: element.subrole,
            title: nil,
            description: nil,
            value: nil,
            placeholder: nil,
            identifier: nil
        )
    }

    private static func metadataEndpoint(
        _ endpoint: EventStreamMouseDragEndpoint
    ) -> EventStreamMouseDragEndpoint {
        EventStreamMouseDragEndpoint(
            app: endpoint.app,
            window: endpoint.window.map(metadataWindow),
            element: endpoint.element.map(metadataElement)
        )
    }

    private static func metadataWindow(_ window: EventStreamWindow) -> EventStreamWindow {
        EventStreamWindow(
            title: window.title,
            url: domainURL(window.url),
            windowID: window.windowID
        )
    }

    private static func domainURL(_ value: String?) -> String? {
        guard let value,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty
        else {
            return nil
        }
        // Construct a new URL so credentials, port, path, query and fragment
        // cannot survive. Unparseable input must not fall back to the raw text.
        var domain = URLComponents()
        domain.scheme = scheme
        domain.host = host
        return domain.string
    }
}

extension HistoryEvent {
    var persistenceIdentity: HistoryEvent {
        HistoryEvent(id: id, timestamp: timestamp, kind: kind)
    }
}
