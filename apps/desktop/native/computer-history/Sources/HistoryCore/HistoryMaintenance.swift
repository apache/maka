import Foundation

public enum HistoryClearScope: Sendable {
    case lastTenMinutes
    case lastHour
    case lastDay
    case today
    case interval(start: Date, end: Date)
    case applicationSession(bundleIdentifier: String?)
    case all

    func interval(now: Date) -> DateInterval? {
        switch self {
        case .lastTenMinutes:
            return DateInterval(start: now.addingTimeInterval(-600), end: now)
        case .lastHour:
            return DateInterval(start: now.addingTimeInterval(-3_600), end: now)
        case .lastDay:
            return DateInterval(start: now.addingTimeInterval(-86_400), end: now)
        case .today:
            let calendar = Calendar.current
            return DateInterval(start: calendar.startOfDay(for: now), end: now)
        case let .interval(start, end):
            return DateInterval(start: start, end: end)
        case .applicationSession, .all:
            return nil
        }
    }
}

public struct HistoryClearResult: Equatable, Sendable {
    public let deletedEventCount: Int
    public let deletedMemoryCount: Int

    public init(deletedEventCount: Int, deletedMemoryCount: Int) {
        self.deletedEventCount = deletedEventCount
        self.deletedMemoryCount = deletedMemoryCount
    }
}

