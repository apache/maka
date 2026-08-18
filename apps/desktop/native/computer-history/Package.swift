// swift-tools-version: 5.10

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
            dependencies: ["HistoryCore"]
        ),
    ]
)
