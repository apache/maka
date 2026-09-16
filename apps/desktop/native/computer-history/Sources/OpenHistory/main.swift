// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/OpenHistory/main.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import HistoryCore

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "help"
let homeURL = historyHome()

switch command {
case "applications":
    printApplications(bundleIdentifiers: Array(arguments.dropFirst()))
case "record":
    runRecorder(arguments: Array(arguments.dropFirst()), homeURL: homeURL)
case "maintenance":
    do {
        guard let expected = optionValue("--parent-pid", in: arguments).flatMap(Int32.init) else {
            throw RecorderOwnershipError.invalidParent
        }
        let parent = try RecorderParent(expected: expected)
        try RecorderOwnership.admitMaintenance(homeURL: homeURL, descriptor: 3)
        guard parent.isAlive() else { throw RecorderOwnershipError.invalidParent }
        print("maintenance-admitted")
    } catch RecorderOwnershipError.alreadyActive {
        fputs("Another Computer History recorder is active.\n", stderr)
        exit(75)
    } catch {
        fputs("Maintenance admission failed: \(error)\n", stderr)
        exit(1)
    }
case "sample":
    writeSample(homeURL: homeURL)
case "permissions":
    printPermissions(request: !arguments.contains("--no-prompt"))
case "status":
    printStatus(homeURL: homeURL)
case "pause":
    writePauseControl(arguments: Array(arguments.dropFirst()), homeURL: homeURL)
case "resume":
    writeControlState(.running, homeURL: homeURL)
default:
    printUsage()
}

func historyHome() -> URL {
    if let override = ProcessInfo.processInfo.environment["OPEN_COMPUTER_HISTORY_HOME"],
       !override.isEmpty
    {
        return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath)
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".open-codex-computer-history", isDirectory: true)
}

func runRecorder(arguments: [String], homeURL: URL) {
    do {
        let parentValue = optionValue("--parent-pid", in: arguments)
        if arguments.contains("--parent-pid"), parentValue.flatMap(Int32.init) == nil {
            throw RecorderOwnershipError.invalidParent
        }
        let parent = try RecorderParent(expected: parentValue.flatMap(Int32.init) ?? getppid())
        let ownership = try RecorderOwnership(homeURL: homeURL)
        try withExtendedLifetime(ownership) {
            try runAdmittedRecorder(arguments: arguments, homeURL: homeURL, parent: parent)
        }
    } catch RecorderOwnershipError.alreadyActive {
        fputs("Recorder already active for this history home.\n", stderr)
        exit(75)
    } catch RecorderOwnershipError.invalidParent {
        fputs("Recorder parent must be its live launching process (--parent-pid).\n", stderr)
        exit(2)
    } catch {
        fputs("Recorder failed: \(error)\n", stderr)
        exit(1)
    }
}

func runAdmittedRecorder(arguments: [String], homeURL: URL, parent: RecorderParent) throws {
    guard parent.isAlive() else { throw RecorderOwnershipError.invalidParent }
    let requestPermissions = !arguments.contains("--no-prompt")
    if requestPermissions {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestListenEventAccess()
    }

    guard AXIsProcessTrusted(), CGPreflightListenEventAccess() else {
        fputs(
            "Accessibility and Input Monitoring permissions are required. " +
                "Run `open-history permissions`, then enable the built binary in System Settings.\n",
            stderr
        )
        exit(2)
    }

    guard parent.isAlive() else { throw RecorderOwnershipError.invalidParent }
    var policy = loadPolicy(homeURL: homeURL)
    if arguments.contains("--capture-text") {
        policy.captureText = true
    }
    let store = try SegmentStore(homeURL: homeURL)
    let recorder = HistoryRecorder(store: store, policy: policy, parent: parent)
    let parentMonitor = ProcessExitMonitor(processIdentifier: parent.processIdentifier) {
        recorder.stop(reason: "parent_exited")
        CFRunLoopStop(CFRunLoopGetMain())
    }

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    interruptSource.setEventHandler {
        recorder.stop(reason: "user_interrupt")
        CFRunLoopStop(CFRunLoopGetMain())
    }
    terminateSource.setEventHandler {
        recorder.stop(reason: "terminated")
        CFRunLoopStop(CFRunLoopGetMain())
    }
    interruptSource.resume()
    terminateSource.resume()

    do {
        try recorder.start()
    } catch {
        recorder.stop(reason: "startup_failed")
        throw error
    }
    if let failure = recorder.failure { throw failure }
    print("Recording interaction events to \(store.eventsURL.path)")
    print("Press Control-C to stop.")

    if let duration = optionValue("--duration", in: arguments).flatMap(Double.init) {
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
            recorder.complete()
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
    withExtendedLifetime((parentMonitor, interruptSource, terminateSource)) {
        CFRunLoopRun()
    }
    recorder.stop(reason: "run_loop_ended")
    if let failure = recorder.failure { throw failure }
}

func loadPolicy(homeURL: URL) -> ObservationPolicy {
    let configURL = homeURL.appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configURL),
          let policy = try? JSONDecoder().decode(ObservationPolicy.self, from: data)
    else {
        return ObservationPolicy()
    }
    return policy
}

