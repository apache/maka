// An accessibility oracle that owes Computer Use nothing.
//
// Every real-machine check so far read the result back through the same path
// that wrote it: the model acts through maka-cu, and then the observation
// that says it worked also comes from maka-cu. An executor that reports a
// successful click on a control it never touched passes that test. So does a
// locked screen, which is how a menu-only tree once read as a normal one.
//
// This walks the accessibility tree itself, through the system framework, in a
// separate process. When it and an observation disagree, the observation is
// the one that has to explain itself.
//
// Usage:
//   swift cu-ax-oracle.swift <bundle-id> [--role AXButton] [--depth 8]
// Prints one JSON object: the app, its windows, and every element with a role,
// a label, and a value.
import AppKit
import ApplicationServices
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  FileHandle.standardError.write("usage: cu-ax-oracle.swift <bundle-id> [--role R] [--depth N]\n".data(using: .utf8)!)
  exit(64)
}
let bundleId = arguments[1]
var roleFilter: String?
var maxDepth = 12
var index = 2
while index < arguments.count {
  switch arguments[index] {
  case "--role" where index + 1 < arguments.count:
    roleFilter = arguments[index + 1]
    index += 2
  case "--depth" where index + 1 < arguments.count:
    maxDepth = Int(arguments[index + 1]) ?? maxDepth
    index += 2
  default:
    index += 1
  }
}

func emit(_ object: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

// The screen lock reshapes every accessibility tree at once, and it does it
// without an error. Report it as a distinct state rather than as an app with
// no windows — that confusion cost a previous session most of an afternoon.
let sessionDictionary = CGSessionCopyCurrentDictionary() as? [String: Any]
if (sessionDictionary?["CGSSessionScreenIsLocked"] as? Int) == 1 {
  emit(["error": "screen_locked"])
}

guard
  let running = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == bundleId
  })
else {
  emit(["error": "not_running", "bundle_id": bundleId])
}
let pid = running.processIdentifier

func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
  guard let value = copyAttribute(element, attribute) else { return nil }
  if let string = value as? String { return string }
  if CFGetTypeID(value) == AXValueGetTypeID() { return nil }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  guard let value = copyAttribute(element, kAXChildrenAttribute as String) else { return [] }
  return (value as? [AXUIElement]) ?? []
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  guard
    let positionValue = copyAttribute(element, kAXPositionAttribute as String),
    let sizeValue = copyAttribute(element, kAXSizeAttribute as String)
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard
    AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
    AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  else { return nil }
  return ["x": point.x, "y": point.y, "w": size.width, "h": size.height]
}

var elements: [[String: Any]] = []
var truncated = false
let elementBudget = 4000

func walk(_ element: AXUIElement, depth: Int, path: String) {
  if depth > maxDepth || elements.count >= elementBudget {
    if elements.count >= elementBudget { truncated = true }
    return
  }
  let role = stringAttribute(element, kAXRoleAttribute as String) ?? "?"
  if roleFilter == nil || role == roleFilter {
    var record: [String: Any] = ["role": role, "depth": depth, "path": path]
    if let title = stringAttribute(element, kAXTitleAttribute as String), !title.isEmpty {
      record["title"] = title
    }
    if let description = stringAttribute(element, kAXDescriptionAttribute as String),
      !description.isEmpty
    {
      record["description"] = description
    }
    if let value = stringAttribute(element, kAXValueAttribute as String), !value.isEmpty {
      record["value"] = value.count > 400 ? String(value.prefix(400)) + "…" : value
    }
    if let identifier = stringAttribute(element, "AXIdentifier"), !identifier.isEmpty {
      record["identifier"] = identifier
    }
    if let bounds = frame(element) { record["frame"] = bounds }
    elements.append(record)
  }
  for (childIndex, child) in children(element).enumerated() {
    walk(child, depth: depth + 1, path: "\(path)/\(childIndex)")
  }
}

let application = AXUIElementCreateApplication(pid)
// The menu bar is not part of any window, and including it is what makes an
// app look like it has hundreds of controls it does not have. Walk the windows.
let windowValue = copyAttribute(application, kAXWindowsAttribute as String)
let windows = (windowValue as? [AXUIElement]) ?? []
var windowRecords: [[String: Any]] = []
for (windowIndex, window) in windows.enumerated() {
  var record: [String: Any] = ["index": windowIndex]
  if let title = stringAttribute(window, kAXTitleAttribute as String) { record["title"] = title }
  if let bounds = frame(window) { record["frame"] = bounds }
  if let subrole = stringAttribute(window, kAXSubroleAttribute as String) {
    record["subrole"] = subrole
  }
  windowRecords.append(record)
  walk(window, depth: 0, path: "w\(windowIndex)")
}

emit([
  "bundle_id": bundleId,
  "pid": Int(pid),
  "localized_name": running.localizedName ?? "",
  "active": running.isActive,
  "window_count": windows.count,
  "windows": windowRecords,
  "element_count": elements.count,
  "truncated": truncated,
  "elements": elements,
])
