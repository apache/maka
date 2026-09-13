/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import Darwin
import XCTest
@testable import HistoryCore

final class RecorderOwnershipTests: XCTestCase {
    func testLockAdmissionProbeReleaseAndReacquisition() throws {
        let root = temporaryHome()
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertFalse(try RecorderOwnership.isActive(homeURL: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        var owner: RecorderOwnership? = try RecorderOwnership(homeURL: root)
        XCTAssertNotNil(owner)
        XCTAssertTrue(try RecorderOwnership.isActive(homeURL: root))
        XCTAssertThrowsError(try RecorderOwnership(homeURL: root)) {
            guard case RecorderOwnershipError.alreadyActive = $0 else {
                return XCTFail("Unexpected admission error: \($0)")
            }
        }
        let path = root.appendingPathComponent("recorder.lock").path
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        owner = nil
        XCTAssertFalse(try RecorderOwnership.isActive(homeURL: root))
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        let next = try RecorderOwnership(homeURL: root)
        try withExtendedLifetime(next) {
            XCTAssertTrue(try RecorderOwnership.isActive(homeURL: root))
        }
    }

    func testSymlinkOrDirectoryLockFailsClosed() throws {
        let root = temporaryHome()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let lock = root.appendingPathComponent("recorder.lock")
        try FileManager.default.createSymbolicLink(at: lock, withDestinationURL: root)
        XCTAssertThrowsError(try RecorderOwnership.isActive(homeURL: root))
        XCTAssertThrowsError(try RecorderOwnership(homeURL: root))
        try FileManager.default.removeItem(at: lock)
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: false)
        XCTAssertThrowsError(try RecorderOwnership.isActive(homeURL: root))
    }

    func testMaintenanceRequiresExactWritableLockAndRetainsParentDescription() throws {
        let root = temporaryHome()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let path = root.appendingPathComponent("recorder.lock").path
        let parent = open(path, O_CREAT | O_RDWR, 0o600)
        XCTAssertGreaterThanOrEqual(parent, 0)
        defer { close(parent) }
        let other = open(root.appendingPathComponent("other.lock").path, O_CREAT | O_RDWR, 0o600)
        defer { close(other) }
        XCTAssertThrowsError(try RecorderOwnership.admitMaintenance(homeURL: root, descriptor: other))
        let readOnly = open(path, O_RDONLY)
        defer { close(readOnly) }
        XCTAssertThrowsError(try RecorderOwnership.admitMaintenance(homeURL: root, descriptor: readOnly))
        XCTAssertThrowsError(try RecorderOwnership.admitMaintenance(homeURL: root, descriptor: -1))
        let inherited = dup(parent)
        try RecorderOwnership.admitMaintenance(homeURL: root, descriptor: inherited)
        close(inherited)
        XCTAssertTrue(try RecorderOwnership.isActive(homeURL: root))
        XCTAssertThrowsError(try RecorderOwnership(homeURL: root))
        let contender = open(path, O_RDWR)
        defer { close(contender) }
        XCTAssertThrowsError(try RecorderOwnership.admitMaintenance(homeURL: root, descriptor: contender)) {
            guard case RecorderOwnershipError.alreadyActive = $0 else {
                return XCTFail("Unexpected admission error: \($0)")
            }
        }
    }

    func testParentIdentityRejectsOrphansAndDifferentLaunchers() throws {
        for expected: Int32 in [0, 1, -1, 123] {
            XCTAssertThrowsError(try RecorderParent(expected: expected, actual: 42))
        }
        let parent = try RecorderParent(expected: 42, actual: 42)
        XCTAssertTrue(parent.isAlive(actual: 42))
        XCTAssertFalse(parent.isAlive(actual: 1))
        XCTAssertFalse(parent.isAlive(actual: 43))
        XCTAssertTrue(try RecorderParent(expected: getppid()).isAlive())
    }

    func testCLIRefusesDuplicateAndWrongParentBeforePermissionsOrSegmentCreation() throws {
        let root = temporaryHome()
        defer { try? FileManager.default.removeItem(at: root) }
        let helper = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/debug/open-history")
        func run(_ arguments: [String]) throws -> (Int32, String) {
            let process = Process()
            let output = Pipe()
            process.executableURL = helper
            process.arguments = arguments
            process.environment = ProcessInfo.processInfo.environment.merging(
                ["OPEN_COMPUTER_HISTORY_HOME": root.path], uniquingKeysWith: { _, new in new }
            )
            process.standardOutput = output
            process.standardError = output
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        }
        let wrongParent = try run(["record", "--no-prompt", "--parent-pid", "1"])
        XCTAssertEqual(wrongParent.0, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        let owner = try RecorderOwnership(homeURL: root)
        try withExtendedLifetime(owner) {
            let status = try run(["status"])
            XCTAssertEqual(status.0, 0)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(
                with: Data(status.1.utf8)
            ) as? [String: Any])
            XCTAssertEqual(json["recorderActive"] as? Bool, true)
            let duplicate = try run(["record", "--no-prompt", "--parent-pid", String(getpid())])
            XCTAssertEqual(duplicate.0, 75)
            XCTAssertTrue(duplicate.1.contains("Recorder already active"))
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: root.appendingPathComponent("segments").path
            ))
        }
    }

    func testProcessExitNotificationForSyntheticChildWithoutCapture() throws {
        let child = Process()
        let input = Pipe()
        child.executableURL = URL(fileURLWithPath: "/bin/cat")
        child.standardInput = input
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer {
            if child.isRunning { child.terminate() }
            child.waitUntilExit()
        }
        let exited = expectation(description: "kernel process exit")
        let monitor = ProcessExitMonitor(processIdentifier: child.processIdentifier) {
            exited.fulfill()
        }
        try input.fileHandleForWriting.close()
        withExtendedLifetime(monitor) { wait(for: [exited], timeout: 3) }
        child.waitUntilExit()
        XCTAssertEqual(child.terminationStatus, 0)
    }

    private func temporaryHome() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
}
