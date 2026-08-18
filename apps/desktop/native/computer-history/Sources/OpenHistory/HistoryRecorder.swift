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

private let accessibilityCallback: AXObserverCallback = { _, _, notification, userInfo in
    guard let userInfo else {
        return
    }
    let recorder = Unmanaged<HistoryRecorder>.fromOpaque(userInfo).takeUnretainedValue()
    recorder.handleAccessibilityNotification(notification as String)
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
    private var policy: ObservationPolicy
    private var sequence = 0
    private var currentProcessIdentifier: pid_t?
    private var workspaceObserver: NSObjectProtocol?
    private var accessibilityObserver: AXObserver?
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var mouseDown: MouseDownState?
    private var textBuffer = ""
    private var textSnapshot: AccessibilitySnapshot?
    private var textFlushTask: DispatchWorkItem?
    private var terminalText: String?
    private var terminalSnapshot: AccessibilitySnapshot?
    private var terminalFlushTask: DispatchWorkItem?
    private var axDebounceTasks: [String: DispatchWorkItem] = [:]
    private var lastWindowSignature: String?
    private var windowRetryTask: DispatchWorkItem?
    private var windowRetryCount = 0
    private var lastSelectionSignature: String?
    private var previousAXRevisionByWindowKey: [String: AXTreeRevisionSnapshot] = [:]
    private var latestURLByWindowID: [UInt32: String] = [:]
    private var controlTimer: Timer?
    private var segmentTimer: Timer?
    private var recorderState: RecorderState = .running
    private var stopped = false

    init(store: SegmentStore, policy: ObservationPolicy) {
        self.store = store
        self.runtimeControl = RuntimeControlStore(homeURL: store.homeURL)
        self.recorderStartedAt = store.startedAt
        self.segmentDurationSeconds = ProcessInfo.processInfo.environment[
            "OPEN_HISTORY_SEGMENT_SECONDS"
        ].flatMap(Double.init) ?? 600
        self.policy = policy
    }

    func start() throws {
        SegmentStore.prune(homeURL: store.homeURL, olderThan: 48 * 60 * 60)
        observeWorkspace()
        installEventTap()

        if let app = NSWorkspace.shared.frontmostApplication {
            currentProcessIdentifier = app.processIdentifier
            installAccessibilityObserver(processIdentifier: app.processIdentifier)
        }
        try append(kind: .sessionStarted, snapshot: currentSnapshot())
        appendWindowChangedIfNeeded(currentSnapshot())
        if runtimeControl.readControl()?.state == .paused {
            recorderState = .paused
        }
        try writeRuntimeStatus(state: recorderState)
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
    }

    func stop(reason: String) {
        guard !stopped else {
            return
        }
        stopped = true
        controlTimer?.invalidate()
        controlTimer = nil
        segmentTimer?.invalidate()
        segmentTimer = nil
        flushTextBuffer()
        flushTerminalBuffer()
        axDebounceTasks.values.forEach { $0.cancel() }
        axDebounceTasks.removeAll()
        windowRetryTask?.cancel()
        windowRetryTask = nil
        try? append(kind: .sessionEnded, snapshot: currentSnapshot())
        try? store.finish(reason: reason)
        try? writeRuntimeStatus(state: .stopped, endedAt: Date())

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
        guard recorderState == .running else {
            return
        }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
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
                snapshot: currentSnapshot(at: event.location)
            )
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            handleMouseUp(event: event)
        default:
            break
        }
    }

    func handleAccessibilityNotification(_ notification: String) {
        guard !stopped, recorderState == .running else {
            return
        }
        axDebounceTasks[notification]?.cancel()
        let task = DispatchWorkItem { [weak self] in
            self?.axDebounceTasks.removeValue(forKey: notification)
            self?.processAccessibilityNotification(notification)
        }
        axDebounceTasks[notification] = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: task)
    }

    private func processAccessibilityNotification(_ notification: String) {
        guard !stopped, recorderState == .running else {
            return
        }
        let snapshot = currentSnapshot()
        switch notification {
        case kAXFocusedWindowChangedNotification,
             kAXTitleChangedNotification:
            appendWindowChangedIfNeeded(snapshot)
        case kAXFocusedUIElementChangedNotification:
            break
        case kAXSelectedTextChangedNotification:
            appendSelection(snapshot)
        case kAXValueChangedNotification:
            if isTerminal(snapshot?.app.bundleIdentifier) {
                terminalSnapshot = snapshot
                terminalText = policy.captureText ? snapshot?.element?.value : nil
                scheduleTerminalFlush()
            }
        default:
            break
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
        flushTextBuffer()
        flushTerminalBuffer()
        windowRetryTask?.cancel()
        windowRetryTask = nil
        windowRetryCount = 0
        currentProcessIdentifier = application.processIdentifier
        installAccessibilityObserver(processIdentifier: application.processIdentifier)
        appendWindowChangedIfNeeded(currentSnapshot())
    }

    private func installAccessibilityObserver(processIdentifier: pid_t) {
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

        let application = AXUIElementCreateApplication(processIdentifier)
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        let notifications = [
            kAXFocusedWindowChangedNotification,
            kAXFocusedUIElementChangedNotification,
            kAXTitleChangedNotification,
            kAXValueChangedNotification,
            kAXSelectedTextChangedNotification,
        ]
        for notification in notifications {
            AXObserverAddNotification(observer, application, notification as CFString, pointer)
        }
        accessibilityObserver = observer
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )
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
        let key = keyEquivalent(event)
        let hasShortcutModifier = flags.contains(.maskCommand) ||
            flags.contains(.maskControl) ||
            flags.contains(.maskAlternate)

        if hasShortcutModifier {
            flushTextBuffer()
            let snapshot = currentSnapshot()
            try? append(
                kind: .keyboardShortcut,
                snapshot: snapshot,
                keyboard: EventStreamKeyboardInteraction(
                    text: nil,
                    keyEquivalent: key,
                    modifiers: modifiers,
                    target: snapshot?.element
                )
            )
            return
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if keyCode == 36 || keyCode == 76 {
            flushTextBuffer()
            let snapshot = currentSnapshot()
            try? append(
                kind: .keyboardSubmit,
                snapshot: snapshot,
                keyboard: EventStreamKeyboardInteraction(
                    text: nil,
                    keyEquivalent: "return",
                    modifiers: modifiers,
                    target: snapshot?.element
                )
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                [weak self] in
                self?.appendSelection(self?.currentSnapshot())
            }
            return
        }

        let characters = NSEvent(cgEvent: event)?.characters ?? ""
        guard !characters.isEmpty else {
            return
        }
        let snapshot = currentSnapshot()
        textSnapshot = snapshot
        if policy.captureText, snapshot?.app.secureInput != true {
            textBuffer.append(characters)
        } else if textBuffer.isEmpty {
            // An empty sentinel keeps a metadata-only typing burst observable.
            textBuffer = "\u{0}"
        }
        scheduleTextFlush()
    }

    private func scheduleTextFlush() {
        textFlushTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            self?.flushTextBuffer()
        }
        textFlushTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: task)
    }

    private func flushTextBuffer() {
        textFlushTask?.cancel()
        textFlushTask = nil
        guard !textBuffer.isEmpty else {
            return
        }
        let snapshot = textSnapshot
        let text = textBuffer == "\u{0}" ? nil : textBuffer
        try? append(
            kind: .keyboardTextInput,
            snapshot: snapshot,
            keyboard: EventStreamKeyboardInteraction(
                text: text,
                keyEquivalent: nil,
                modifiers: [],
                target: snapshot?.element
            )
        )
        textBuffer = ""
        textSnapshot = nil
    }

    private func handleMouseUp(event: CGEvent) {
        guard let down = mouseDown else {
            return
        }
        mouseDown = nil
        let destinationSnapshot = currentSnapshot(at: event.location)
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
                origin: down.snapshot?.dragEndpoint,
                destination: destinationSnapshot?.dragEndpoint
            )
        } else {
            kind = down.button == "right" ? .mouseContextMenu : .mouseClick
            mouse = EventStreamMouseInteraction(
                button: down.button,
                clickCount: down.clickCount,
                modifiers: down.modifiers,
                target: minimalMouseTarget(destinationSnapshot?.element),
                origin: nil,
                destination: nil
            )
        }
        try? append(kind: kind, snapshot: destinationSnapshot, mouse: mouse)
    }

    private func append(
        kind: HistoryEventKind,
        snapshot: AccessibilitySnapshot?,
        mouse: EventStreamMouseInteraction? = nil,
        keyboard: EventStreamKeyboardInteraction? = nil,
        selection: EventStreamSelection? = nil,
        diagnostic: EventStreamDiagnostic? = nil
    ) throws {
        sequence += 1
        let suppressionReason = snapshot.flatMap {
            policy.shouldSuppress(
                bundleIdentifier: $0.app.bundleIdentifier ?? "",
                windowTitle: $0.window?.title,
                urlDomain: ObservationPolicy.normalizedDomain($0.window?.url),
                role: $0.element?.role,
                subrole: $0.element?.subrole
            )
        }
        let isBoundary = kind == .sessionStarted || kind == .sessionEnded
        let eventSnapshot = isBoundary && suppressionReason != nil ? nil : snapshot
        let event = HistoryEvent(
            id: sequence,
            timestamp: Date(),
            kind: kind,
            app: eventSnapshot?.app,
            window: eventSnapshot?.window,
            mouse: mouse,
            keyboard: keyboard,
            selection: selection,
            ax: shouldIncludeAX(kind)
                ? axTree(
                    for: eventSnapshot,
                    forceFull: kind == .keyboardSubmit
                )
                : nil,
            diagnostic: diagnostic
        )

        if isBoundary {
            try store.append(event)
            return
        }
        guard snapshot != nil else {
            try store.appendSuppressed(event)
            return
        }
        if suppressionReason != nil {
            try store.appendSuppressed(event)
        } else {
            try store.append(event)
        }
    }

    private func currentSnapshot(at point: CGPoint? = nil) -> AccessibilitySnapshot? {
        guard let currentProcessIdentifier else {
            return nil
        }
        guard var snapshot = AccessibilityReader.snapshot(
            processIdentifier: currentProcessIdentifier,
            at: point
        ) else {
            return nil
        }
        if let windowID = snapshot.windowID {
            if let url = snapshot.window?.url {
                latestURLByWindowID[windowID] = url
            } else if let cachedURL = latestURLByWindowID[windowID] {
                snapshot = snapshot.replacingWindowURL(cachedURL)
            }
        }
        return snapshot
    }

    private func axTree(
        for snapshot: AccessibilitySnapshot?,
        forceFull: Bool = false
    ) -> EventStreamAXTree? {
        guard let snapshot, let revision = snapshot.axRevision else {
            return nil
        }
        guard let windowKey = axRevisionKey(snapshot) else {
            return EventStreamAXTree(mode: .fullTree, text: revision.fullText())
        }
        let previous = previousAXRevisionByWindowKey[windowKey]
        previousAXRevisionByWindowKey[windowKey] = revision
        if forceFull {
            return EventStreamAXTree(mode: .fullTree, text: revision.fullText())
        }
        if let previous {
            return EventStreamAXTree(
                mode: .diffFromPrevious,
                text: revision.diff(from: previous)
            )
        }
        return EventStreamAXTree(mode: .fullTree, text: revision.fullText())
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

    private func axRevisionKey(_ snapshot: AccessibilitySnapshot) -> String? {
        if let windowID = snapshot.windowID {
            return "window:\(windowID)"
        }
        let bundleIdentifier = snapshot.app.bundleIdentifier ?? ""
        let title = snapshot.window?.title ?? ""
        guard !bundleIdentifier.isEmpty || !title.isEmpty else {
            return nil
        }
        return "context:\(bundleIdentifier)\u{1F}\(title)"
    }

    private func appendWindowChangedIfNeeded(_ snapshot: AccessibilitySnapshot?) {
        guard recorderState == .running else {
            return
        }
        guard let snapshot,
              let title = snapshot.window?.title,
              !title.isEmpty,
              snapshot.axRevision != nil else {
            scheduleWindowRetry()
            return
        }
        windowRetryTask?.cancel()
        windowRetryTask = nil
        windowRetryCount = 0
        let signature = [
            snapshot.app.bundleIdentifier ?? "",
            snapshot.window?.title ?? "",
            snapshot.window?.url ?? "",
            snapshot.windowID.map(String.init) ?? "",
            snapshot.element?.role ?? "",
            snapshot.element?.title ?? "",
            snapshot.element?.identifier ?? "",
        ].joined(separator: "\u{1F}")
        guard signature != lastWindowSignature else {
            return
        }
        lastWindowSignature = signature
        try? append(kind: .windowChanged, snapshot: snapshot)
    }

    private func scheduleWindowRetry() {
        guard windowRetryTask == nil, windowRetryCount < 10 else {
            return
        }
        windowRetryCount += 1
        let task = DispatchWorkItem { [weak self] in
            self?.windowRetryTask = nil
            self?.appendWindowChangedIfNeeded(self?.currentSnapshot())
        }
        windowRetryTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: task)
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
        guard let snapshot else {
            return
        }
        let selectedText = policy.captureText ? snapshot.selectedText : nil
        let selectedRange = snapshot.selectedRange
        guard selectedText?.isEmpty == false ||
                (selectedRange?.length ?? 0) > 0 else {
            return
        }
        let signature = [
            snapshot.element?.identifier ?? "",
            selectedText ?? "",
            selectedRange.map { "\($0.location):\($0.length)" } ?? "",
        ].joined(separator: "\u{1F}")
        guard signature != lastSelectionSignature else {
            return
        }
        lastSelectionSignature = signature
        let selection = EventStreamSelection(
            target: snapshot.element,
            selectedText: selectedText,
            selectedRange: selectedRange,
            selectedItems: snapshot.selectedItems
        )
        try? append(
            kind: .selectionChanged,
            snapshot: snapshot,
            selection: selection
        )
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
             .debugError:
            return true
        case .sessionStarted,
             .sessionEnded,
             .keyboardTextInput,
             .selectionChanged:
            return false
        }
    }

    private func reconcileControlState() {
        guard !stopped, let control = runtimeControl.readControl() else {
            return
        }
        let requested: RecorderState
        if control.state == .paused,
           let resumeAt = control.resumeAt,
           resumeAt <= Date()
        {
            requested = .running
            try? runtimeControl.writeControl(.running)
        } else {
            requested = control.state
        }
        switch (recorderState, requested) {
        case (.running, .paused):
            flushTextBuffer()
            flushTerminalBuffer()
            recorderState = .paused
            try? writeRuntimeStatus(state: .paused)
        case (.paused, .running):
            recorderState = .running
            lastWindowSignature = nil
            try? writeRuntimeStatus(state: .running)
            appendWindowChangedIfNeeded(currentSnapshot())
        default:
            break
        }
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
                endedAt: endedAt
            )
        )
    }

    private func rotateSegment() {
        guard !stopped, recorderState == .running else {
            return
        }
        flushTextBuffer()
        flushTerminalBuffer()
        let homeURL = store.homeURL
        do {
            try store.finish(reason: "segment_rotated")
            store = try SegmentStore(homeURL: homeURL)
            try writeRuntimeStatus(state: .running)
        } catch {
            try? append(
                kind: .debugError,
                snapshot: currentSnapshot(),
                diagnostic: EventStreamDiagnostic(
                    message: "Segment rotation failed: \(error.localizedDescription)"
                )
            )
        }
    }

    private func scheduleTerminalFlush() {
        terminalFlushTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            self?.flushTerminalBuffer()
        }
        terminalFlushTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: task)
    }

    private func flushTerminalBuffer() {
        terminalFlushTask?.cancel()
        terminalFlushTask = nil
        guard let snapshot = terminalSnapshot else {
            return
        }
        try? append(
            kind: .terminalValueChanged,
            snapshot: snapshot,
            keyboard: EventStreamKeyboardInteraction(
                text: terminalText,
                keyEquivalent: nil,
                modifiers: [],
                target: snapshot.element
            )
        )
        terminalText = nil
        terminalSnapshot = nil
    }
}
