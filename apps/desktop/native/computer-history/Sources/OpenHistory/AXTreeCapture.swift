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
        guard let root else {
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
            let id = nextID
            nextID += 1
            lines[id] = render(element, depth: depth, secureInput: secureInput)
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
        secureInput: Bool
    ) -> String {
        let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        var attributes: [String] = []
        append("subrole", stringAttribute(element, kAXSubroleAttribute as CFString), to: &attributes)
        append("title", stringAttribute(element, kAXTitleAttribute as CFString), to: &attributes)
        append(
            "description",
            stringAttribute(element, kAXDescriptionAttribute as CFString),
            to: &attributes
        )
        if !secureInput && role != "AXSecureTextField" {
            append("value", stringAttribute(element, kAXValueAttribute as CFString), to: &attributes)
        }
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
