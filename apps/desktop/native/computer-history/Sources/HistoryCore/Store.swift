// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/HistoryCore/Store.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import Foundation

public final class SegmentStore {
    public let homeURL: URL
    public let segmentURL: URL
    public let eventsURL: URL
    public let suppressedEventsURL: URL?
    public let metadataURL: URL
    public let sessionID: String
    public let segmentID: String
    public let startedAt: Date

    private let encoder: JSONEncoder
    private var eventsHandle: FileHandle
    private var suppressedHandle: FileHandle?
    private(set) public var eventCount = 0
    private(set) public var suppressedEventCount = 0

    public init(
        homeURL: URL,
        now: Date = Date(),
        persistSuppressedEvents: Bool = false
    ) throws {
        self.homeURL = homeURL
        self.sessionID = UUID().uuidString.lowercased()
        self.segmentID = UUID().uuidString.lowercased()
        self.startedAt = now

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"

        self.segmentURL = homeURL
            .appendingPathComponent("segments", isDirectory: true)
            .appendingPathComponent("\(formatter.string(from: now))-\(segmentID.prefix(8))", isDirectory: true)
        self.eventsURL = segmentURL.appendingPathComponent("events.jsonl")
        self.suppressedEventsURL = persistSuppressedEvents
            ? segmentURL.appendingPathComponent("suppressed.jsonl")
            : nil
        self.metadataURL = segmentURL.appendingPathComponent("metadata.json")

        try FileManager.default.createDirectory(
            at: segmentURL,
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: eventsURL.path, contents: nil)
        self.eventsHandle = try FileHandle(forWritingTo: eventsURL)
        if let suppressedEventsURL {
            FileManager.default.createFile(
                atPath: suppressedEventsURL.path,
                contents: nil
            )
            self.suppressedHandle = try FileHandle(
                forWritingTo: suppressedEventsURL
            )
        } else {
            self.suppressedHandle = nil
        }

        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.encoder.dateEncodingStrategy = .iso8601
        try writeMetadata(endedAt: nil, reason: nil)
    }

    deinit {
        try? eventsHandle.close()
        try? suppressedHandle?.close()
    }

    /// Applies the supplied policy before writing. Suppressed interactions are
    /// counted instead; suppressed session boundaries retain only their identity.
    @discardableResult
    public func append(_ event: HistoryEvent, policy: ObservationPolicy) throws -> Bool {
        guard let projected = policy.eventForPersistence(event) else {
            try appendSuppressed(event)
            return false
        }
        try write(projected, to: eventsHandle)
        eventCount += 1
        return true
    }

    /// Counts an event rejected by the producer. Optional debug output contains
    /// only its ID, timestamp and kind, never the rejected payload.
    public func appendSuppressed(_ event: HistoryEvent) throws {
        if let suppressedHandle {
            try write(event.persistenceIdentity, to: suppressedHandle)
        }
        suppressedEventCount += 1
    }

    public func finish(reason: String, now: Date = Date()) throws {
        try writeMetadata(endedAt: now, reason: reason)
        try eventsHandle.synchronize()
        try suppressedHandle?.synchronize()
    }

    private func writeMetadata(endedAt: Date?, reason: String?) throws {
        let metadata = SegmentMetadata(
            id: sessionID,
            eventsPath: eventsURL.path,
            startedAt: startedAt,
            endedAt: endedAt,
            endReason: reason,
            eventCount: eventCount,
            suppressedEventCount: suppressedEventCount
        )
        let data = try encoder.encode(metadata)
        try data.write(to: metadataURL, options: .atomic)
    }

    public static func prune(homeURL: URL, olderThan interval: TimeInterval, now: Date = Date()) {
        let root = homeURL.appendingPathComponent("segments", isDirectory: true)
        guard let directories = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }
        for directory in directories {
            let values = try? directory.resourceValues(forKeys: [.contentModificationDateKey])
            guard let modifiedAt = values?.contentModificationDate,
                  now.timeIntervalSince(modifiedAt) > interval
            else {
                continue
            }
            try? FileManager.default.removeItem(at: directory)
        }
    }

    private func write<T: Encodable>(_ value: T, to handle: FileHandle) throws {
        var data = try encoder.encode(value)
        data.append(0x0A)
        try handle.write(contentsOf: data)
    }
}

public extension ISO8601DateFormatter {
    static let openHistory: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
