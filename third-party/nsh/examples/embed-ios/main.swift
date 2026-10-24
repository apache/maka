// An existing UIKit app that embeds a nsh app below its own native UI.
//
// Build: see README.md. The nsh bundle (`nsh build ../embedded`) is
// copied into the app as `nsh/bundle.nshc` (+ `nsh/assets`). The app registers
// a native component the bundle uses (`embed.badge`) and talks to it through
// the view's channel (`nsh/host`): launch parameters, the "time" call it
// answers, the "tapped" posts it hears and the "message" events "Send a
// message" sends. "Load update" runs a
// signed package (`nsh publish`) verified against a root key; a real app
// downloads the package, here it ships as `nsh/update.nshpkg` with
// `nsh/root.pub`. "Brand" puts the host's brand over the app's theme
// (`setThemeOverrides`).

import NativeShell
import UIKit

final class EmbedController: UIViewController {
    private let app = NshAppView()
    private let status = UILabel()
    private var count = 0
    private var branded = false
    private lazy var trust: NshTrust? = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return try? NshTrust(stateDirectory: support.appendingPathComponent("nsh"))
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        // Native UI of the host app.
        let title = UILabel()
        title.text = "Native host app"
        title.font = .boldSystemFont(ofSize: 24)
        let reload = UIButton(type: .system)
        reload.setTitle("Reload nsh", for: .normal)
        reload.addTarget(self, action: #selector(load), for: .touchUpInside)
        let update = UIButton(type: .system)
        update.setTitle("Load update", for: .normal)
        update.addTarget(self, action: #selector(loadUpdate), for: .touchUpInside)
        let message = UIButton(type: .system)
        message.setTitle("Send a message", for: .normal)
        message.addTarget(self, action: #selector(sendMessage), for: .touchUpInside)
        status.font = .systemFont(ofSize: 13)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0
        let brand = UIButton(type: .system)
        brand.setTitle("Brand", for: .normal)
        brand.addTarget(self, action: #selector(toggleBrand), for: .touchUpInside)
        let buttons = UIStackView(arrangedSubviews: [reload, update, message, brand])
        buttons.spacing = 16
        let header = UIStackView(arrangedSubviews: [title, buttons, status])
        header.axis = .vertical
        header.alignment = .leading
        header.spacing = 6
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)

        // The embedded nsh app.
        app.translatesAutoresizingMaskIntoConstraints = false
        app.layer.borderColor = UIColor.systemPurple.cgColor
        app.layer.borderWidth = 2
        app.clipsToBounds = true
        app.onError = { [weak self] message in self?.status.text = "nsh error: \(message)" }
        app.register(component: "embed.badge") { context in Badge(context) }
        // The channel with the app (`nsh/host`): what it reads at start, the
        // call it makes and the posts it sends.
        app.params = ["user": "Ada"]
        app.handle("time") { _ in
            ["time": DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)]
        }
        app.handle("tapped") { [weak self] data, _ in
            let count = (data as? [String: Any])?["count"] ?? 0
            self?.status.text = "the app posted tapped: \(count)"
        }
        view.addSubview(app)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            app.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            app.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            app.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            app.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
        load()
    }

    @objc private func load() {
        guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            return
        }
        do {
            try app.loadBundle(at: url)
            count += 1
            status.text = "loaded \(count)×"
        } catch {
            status.text = "\(error)"
        }
    }

    /// An event the app hears with `host.on("message", ...)`.
    @objc private func sendMessage() {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        app.send("message", ["text": "Hello from UIKit at \(time)"])
    }

    /// The host's brand over the app's theme: the tokens it sets win, light and
    /// dark, the app's others stay; `nil` gives the app its own theme back.
    @objc private func toggleBrand() {
        branded.toggle()
        let brand = """
            { "cssVars": {
                "theme": { "radius": "1rem" },
                "light": { "primary": "#e11d48", "primary-foreground": "#ffffff" },
                "dark": { "primary": "#fb7185", "primary-foreground": "#1c1917" }
            } }
            """
        do {
            try app.setThemeOverrides(branded ? brand : nil)
        } catch {
            status.text = "\(error)"
        }
    }

    @objc private func loadUpdate() {
        guard let trust,
            let package = Bundle.main.url(forResource: "update", withExtension: "nshpkg", subdirectory: "nsh"),
            let root = Bundle.main.url(forResource: "root", withExtension: "pub", subdirectory: "nsh")
        else {
            status.text = "no nsh/update.nshpkg and nsh/root.pub in the app"
            return
        }
        Task {
            do {
                try trust.addRoot(String(contentsOf: root, encoding: .utf8))
                let info = try await app.loadPackage(at: package, trust: trust)
                status.text = "running \(info.id) \(info.version) (build \(info.build))"
            } catch {
                status.text = "\(error)"
            }
        }
    }

    // Let the embedded app's pages and dialogs (`statusBar`) set the status bar.
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
        NshAppView.preferredStatusBarUpdateAnimation
    }
}

/// `embed.badge`: a native label the nsh app lays out (`nativeComponent`).
/// Props `text` and `color`; emits `tap` with the count; command `pulse`.
final class Badge: NshComponent {
    let view = UIView()
    private let label = UILabel()
    private let context: NshComponentContext
    private var taps = 0

    init(_ context: NshComponentContext) {
        self.context = context
        label.textColor = .white
        label.font = .boldSystemFont(ofSize: 17)
        label.textAlignment = .center
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    func setProp(_ name: String, _ value: Any?) {
        switch name {
        case "text":
            label.text = value as? String
            // Sized to its text, with padding.
            let size = label.intrinsicContentSize
            context.setSize(CGSize(width: size.width + 32, height: size.height + 20))
        case "color":
            view.backgroundColor = (value as? String).flatMap(UIColor.init(hex:)) ?? .systemPurple
        default:
            break
        }
    }

    func command(_ name: String, _ args: Any?) {
        guard name == "pulse" else { return }
        view.alpha = 0.3
        UIView.animate(withDuration: 0.6) { self.view.alpha = 1 }
    }

    @objc private func tapped() {
        taps += 1
        context.emit("tap", ["count": taps])
    }
}

extension UIColor {
    /// `#rrggbb`.
    convenience init?(hex: String) {
        guard hex.hasPrefix("#"), hex.count == 7, let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
            blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = EmbedController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
