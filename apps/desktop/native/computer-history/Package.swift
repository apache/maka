// swift-tools-version: 5.10

// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Package.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import PackageDescription

let package = Package(
    name: "OpenCodexComputerHistory",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "open-history", targets: ["OpenHistory"]),
        .library(name: "HistoryCore", targets: ["HistoryCore"]),
    ],
    targets: [
        .target(name: "HistoryCore"),
        .executableTarget(
            name: "OpenHistory",
            dependencies: ["HistoryCore"]
        ),
        .testTarget(
            name: "HistoryCoreTests",
            dependencies: ["HistoryCore", "OpenHistory"]
        ),
    ]
)