func writeSample(homeURL: URL) {
    do {
        let store = try SegmentStore(homeURL: homeURL)
        let policy = loadPolicy(homeURL: homeURL)
        let timestamp = Date()
        let app = EventStreamApp(
            name: "Open History Sample",
            secureInput: false,
            processIdentifier: nil,
            bundleIdentifier: "org.openhistory.sample"
        )
        let window = EventStreamWindow(
            title: "Sample workflow",
            url: nil,
            windowID: nil
        )
        let element = EventStreamAXElement(
            role: "AXTextArea",
            subrole: nil,
            title: "Research notes",
            description: nil,
            value: nil,
            placeholder: nil,
            identifier: "notes"
        )
        try store.append(HistoryEvent(
            id: 1,
            timestamp: timestamp,
            kind: .sessionStarted,
            app: app,
            window: window
        ), policy: policy)
        try store.append(HistoryEvent(
            id: 2,
            timestamp: timestamp,
            kind: .windowChanged,
            app: app,
            window: window,
            ax: EventStreamAXTree(
                mode: .fullTree,
                text: "AXWindow[Sample workflow] > AXTextArea[Research notes]"
            )
        ), policy: policy)
        try store.append(HistoryEvent(
            id: 3,
            timestamp: timestamp,
            kind: .keyboardTextInput,
            app: app,
            window: window,
            keyboard: EventStreamKeyboardInteraction(
                text: nil,
                keyEquivalent: nil,
                modifiers: [],
                target: element
            )
        ), policy: policy)
        try store.finish(reason: "sample")
        print(store.eventsURL.path)
    } catch {
        fputs("Failed to write sample: \(error)\n", stderr)
        exit(1)
    }
}

func printPermissions(request: Bool) {
    if request {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestListenEventAccess()
    }
    let status = [
        "accessibility": AXIsProcessTrusted(),
        "inputMonitoring": CGPreflightListenEventAccess(),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]),
       let output = String(data: data, encoding: .utf8)
    {
        print(output)
    }
}

func printStatus(homeURL: URL) {
    let recorderActive: Bool
    do {
        recorderActive = try RecorderOwnership.isActive(homeURL: homeURL)
    } catch {
        fputs("Cannot determine recorder ownership: \(error)\n", stderr)
        exit(1)
    }
    let segmentsURL = homeURL.appendingPathComponent("segments", isDirectory: true)
    let segments = (try? FileManager.default.contentsOfDirectory(
        at: segmentsURL,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
    )) ?? []
    let runtime = RuntimeControlStore(homeURL: homeURL).readRuntime()
    let status: [String: Any] = [
        "home": homeURL.path,
        "segments": segments.count,
        "accessibility": AXIsProcessTrusted(),
        "inputMonitoring": CGPreflightListenEventAccess(),
        "state": runtime?.state.rawValue ?? RecorderState.stopped.rawValue,
        "recorderActive": recorderActive,
        "processIdentifier": runtime?.processIdentifier as Any,
        "currentSegmentEventsPath": runtime?.currentSegmentEventsPath as Any,
        "lastError": runtime?.lastError as Any,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: status, options: [.prettyPrinted, .sortedKeys]),
       let output = String(data: data, encoding: .utf8)
    {
        print(output)
    }
}

func writeControlState(_ state: RecorderState, homeURL: URL) {
    do {
        try RuntimeControlStore(homeURL: homeURL).writeControl(state)
        print(state.rawValue)
    } catch {
        fputs("Failed to update recorder state: \(error)\n", stderr)
        exit(1)
    }
}

func writePauseControl(arguments: [String], homeURL: URL) {
    let resumeAt: Date?
    switch optionValue("--for", in: arguments) {
    case "30m":
        resumeAt = Date().addingTimeInterval(30 * 60)
    case "1h":
        resumeAt = Date().addingTimeInterval(60 * 60)
    case "tomorrow":
        resumeAt = Calendar.current.date(
            byAdding: .day,
            value: 1,
            to: Calendar.current.startOfDay(for: Date())
        )
    case nil:
        resumeAt = nil
    default:
        fputs("Pause duration must be 30m, 1h, or tomorrow.\n", stderr)
        exit(2)
    }
    do {
        try RuntimeControlStore(homeURL: homeURL).writeControl(
            .paused,
            resumeAt: resumeAt
        )
        print(RecorderState.paused.rawValue)
    } catch {
        fputs("Failed to pause recorder: \(error)\n", stderr)
        exit(1)
    }
}

func optionValue(_ option: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: option), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

func printUsage() {
    print("""
    Open Codex Computer History

    Usage:
      open-history record [--duration SECONDS] [--capture-text] [--no-prompt] [--parent-pid PID]
      open-history maintenance --parent-pid PID  (internal; recorder.lock inherited as fd 3)
      open-history sample
      open-history permissions [--no-prompt]
      open-history status
      open-history pause [--for 30m|1h|tomorrow]
      open-history resume
      open-history applications <bundle-id>...

    Environment:
      OPEN_COMPUTER_HISTORY_HOME  Override ~/.open-codex-computer-history
    """)
}
