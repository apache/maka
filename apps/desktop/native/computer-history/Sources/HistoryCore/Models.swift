import Foundation

public enum HistoryEventKind: String, Codable, CaseIterable, Sendable {
    case sessionStarted = "session.started"
    case sessionEnded = "session.ended"
    case windowChanged = "window.changed"
    case mouseClick = "mouse.click"
    case mouseContextMenu = "mouse.context_menu"
    case mouseDrag = "mouse.drag"
    case keyboardTextInput = "keyboard.text_input"
    case keyboardSubmit = "keyboard.submit"
    case keyboardShortcut = "keyboard.shortcut"
    case terminalValueChanged = "terminal.value_changed"
    case selectionChanged = "selection.changed"
    case debugError = "debug.error"
}

public struct EventStreamApp: Codable, Equatable, Sendable {
    public let name: String?
    public let secureInput: Bool
    public let processIdentifier: Int32?
    public let bundleIdentifier: String?

    public init(
        name: String?,
        secureInput: Bool,
        processIdentifier: Int32?,
        bundleIdentifier: String?
    ) {
        self.name = name
        self.secureInput = secureInput
        self.processIdentifier = processIdentifier
        self.bundleIdentifier = bundleIdentifier
    }

    private enum CodingKeys: String, CodingKey {
        case name
        case secureInput
        case processIdentifier
        case bundleIdentifier
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        secureInput = try container.decodeIfPresent(
            Bool.self,
            forKey: .secureInput
        ) ?? false
        processIdentifier = try container.decodeIfPresent(
            Int32.self,
            forKey: .processIdentifier
        )
        bundleIdentifier = try container.decodeIfPresent(
            String.self,
            forKey: .bundleIdentifier
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        if secureInput {
            try container.encode(true, forKey: .secureInput)
        }
        try container.encodeIfPresent(
            processIdentifier,
            forKey: .processIdentifier
        )
        try container.encodeIfPresent(
            bundleIdentifier,
            forKey: .bundleIdentifier
        )
    }
}

public struct EventStreamWindow: Codable, Equatable, Sendable {
    public let title: String?
    public let url: String?
    public let windowID: UInt32?

    public init(title: String?, url: String?, windowID: UInt32?) {
        self.title = title
        self.url = url
        self.windowID = windowID
    }
}

public struct EventStreamAXElement: Codable, Equatable, Sendable {
    public let role: String?
    public let subrole: String?
    public let title: String?
    public let description: String?
    public let value: String?
    public let placeholder: String?
    public let identifier: String?

    public init(
        role: String?,
        subrole: String?,
        title: String?,
        description: String?,
        value: String?,
        placeholder: String?,
        identifier: String?
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.value = value
        self.placeholder = placeholder
        self.identifier = identifier
    }
}

public struct EventStreamMouseDragEndpoint: Codable, Equatable, Sendable {
    public let app: EventStreamApp?
    public let window: EventStreamWindow?
    public let element: EventStreamAXElement?

    public init(
        app: EventStreamApp?,
        window: EventStreamWindow?,
        element: EventStreamAXElement?
    ) {
        self.app = app
        self.window = window
        self.element = element
    }

    public var isEmpty: Bool {
        app == nil && window == nil && element == nil
    }
}

public struct EventStreamMouseInteraction: Codable, Equatable, Sendable {
    public let button: String?
    public let clickCount: Int?
    public let modifiers: [String]
    public let target: EventStreamAXElement?
    public let origin: EventStreamMouseDragEndpoint?
    public let destination: EventStreamMouseDragEndpoint?

    public init(
        button: String?,
        clickCount: Int?,
        modifiers: [String],
        target: EventStreamAXElement?,
        origin: EventStreamMouseDragEndpoint?,
        destination: EventStreamMouseDragEndpoint?
    ) {
        self.button = button
        self.clickCount = clickCount
        self.modifiers = modifiers
        self.target = target
        self.origin = origin
        self.destination = destination
    }

    private enum CodingKeys: String, CodingKey {
        case button
        case clickCount
        case modifiers
        case target
        case origin
        case destination
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        button = try container.decodeIfPresent(String.self, forKey: .button)
        clickCount = try container.decodeIfPresent(Int.self, forKey: .clickCount)
        modifiers = try container.decodeIfPresent(
            [String].self,
            forKey: .modifiers
        ) ?? []
        target = try container.decodeIfPresent(
            EventStreamAXElement.self,
            forKey: .target
        )
        origin = try container.decodeIfPresent(
            EventStreamMouseDragEndpoint.self,
            forKey: .origin
        )
        destination = try container.decodeIfPresent(
            EventStreamMouseDragEndpoint.self,
            forKey: .destination
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(button, forKey: .button)
        try container.encodeIfPresent(clickCount, forKey: .clickCount)
        if !modifiers.isEmpty {
            try container.encode(modifiers, forKey: .modifiers)
        }
        try container.encodeIfPresent(target, forKey: .target)
        try container.encodeIfPresent(origin, forKey: .origin)
        try container.encodeIfPresent(destination, forKey: .destination)
    }
}

public struct EventStreamKeyboardInteraction: Codable, Equatable, Sendable {
    public let text: String?
    public let keyEquivalent: String?
    public let modifiers: [String]
    public let target: EventStreamAXElement?

