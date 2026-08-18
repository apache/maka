import XCTest
@testable import HistoryCore

final class PolicyTests: XCTestCase {
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
