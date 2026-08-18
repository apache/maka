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
case "record":
    runRecorder(arguments: Array(arguments.dropFirst()), homeURL: homeURL)
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

    do {
        var policy = loadPolicy(homeURL: homeURL)
        if arguments.contains("--capture-text") {
            policy.captureText = true
        }
        let store = try SegmentStore(homeURL: homeURL)
        let recorder = HistoryRecorder(store: store, policy: policy)
        try recorder.start()
        print("Recording interaction events to \(store.eventsURL.path)")
        print("Press Control-C to stop.")

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

        if let duration = optionValue("--duration", in: arguments).flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                recorder.stop(reason: "duration_elapsed")
                CFRunLoopStop(CFRunLoopGetMain())
            }
        }
        CFRunLoopRun()
        recorder.stop(reason: "run_loop_ended")
    } catch {
        fputs("Recorder failed: \(error)\n", stderr)
        exit(1)
    }
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
        ))
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
        ))
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
        ))
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
        "processIdentifier": runtime?.processIdentifier as Any,
        "currentSegmentEventsPath": runtime?.currentSegmentEventsPath as Any,
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
      open-history record [--duration SECONDS] [--capture-text] [--no-prompt]
      open-history sample
      open-history permissions [--no-prompt]
      open-history status
      open-history pause [--for 30m|1h|tomorrow]
      open-history resume

    Environment:
      OPEN_COMPUTER_HISTORY_HOME  Override ~/.open-codex-computer-history
    """)
}
