import AppKit
import ApplicationServices
import Foundation
import HistoryCore

struct AccessibilitySnapshot {
    let app: EventStreamApp
    let window: EventStreamWindow?
    let windowID: UInt32?
    let element: EventStreamAXElement?
    let selectedText: String?
    let selectedRange: EventStreamTextRange?
    let selectedItems: [EventStreamAXElement]
    let axRevision: AXTreeRevisionSnapshot?

    var dragEndpoint: EventStreamMouseDragEndpoint {
        EventStreamMouseDragEndpoint(app: app, window: window, element: element)
    }

    func replacingWindowURL(_ url: String?) -> AccessibilitySnapshot {
        AccessibilitySnapshot(
            app: app,
            window: EventStreamWindow(
                title: window?.title,
                url: url,
                windowID: nil
            ),
            windowID: windowID,
            element: element,
            selectedText: selectedText,
            selectedRange: selectedRange,
            selectedItems: selectedItems,
            axRevision: axRevision
        )
    }
}

enum AccessibilityReader {
    private static let browserBundleIdentifiers = Set([
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.google.Chrome.canary",
        "com.google.Chrome.dev",
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.Beta",
        "com.microsoft.edgemac.Canary",
        "com.microsoft.edgemac.Dev",
        "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition",
        "org.mozilla.nightly",
    ])

    static func snapshot(
        processIdentifier: pid_t,
        at point: CGPoint? = nil
    ) -> AccessibilitySnapshot? {
        guard let runningApplication = NSRunningApplication(processIdentifier: processIdentifier)
        else {
            return nil
        }

        let appElement = AXUIElementCreateApplication(processIdentifier)
        let windowElement = elementAttribute(appElement, kAXFocusedWindowAttribute as CFString)
        let focusedElement = point.flatMap {
            elementAtPosition(appElement, point: $0)
        } ?? elementAttribute(
            appElement,
            kAXFocusedUIElementAttribute as CFString
        )

        let windowTitle = stringAttribute(windowElement, kAXTitleAttribute as CFString)
        let basicURL = firstStringAttribute(
            elements: [focusedElement, windowElement, appElement],
            attributes: ["AXURL" as CFString, "AXDocument" as CFString]
        )
        let url = normalizedWebURL(basicURL)
            ?? browserURL(
                in: windowElement,
                bundleIdentifier: runningApplication.bundleIdentifier
            )
        let role = stringAttribute(focusedElement, kAXRoleAttribute as CFString)
        let subrole = stringAttribute(focusedElement, kAXSubroleAttribute as CFString)
        let secureInput = ObservationPolicy.isSecureRole(role, subrole: subrole)
        let element = focusedElement.map {
            eventElement($0, includeValue: !secureInput)
        }

        let resolvedWindowID = windowID(
            processIdentifier: processIdentifier,
            title: windowTitle
        )
        return AccessibilitySnapshot(
            app: EventStreamApp(
                name: runningApplication.localizedName,
                secureInput: secureInput,
                processIdentifier: nil,
                bundleIdentifier: runningApplication.bundleIdentifier
            ),
            window: EventStreamWindow(
                title: windowTitle,
                url: url,
                windowID: nil
            ),
            windowID: resolvedWindowID,
            element: element,
            selectedText: secureInput
                ? nil
                : stringAttribute(focusedElement, kAXSelectedTextAttribute as CFString),
            selectedRange: selectedRangeAttribute(focusedElement),
            selectedItems: secureInput ? [] : selectedItems(from: focusedElement),
            axRevision: AXTreeCapture.capture(
                root: windowElement ?? focusedElement,
                secureInput: secureInput
            )
        )
    }

    private static func eventElement(
        _ element: AXUIElement,
        includeValue: Bool
    ) -> EventStreamAXElement {
        EventStreamAXElement(
            role: stringAttribute(element, kAXRoleAttribute as CFString),
            subrole: stringAttribute(element, kAXSubroleAttribute as CFString),
            title: stringAttribute(element, kAXTitleAttribute as CFString),
            description: stringAttribute(element, kAXDescriptionAttribute as CFString),
            value: includeValue ? stringAttribute(element, kAXValueAttribute as CFString) : nil,
            placeholder: stringAttribute(element, kAXPlaceholderValueAttribute as CFString),
            identifier: stringAttribute(element, kAXIdentifierAttribute as CFString)
        )
    }

