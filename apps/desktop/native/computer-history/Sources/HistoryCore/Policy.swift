import Foundation

public struct ObservationPolicy: Codable, Equatable, Sendable {
    public enum DefaultBehavior: String, Codable, Sendable {
        case observe
        case doNotObserve = "do_not_observe"
    }

    public enum RuleScope: String, Codable, Sendable {
        case application
        case url
    }

    public struct Rule: Codable, Equatable, Hashable, Sendable {
        public let scope: RuleScope
        public let bundleID: String?
        public let urlDomain: String?

        public init(scope: RuleScope, bundleID: String? = nil, urlDomain: String? = nil) {
            self.scope = scope
            self.bundleID = bundleID
            self.urlDomain = urlDomain
        }
    }

    public struct ObservationSettings: Codable, Equatable, Sendable {
        public var defaultApplicationBehavior: DefaultBehavior
        public var defaultURLBehavior: DefaultBehavior
        public var allowlist: [Rule]
        public var blocklist: [Rule]

        public init(
            defaultApplicationBehavior: DefaultBehavior = .observe,
            defaultURLBehavior: DefaultBehavior = .observe,
            allowlist: [Rule] = [],
            blocklist: [Rule] = []
        ) {
            self.defaultApplicationBehavior = defaultApplicationBehavior
            self.defaultURLBehavior = defaultURLBehavior
            self.allowlist = allowlist
            self.blocklist = blocklist
        }
    }

    public var observation: ObservationSettings
    public var showMenuBarIcon: Bool
    public var captureText: Bool

    public init(
        observation: ObservationSettings = ObservationSettings(),
        showMenuBarIcon: Bool = true,
        captureText: Bool = true
    ) {
        self.observation = observation
        self.showMenuBarIcon = showMenuBarIcon
        self.captureText = captureText
    }

    private enum CodingKeys: String, CodingKey {
        case observation
        case showMenuBarIcon
        case captureText
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        observation = try container.decodeIfPresent(
            ObservationSettings.self,
            forKey: .observation
        ) ?? ObservationSettings()
        showMenuBarIcon = try container.decodeIfPresent(
            Bool.self,
            forKey: .showMenuBarIcon
        ) ?? true
        captureText = try container.decodeIfPresent(
            Bool.self,
            forKey: .captureText
        ) ?? true
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(observation, forKey: .observation)
        try container.encode(showMenuBarIcon, forKey: .showMenuBarIcon)
        try container.encode(captureText, forKey: .captureText)
    }

    public func allowsApplication(_ bundleIdentifier: String) -> Bool {
        if matchesApplication(bundleIdentifier, in: observation.blocklist) {
            return false
        }
        if matchesApplication(bundleIdentifier, in: observation.allowlist) {
            return true
        }
        return observation.defaultApplicationBehavior == .observe
    }

    public func allowsDomain(_ domain: String?) -> Bool {
        guard let normalized = Self.normalizedDomain(domain) else {
            return observation.defaultURLBehavior == .observe
        }
        if matchesDomain(normalized, in: observation.blocklist) {
            return false
        }
        if matchesDomain(normalized, in: observation.allowlist) {
            return true
        }
        return observation.defaultURLBehavior == .observe
    }

    public func shouldSuppress(
        bundleIdentifier: String,
        windowTitle: String?,
        urlDomain: String?,
        role: String?,
        subrole: String?
    ) -> String? {
        guard allowsApplication(bundleIdentifier) else {
            return "application_policy"
        }
        guard allowsDomain(urlDomain) else {
            return "url_policy"
        }
        if Self.isPrivateBrowsing(
            bundleIdentifier: bundleIdentifier,
            title: windowTitle
        ) {
            return "private_browsing"
        }
        if Self.isSecureRole(role, subrole: subrole) {
            return "secure_input"
        }
        return nil
    }

    public static func normalizedDomain(_ value: String?) -> String? {
        guard var value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty
        else {
            return nil
        }
        if let url = URL(string: value.contains("://") ? value : "https://\(value)"),
           let host = url.host
        {
            value = host
        }
        return value.hasPrefix("www.") ? String(value.dropFirst(4)) : value
    }

    public static func isPrivateBrowsing(
        bundleIdentifier: String,
        title: String?
    ) -> Bool {
        guard browserBundleIdentifiers.contains(bundleIdentifier),
              let title = title?.lowercased()
        else {
            return false
        }
        return [
            "private browsing",
            "incognito",
            "inprivate",
            "private window",
            "无痕",
            "無痕",
            "私密浏览",
            "私密瀏覽",
            "シークレット",
            "プライベート",
            "시크릿",
            "프라이빗",
            "inkognito",
            "navigation privée",
            "navegación privada",
            "incógnito",
            "navegação privada",
            "in incognito",
            "инкогнито",
        ].contains { title.contains($0) }
    }

    public static func isSecureRole(_ role: String?, subrole: String?) -> Bool {
        let values = [role, subrole].compactMap { $0?.lowercased() }
        return values.contains {
            $0.contains("securetextfield") ||
                $0.contains("password") ||
                $0.contains("secure input")
        }
    }

    private func matchesApplication(_ bundleIdentifier: String, in rules: [Rule]) -> Bool {
        rules.contains {
            $0.scope == .application && $0.bundleID == bundleIdentifier
        }
    }

    private func matchesDomain(_ domain: String, in rules: [Rule]) -> Bool {
        rules.contains {
            guard $0.scope == .url, let ruleDomain = Self.normalizedDomain($0.urlDomain) else {
                return false
            }
            return domain == ruleDomain || domain.hasSuffix("." + ruleDomain)
        }
    }

    private static let browserBundleIdentifiers = Set([
        "com.google.Chrome",
        "com.google.Chrome.beta",
        "com.google.Chrome.canary",
        "com.google.Chrome.dev",
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.microsoft.edgemac",
        "com.microsoft.edgemac.Beta",
        "com.microsoft.edgemac.Canary",
        "com.microsoft.edgemac.Dev",
        "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition",
        "org.mozilla.nightly",
    ])
}
