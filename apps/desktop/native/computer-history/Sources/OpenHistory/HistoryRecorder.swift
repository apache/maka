// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/OpenHistory/HistoryRecorder.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import HistoryCore

private let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo else {
        return Unmanaged.passUnretained(event)
    }
    let recorder = Unmanaged<HistoryRecorder>.fromOpaque(userInfo).takeUnretainedValue()
    recorder.handleEventTap(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

private let accessibilityCallback: AXObserverCallback = { observer, element, notification, userInfo in
    guard let userInfo else {
        return
    }
    let recorder = Unmanaged<HistoryRecorder>.fromOpaque(userInfo).takeUnretainedValue()
    recorder.handleAccessibilityNotification(observer: observer, origin: AXNode(element: element), notification: notification as String)
}

final class HistoryRecorder {
    private struct MouseDownState {
        let point: CGPoint
        let button: String
        let clickCount: Int
        let modifiers: [String]
        let snapshot: AccessibilitySnapshot?
    }

    private var store: SegmentStore
    private let runtimeControl: RuntimeControlStore
    private let recorderStartedAt: Date
    private let segmentDurationSeconds: TimeInterval
    private let parent: RecorderParent
    private var policy: ObservationPolicy
    private var sequence = 0
    private var currentProcessIdentifier: pid_t?
    private var workspaceObserver: NSObjectProtocol?
    private var accessibilityObserver: AXObserver?
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var mouseDown: MouseDownState?
    private var textBuffer = TextInputBuffer()
    private var textSourceSnapshot: AccessibilitySnapshot?
    private var textFlushTask: DispatchWorkItem?
    private struct CallbackSource: Hashable {
        let origin: AXNode
        let window: AXNode
    }
    private var callbacks = ObservationCallbacks<CallbackSource>()
    private var sampling = ObservationSampling()
    private var pendingWindow: AXNode?
    private var pendingValueChange = false
    private var registeredNodes: [AXNode] = []
    private static let notifications = [
        kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification,
        kAXTitleChangedNotification, kAXValueChangedNotification, kAXSelectedTextChangedNotification,
        kAXUIElementDestroyedNotification, "AXLayoutChanged", "AXLoadComplete", "AXRowCountChanged",
    ]
    private let sources = WindowSources()
    private var delivery = ObservationDelivery()
    private let fingerprintEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
    private var selectionDelivery = SelectionDelivery()
    private var controlTimer: Timer?
    private var segmentTimer: Timer?
    private var observationTimer: Timer?
    private var lifecycle: RecorderLifecycle
    private(set) var failure: Error?

    init(store: SegmentStore, policy: ObservationPolicy, parent: RecorderParent) {
        self.store = store
        self.runtimeControl = RuntimeControlStore(homeURL: store.homeURL)
        self.recorderStartedAt = store.startedAt
        self.segmentDurationSeconds = ProcessInfo.processInfo.environment[
            "OPEN_HISTORY_SEGMENT_SECONDS"
        ].flatMap(Double.init) ?? 600
        self.policy = policy
        self.parent = parent
        self.lifecycle = RecorderLifecycle(
            control: RuntimeControlStore(homeURL: store.homeURL).readControl()
        )
    }

    func start() throws {
        reconcileControlState()
        guard !lifecycle.stopped else { throw RecorderOwnershipError.invalidParent }
        SegmentStore.prune(homeURL: store.homeURL, olderThan: 48 * 60 * 60)
        // A timeout on the application handle does not cover descendant handles.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.05)
        observeWorkspace()

        if observationAllowed(), let app = NSWorkspace.shared.frontmostApplication {
            installEventTap()
            currentProcessIdentifier = app.processIdentifier
            installAccessibilityObserver(processIdentifier: app.processIdentifier)
        }
        try append(kind: .sessionStarted, snapshot: nil)
        if observationAllowed() { appendObservation(currentSnapshot()) }
        try writeRuntimeStatus(state: lifecycle.state)
        controlTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) {
            [weak self] _ in
            self?.reconcileControlState()
        }
        segmentTimer = Timer.scheduledTimer(
            withTimeInterval: segmentDurationSeconds,
            repeats: true
        ) { [weak self] _ in
            self?.rotateSegment()
        }
        observationTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.samplePendingObservation()
        }
    }

    func stop(reason: String) {
        observationTimer?.invalidate()
        observationTimer = nil
        guard !lifecycle.stopped else {
            return
        }
        lifecycle.stop()
        controlTimer?.invalidate()
        controlTimer = nil
        segmentTimer?.invalidate()
        segmentTimer = nil
        discardPendingWork()
        do {
            sequence += 1
            try store.stop(event: HistoryEvent(id: sequence, timestamp: Date(), kind: .sessionEnded),
                policy: policy, reason: reason)
        } catch {
            failure = failure ?? error
        }
        do {
            try writeRuntimeStatus(state: .stopped, endedAt: Date())
        } catch {
            failure = failure ?? error
        }
        if failure != nil { fputs("Computer History storage failed; recording stopped.\n", stderr) }

        if let workspaceObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
        }
        if let accessibilityObserver {
            CFRunLoopRemoveSource(
                CFRunLoopGetCurrent(),
                AXObserverGetRunLoopSource(accessibilityObserver),
                .defaultMode
            )
        }
        if let eventTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), eventTapSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
    }

    func handleEventTap(type: CGEventType, event: CGEvent) {
        guard observationAllowed() else {
            return
        }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lifecycle.invalidatePendingWork()
            discardPendingWork()
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return
        }

        switch type {
        case .keyDown:
            handleKeyDown(event)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            mouseDown = MouseDownState(
                point: event.location,
                button: mouseButton(for: type),
                clickCount: Int(event.getIntegerValueField(.mouseEventClickState)),
                modifiers: modifierNames(event.flags),
                snapshot: currentSnapshot(at: event.location, includeTree: false)
            )
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            handleMouseUp(event: event)
        default:
            break
        }
    }

    func handleAccessibilityNotification(observer: AXObserver, origin: AXNode, notification: String) {
        guard observationAllowed(), let current = accessibilityObserver, CFEqual(observer, current),
              let pid = currentProcessIdentifier else { return }
        if notification == kAXUIElementDestroyedNotification {
            sources.remove(window: origin)
            lifecycle.invalidatePendingWork()
            discardPendingWork()
            return
        }
        let access = NativeAccessibility(processIdentifier: pid)
        let capture = ObservationCapture(access: access, policy: policy)
        var origin = origin
        guard access.owns(origin) else { return }
        if [kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification].contains(notification) {
            lifecycle.invalidatePendingWork()
            // Focus invalidates pending input, not the last persisted snapshot.
            // Source/window metadata still detects actual window transitions.
            discardPendingContent()
        }
        if [kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification,
            kAXTitleChangedNotification].contains(notification) {
            // App/window notifications may not identify the focused control.
            // Resolve it at receipt, never when the delayed work executes.
            if ["AXApplication", "AXWindow"].contains(access.role(origin)?.name ?? "") {
                let app = AXNode(element: AXUIElementCreateApplication(pid))
                guard let focused = access.node(app, "AXFocusedUIElement"),
                      access.role(origin)?.name == "AXApplication" || capture.window(for: focused) == origin
                else { return }
                origin = focused
            }
        }
        guard let window = capture.window(for: origin) else { return }
        if notification != kAXSelectedTextChangedNotification {
            // Generic UI records describe a current window snapshot, not the
            // notifying control. Selection/input keep their exact origin path.
            if pendingWindow != window { pendingValueChange = false }
            pendingWindow = window
            pendingValueChange = pendingValueChange || notification == kAXValueChangedNotification
            sampling.request(now: ProcessInfo.processInfo.systemUptime)
            return
        }
        let source = CallbackSource(origin: origin, window: window)
        guard let token = callbacks.admit(source) else { return }
        let generation = lifecycle.generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self, self.observationAllowed(generation: generation),
                  self.currentProcessIdentifier == pid,
                  let current = self.accessibilityObserver, CFEqual(current, observer),
                  self.callbacks.take(token) else { return }
            self.processAccessibilityNotification(source)
        }
    }

    private func processAccessibilityNotification(_ source: CallbackSource) {
        appendSelection(currentSnapshot(origin: source.origin, expectedWindow: source.window, includeTree: false))
    }

    private func samplePendingObservation() {
        guard lifecycle.state == .running, !lifecycle.stopped,
              let token = sampling.begin(now: ProcessInfo.processInfo.systemUptime) else { return }
        let generation = lifecycle.generation
        let snapshot = currentSnapshot(expectedWindow: pendingWindow)
        let terminal = pendingValueChange && isTerminal(snapshot?.app.bundleIdentifier)
        appendObservation(snapshot, kind: terminal ? .terminalValueChanged : .uiChanged)
        guard observationAllowed(generation: generation) else { return }
        let settled = snapshot?.contentState == .available || snapshot?.contentState == .metadataOnly
        if sampling.complete(token, settled: settled) {
            pendingWindow = nil
            pendingValueChange = false
        }
    }

    private func observeWorkspace() {
        workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication
            else {
                return
            }
            self?.switchFrontmostApplication(to: app)
        }
    }

    private func switchFrontmostApplication(to application: NSRunningApplication) {
        lifecycle.invalidatePendingWork()
        discardPendingWork()
        guard observationAllowed() else { return }
        currentProcessIdentifier = application.processIdentifier
        installAccessibilityObserver(processIdentifier: application.processIdentifier)
        appendObservation(currentSnapshot())
    }

    private func installAccessibilityObserver(processIdentifier: pid_t) {
        callbacks.invalidate()
        registeredNodes.removeAll()
        if let accessibilityObserver {
            CFRunLoopRemoveSource(
                CFRunLoopGetCurrent(),
                AXObserverGetRunLoopSource(accessibilityObserver),
                .defaultMode
            )
        }
        accessibilityObserver = nil

        var observer: AXObserver?
        guard AXObserverCreate(processIdentifier, accessibilityCallback, &observer) == .success,
              let observer
        else {
            return
        }

        accessibilityObserver = observer
        registerNotifications(on: AXNode(element: AXUIElementCreateApplication(processIdentifier)))
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode
        )
    }

    private func registerNotifications(
        on node: AXNode, deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 0.1
    ) {
        guard !registeredNodes.contains(node),
              ProcessInfo.processInfo.systemUptime < deadline,
              let observer = accessibilityObserver else { return }
        if registeredNodes.count >= 16 {
            // Replacing the observer drops all old registrations without a
            // synchronous remove call for every notification on every control.
            if let pid = currentProcessIdentifier { installAccessibilityObserver(processIdentifier: pid) }
            return
        }
        registeredNodes.append(node)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        for notification in Self.notifications {
            guard ProcessInfo.processInfo.systemUptime < deadline else { break }
            // Unsupported notifications are covered by the bounded foreground
            // sampler; never pretend registration implies complete delivery.
            AXObserverAddNotification(observer, node.element, notification as CFString, pointer)
        }
    }

    private func installEventTap() {
        let eventTypes: [CGEventType] = [
            .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .keyDown, .flagsChanged,
        ]
        let mask = eventTypes.reduce(CGEventMask(0)) {
            $0 | (CGEventMask(1) << $1.rawValue)
        }
        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let eventTap else {
            return
        }
        eventTapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        if let eventTapSource {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), eventTapSource, .commonModes)
        }
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }

    private func handleKeyDown(_ event: CGEvent) {
        let flags = event.flags
        let modifiers = modifierNames(flags)
        let hasShortcutModifier = flags.contains(.maskCommand) ||
            flags.contains(.maskControl) ||
            flags.contains(.maskAlternate)

        if hasShortcutModifier {
            flushTextBuffer()
            guard let snapshot = currentSnapshot() else { return }
            _ = try? append(
                kind: .keyboardShortcut,
                snapshot: snapshot,
                keyboard: EventStreamKeyboardInteraction(
                    text: nil,
                    keyEquivalent: snapshot.contentState == .available ? keyEquivalent(event) : nil,
                    modifiers: modifiers,
                    target: snapshot.element
                )
            )
            return
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if keyCode == 36 || keyCode == 76 {
            flushTextBuffer()
            let snapshot = currentSnapshot()
            _ = try? append(
                kind: .keyboardSubmit,
                snapshot: snapshot,
                keyboard: EventStreamKeyboardInteraction(
                    text: nil,
                    keyEquivalent: "return",
                    modifiers: modifiers,
                    target: snapshot?.element
                )
            )
            return
        }

        let snapshot = currentSnapshot(includeTree: false)
        let source = snapshot.flatMap(textSource)
        let previous = textSourceSnapshot
        textSourceSnapshot = snapshot
        if let completed = textBuffer.append(
            characters: { NSEvent(cgEvent: event)?.characters ?? "" },
            source: source, policy: policy
        ) {
            appendTextInput(completed, snapshot: previous)
        }
        scheduleTextFlush()
    }

    private func textSource(_ snapshot: AccessibilitySnapshot) -> TextInputSource? {
        currentProcessIdentifier.map {
            TextInputSource(
                app: snapshot.app, window: snapshot.window, element: snapshot.element,
                processIdentifier: $0, windowIdentifier: nil, focusIdentifier: snapshot.focusIdentifier,
                sourceId: snapshot.sourceId, contentState: snapshot.contentState,
                contentDomains: snapshot.contentDomains,
                sourcePath: snapshot.sourcePath.map(AnyHashable.init), documentURLs: snapshot.documentURLs
            )
        }
    }

    private func scheduleTextFlush() {
        guard textFlushTask == nil else { return }
        let generation = lifecycle.generation
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.observationAllowed(generation: generation) else { return }
            self.flushTextBuffer()
        }
        textFlushTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: task)
    }

    private func flushTextBuffer() {
        textFlushTask?.cancel()
        textFlushTask = nil
        guard observationAllowed(), let input = textBuffer.drain() else { return }
        let snapshot = textSourceSnapshot
        textSourceSnapshot = nil
        appendTextInput(input, snapshot: snapshot)
    }

    private func appendTextInput(_ input: BufferedTextInput, snapshot: AccessibilitySnapshot?) {
        let generation = lifecycle.generation
        guard observationAllowed(), let origin = snapshot?.targetNode, let window = snapshot?.windowNode,
              let verified = currentSnapshot(origin: origin, expectedWindow: window, includeTree: false),
              let source = textSource(verified), input.source.matches(source) else { return }
        sequence += 1
        _ = try? persist(input.event(id: sequence, timestamp: Date()), generation: generation)
    }

    private func handleMouseUp(event: CGEvent) {
        guard let down = mouseDown else {
            return
        }
        mouseDown = nil
        guard let original = down.snapshot, let origin = original.targetNode, let window = original.windowNode,
              let verified = currentSnapshot(origin: origin, expectedWindow: window, includeTree: false),
              verified.sourceId == original.sourceId, verified.window == original.window,
              verified.contentState == original.contentState,
              verified.sourcePath == original.sourcePath, verified.documentURLs == original.documentURLs,
              verified.contentDomains == original.contentDomains else { return }
        let destinationSnapshot = currentSnapshot(at: event.location)
        guard let destinationSnapshot else { return }
        let domains = Set((original.contentDomains ?? []) + (destinationSnapshot.contentDomains ?? []))
        guard domains.count <= 64 else { return }
        let distance = hypot(event.location.x - down.point.x, event.location.y - down.point.y)
        let mouse: EventStreamMouseInteraction
        let kind: HistoryEventKind
        if distance > 6 {
            kind = .mouseDrag
            mouse = EventStreamMouseInteraction(
                button: down.button,
                clickCount: down.clickCount,
                modifiers: down.modifiers,
                target: nil,
                origin: original.dragEndpoint,
                destination: destinationSnapshot.dragEndpoint
            )
        } else {
            kind = down.button == "right" ? .mouseContextMenu : .mouseClick
            mouse = EventStreamMouseInteraction(
                button: down.button,
                clickCount: down.clickCount,
                modifiers: down.modifiers,
                target: minimalMouseTarget(destinationSnapshot.element),
                origin: nil,
                destination: nil
            )
        }
        _ = try? append(kind: kind, snapshot: destinationSnapshot, mouse: mouse, contentDomains: domains.sorted())
    }

    @discardableResult
    private func append(
        kind: HistoryEventKind,
        snapshot: AccessibilitySnapshot?,
        mouse: EventStreamMouseInteraction? = nil,
        keyboard: EventStreamKeyboardInteraction? = nil,
        selection: EventStreamSelection? = nil,
        diagnostic: EventStreamDiagnostic? = nil,
        contentDomains: [String]? = nil
    ) throws -> Bool {
        let generation = lifecycle.generation
        let isBoundary = kind == .sessionStarted || kind == .sessionEnded
        guard isBoundary || observationAllowed() else { return false }
        sequence += 1
        if isBoundary {
            return try persist(HistoryEvent(id: sequence, timestamp: Date(), kind: kind))
        }
        guard policy.allowsObservation(
            app: snapshot?.app, window: snapshot?.window, element: snapshot?.element
        ) else { return false }
        let event = HistoryEvent(
            id: sequence,
            timestamp: Date(),
            kind: kind,
            app: snapshot?.app,
            window: snapshot?.window,
            mouse: mouse,
            keyboard: keyboard,
            selection: selection,
            ax: shouldIncludeAX(kind) ? snapshot?.ax : nil,
            diagnostic: diagnostic,
            sourceId: snapshot?.sourceId,
            contentState: snapshot?.contentState,
            contentDomains: snapshot?.contentState == .available ? (contentDomains ?? snapshot?.contentDomains) : nil
        )

        return try persist(event, generation: generation)
    }

    @discardableResult
    private func persist(_ event: HistoryEvent, generation: UInt64? = nil) throws -> Bool {
        reconcileControlState()
        guard let event = lifecycle.eventForPersistence(
            event, parentAlive: parent.isAlive(), generation: generation
        )
        else { return false }
        do {
            return try store.append(event, policy: policy)
        } catch {
            failStorage(error)
            throw error
        }
    }

    private func currentSnapshot(
        at point: CGPoint? = nil, origin: AXNode? = nil,
        expectedWindow: AXNode? = nil, includeTree: Bool = true
    ) -> AccessibilitySnapshot? {
        defer {
            if includeTree {
                sampling.observed(now: ProcessInfo.processInfo.systemUptime)
            }
        }
        guard observationAllowed(), let currentProcessIdentifier,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == currentProcessIdentifier else {
            lifecycle.invalidatePendingWork()
            discardPendingWork()
            return nil
        }
        let generation = lifecycle.generation
        guard let snapshot = AccessibilityReader.snapshot(
            processIdentifier: currentProcessIdentifier,
            policy: policy, sources: sources, at: point, origin: origin,
            expectedWindow: expectedWindow, includeTree: includeTree
        ) else {
            lifecycle.invalidatePendingWork()
            discardPendingWork()
            return nil
        }
        // AX can block long enough for pause or parent exit to occur.
        guard observationAllowed(generation: generation),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == currentProcessIdentifier,
              policy.allowsObservation(
            app: snapshot.app, window: snapshot.window, element: snapshot.element
        ) else {
            lifecycle.invalidatePendingWork()
            discardPendingWork()
            return nil
        }
        let registrationDeadline = ProcessInfo.processInfo.systemUptime + 0.1
        for node in [snapshot.windowNode, snapshot.targetNode, snapshot.contentRoot].compactMap({ $0 }) {
            registerNotifications(on: node, deadline: registrationDeadline)
        }
        if snapshot.contentState == .unavailable {
            lifecycle.invalidatePendingWork()
            discardPendingContent()
        }
        return snapshot
    }

    private func minimalMouseTarget(
        _ element: EventStreamAXElement?
    ) -> EventStreamAXElement? {
        guard let role = element?.role else {
            return nil
        }
        return EventStreamAXElement(
            role: role,
            subrole: nil,
            title: nil,
            description: nil,
            value: nil,
            placeholder: nil,
            identifier: nil
        )
    }

    private func appendObservation(_ snapshot: AccessibilitySnapshot?, kind: HistoryEventKind = .uiChanged) {
        guard let snapshot, observationAllowed() else { return }
        let metadata = HistoryEvent(id: 0, timestamp: Date(timeIntervalSince1970: 0), kind: .windowChanged,
            app: snapshot.app, window: snapshot.window, sourceId: snapshot.sourceId, contentState: snapshot.contentState)
        guard let metadataFingerprint = try? fingerprintEncoder.encode(metadata) else { return }
        let event = HistoryEvent(id: 0, timestamp: Date(timeIntervalSince1970: 0), kind: .uiChanged,
            app: snapshot.app, window: snapshot.window, ax: snapshot.ax,
            sourceId: snapshot.sourceId, contentState: snapshot.contentState, contentDomains: snapshot.contentDomains)
        guard let fingerprint = try? fingerprintEncoder.encode(event) else { return }
        let generation = lifecycle.generation
        var next = delivery
        _ = try? next.deliver(
            source: snapshot.sourceId ?? snapshot.app.bundleIdentifier ?? "unknown",
            metadataFingerprint: metadataFingerprint, fingerprint: fingerprint, kind: kind
        ) { retainedKind in
            try append(kind: retainedKind, snapshot: snapshot)
        }
        if observationAllowed(generation: generation) {
            delivery = next
        }
    }

    private func keyEquivalent(_ event: CGEvent) -> String? {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let named: [Int64: String] = [
            36: "return", 48: "tab", 49: "space", 51: "delete",
            53: "escape", 76: "enter", 123: "left", 124: "right",
            125: "down", 126: "up",
        ]
        if let name = named[keyCode] {
            return name
        }
        return NSEvent(cgEvent: event)?.charactersIgnoringModifiers?.lowercased()
    }

    private func modifierNames(_ flags: CGEventFlags) -> [String] {
        var result: [String] = []
        if flags.contains(.maskCommand) { result.append("command") }
        if flags.contains(.maskControl) { result.append("control") }
        if flags.contains(.maskAlternate) { result.append("option") }
        if flags.contains(.maskShift) { result.append("shift") }
        if flags.contains(.maskSecondaryFn) { result.append("fn") }
        return result
    }

    private func mouseButton(for type: CGEventType) -> String {
        switch type {
        case .rightMouseDown, .rightMouseUp:
            return "right"
        case .otherMouseDown, .otherMouseUp:
            return "other"
        default:
            return "left"
        }
    }

    private func isTerminal(_ bundleIdentifier: String?) -> Bool {
        guard let bundleIdentifier else {
            return false
        }
        return [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "dev.warp.Warp-Stable",
            "com.mitchellh.ghostty",
        ].contains(bundleIdentifier)
    }

    private func appendSelection(_ snapshot: AccessibilitySnapshot?) {
        guard observationAllowed(), let snapshot, let source = textSource(snapshot) else {
            return
        }
        let selection = EventStreamSelection(
            target: snapshot.element,
            selectedText: policy.captureText ? snapshot.selectedText : nil,
            selectedRange: snapshot.selectedRange,
            selectedItems: []
        )
        let generation = lifecycle.generation
        var next = selectionDelivery
        _ = try? next.deliver(source: source, selection: selection) {
            try append(kind: .selectionChanged, snapshot: snapshot, selection: selection)
        }
        if observationAllowed(generation: generation) { selectionDelivery = next }
    }

    private func shouldIncludeAX(_ kind: HistoryEventKind) -> Bool {
        switch kind {
        case .windowChanged,
             .mouseClick,
             .mouseContextMenu,
             .mouseDrag,
             .keyboardSubmit,
             .keyboardShortcut,
             .terminalValueChanged,
             .debugError,
             .uiChanged:
            return true
        case .sessionStarted,
             .sessionEnded,
             .keyboardTextInput,
             .selectionChanged:
            return false
        }
    }

    private func reconcileControlState() {
        guard !lifecycle.stopped else { return }
        if !parent.isAlive() {
            stop(reason: "parent_exited")
            CFRunLoopStop(CFRunLoopGetMain())
            return
        }
        let generation = lifecycle.generation
        lifecycle.reconcile(runtimeControl.readControl())
        guard lifecycle.generation != generation else { return }
        discardPendingWork()
        if lifecycle.state == .stopped {
            stop(reason: "control_stopped")
            CFRunLoopStop(CFRunLoopGetMain())
            return
        }
        if lifecycle.state == .running, let app = NSWorkspace.shared.frontmostApplication {
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            } else {
                installEventTap()
            }
            currentProcessIdentifier = app.processIdentifier
            installAccessibilityObserver(processIdentifier: app.processIdentifier)
        } else {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: false) }
            if let accessibilityObserver {
                CFRunLoopRemoveSource(
                    CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(accessibilityObserver), .defaultMode
                )
                self.accessibilityObserver = nil
            }
        }
        try? writeRuntimeStatus(state: lifecycle.state)
    }

    private func observationAllowed(generation: UInt64? = nil) -> Bool {
        reconcileControlState()
        return lifecycle.allowsObservation(parentAlive: parent.isAlive(), generation: generation)
    }

    private func discardPendingWork() {
        discardPendingContent()
        sampling.invalidate()
        pendingWindow = nil
        pendingValueChange = false
        delivery.reset()
    }

    private func discardPendingContent() {
        textBuffer.discard()
        textSourceSnapshot = nil
        mouseDown = nil
        textFlushTask?.cancel()
        textFlushTask = nil
        callbacks.invalidate()
        selectionDelivery.reset()
    }

    private func writeRuntimeStatus(
        state: RecorderState,
        endedAt: Date? = nil
    ) throws {
        try runtimeControl.writeRuntime(
            RecorderRuntimeStatus(
                state: state,
                processIdentifier: state == .stopped ? nil : getpid(),
                eventStreamRootPath: store.homeURL.path,
                currentSegmentEventsPath: state == .stopped ? nil : store.eventsURL.path,
                currentSegmentMetadataPath: state == .stopped ? nil : store.metadataURL.path,
                suppressedEventsPath: state == .stopped
                    ? nil
                    : store.suppressedEventsURL?.path,
                startedAt: recorderStartedAt,
                endedAt: endedAt,
                lastError: failure == nil ? nil : "storage_failure"
            )
        )
    }

    private func rotateSegment() {
        guard observationAllowed() else {
            return
        }
        flushTextBuffer()
        guard observationAllowed() else { return }
        do {
            store = try store.rotated()
            delivery.reset()
            selectionDelivery.reset()
            try writeRuntimeStatus(state: .running)
        } catch {
            failStorage(error)
        }
    }

    private func failStorage(_ error: Error) {
        failure = failure ?? error
        stop(reason: "storage_failure")
        CFRunLoopStop(CFRunLoopGetMain())
    }
}