    private static func selectedItems(from element: AXUIElement?) -> [EventStreamAXElement] {
        for attributeName in [
            kAXSelectedChildrenAttribute as CFString,
            kAXSelectedRowsAttribute as CFString,
        ] {
            guard let raw = attribute(element, attributeName) as? [AXUIElement] else {
                continue
            }
            return raw.prefix(50).map { eventElement($0, includeValue: true) }
        }
        return []
    }

    private static func firstStringAttribute(
        elements: [AXUIElement?],
        attributes: [CFString]
    ) -> String? {
        for element in elements.compactMap({ $0 }) {
            for attribute in attributes {
                if let value = stringAttribute(element, attribute), !value.isEmpty {
                    return value
                }
            }
        }
        return nil
    }

    private static func browserURL(
        in root: AXUIElement?,
        bundleIdentifier: String?
    ) -> String? {
        guard let root,
              let bundleIdentifier,
              browserBundleIdentifiers.contains(bundleIdentifier)
        else {
            return nil
        }
        var queue = [root]
        var visited = Set<CFHashCode>()
        var count = 0
        while !queue.isEmpty, count < 500 {
            let element = queue.removeFirst()
            count += 1
            guard visited.insert(CFHash(element)).inserted else {
                continue
            }
            for attribute in ["AXURL" as CFString, "AXDocument" as CFString] {
                if let url = normalizedWebURL(stringAttribute(element, attribute)) {
                    return url
                }
            }
            let role = stringAttribute(element, kAXRoleAttribute as CFString)
            let label = [
                stringAttribute(element, kAXTitleAttribute as CFString),
                stringAttribute(element, kAXDescriptionAttribute as CFString),
                stringAttribute(element, kAXIdentifierAttribute as CFString),
            ].compactMap { $0 }.joined(separator: " ").lowercased()
            if role == kAXTextFieldRole as String,
               (label.contains("address") || label.contains("search"))
            {
                if let url = normalizedWebURL(
                    stringAttribute(element, kAXValueAttribute as CFString)
                ) {
                    return url
                }
            }
            queue.append(contentsOf: childElements(element))
        }
        return nil
    }

    private static func normalizedWebURL(_ value: String?) -> String? {
        guard let value,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return url.absoluteString
    }

    private static func childElements(_ element: AXUIElement) -> [AXUIElement] {
        guard let value = attribute(element, kAXChildrenAttribute as CFString) else {
            return []
        }
        return value as? [AXUIElement] ?? []
    }

    private static func selectedRangeAttribute(
        _ element: AXUIElement?
    ) -> EventStreamTextRange? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute as CFString),
              CFGetTypeID(value) == AXValueGetTypeID()
        else {
            return nil
        }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else {
            return nil
        }
        return EventStreamTextRange(location: range.location, length: range.length)
    }

    private static func windowID(processIdentifier: pid_t, title: String?) -> UInt32? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        let candidates = windows.filter {
            ($0[kCGWindowOwnerPID as String] as? Int32) == processIdentifier
        }
        let match = candidates.first {
            guard let title, !title.isEmpty else {
                return true
            }
            return ($0[kCGWindowName as String] as? String) == title
        } ?? candidates.first
        return (match?[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }

    private static func elementAttribute(
        _ element: AXUIElement?,
        _ name: CFString
    ) -> AXUIElement? {
        guard let value = attribute(element, name),
              CFGetTypeID(value) == AXUIElementGetTypeID()
        else {
            return nil
        }
        return (value as! AXUIElement)
    }

    private static func elementAtPosition(
        _ application: AXUIElement,
        point: CGPoint
    ) -> AXUIElement? {
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            application,
            Float(point.x),
            Float(point.y),
            &element
        ) == .success else {
            return nil
        }
        return element
    }

    private static func stringAttribute(
        _ element: AXUIElement?,
        _ name: CFString
    ) -> String? {
        guard let value = attribute(element, name) else {
            return nil
        }
        if let string = value as? String {
            return string
        }
        if let url = value as? URL {
            return url.absoluteString
        }
        return nil
    }

    private static func attribute(
        _ element: AXUIElement?,
        _ name: CFString
    ) -> CFTypeRef? {
        guard let element else {
            return nil
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
            return nil
        }
        return value
    }
}
