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

import ApplicationServices
import Foundation

/// The ranged AX API can reject index zero for an empty array. Only a
/// successful zero count proves a leaf; messaging failures remain unreadable.
public enum AXChildrenReader {
    public static func read(
        _ element: AXUIElement,
        attribute: CFString = kAXChildrenAttribute as CFString,
        limit: Int = 257,
        withinBudget: () -> Bool,
        copyValues: (AXUIElement, CFString, CFIndex, CFIndex, UnsafeMutablePointer<CFArray?>) -> AXError = {
            AXUIElementCopyAttributeValues($0, $1, $2, $3, $4)
        },
        valueCount: (AXUIElement, CFString, UnsafeMutablePointer<CFIndex>) -> AXError = {
            AXUIElementGetAttributeValueCount($0, $1, $2)
        }
    ) -> [AXUIElement]? {
        guard withinBudget() else { return nil }
        var values: CFArray?
        let result = copyValues(element, attribute, 0, limit, &values)
        guard withinBudget() else { return nil }
        if result == .attributeUnsupported || result == .noValue { return [] }
        if result == .illegalArgument {
            var count: CFIndex = -1
            guard valueCount(element, attribute, &count) == .success,
                  withinBudget(), count == 0 else { return nil }
            return []
        }
        guard result == .success, let values,
              (values as NSArray).allSatisfy({ CFGetTypeID($0 as CFTypeRef) == AXUIElementGetTypeID() })
        else { return nil }
        return (values as NSArray).map { $0 as! AXUIElement }
    }
}

/// Platform reads are injectable so source ownership and redaction use the same
/// code for real AX handles and deterministic synthetic trees.
public protocol ObservationAccessibility {
    associatedtype Node: Hashable
    /// Nil means an unreadable role/security context, not an absent subrole.
    func role(_ node: Node) -> ObservationRole?
    func string(_ node: Node, _ attribute: String) -> String?
    func node(_ node: Node, _ attribute: String) -> Node?
    func children(_ node: Node) -> [Node]?
    func owns(_ node: Node) -> Bool
    func selectedRange(_ node: Node) -> EventStreamTextRange?
    /// Empty means unsupported or no selection; nil means unreadable/oversized.
    func selectedNodes(_ node: Node, _ attribute: String) -> [Node]?
    func visibleRange(_ node: Node) -> ObservationVisibleRange
    func text(_ node: Node, in range: EventStreamTextRange) -> String?
}

public enum ObservationVisibleRange: Equatable {
    case unsupported
    case unavailable
    case range(EventStreamTextRange)
}

/// AX text offsets are UTF-16, not UTF-8 or Swift Character offsets. A bounded
/// request can cut a surrogate pair at either edge; omit only that incomplete
/// edge scalar and reject malformed interior UTF-16.
public enum ObservationTextRange {
    public static func bounded(_ range: EventStreamTextRange) -> EventStreamTextRange? {
        guard range.location >= 0, range.length >= 0,
              range.location <= Int.max - range.length else { return nil }
        return EventStreamTextRange(location: range.location, length: min(range.length, 8_192))
    }

    public static func decode(_ units: [UInt16]) -> String? {
        var units = units[...]
        if let first = units.first, (0xDC00...0xDFFF).contains(first) { units = units.dropFirst() }
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units = units.dropLast() }
        var bytes = Data()
        for unit in units {
            bytes.append(UInt8(truncatingIfNeeded: unit))
            bytes.append(UInt8(truncatingIfNeeded: unit >> 8))
        }
        return String(data: bytes, encoding: .utf16LittleEndian)
    }
}

public struct ObservationRole: Equatable {
    public let name: String
    public let subrole: String?
    public init(_ name: String, subrole: String? = nil) {
        self.name = name
        self.subrole = subrole
    }
    public var secure: Bool { ObservationPolicy.isSecureRole(name, subrole: subrole) }
}

public struct CapturedObservation<Node: Hashable> {
    public let windowNode: Node?
    public let targetNode: Node?
    public let contentRoot: Node?
    public let window: EventStreamWindow?
    public let element: EventStreamAXElement?
    public let selectedText: String?
    public let selectedRange: EventStreamTextRange?
    public let selectedTextTruncated: Bool?
    public let ax: EventStreamAXTree?
    public let contentState: HistoryEvent.ContentState
    public let contentDomains: [String]?
    /// In-memory attribution only; never serialized into event payloads.
    public let sourcePath: [Node]
    public let documentURLs: [String]
    public var selectedItems: [EventStreamAXElement] = []
    /// Exact membership is used for deduplication, never persisted.
    public var selectedItemNodes: [Node] = []

