import Foundation

public struct AXTreeRevisionSnapshot: Equatable, Sendable {
    public let lines: [Int: String]

    public init(lines: [Int: String]) {
        self.lines = lines
    }

    public func fullText() -> String {
        lines.keys.sorted().compactMap { id in
            lines[id].map { "[\(id)] \($0)" }
        }.joined(separator: "\n")
    }

    public func diff(from previous: AXTreeRevisionSnapshot) -> String {
        var output: [String] = []
        for id in lines.keys.sorted() {
            guard let current = lines[id] else {
                continue
            }
            if let old = previous.lines[id] {
                if old != current {
                    output.append("~ [\(id)] \(current)")
                }
            } else {
                output.append("+ [\(id)] \(current)")
            }
        }
        let removed = previous.lines.keys.filter { lines[$0] == nil }.sorted()
        if !removed.isEmpty {
            output.append("- Removed element IDs: \(compressedRanges(removed))")
        }
        if output.isEmpty {
            return "There has been no change in the accessibility tree."
        }
        return output.joined(separator: "\n")
    }

    private func compressedRanges(_ values: [Int]) -> String {
        guard let first = values.first else {
            return ""
        }
        var ranges: [String] = []
        var start = first
        var previous = first
        for value in values.dropFirst() {
            if value == previous + 1 {
                previous = value
                continue
            }
            ranges.append(start == previous ? "\(start)" : "\(start)-\(previous)")
            start = value
            previous = value
        }
        ranges.append(start == previous ? "\(start)" : "\(start)-\(previous)")
        return ranges.joined(separator: ", ")
    }
}
