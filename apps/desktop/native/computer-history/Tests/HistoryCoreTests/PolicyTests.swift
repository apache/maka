// Adapted from https://github.com/hqhq1025/open-codex-computer-history
// Source: collector/Tests/HistoryCoreTests/PolicyTests.swift
// Revision: 30c99f904d9375a01e17a05516f896ebda24a544
// Copyright (c) 2026 Open Codex Computer History contributors
// Licensed under MIT; see apps/desktop/resources/licenses/open-computer-history/LICENSE.
// Modified by Maka for its vendored Computer History helper.

import XCTest
@testable import HistoryCore

final class PolicyTests: XCTestCase {
    func testSafariLocalizedMarkersStayBrowserScopedAndOrdinaryTitlesRemainAllowed() {
        let policy = ObservationPolicy()
        for bundle in ["com.apple.Safari", "com.apple.SafariTechnologyPreview"] {
            for title in ["Neutral - Privat nettlesing", "Neutral - NAVIGAZIONE PRIVATA"] {
                XCTAssertTrue(ObservationPolicy.isPrivateBrowsing(bundleIdentifier: bundle, title: title))
                XCTAssertEqual(policy.shouldSuppress(bundleIdentifier: bundle, windowTitle: title,
                    urlDomain: "example.com", role: "AXTextArea", subrole: nil), "private_browsing")
            }
            XCTAssertFalse(ObservationPolicy.isPrivateBrowsing(bundleIdentifier: bundle, title: "Neutral research notes"))
        }
        for bundle in ["test.editor", "com.apple.Safari.unverified", "com.google.Chrome"] {
            XCTAssertFalse(ObservationPolicy.isPrivateBrowsing(bundleIdentifier: bundle, title: "Privat nettlesing"))
        }
        for bundle in ["com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev"] {
            XCTAssertTrue(ObservationPolicy.isPrivateBrowsing(bundleIdentifier: bundle, title: "Neutral [InPrivate]"))
        }
    }

    func testTextCaptureMatchesOfficialDefault() {
        XCTAssertTrue(ObservationPolicy().captureText)
    }

    func testPrivateBrowsingIsAlwaysSuppressed() {
        let policy = ObservationPolicy()
        XCTAssertEqual(
            policy.shouldSuppress(
                bundleIdentifier: "com.google.Chrome",
                windowTitle: "New Incognito Tab",
                urlDomain: nil,
                role: "AXWebArea",
                subrole: nil
            ),
            "private_browsing"
        )
    }

    func testLocalizedChromeIncognitoTitleIsSuppressed() {
        let policy = ObservationPolicy()
        XCTAssertEqual(
            policy.shouldSuppress(
                bundleIdentifier: "com.google.Chrome",
                windowTitle: "新的无痕式标签页 - Google Chrome（无痕）",
                urlDomain: "support.google.com",
                role: "AXWebArea",
                subrole: nil
            ),
            "private_browsing"
        )
    }

    func testSecureTextFieldIsAlwaysSuppressed() {
        let policy = ObservationPolicy(captureText: true)
        XCTAssertEqual(
            policy.shouldSuppress(
                bundleIdentifier: "com.apple.Safari",
                windowTitle: "Login",
                urlDomain: "example.com",
                role: "AXSecureTextField",
                subrole: nil
            ),
            "secure_input"
        )
    }

    func testWebsiteAllowlistIncludesSubdomains() {
        let policy = ObservationPolicy(
            observation: .init(
                defaultURLBehavior: .doNotObserve,
                allowlist: [.init(scope: .url, urlDomain: "example.com")],
                blocklist: []
            )
        )
        XCTAssertTrue(policy.allowsDomain("docs.example.com"))
        XCTAssertFalse(policy.allowsDomain("example.org"))
    }
}