    public func hasSameSource(as other: Self) -> Bool {
        windowNode == other.windowNode && targetNode == other.targetNode &&
            window == other.window && sourcePath == other.sourcePath && documentURLs == other.documentURLs
    }
}

public struct ObservationCapture<Access: ObservationAccessibility> {
    private struct Document: Equatable {
        let identity: String
        let remoteURL: String?
        var domain: String? { remoteURL.flatMap { URLComponents(string: $0)?.host?.lowercased() } }
    }

    public let access: Access
    public let policy: ObservationPolicy
    public let now: () -> TimeInterval

    public init(
        access: Access, policy: ObservationPolicy,
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.access = access
        self.policy = policy
        self.now = now
    }

    public func window(for target: Access.Node) -> Access.Node? {
        guard access.owns(target) else { return nil }
        if access.role(target)?.name == "AXWindow" { return target }
        if let window = access.node(target, "AXWindow"), access.owns(window),
           access.role(window)?.name == "AXWindow" { return window }
        var current: Access.Node? = target
        var visited = Set<Access.Node>()
        for _ in 0..<48 {
            guard let value = current, access.owns(value), visited.insert(value).inserted else { return nil }
            if access.role(value)?.name == "AXWindow" { return value }
            current = access.node(value, "AXParent")
        }
        return nil
    }