public enum HistoryMaintenance {
    public static func clear(
        homeURL: URL,
        scope: HistoryClearScope,
        now: Date = Date()
    ) throws -> HistoryClearResult {
        let segmentsURL = homeURL.appendingPathComponent("segments", isDirectory: true)
        let memoriesURL = homeURL
            .appendingPathComponent("memories", isDirectory: true)
            .appendingPathComponent("resources", isDirectory: true)

        if case .all = scope {
            let eventCount = countJSONLLines(under: segmentsURL)
            let memoryCount = countFiles(under: memoriesURL, suffix: ".md")
            try? FileManager.default.removeItem(at: segmentsURL)
            try? FileManager.default.removeItem(at: memoriesURL)
            return HistoryClearResult(
                deletedEventCount: eventCount,
                deletedMemoryCount: memoryCount
            )
        }

        let applicationBundleIdentifier: String?
        let resolvedInterval: DateInterval?
        if case let .applicationSession(bundleIdentifier) = scope {
            applicationBundleIdentifier = bundleIdentifier
            resolvedInterval = latestApplicationSessionInterval(
                homeURL: homeURL,
                bundleIdentifier: bundleIdentifier
            )
        } else {
            applicationBundleIdentifier = nil
            resolvedInterval = scope.interval(now: now)
        }
        guard let interval = resolvedInterval else {
            return HistoryClearResult(deletedEventCount: 0, deletedMemoryCount: 0)
        }
        var deletedEventCount = 0
        for segmentURL in directoryContents(segmentsURL) {
            for filename in ["events.jsonl", "suppressed.jsonl"] {
                let fileURL = segmentURL.appendingPathComponent(filename)
                deletedEventCount += try filterEvents(
                    fileURL,
                    excluding: interval,
                    bundleIdentifier: applicationBundleIdentifier
                )
            }
            try updateMetadata(in: segmentURL)
        }

        var deletedMemoryCount = 0
        for memoryURL in directoryContents(memoriesURL)
            where memoryURL.pathExtension == "md"
        {
            let date = memoryDate(memoryURL)
                ?? (try? memoryURL.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ).contentModificationDate)
            guard let date, interval.contains(date) else {
                continue
            }
            try FileManager.default.removeItem(at: memoryURL)
            deletedMemoryCount += 1
        }
        return HistoryClearResult(
            deletedEventCount: deletedEventCount,
            deletedMemoryCount: deletedMemoryCount
        )
    }

    private static func filterEvents(
        _ fileURL: URL,
        excluding interval: DateInterval,
        bundleIdentifier: String?
    ) throws -> Int {
        guard let data = try? Data(contentsOf: fileURL),
              let text = String(data: data, encoding: .utf8)
        else {
            return 0
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var retained: [String] = []
        var deleted = 0
        for line in text.split(whereSeparator: \.isNewline).map(String.init) {
            guard let event = try? decoder.decode(
                HistoryEvent.self,
                from: Data(line.utf8)
            ) else {
                retained.append(line)
                continue
            }
            let matchesBundle = bundleIdentifier == nil ||
                event.app?.bundleIdentifier == bundleIdentifier
            if interval.contains(event.timestamp), matchesBundle {
                deleted += 1
            } else {
                retained.append(line)
            }
        }
        let output = retained.isEmpty ? "" : retained.joined(separator: "\n") + "\n"
        try Data(output.utf8).write(to: fileURL, options: .atomic)
        return deleted
    }

    private static func latestApplicationSessionInterval(
        homeURL: URL,
        bundleIdentifier: String?
    ) -> DateInterval? {
        let segmentsURL = homeURL.appendingPathComponent("segments", isDirectory: true)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var events: [HistoryEvent] = []
        for segmentURL in directoryContents(segmentsURL) {
            let eventsURL = segmentURL.appendingPathComponent("events.jsonl")
            guard let text = try? String(contentsOf: eventsURL, encoding: .utf8) else {
                continue
            }
            events.append(contentsOf: text.split(whereSeparator: \.isNewline).compactMap {
                try? decoder.decode(HistoryEvent.self, from: Data($0.utf8))
            })
        }
        events.sort { $0.timestamp < $1.timestamp }

        var sessions: [(bundleIdentifier: String, start: Date, end: Date)] = []
        var current: (bundleIdentifier: String, start: Date, end: Date)?
        for event in events {
            guard let currentBundleIdentifier = event.app?.bundleIdentifier else {
                continue
            }
            if current?.bundleIdentifier != currentBundleIdentifier {
                if let current {
                    sessions.append(current)
                }
                current = (
                    bundleIdentifier: currentBundleIdentifier,
                    start: event.timestamp,
                    end: event.timestamp
                )
            } else {
                current?.end = event.timestamp
            }
        }
        if let current {
            sessions.append(current)
        }
        guard let selected = sessions.reversed().first(where: {
            bundleIdentifier == nil || $0.bundleIdentifier == bundleIdentifier
        }) else {
            return nil
        }
        return DateInterval(
            start: selected.start,
            end: selected.end.addingTimeInterval(0.001)
        )
    }

    private static func updateMetadata(in segmentURL: URL) throws {
        let metadataURL = segmentURL.appendingPathComponent("metadata.json")
        guard let data = try? Data(contentsOf: metadataURL) else {
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let metadata = try? decoder.decode(SegmentMetadata.self, from: data) else {
            return
        }
        let updated = SegmentMetadata(
            id: metadata.id,
            eventsPath: metadata.eventsPath,
            startedAt: metadata.startedAt,
            endedAt: metadata.endedAt,
            endReason: metadata.endReason,
            eventCount: countLines(
                segmentURL.appendingPathComponent("events.jsonl")
            ),
            suppressedEventCount: countLines(
                segmentURL.appendingPathComponent("suppressed.jsonl")
            )
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(updated).write(to: metadataURL, options: .atomic)
    }

    private static func countJSONLLines(under root: URL) -> Int {
        directoryContents(root).reduce(0) { total, segment in
            total + countLines(segment.appendingPathComponent("events.jsonl"))
                + countLines(segment.appendingPathComponent("suppressed.jsonl"))
        }
    }

    private static func countFiles(under root: URL, suffix: String) -> Int {
        directoryContents(root).filter { $0.path.hasSuffix(suffix) }.count
    }

    private static func countLines(_ fileURL: URL) -> Int {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else {
            return 0
        }
        return text.split(whereSeparator: \.isNewline).count
    }

    private static func directoryContents(_ root: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
    }

    private static func memoryDate(_ url: URL) -> Date? {
        let pattern =
            #"^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(
                in: url.lastPathComponent,
                range: NSRange(url.lastPathComponent.startIndex..., in: url.lastPathComponent)
              ),
              match.numberOfRanges == 5,
              let prefixRange = Range(match.range(at: 1), in: url.lastPathComponent),
              let hourRange = Range(match.range(at: 2), in: url.lastPathComponent),
              let minuteRange = Range(match.range(at: 3), in: url.lastPathComponent),
              let secondRange = Range(match.range(at: 4), in: url.lastPathComponent)
        else {
            return nil
        }
        let value = "\(url.lastPathComponent[prefixRange])" +
            "\(url.lastPathComponent[hourRange]):" +
            "\(url.lastPathComponent[minuteRange]):" +
            "\(url.lastPathComponent[secondRange])Z"
        return ISO8601DateFormatter().date(from: value)
    }
}
