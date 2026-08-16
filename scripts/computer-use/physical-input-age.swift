import Cocoa
import CoreGraphics

let eventTypes: [CGEventType] = [
    .keyDown,
    .leftMouseDown,
    .rightMouseDown,
    .otherMouseDown,
    .mouseMoved,
    .leftMouseDragged,
    .rightMouseDragged,
    .otherMouseDragged,
    .scrollWheel,
]

let age = eventTypes.map { eventType in
    CGEventSource.secondsSinceLastEventType(
        .hidSystemState,
        eventType: eventType
    )
}.min() ?? .infinity

print(age)