    public func capture(
        app: EventStreamApp, window: Access.Node?, target: Access.Node?,
        browser: Bool, includeTree: Bool, includeSelectionItems: Bool = false
    ) -> CapturedObservation<Access.Node>? {
        let deadline = now() + 0.75
        guard !app.secureInput, policy.allowsApplication(app.bundleIdentifier ?? "") else { return nil }
        let window = window.flatMap { access.owns($0) && access.role($0)?.name == "AXWindow" ? $0 : nil }
        let title = window.flatMap { access.string($0, "AXTitle") }
        if ObservationPolicy.isPrivateBrowsing(bundleIdentifier: app.bundleIdentifier ?? "", title: title) {
            return nil
        }
        let target = target.flatMap { access.owns($0) ? $0 : nil }
        if browser && title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            return unavailable(window: window, target: target, appWindow: nil)
        }
        var ancestors: [Access.Node] = []
        var roles: [Access.Node: ObservationRole] = [:]
        var documents: [Access.Node: Document] = [:]
        var domains = Set<String>()
        var visited = Set<Access.Node>()
        var current = target
        var connected = false
        for _ in 0..<48 {
            guard now() < deadline, let value = current, access.owns(value), visited.insert(value).inserted,
                  let role = access.role(value) else { break }
            if role.secure { return nil }
            roles[value] = role
            ancestors.append(value)
            if value == window { connected = true; break }
            current = access.node(value, "AXParent")
        }
        let ancestorDocuments = ancestors.filter { roles[$0]?.name == "AXWebArea" }
        var documentKnown = connected && (!browser || !ancestorDocuments.isEmpty)
        var localDocumentsAllowed = !browser
        // A local document is app-owned only outside remote WebAreas. Walking
        // inward prevents an embedded custom/file URL inheriting app authority.
        for node in ancestorDocuments.reversed() {
            guard now() < deadline else {
                return unavailable(window: window, target: target, appWindow: nil)
            }
            guard let document = document(node, app: app, allowLocal: localDocumentsAllowed) else {
                documentKnown = false
                break
            }
            if let domain = document.domain {
                if !policy.allowsDomain(domain) { return nil }
                domains.insert(domain)
                localDocumentsAllowed = false
            }
            documents[node] = document
        }
        guard now() < deadline else {
            return unavailable(window: window, target: target, appWindow: nil)
        }
        let contentAllowed = connected && documentKnown && target != nil
        let state: HistoryEvent.ContentState = !contentAllowed ? .unavailable
            : policy.captureText ? .available : .metadataOnly
        let visibleWindow = (browser || !ancestorDocuments.isEmpty) && !documentKnown ? nil : window.map { _ in
            EventStreamWindow(title: boundedText(title, bytes: 1_024),
                url: ancestorDocuments.last.flatMap { documents[$0]?.remoteURL }, windowID: nil)
        }
        let root = browser ? ancestorDocuments.last : window
        let content = state == .available
        // Container values/labels/selection can aggregate denied descendant
        // documents. Only leaf controls contribute these independent fields.
        let leaf = !includeSelectionItems && content && (target.map {
            access.children($0)?.isEmpty == true &&
                !["AXWebArea", "AXWindow", "AXGroup", "AXScrollArea"].contains(roles[$0]?.name ?? "")
        } ?? false)
        var valid = true
        var visibleRanges: [Access.Node: EventStreamTextRange] = [:]
        let element = target.flatMap { contentAllowed ? self.element($0, role: roles[$0], content: content && leaf,
            visibleRanges: &visibleRanges, valid: &valid) : nil }
        let range = target.flatMap { contentAllowed ? access.selectedRange($0) : nil }
        let rawSelectedText = target.flatMap { content && leaf ? access.string($0, "AXSelectedText") : nil }
        let selectedText = boundedText(rawSelectedText, bytes: 8_192)
        let selectedTextTruncated = rawSelectedText.map { $0.utf8.count > 8_192 }
        guard now() < deadline else {
            return unavailable(window: window, target: target, appWindow: nil)
        }
        var reads: [(node: Access.Node, parent: Access.Node?, role: ObservationRole, leaf: Bool)] = []
        var selectedItems: [EventStreamAXElement] = []
        var selectedItemNodes: [Access.Node] = []
        var selectedMembership: [String: [Access.Node]] = [:]
        var selectionChildren: [Access.Node: [Access.Node]] = [:]
        if includeSelectionItems, contentAllowed, let target {
            if let selection = selectionItems(target, deadline: deadline, app: app,
                allowLocal: localDocumentsAllowed, content: content,
                sourceCurrent: {
                    for (index, ancestor) in ancestors.enumerated() {
                        guard now() < deadline, access.owns(ancestor),
                              access.role(ancestor) == roles[ancestor] else { return false }
                        if index + 1 < ancestors.count,
                           access.node(ancestor, "AXParent") != ancestors[index + 1] { return false }
                    }
                    guard let window, access.string(window, "AXTitle") == title else { return false }
                    return now() < deadline
                },
                documents: &documents, domains: &domains, reads: &reads,
                membership: &selectedMembership, children: &selectionChildren,
                visibleRanges: &visibleRanges, valid: &valid) {
                selectedItems = selection.items
                selectedItemNodes = selection.nodes
            } else {
                return unavailable(window: window, target: target, appWindow: nil)
            }
        }
        let tree = content && includeTree ? root.map {
            self.tree($0, deadline: min(deadline, now() + 0.2),
                app: app, allowLocal: !browser,
                documents: &documents, domains: &domains, reads: &reads,
                visibleRanges: &visibleRanges, valid: &valid)
        } : nil
        // Selection text and UTF-16 offsets come from separate AX reads. The
        // control remaining safe does not prove they still describe one selection.
        if contentAllowed, let target {
            if now() >= deadline || access.selectedRange(target) != range { valid = false }
        }
        for (node, range) in visibleRanges {
            if now() >= deadline || access.visibleRange(node) != .range(range) { valid = false }
        }
        for (node, children) in selectionChildren {
            if now() >= deadline || access.children(node) != children { valid = false }
        }
        if let target {
            for (attribute, nodes) in selectedMembership {
                if now() >= deadline || access.selectedNodes(target, attribute) != nodes { valid = false }
            }
        }
        // A later sibling can mutate an earlier node after its local reads.
        // Validate every contributing path together after collection.
        for read in reads {
            guard now() < deadline, access.owns(read.node), access.role(read.node) == read.role,
                  read.parent == nil || access.node(read.node, "AXParent") == read.parent,
                  !read.leaf || access.children(read.node)?.isEmpty == true else {
                valid = false
                break
            }
        }
        // Recheck ancestry after potentially blocking reads. A moving target must
        // not carry text obtained under an earlier document or window policy.
        if contentAllowed {
            if leaf, let target, access.children(target)?.isEmpty != true { valid = false }
            if let target, self.window(for: target) != window { valid = false }
            for (index, ancestor) in ancestors.enumerated() {
                guard now() < deadline else { valid = false; break }
                if !access.owns(ancestor) || access.role(ancestor) != roles[ancestor] { valid = false }
                if index + 1 < ancestors.count, access.node(ancestor, "AXParent") != ancestors[index + 1] {
                    valid = false
                }
            }
        }
        for (document, before) in documents {
            guard now() < deadline else { valid = false; break }
            if documentIdentity(document) != before.identity || access.role(document)?.name != "AXWebArea" { valid = false }
        }
        if let window, access.string(window, "AXTitle") != title { valid = false }
        if now() >= deadline { valid = false }
        if !valid {
            return unavailable(window: window, target: target, appWindow: nil)
        }
        return CapturedObservation(
            windowNode: window, targetNode: target, contentRoot: root, window: visibleWindow,
            element: element, selectedText: selectedText, selectedRange: range,
            selectedTextTruncated: selectedTextTruncated, ax: tree, contentState: state,
            contentDomains: content ? domains.sorted() : nil,
            sourcePath: contentAllowed ? ancestors : [],
            documentURLs: contentAllowed ? ancestorDocuments.compactMap { documents[$0]?.identity } : [],
            selectedItems: selectedItems, selectedItemNodes: selectedItemNodes
        )
    }

    private func selectionItems(
        _ owner: Access.Node, deadline: TimeInterval, app: EventStreamApp,
        allowLocal: Bool, content: Bool,
        sourceCurrent: () -> Bool,
        documents: inout [Access.Node: Document], domains: inout Set<String>,
        reads: inout [(node: Access.Node, parent: Access.Node?, role: ObservationRole, leaf: Bool)],
        membership: inout [String: [Access.Node]], children: inout [Access.Node: [Access.Node]],
        visibleRanges: inout [Access.Node: EventStreamTextRange], valid: inout Bool
    ) -> (items: [EventStreamAXElement], nodes: [Access.Node])? {
        var selected: [Access.Node] = []
        for attribute in ["AXSelectedChildren", "AXSelectedRows"] {
            guard now() < deadline, let nodes = access.selectedNodes(owner, attribute),
                  nodes.count <= 32, Set(nodes).count == nodes.count else { return nil }
            membership[attribute] = nodes
            for node in nodes where !selected.contains(node) { selected.append(node) }
        }
        guard selected.count <= 32 else { return nil }
        var roles: [Access.Node: ObservationRole] = [:]
        var parents: [Access.Node: Access.Node] = [:]
        var itemLeaves: [[Access.Node]] = []
        let containers = ["AXWebArea", "AXWindow", "AXGroup", "AXScrollArea", "AXRow", "AXCell",
            "AXList", "AXTable", "AXOutline"]

        func admit(_ node: Access.Node, parent: Access.Node, local: Bool) -> Bool? {
            guard now() < deadline, access.owns(node), access.node(node, "AXParent") == parent,
                  let role = access.role(node), !role.secure,
                  !["AXWindow", "AXApplication"].contains(role.name) else { return nil }
            if let previous = roles[node] {
                guard previous == role, parents[node] == parent else { return nil }
            } else {
                guard roles.count < 128 else { return nil }
                roles[node] = role
                parents[node] = parent
                reads.append((node, parent, role, false))
            }
            var local = local
            if role.name == "AXWebArea" {
                guard let document = document(node, app: app, allowLocal: local),
                      documents[node] == nil || documents[node] == document else { return nil }
                if let domain = document.domain {
                    guard policy.allowsDomain(domain), domains.contains(domain) || domains.count < 64 else { return nil }
                    domains.insert(domain)
                    local = false
                }
                documents[node] = document
            }
            return local
        }

        // Admit all selected subtrees before labels. Container values can
        // aggregate secure fields or denied embedded documents.
        for item in selected {
            guard item != owner else { return nil }
            var path: [Access.Node] = []
            var current = item
            var pathSet = Set<Access.Node>()
            while current != owner {
                guard now() < deadline, path.count < 48, access.owns(current),
                      pathSet.insert(current).inserted, let parent = access.node(current, "AXParent") else { return nil }
                path.append(current)
                current = parent
            }
            if membership["AXSelectedChildren"]?.contains(item) == true, path.count != 1 { return nil }
            var parent = owner
            var local = allowLocal
            for node in path.reversed() {
                guard let next = admit(node, parent: parent, local: local) else { return nil }
                parent = node
                local = next
            }
            var leaves: [Access.Node] = []
            var visited = Set<Access.Node>()
            func visit(_ node: Access.Node, depth: Int, local: Bool) -> Bool {
                guard now() < deadline, depth <= 14, visited.insert(node).inserted,
                      let values = access.children(node), values.count <= 128,
                      Set(values).count == values.count,
                      children[node] == nil || children[node] == values else { return false }
                children[node] = values
                if values.isEmpty, !containers.contains(roles[node]?.name ?? "") { leaves.append(node) }
                for child in values {
                    guard let next = admit(child, parent: node, local: local),
                          visit(child, depth: depth + 1, local: next) else { return false }
                }
                return true
            }
            guard visit(item, depth: 0, local: local) else { return nil }
            itemLeaves.append(leaves)
        }

        // Admission is not a lease. Recheck the exact source around each
        // sensitive read so a changed provider cannot feed subsequent fields.
        func current(_ leaf: Access.Node) -> Bool {
            guard sourceCurrent() else { return false }
            for (attribute, nodes) in membership {
                guard now() < deadline, access.selectedNodes(owner, attribute) == nodes else { return false }
            }
            var node = leaf
            for _ in 0..<128 {
                guard now() < deadline else { return false }
                if node == owner { break }
                guard access.owns(node), access.role(node) == roles[node],
                      let parent = parents[node], access.node(node, "AXParent") == parent else { return false }
                if let expected = children[node], access.children(node) != expected { return false }
                node = parent
            }
            guard node == owner else { return false }
            for (document, before) in documents {
                guard now() < deadline, access.owns(document),
                      access.role(document)?.name == "AXWebArea",
                      documentIdentity(document) == before.identity else { return false }
            }
            return now() < deadline
        }

        var items: [EventStreamAXElement] = []
        let encoder = JSONEncoder()
        // Reserve space per item so a large label cannot remove later membership.
        let itemBudget = selected.isEmpty ? 0 : (8_192 - 2 - selected.count) / selected.count
        for (index, item) in selected.enumerated() {
            guard now() < deadline, let role = roles[item] else { return nil }
            let metadata = EventStreamAXElement(role: role.name, subrole: role.subrole,
                title: nil, description: nil, value: nil, placeholder: nil, identifier: nil)
            guard let metadataBytes = try? encoder.encode(metadata), metadataBytes.count + 10 <= itemBudget else { return nil }
            var parts: [String] = []
            if content {
                for leaf in itemLeaves[index] {
                    for attribute in ["AXTitle", "AXDescription", "AXValue"] {
                        guard current(leaf) else { return nil }
                        let observed = attribute == "AXValue"
                            ? value(leaf, role: roles[leaf], visibleRanges: &visibleRanges, valid: &valid,
                                isCurrent: { current(leaf) })
                            : (text: access.string(leaf, attribute), clipped: false)
                        guard valid, current(leaf) else { return nil }
                        if let raw = observed.text, !raw.isEmpty {
                            let sample = boundedText(raw, bytes: 512) ?? ""
                            parts.append("\(roles[leaf]?.name ?? "") \(attribute): \(sample)\(observed.clipped || raw.utf8.count > 512 ? " [partial]" : "")")
                        }
                    }
                    if parts.joined(separator: "\n").utf8.count >= itemBudget { break }
                }
            }
            let text = parts.isEmpty ? "" : "Sampled selected-item content:\n" + parts.joined(separator: "\n")
            let value: String?
            if text.isEmpty {
                value = nil
            } else {
                guard let encoded = boundedJSON(text, bytes: itemBudget - metadataBytes.count - 9),
                      let data = encoded.text.data(using: .utf8),
                      let retained = try? JSONDecoder().decode(String.self, from: data) else { return nil }
                value = retained
            }
            items.append(.init(role: role.name, subrole: role.subrole, title: nil,
                description: nil, value: value, placeholder: nil, identifier: nil))
        }
        guard let encoded = try? encoder.encode(items), encoded.count <= 8_192 else { return nil }
        return (items, selected)
    }

    private func documentIdentity(_ node: Access.Node) -> String? {
        guard let value = access.string(node, "AXURL") ?? access.string(node, "AXDocument"),
              value.utf8.count <= 4_096 else { return nil }
        return value
    }

    private func document(_ node: Access.Node, app: EventStreamApp, allowLocal: Bool) -> Document? {
        guard let value = documentIdentity(node) else { return nil }
        if let remoteURL = Self.documentURL(value) {
            return Document(identity: value, remoteURL: remoteURL)
        }
        guard allowLocal, let url = URLComponents(string: value),
              url.user == nil, url.password == nil, url.port == nil,
              url.path.hasPrefix("/") else { return nil }
        switch url.scheme?.lowercased() {
        case "file":
            guard url.host == nil || url.host == "" || url.host?.lowercased() == "localhost" else { return nil }
        case "app":
            // Verified Codex app-owned WebArea scheme. Other custom schemes
            // require their own source evidence, not a guessed HTTP hostname.
            guard app.bundleIdentifier == "com.openai.codex" else { return nil }
        default:
            return nil
        }
        // Preserve the exact local identity for revalidation/typing attribution,
        // but never project its host or path into persisted window metadata.
        return Document(identity: value, remoteURL: nil)
    }

    private func unavailable(
        window: Access.Node?, target: Access.Node?, appWindow: EventStreamWindow?
    ) -> CapturedObservation<Access.Node> {
        CapturedObservation(windowNode: window, targetNode: target, contentRoot: nil,
            window: appWindow, element: nil, selectedText: nil, selectedRange: nil, selectedTextTruncated: nil, ax: nil,
            contentState: .unavailable, contentDomains: nil, sourcePath: [], documentURLs: [])
    }

    private func element(
        _ node: Access.Node, role: ObservationRole?, content: Bool,
        visibleRanges: inout [Access.Node: EventStreamTextRange], valid: inout Bool
    ) -> EventStreamAXElement {
        let value = content ? value(node, role: role, visibleRanges: &visibleRanges, valid: &valid).text : nil
        return EventStreamAXElement(
            role: role?.name, subrole: role?.subrole,
            title: content ? boundedText(access.string(node, "AXTitle"), bytes: 512) : nil,
            description: content ? boundedText(access.string(node, "AXDescription"), bytes: 512) : nil,
            value: value,
            placeholder: content ? boundedText(access.string(node, "AXPlaceholderValue"), bytes: 512) : nil,
            identifier: content ? boundedText(access.string(node, "AXIdentifier"), bytes: 512) : nil
        )
    }

    private func value(
        _ node: Access.Node, role: ObservationRole?,
        visibleRanges: inout [Access.Node: EventStreamTextRange], valid: inout Bool,
        isCurrent: () -> Bool = { true }
    ) -> (text: String?, clipped: Bool) {
        if role?.name == "AXTextArea" {
            switch access.visibleRange(node) {
            case .unsupported:
                guard isCurrent() else { valid = false; return (nil, true) }
                break
            case .unavailable:
                valid = false
                return (nil, true)
            case let .range(range):
                guard let request = ObservationTextRange.bounded(range), access.owns(node),
                      access.role(node) == role, access.children(node)?.isEmpty == true else {
                    valid = false
                    return (nil, true)
                }
                if let previous = visibleRanges[node], previous != range { valid = false }
                visibleRanges[node] = range
                guard request.length > 0 else { return ("", true) }
                guard isCurrent(), let text = access.text(node, in: request),
                      text.utf16.count <= request.length else {
                    valid = false
                    return (nil, true)
                }
                return (boundedText(text, bytes: 8_192), true)
            }
        }
        let raw = access.string(node, "AXValue")
        return (boundedText(raw, bytes: 8_192), (raw?.utf8.count ?? 0) > 8_192)
    }

    private func tree(
        _ root: Access.Node, deadline: TimeInterval, app: EventStreamApp, allowLocal: Bool,
        documents: inout [Access.Node: Document],
        domains: inout Set<String>,
        reads: inout [(node: Access.Node, parent: Access.Node?, role: ObservationRole, leaf: Bool)],
        visibleRanges: inout [Access.Node: EventStreamTextRange],
        valid: inout Bool
    ) -> EventStreamAXTree {
        var lines: [String] = []
        var visited = Set<Access.Node>()
        var size = 0
        var truncated = false
        func visit(_ node: Access.Node, parent: Access.Node?, depth: Int, allowLocal: Bool) {
            guard visited.count < 256, depth <= 14, size < 32_768, now() < deadline else {
                truncated = true
                return
            }
            guard visited.insert(node).inserted, access.owns(node),
                  let role = access.role(node), !role.secure else { truncated = true; return }
            if let parent, access.node(node, "AXParent") != parent { truncated = true; return }
            var localChildrenAllowed = allowLocal
            if role.name == "AXWebArea" {
                guard let document = document(node, app: app, allowLocal: allowLocal) else { truncated = true; return }
                if let domain = document.domain {
                    guard policy.allowsDomain(domain), domains.contains(domain) || domains.count < 64
                    else { truncated = true; return }
                    domains.insert(domain)
                    localChildrenAllowed = false
                }
                if let previous = documents[node], previous != document { valid = false; return }
                documents[node] = document
            }
            guard let children = access.children(node) else { truncated = true; return }
            var parts = [String(repeating: "  ", count: depth) + role.name]
            let attributes = children.isEmpty && !["AXWebArea", "AXWindow", "AXGroup", "AXScrollArea"].contains(role.name)
                ? ["AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue", "AXIdentifier"] : []
            reads.append((node, parent, role, !attributes.isEmpty))
            for attribute in attributes {
                guard now() < deadline else { truncated = true; break }
                let value: String?
                // Read-only editors expose their body as a leaf value, even
                // while focus stays on another control. Match the target budget.
                let limit = attribute == "AXValue" ? 8_192 : 400
                if attribute == "AXValue" {
                    let sample = self.value(node, role: role, visibleRanges: &visibleRanges, valid: &valid)
                    value = sample.text
                    truncated = truncated || sample.clipped
                } else {
                    let raw = access.string(node, attribute)
                    if (raw?.utf8.count ?? 0) > limit { truncated = true }
                    value = boundedText(raw, bytes: limit)
                }
                if let value, !value.isEmpty {
                    // JSON escaping keeps document text from impersonating tree structure.
                    let prefix = "[\(lines.count)] " + parts.joined(separator: " ") + " \(attribute)="
                    let remaining = 32_768 - size - prefix.utf8.count - 1
                    guard let encoded = boundedJSON(value, bytes: remaining) else { truncated = true; break }
                    truncated = truncated || encoded.clipped
                    parts.append("\(attribute)=\(encoded.text)")
                }
            }
            let line = "[\(lines.count)] " + parts.joined(separator: " ")
            guard size + line.utf8.count + 1 <= 32_768 else { truncated = true; return }
            size += line.utf8.count + 1
            lines.append(line)
            for child in children {
                if visited.count >= 256 || size >= 32_768 || now() >= deadline { truncated = true; break }
                visit(child, parent: node, depth: depth + 1, allowLocal: localChildrenAllowed)
            }
        }
        visit(root, parent: nil, depth: 0, allowLocal: allowLocal)
        return EventStreamAXTree(mode: .fullTree, text: lines.joined(separator: "\n"), truncated: truncated)
    }

    private func boundedJSON(_ value: String, bytes: Int) -> (text: String, clipped: Bool)? {
        guard bytes >= 2 else { return nil }
        let encoder = JSONEncoder()
        func encode(_ value: String) -> String? {
            guard let data = try? encoder.encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        }
        guard let full = encode(value) else { return nil }
        if full.utf8.count <= bytes { return (full, false) }
        // Escape expansion counts against the tree budget as well as raw text.
        var lower = 0
        var upper = value.utf8.count
        var retained = "\"\""
        while lower < upper {
            let middle = (lower + upper + 1) / 2
            guard let prefix = boundedText(value, bytes: middle), let encoded = encode(prefix) else { return nil }
            if encoded.utf8.count <= bytes {
                lower = middle
                retained = encoded
            } else {
                upper = middle - 1
            }
        }
        return (retained, true)
    }

    public static func documentURL(_ value: String?) -> String? {
        guard let value, value.utf8.count <= 4_096,
              var url = URLComponents(string: value),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, host.utf8.count <= 253 else { return nil }
        let hostname = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard !hostname.isEmpty else { return nil }
        url.host = hostname
        url.user = nil
        url.password = nil
        return url.string
    }
}

public func boundedText(_ value: String?, bytes: Int) -> String? {
    guard let value else { return nil }
    var prefix = value.utf8.prefix(max(0, bytes))
    while !prefix.isEmpty {
        if let text = String(bytes: prefix, encoding: .utf8) { return text }
        prefix = prefix.dropLast()
    }
    return ""
}
