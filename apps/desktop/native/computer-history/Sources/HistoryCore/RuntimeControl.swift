// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Sources/HistoryCore/RuntimeControl.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import Foundation

public enum RecorderState: String, Codable, Sendable {
    case stopped
    case running
    case paused
}

public struct RecorderRuntimeStatus: Codable, Sendable {
    public let state: RecorderState
    public let processIdentifier: Int32?
    public let eventStreamRootPath: String
    public let currentSegmentEventsPath: String?
    public let currentSegmentMetadataPath: String?
    public let suppressedEventsPath: String?
    public let startedAt: Date?
    public let endedAt: Date?
    public let lastError: String?

    public init(
        state: RecorderState,
        processIdentifier: Int32?,
        eventStreamRootPath: String,
        currentSegmentEventsPath: String?,
        currentSegmentMetadataPath: String?,
        suppressedEventsPath: String?,
        startedAt: Date?,
        endedAt: Date?,
        lastError: String? = nil
    ) {
        self.state = state
        self.processIdentifier = processIdentifier
        self.eventStreamRootPath = eventStreamRootPath
        self.currentSegmentEventsPath = currentSegmentEventsPath
        self.currentSegmentMetadataPath = currentSegmentMetadataPath
        self.suppressedEventsPath = suppressedEventsPath
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.lastError = lastError
    }
}

public struct RecorderControlRequest: Codable, Sendable {
    public let state: RecorderState
    public let updatedAt: Date
    public let resumeAt: Date?
    public let revision: String?

    public init(
        state: RecorderState,
        updatedAt: Date = Date(),
        resumeAt: Date? = nil,
        revision: String? = UUID().uuidString
    ) {
        self.state = state
        self.updatedAt = updatedAt
        self.resumeAt = resumeAt
        self.revision = revision
    }
}

public final class RuntimeControlStore {
    public let homeURL: URL
    public let runtimeURL: URL
    public let controlURL: URL

    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(homeURL: URL) {
        self.homeURL = homeURL
        self.runtimeURL = homeURL.appendingPathComponent("runtime.json")
        self.controlURL = homeURL.appendingPathComponent("control.json")
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    public func writeRuntime(_ status: RecorderRuntimeStatus) throws {
        try FileManager.default.createDirectory(
            at: homeURL,
            withIntermediateDirectories: true
        )
        try encoder.encode(status).write(to: runtimeURL, options: .atomic)
    }

    public func readRuntime() -> RecorderRuntimeStatus? {
        guard let data = try? Data(contentsOf: runtimeURL) else {
            return nil
        }
        return try? decoder.decode(RecorderRuntimeStatus.self, from: data)
    }

    public func writeControl(_ state: RecorderState, resumeAt: Date? = nil) throws {
        try FileManager.default.createDirectory(
            at: homeURL,
            withIntermediateDirectories: true
        )
        try encoder.encode(RecorderControlRequest(state: state, resumeAt: resumeAt))
            .write(to: controlURL, options: .atomic)
    }

    public func readControl() -> RecorderControlRequest? {
        guard let data = try? Data(contentsOf: controlURL) else {
            return nil
        }
        return try? decoder.decode(RecorderControlRequest.self, from: data)
    }
}