    public init(
        text: String?,
        keyEquivalent: String?,
        modifiers: [String],
        target: EventStreamAXElement?
    ) {
        self.text = text
        self.keyEquivalent = keyEquivalent
        self.modifiers = modifiers
        self.target = target
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case keyEquivalent
        case modifiers
        case target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        keyEquivalent = try container.decodeIfPresent(
            String.self,
            forKey: .keyEquivalent
        )
        modifiers = try container.decodeIfPresent(
            [String].self,
            forKey: .modifiers
        ) ?? []
        target = try container.decodeIfPresent(
            EventStreamAXElement.self,
            forKey: .target
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(text, forKey: .text)
        try container.encodeIfPresent(keyEquivalent, forKey: .keyEquivalent)
        if !modifiers.isEmpty {
            try container.encode(modifiers, forKey: .modifiers)
        }
        try container.encodeIfPresent(target, forKey: .target)
    }
}

public struct EventStreamTextRange: Codable, Equatable, Sendable {
    public let location: Int
    public let length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }
}

public struct EventStreamSelection: Codable, Equatable, Sendable {
    public let target: EventStreamAXElement?
    public let selectedText: String?
    public let selectedRange: EventStreamTextRange?
    public let selectedItems: [EventStreamAXElement]

    public init(
        target: EventStreamAXElement?,
        selectedText: String?,
        selectedRange: EventStreamTextRange?,
        selectedItems: [EventStreamAXElement]
    ) {
        self.target = target
        self.selectedText = selectedText
        self.selectedRange = selectedRange
        self.selectedItems = selectedItems
    }

    private enum CodingKeys: String, CodingKey {
        case target
        case selectedText
        case selectedRange
        case selectedItems
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decodeIfPresent(
            EventStreamAXElement.self,
            forKey: .target
        )
        selectedText = try container.decodeIfPresent(
            String.self,
            forKey: .selectedText
        )
        selectedRange = try container.decodeIfPresent(
            EventStreamTextRange.self,
            forKey: .selectedRange
        )
        selectedItems = try container.decodeIfPresent(
            [EventStreamAXElement].self,
            forKey: .selectedItems
        ) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(target, forKey: .target)
        try container.encodeIfPresent(selectedText, forKey: .selectedText)
        try container.encodeIfPresent(selectedRange, forKey: .selectedRange)
        if !selectedItems.isEmpty {
            try container.encode(selectedItems, forKey: .selectedItems)
        }
    }
}

public struct EventStreamAXTree: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, Sendable {
        case fullTree
        case diffFromPrevious
    }

    public let mode: Mode
    public let text: String

    public init(mode: Mode, text: String) {
        self.mode = mode
        self.text = text
    }
}

public struct EventStreamDiagnostic: Codable, Equatable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

public struct HistoryEvent: Codable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let timestamp: Date
    public let kind: HistoryEventKind
    public let app: EventStreamApp?
    public let window: EventStreamWindow?
    public let mouse: EventStreamMouseInteraction?
    public let keyboard: EventStreamKeyboardInteraction?
    public let selection: EventStreamSelection?
    public let ax: EventStreamAXTree?
    public let diagnostic: EventStreamDiagnostic?

    public init(
        id: Int,
        timestamp: Date,
        kind: HistoryEventKind,
        app: EventStreamApp? = nil,
        window: EventStreamWindow? = nil,
        mouse: EventStreamMouseInteraction? = nil,
        keyboard: EventStreamKeyboardInteraction? = nil,
        selection: EventStreamSelection? = nil,
        ax: EventStreamAXTree? = nil,
        diagnostic: EventStreamDiagnostic? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.app = app
        self.window = window
        self.mouse = mouse
        self.keyboard = keyboard
        self.selection = selection
        self.ax = ax
        self.diagnostic = diagnostic
    }
}

public struct SegmentMetadata: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let eventsPath: String
    public let startedAt: Date
    public let endedAt: Date?
    public let endReason: String?
    public let eventCount: Int?
    public let suppressedEventCount: Int?

    public init(
        id: String,
        eventsPath: String,
        startedAt: Date,
        endedAt: Date?,
        endReason: String?,
        eventCount: Int?,
        suppressedEventCount: Int?
    ) {
        self.id = id
        self.eventsPath = eventsPath
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.endReason = endReason
        self.eventCount = eventCount
        self.suppressedEventCount = suppressedEventCount
    }
}
