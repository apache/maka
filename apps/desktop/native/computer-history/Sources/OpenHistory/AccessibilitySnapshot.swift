// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/OpenHistory/AccessibilitySnapshot.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import AppKit
import ApplicationServices
import Carbon
import Foundation
import HistoryCore

struct AXNode: Hashable {
    let element: AXUIElement
    static func == (lhs: Self, rhs: Self) -> Bool { CFEqual(lhs.element, rhs.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

struct NativeAccessibility: ObservationAccessibility {
    let processIdentifier: pid_t
    private let deadline = ProcessInfo.processInfo.systemUptime + 0.75
    private var withinBudget: Bool { ProcessInfo.processInfo.systemUptime < deadline }
    func role(_ node: AXNode) -> ObservationRole? {
        guard let role = string(node, "AXRole"), !role.isEmpty, withinBudget else { return nil }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(node.element, kAXSubroleAttribute as CFString, &value)
        switch result {
        case .success:
            guard let subrole = value as? String else { return nil }
            return ObservationRole(role, subrole: subrole)
        case .attributeUnsupported, .noValue:
            return ObservationRole(role)
        default:
            return nil
        }
    }
    func owns(_ node: AXNode) -> Bool {
        guard withinBudget else { return false }
        var pid: pid_t = 0
        return AXUIElementGetPid(node.element, &pid) == .success && pid == processIdentifier
    }
    func string(_ node: AXNode, _ attribute: String) -> String? {
        let value = attributeValue(node, attribute)
        return (value as? String) ?? (value as? URL)?.absoluteString
    }
    func node(_ node: AXNode, _ attribute: String) -> AXNode? {
        guard let value = attributeValue(node, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return AXNode(element: value as! AXUIElement)
    }
    func children(_ node: AXNode) -> [AXNode]? {
        AXChildrenReader.read(node.element, withinBudget: { withinBudget })?.map { AXNode(element: $0) }
    }
    func selectedRange(_ node: AXNode) -> EventStreamTextRange? {
        guard let value = attributeValue(node, "AXSelectedTextRange"),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
        return EventStreamTextRange(location: range.location, length: range.length)
    }
    func selectedNodes(_ node: AXNode, _ attribute: String) -> [AXNode]? {
        guard let values = AXChildrenReader.read(node.element, attribute: attribute as CFString,
            limit: 33, withinBudget: { withinBudget }), values.count <= 32 else { return nil }
        return values.map { AXNode(element: $0) }
    }
    func visibleRange(_ node: AXNode) -> ObservationVisibleRange {
        guard withinBudget else { return .unavailable }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(node.element, kAXVisibleCharacterRangeAttribute as CFString, &value)
        guard withinBudget else { return .unavailable }
        if result == .attributeUnsupported { return .unsupported }
        guard result == .success, let value, CFGetTypeID(value) == AXValueGetTypeID() else { return .unavailable }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return .unavailable }
        let reported = EventStreamTextRange(location: range.location, length: range.length)
        guard ObservationTextRange.bounded(reported) != nil else { return .unavailable }
        return .range(reported)
    }
    func text(_ node: AXNode, in range: EventStreamTextRange) -> String? {
        guard withinBudget, ObservationTextRange.bounded(range) == range else { return nil }
        var range = CFRange(location: range.location, length: range.length)
        guard let parameter = AXValueCreate(.cfRange, &range) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(node.element,
            kAXStringForRangeParameterizedAttribute as CFString, parameter, &value) == .success,
            withinBudget, let value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
        let string = value as! CFString
        let count = CFStringGetLength(string)
        guard count <= range.length else { return nil }
        var units = [UniChar](repeating: 0, count: count)
        CFStringGetCharacters(string, CFRange(location: 0, length: count), &units)
        return ObservationTextRange.decode(units)
    }
    private func attributeValue(_ node: AXNode, _ attribute: String) -> CFTypeRef? {
        guard withinBudget else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node.element, attribute as CFString, &value) == .success else { return nil }
        return value
    }
}

/// AX equality, not titles or CGWindow heuristics, defines lifetime identity.
final class WindowSources {
    private struct Source: Hashable {
        let process: ObservationProcessIdentity
        let window: AXNode
    }
    private var sources = OpaqueSourceRegistry<Source>()

    func id(for window: AXNode, process: ObservationProcessIdentity) -> String {
        sources.id(for: Source(process: process, window: window))
    }

    func remove(window: AXNode) {
        sources.remove { $0.window == window }
    }
}

struct AccessibilitySnapshot {
    let app: EventStreamApp
    let window: EventStreamWindow?
    let sourceId: String?
    let windowNode: AXNode?
    let targetNode: AXNode?
    let contentRoot: AXNode?
    let element: EventStreamAXElement?
    let selectedText: String?
    let selectedRange: EventStreamTextRange?
    let selectedTextTruncated: Bool?
    let ax: EventStreamAXTree?
    let contentState: HistoryEvent.ContentState
    let contentDomains: [String]?
    let sourcePath: [AXNode]
    let documentURLs: [String]
    var selectedItems: [EventStreamAXElement] = []
    var selectedItemNodes: [AXNode] = []

    var focusIdentifier: UInt? { targetNode.map { UInt(CFHash($0.element)) } }
    var dragEndpoint: EventStreamMouseDragEndpoint {
        EventStreamMouseDragEndpoint(app: app, window: window, element: element)
    }
}

enum AccessibilityReader {
    static func snapshot(
        processIdentifier: pid_t, policy: ObservationPolicy, sources: WindowSources,
        at point: CGPoint? = nil, origin: AXNode? = nil,
        expectedWindow: AXNode? = nil, includeTree: Bool = true,
        includeSelectionItems: Bool = false
    ) -> AccessibilitySnapshot? {
        guard !IsSecureEventInputEnabled(),
              let processIdentity = ObservationProcessIdentity.read(processIdentifier),
              let running = NSRunningApplication(processIdentifier: processIdentifier), !running.isTerminated else { return nil }
        let app = EventStreamApp(name: running.localizedName, secureInput: false, processIdentifier: nil, bundleIdentifier: running.bundleIdentifier)
        guard policy.allowsApplication(running.bundleIdentifier ?? "") else { return nil }
        let access = NativeAccessibility(processIdentifier: processIdentifier)
        let capture = ObservationCapture(access: access, policy: policy)
        let application = AXNode(element: AXUIElementCreateApplication(processIdentifier))
        // Chromium activates its native AX provider when the application role
        // is queried. Focus alone can remain absent on a cold browser.
        guard access.owns(application), access.role(application)?.name == "AXApplication" else { return nil }
        let focused = access.node(application, "AXFocusedUIElement")
        var target = origin ?? focused
        if let point {
            var hit: AXUIElement?
            if AXUIElementCopyElementAtPosition(application.element, Float(point.x), Float(point.y), &hit) == .success,
               let hit { target = AXNode(element: hit) }
            else { target = nil }
        }
        let window = target.flatMap { capture.window(for: $0) }
            ?? (origin == nil ? access.node(application, "AXFocusedWindow") : nil)
        if let expectedWindow, window != expectedWindow { return nil }
        // Input focus and notification origin are separate sources. Unknown or
        // secure current focus cannot authorize reading another element's text.
        var focusedContext: CapturedObservation<AXNode>?
        var metadataPolicy = policy
        metadataPolicy.captureText = false
        if let focused {
            guard access.owns(focused), let role = access.role(focused), !role.secure else { return nil }
            if focused != target {
                focusedContext = ObservationCapture(access: access, policy: metadataPolicy).capture(
                    app: app, window: capture.window(for: focused), target: focused,
                    browser: ObservationPolicy.browserBundleIdentifiers.contains(running.bundleIdentifier ?? ""),
                    includeTree: false
                )
                guard focusedContext?.contentState == .metadataOnly else { return nil }
            }
        } else {
            target = nil
        }
        guard let observation = capture.capture(
            app: app, window: window, target: target,
            browser: ObservationPolicy.browserBundleIdentifiers.contains(running.bundleIdentifier ?? ""), includeTree: includeTree,
            includeSelectionItems: includeSelectionItems
        ) else { return nil }
        guard !IsSecureEventInputEnabled(), access.node(application, "AXFocusedUIElement") == focused,
              focused.map({ access.role($0)?.secure == false }) ?? true else { return nil }
        if let focusedContext, let focused {
            let verified = ObservationCapture(access: access, policy: metadataPolicy).capture(
                app: app, window: capture.window(for: focused), target: focused,
                browser: ObservationPolicy.browserBundleIdentifiers.contains(running.bundleIdentifier ?? ""),
                includeTree: false
            )
            guard verified?.contentState == .metadataOnly,
                  verified?.hasSameSource(as: focusedContext) == true,
                  !IsSecureEventInputEnabled(), access.node(application, "AXFocusedUIElement") == focused
            else { return nil }
        }
        guard !running.isTerminated, ObservationProcessIdentity.read(processIdentifier) == processIdentity else { return nil }
        let sourceId = observation.windowNode.map { sources.id(for: $0, process: processIdentity) }
        let available = sourceId != nil && observation.contentState == .available
        return AccessibilitySnapshot(
            app: app, window: observation.window,
            sourceId: sourceId,
            windowNode: observation.windowNode, targetNode: observation.targetNode, contentRoot: observation.contentRoot,
            element: sourceId != nil ? observation.element : nil, selectedText: available ? observation.selectedText : nil,
            selectedRange: observation.selectedRange,
            selectedTextTruncated: available ? observation.selectedTextTruncated : nil,
            ax: available ? observation.ax : nil,
            contentState: sourceId == nil ? .unavailable : observation.contentState,
            contentDomains: available ? observation.contentDomains : nil,
            sourcePath: observation.sourcePath, documentURLs: observation.documentURLs,
            selectedItems: sourceId != nil ? observation.selectedItems : [],
            selectedItemNodes: sourceId != nil ? observation.selectedItemNodes : []
        )
    }
}
