// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Tests/HistoryCoreTests/AXTreeRevisionTests.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import XCTest
@testable import HistoryCore

final class AXTreeRevisionTests: XCTestCase {
    func testDiffReportsChangedAddedAndCompressedRemovedIDs() {
        let previous = AXTreeRevisionSnapshot(lines: [
            0: "AXWindow",
            1: "AXButton title=\"Old\"",
            2: "AXTextField",
            3: "AXGroup",
            4: "AXStaticText",
        ])
        let current = AXTreeRevisionSnapshot(lines: [
            0: "AXWindow",
            1: "AXButton title=\"New\"",
            5: "AXCheckbox",
        ])
        let diff = current.diff(from: previous)
        XCTAssertTrue(diff.contains("~ [1] AXButton title=\"New\""))
        XCTAssertTrue(diff.contains("+ [5] AXCheckbox"))
        XCTAssertTrue(diff.contains("Removed element IDs: 2-4"))
        XCTAssertFalse(diff.contains("The following is a diff"))
    }

    func testNoChangeMessage() {
        let revision = AXTreeRevisionSnapshot(lines: [0: "AXWindow"])
        XCTAssertEqual(
            revision.diff(from: revision),
            "There has been no change in the accessibility tree."
        )
    }
}
