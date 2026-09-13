// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/OpenHistory/AXTreeCapture.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import ApplicationServices
import Foundation
import HistoryCore

enum AXTreeCapture {
    static func capture(
        root: AXUIElement?,
        secureInput: Bool,
        maximumNodes: Int = 500,
        maximumDepth: Int = 14
    ) -> AXTreeRevisionSnapshot? {
        guard let root, !secureInput else {
            return nil
        }
        var lines: [Int: String] = [:]
        var visited = Set<CFHashCode>()
        var nextID = 0

        func visit(_ element: AXUIElement, depth: Int) {
            guard nextID < maximumNodes, depth <= maximumDepth else {
                return
            }
            let hash = CFHash(element)
            guard visited.insert(hash).inserted else {
                return
            }
            let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
            let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
            // Omit the entire secure subtree before it becomes opaque AX text.
            guard !ObservationPolicy.isSecureRole(role, subrole: subrole) else {
                return
            }
            let id = nextID
            nextID += 1
            lines[id] = render(element, depth: depth, role: role, subrole: subrole)
            for child in children(element) {
                visit(child, depth: depth + 1)
            }
        }
        visit(root, depth: 0)
        return AXTreeRevisionSnapshot(lines: lines)
    }

    private static func render(
        _ element: AXUIElement,
        depth: Int,
        role: String,
        subrole: String?
    ) -> String {
        var attributes: [String] = []
        append("subrole", subrole, to: &attributes)
        append("title", stringAttribute(element, kAXTitleAttribute as CFString), to: &attributes)
        append(
            "description",
            stringAttribute(element, kAXDescriptionAttribute as CFString),
            to: &attributes
        )
        append("value", stringAttribute(element, kAXValueAttribute as CFString), to: &attributes)
        append(
            "placeholder",
            stringAttribute(element, kAXPlaceholderValueAttribute as CFString),
            to: &attributes
        )
        append(
            "identifier",
            stringAttribute(element, kAXIdentifierAttribute as CFString),
            to: &attributes
        )
        if let focused = boolAttribute(element, kAXFocusedAttribute as CFString), focused {
            attributes.append("focused=true")
        }
        if let enabled = boolAttribute(element, kAXEnabledAttribute as CFString), !enabled {
            attributes.append("enabled=false")
        }
        let indentation = String(repeating: "  ", count: depth)
        return attributes.isEmpty
            ? "\(indentation)\(role)"
            : "\(indentation)\(role) \(attributes.joined(separator: " "))"
    }

    private static func append(
        _ name: String,
        _ value: String?,
        to attributes: inout [String]
    ) {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty
        else {
            return
        }
        let normalized = value
            .replacingOccurrences(of: "\n", with: "\\n")
            .prefix(500)
        attributes.append("\(name)=\"\(normalized)\"")
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXChildrenAttribute as CFString,
            &value
        ) == .success else {
            return []
        }
        return value as? [AXUIElement] ?? []
    }

    private static func stringAttribute(
        _ element: AXUIElement,
        _ name: CFString
    ) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
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

    private static func boolAttribute(
        _ element: AXUIElement,
        _ name: CFString
    ) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else {
            return nil
        }
        return value as? Bool
    }
}
