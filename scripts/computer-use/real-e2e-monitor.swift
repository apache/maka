import Cocoa
import CoreGraphics
import Darwin

setbuf(stdout, nil)

let concurrentUserMode = CommandLine.arguments.contains("--concurrent-user")
let snapshotMode = CommandLine.arguments.contains("--snapshot")
let deniedFrontmostBundle: String? = {
    guard let flagIndex = CommandLine.arguments.firstIndex(
        of: "--deny-frontmost-bundle"
    ),
          CommandLine.arguments.indices.contains(flagIndex + 1)
    else {
        return nil
    }
    return CommandLine.arguments[flagIndex + 1]
}()
let mode = concurrentUserMode ? "concurrent_user" : "isolated"
let fixturePID: pid_t? = {
    guard concurrentUserMode,
          let flagIndex = CommandLine.arguments.firstIndex(of: "--concurrent-user"),
          CommandLine.arguments.indices.contains(flagIndex + 1),
          let value = Int32(CommandLine.arguments[flagIndex + 1])
    else {
        return nil
    }
    return value
}()
if concurrentUserMode && fixturePID == nil {
    print("ERROR\tconcurrent mode requires the fixture PID")
    exit(1)
}

func screenIsLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return true
    }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

guard !screenIsLocked() else {
    print("ERROR\tscreen is locked")
    exit(1)
}

guard let initialApplication = NSWorkspace.shared.frontmostApplication else {
    print("ERROR\tno frontmost application")
    exit(1)
}

let frontmostPID = initialApplication.processIdentifier
guard let bundleIdentifier = initialApplication.bundleIdentifier,
      let bundlePath = initialApplication.bundleURL?.resolvingSymlinksInPath().path
else {
    print("ERROR\tfrontmost application identity is incomplete")
    exit(1)
}
let initialPointer = NSEvent.mouseLocation
let startedAt = ProcessInfo.processInfo.systemUptime
let physicalEventTypes: [CGEventType] = [
    .keyDown,
    .leftMouseDown,
    .rightMouseDown,
    .otherMouseDown,
    .mouseMoved,
    .leftMouseDragged,
    .rightMouseDragged,
    .otherMouseDragged,
    .scrollWheel
]
let initialPhysicalInputAge = physicalEventTypes.map { eventType in
    CGEventSource.secondsSinceLastEventType(
        .hidSystemState,
        eventType: eventType
    )
}.min() ?? .infinity
print(
    "READY\t\(mode)\t\(frontmostPID)\t\(initialPointer.x)\t\(initialPointer.y)"
        + "\t\(initialPhysicalInputAge)\t\(bundleIdentifier)\t\(bundlePath)"
)
if snapshotMode {
    exit(0)
}

while true {
    autoreleasepool {
        if screenIsLocked() {
            print("CHANGE\tscreen became locked")
            exit(2)
        }
        let currentPID =
            NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        let currentBundle =
            NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        let currentPointer = NSEvent.mouseLocation
        if let deniedFrontmostBundle, currentBundle == deniedFrontmostBundle {
            print(
                "CHANGE\tdenied bundle became frontmost during E2E: "
                    + deniedFrontmostBundle
            )
            exit(3)
        }
        if concurrentUserMode && currentPID == fixturePID {
            print("CHANGE\tsynthetic fixture became frontmost during concurrent E2E")
            exit(3)
        }
        if !concurrentUserMode && currentPID != frontmostPID {
            print("CHANGE\tfrontmost PID changed: \(frontmostPID) -> \(currentPID)")
            exit(3)
        }
        let displacement = hypot(
            currentPointer.x - initialPointer.x,
            currentPointer.y - initialPointer.y
        )
        if !concurrentUserMode && displacement > 4 {
            print(
                "CHANGE\tpointer moved during isolated E2E: "
                    + "(\(initialPointer.x),\(initialPointer.y)) -> "
                    + "(\(currentPointer.x),\(currentPointer.y)); "
                    + "displacement \(displacement)"
            )
            exit(4)
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
        let receivedPhysicalInput = physicalEventTypes.contains { eventType in
            let age = CGEventSource.secondsSinceLastEventType(
                .hidSystemState,
                eventType: eventType
            )
            return age + 0.02 < elapsed
        }
        if !concurrentUserMode && receivedPhysicalInput {
            print("CHANGE\tphysical user input detected during isolated E2E")
            exit(5)
        }
    }
    usleep(5_000)
}
