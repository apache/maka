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
//   swift scripts/computer-use/ax-oracle.swift <bundle-id> [--role AXButton] [--depth 8]
// Prints one JSON object: the app, its windows, and every element with a role,
// a label, and a value. Exit 0 means the object describes the tree. Exit 1
// means it describes why there is no tree to describe — `screen_locked`,
// `not_permitted`, `not_running` — and the caller must not read the absence of
// an element as evidence the element is absent. Exit 64 is a usage error.
//
// This is a hand-run tool. It has no automated caller in this repository: it is
// meant to be run beside a Computer Use session, by a person, when an
// observation needs a second opinion.
import AppKit
import ApplicationServices
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  FileHandle.standardError.write("usage: ax-oracle.swift <bundle-id> [--role R] [--depth N]\n".data(using: .utf8)!)
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

func emit(_ object: [String: Any], status: Int32 = 0) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(status)
}

// A state this oracle cannot see through. It is printed as JSON like everything
// else, because a caller may want to read the reason — but it exits non-zero,
// so `ax-oracle.swift X > witness.json && assert ...` cannot walk on with a
// file that says the tree is empty because the oracle was blindfolded. Exiting
// 0 here is the same mistake as an observation that reports success for a
// dispatch that never happened.
func fail(_ object: [String: Any]) -> Never {
  emit(object, status: 1)
}

// The screen lock reshapes every accessibility tree at once, and it does it
// without an error. Report it as a distinct state rather than as an app with
// no windows — that confusion cost a previous session most of an afternoon.
let sessionDictionary = CGSessionCopyCurrentDictionary() as? [String: Any]
if (sessionDictionary?["CGSSessionScreenIsLocked"] as? Int) == 1 {
  fail(["error": "screen_locked"])
}

// Without Accessibility permission every attribute read fails and nothing says
// so. `AXUIElementCopyAttributeValue` returns `.apiDisabled`, `windows` comes
// back empty, and this would emit a well-formed
// `{"window_count":0,"element_count":0,"truncated":false}` — indistinguishable
// from an application that genuinely has nothing in it. A witness that reports
// an empty world when it has been blindfolded is worse than no witness, and on
// this project a node process losing its TCC grant is the likeliest way it
// happens. So it is the second thing checked, after the lock.
if !AXIsProcessTrusted() {
  fail([
    "error": "not_permitted",
    "detail":
      "the process running this oracle has no Accessibility permission, so every attribute read would fail and every tree would read as empty",
  ])
}

guard
  let running = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == bundleId
  })
else {
  fail(["error": "not_running", "bundle_id": bundleId])
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
// Two cuts, reported separately, and either one makes `truncated` true.
//
// The depth cut used to prune the subtree and leave `truncated` false. Every
// consumer of this file makes negative assertions off it — "the sidebar item is
// gone", "one of the two windows is gone", "the document is empty" — and a
// depth cut read that way is a fact about the walk being reported as a fact
// about the world. `--depth` defaults to 12, which is shallower than a real
// Electron tree, so this was not a corner case.
var budgetTruncated = false
var depthTruncated = false
var deepestCut = 0
let elementBudget = 4000

func walk(_ element: AXUIElement, depth: Int, path: String) {
  if elements.count >= elementBudget {
    budgetTruncated = true
    return
  }
  if depth > maxDepth {
    depthTruncated = true
    deepestCut = max(deepestCut, depth)
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
  "truncated": budgetTruncated || depthTruncated,
  "truncated_by_budget": budgetTruncated,
  "truncated_by_depth": depthTruncated,
  "deepest_cut": deepestCut,
  "max_depth": maxDepth,
  "elements": elements,
])
