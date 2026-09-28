import AVFoundation
import UIKit
import WebKit

@MainActor
final class HostViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let ownerStore = OwnerDataStore()
    private let statusSurface = UIView()
    private let statusLabel = UILabel()
    private let progressLabel = UILabel()
    private let detailLabel = UILabel()
    private let checkDataButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)
    private lazy var diagnostics = RuntimeDiagnosticsLog(userURL: ownerStore.userURL)
    private var webView: WKWebView?
    private var server: LocalAssetServer?
    private var lifecycle: RuntimeLifecycleCoordinator?
    private var observers: [NSObjectProtocol] = []
    private var startup = RuntimeStartupState()
    private var ownerDataToken: String?
    private var startupTimeout: DispatchWorkItem?
    private var lastNativeMetrics = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.043, blue: 0.047, alpha: 1)
        configureStatusSurface()
        observeApplicationLifecycle()
        beginLaunch()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    deinit {
        startupTimeout?.cancel()
        observers.forEach(NotificationCenter.default.removeObserver)
        server?.stop()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let orientation: String
        switch view.window?.windowScene?.interfaceOrientation {
        case .landscapeLeft: orientation = "landscapeLeft"
        case .landscapeRight: orientation = "landscapeRight"
        case .portrait: orientation = "portrait"
        case .portraitUpsideDown: orientation = "portraitUpsideDown"
        default: orientation = "unknown"
        }
        let values = [
            "width=\(Int(view.bounds.width))",
            "height=\(Int(view.bounds.height))",
            "scale=\(view.window?.screen.scale ?? UIScreen.main.scale)",
            "safeTop=\(Int(view.safeAreaInsets.top))",
            "safeRight=\(Int(view.safeAreaInsets.right))",
            "safeBottom=\(Int(view.safeAreaInsets.bottom))",
            "safeLeft=\(Int(view.safeAreaInsets.left))",
            "orientation=\(orientation)",
        ].joined(separator: " ")
        if values != lastNativeMetrics {
            lastNativeMetrics = values
            diagnostics.recordEvent("native viewport changed")
            diagnostics.recordNativeMetrics(values)
        }
    }

    private func configureStatusSurface() {
        statusSurface.backgroundColor = UIColor(red: 0.035, green: 0.043, blue: 0.047, alpha: 0.96)
        statusSurface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusSurface)

        statusLabel.text = "CnC RA2 — M1 iPhone host"
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "ra2-host-status"

        progressLabel.text = "Data valid\nLocal server ready\nMain navigation finished\nWeb host bootstrap acknowledged\nOwner Data listing acknowledged\nOwner game source validated\nVM startup entered\nFirst game frame observed"
        progressLabel.textColor = UIColor(white: 0.83, alpha: 1)
        progressLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        progressLabel.textAlignment = .left
        progressLabel.numberOfLines = 0
        progressLabel.accessibilityIdentifier = "ra2-host-progress"

        detailLabel.text = "Copy the contents of the validated RA2 Data stage in Files to On My iPhone → CnC RA2 → Data. Keep User separate for writable state."
        detailLabel.textColor = UIColor(white: 0.78, alpha: 1)
        detailLabel.font = .systemFont(ofSize: 15)
        detailLabel.textAlignment = .center
        detailLabel.numberOfLines = 0
        detailLabel.accessibilityIdentifier = "ra2-host-detail"

        checkDataButton.setTitle("Check Data and start", for: .normal)
        checkDataButton.setTitleColor(.white, for: .normal)
        checkDataButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        checkDataButton.backgroundColor = UIColor(red: 0.42, green: 0.12, blue: 0.1, alpha: 1)
        checkDataButton.layer.cornerRadius = 10
        checkDataButton.contentEdgeInsets = UIEdgeInsets(top: 14, left: 22, bottom: 14, right: 22)
        checkDataButton.addTarget(self, action: #selector(retryLaunch), for: .touchUpInside)
        checkDataButton.accessibilityIdentifier = "ra2-owner-data-check"

        spinner.color = .white
        spinner.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [statusLabel, progressLabel, detailLabel, checkDataButton, spinner])
        stack.axis = .vertical
        stack.spacing = 15
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        statusSurface.addSubview(stack)
        NSLayoutConstraint.activate([
            statusSurface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            statusSurface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            statusSurface.topAnchor.constraint(equalTo: view.topAnchor),
            statusSurface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: statusSurface.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: statusSurface.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: statusSurface.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: statusSurface.safeAreaLayoutGuide.trailingAnchor, constant: -28),
            statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 660),
            progressLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            detailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 660),
        ])
    }

    @objc private func retryLaunch() {
        diagnostics.recordEvent("runtime retry requested")
        beginLaunch()
    }

    private func beginLaunch() {
        startupTimeout?.cancel()
        startupTimeout = nil
        removeWebView()
        server?.stop()
        server = nil
        ownerDataToken = nil
        startup = RuntimeStartupState()
        statusSurface.isHidden = false
        statusSurface.isUserInteractionEnabled = true
        statusLabel.text = "Checking RA2 Data"
        progressLabel.text = startup.progressText
        checkDataButton.setTitle("Retry", for: .normal)
        checkDataButton.isHidden = true
        detailLabel.text = "Preparing the Files-visible Data and User folders…"
        spinner.startAnimating()

        do {
            try ownerStore.prepareDocuments()
            try diagnostics.beginRun(identity: appIdentity())
        } catch {
            showFailure(kind: "startup", message: error.localizedDescription, record: true)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [ownerStore] in
            let result = Result { try ownerStore.validateData() }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.acknowledge(.dataValid)
                    self.startLocalServer()
                case .failure(let error):
                    self.showFailure(kind: "ownerData", message: error.localizedDescription, record: true)
                }
            }
        }
    }

    private func startLocalServer() {
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        ownerDataToken = token
        diagnostics.setOwnerDataToken(token)
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else {
            showFailure(kind: "startup", message: "The packaged public Web runtime is missing.", record: true)
            return
        }
        let localServer = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerStore.dataURL, ownerDataToken: token)
        localServer.onDiagnosticResponse = { [weak self] route, status in
            self?.diagnostics.recordRoute(route, status: status)
        }
        server = localServer
        setBusy("Starting the private loopback Web host…")
        localServer.start { [weak self, weak localServer] outcome in
            DispatchQueue.main.async {
                guard let self, let localServer else { return }
                switch outcome {
                case .success:
                    self.diagnostics.recordEvent("LocalAssetServer listener ready")
                    self.acknowledge(.localServerReady)
                    self.showWebRuntime(at: localServer.origin, ownerDataToken: token)
                case .failure(let error):
                    self.diagnostics.recordEvent("LocalAssetServer failed")
                    self.showFailure(kind: "startup", message: "The private loopback host could not start: \(error.localizedDescription)", record: true)
                }
            }
        }
    }

    private func showWebRuntime(at origin: URL, ownerDataToken: String) {
        guard webView == nil else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let contentController = WKUserContentController()
        contentController.add(WeakScriptMessageHandler(target: self), name: "ra2Diagnostics")
        contentController.addUserScript(RuntimeHostBridge.userScript(ownerDataToken: ownerDataToken))
        configuration.userContentController = contentController
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.translatesAutoresizingMaskIntoConstraints = false
        browser.navigationDelegate = self
        browser.scrollView.isScrollEnabled = false
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        browser.isOpaque = false
        browser.backgroundColor = view.backgroundColor
        browser.accessibilityIdentifier = "ra2-route-b-webview"
        webView = browser
        lifecycle = RuntimeLifecycleCoordinator(webView: browser)
        view.insertSubview(browser, at: 0)
        NSLayoutConstraint.activate([
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            browser.topAnchor.constraint(equalTo: view.topAnchor),
            browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        acknowledge(.mainNavigationStarted)
        diagnostics.recordEvent("WebKit navigation started")
        setBusy("Loading the packaged public Route B runtime…")
        browser.load(URLRequest(url: origin))
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, !self.startup.isReady else { return }
            self.showFailure(kind: "startup", message: self.startup.timeoutMessage, record: true)
        }
        startupTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 180, execute: timeout)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == "http", url.host == "127.0.0.1",
              url.port == Int(LocalAssetServer.productionPort) else {
            diagnostics.recordEvent("WebKit navigation blocked")
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        diagnostics.recordEvent("WebKit navigation finished")
        acknowledge(.mainNavigationFinished)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        diagnostics.recordEvent("WebKit navigation failed")
        showFailure(kind: "navigation", message: error.localizedDescription, record: true)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        diagnostics.recordEvent("WebKit provisional navigation failed")
        showFailure(kind: "navigation", message: error.localizedDescription, record: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagnostics.recordEvent("WebContent process terminated")
        showFailure(kind: "webContent", message: "The iOS WebKit content process terminated before runtime readiness. Tap Retry to restart the local host.", record: true)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "ra2Diagnostics", message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }
        switch kind {
        case "phase":
            guard let name = body["phase"] as? String, let phase = RuntimeStartupPhase.bridgePhase(name) else { return }
            acknowledge(phase)
            if phase == .firstGameFrameObserved {
                startupTimeout?.cancel()
                startupTimeout = nil
                statusSurface.isHidden = true
                statusSurface.isUserInteractionEnabled = false
                if let webView { view.bringSubviewToFront(webView) }
            }
        case "error":
            let event = body["event"] as? String ?? "runtime"
            let text = body["message"] as? String ?? "Unspecified JavaScript runtime error"
            let stack = body["stack"] as? String ?? ""
            diagnostics.recordError(event: event, message: text, stack: stack)
            if ["window", "unhandledrejection", "bootstrap", "fatalVM", "navigation", "webContent", "ownerData", "startup"].contains(event) {
                showFailure(kind: event, message: text, record: false)
            }
        case "event":
            guard let event = body["event"] as? String else { return }
            recordBridgeEvent(event)
        case "touch":
            diagnostics.recordTouch(body)
        case "metrics":
            diagnostics.recordWebMetrics(body)
        default:
            return
        }
    }

    private func acknowledge(_ phase: RuntimeStartupPhase) {
        startup.acknowledge(phase)
        diagnostics.recordPhase(phase)
        statusLabel.text = phase.rawValue
        progressLabel.text = startup.progressText
        if phase != .firstGameFrameObserved {
            detailLabel.text = "Waiting for the next Route B startup phase. If startup stops, the current phase and error are saved in User/LastLaunchDiagnostics.txt."
        }
    }

    private func recordBridgeEvent(_ event: String) {
        let fixed = [
            "web bootstrap entry executed",
            "web AppShell mounted",
            "native viewport changed",
            "web pagehide",
            "runtime shutdown",
        ]
        if fixed.contains(event) {
            diagnostics.recordEvent(event)
        } else if event.hasPrefix("vm status: ") {
            let phase = String(event.dropFirst("vm status: ".count))
            if ["loading", "starting", "running", "paused", "stopped", "exited", "blocked", "error"].contains(phase) {
                diagnostics.recordEvent("vm status: \(phase)")
            }
        }
    }

    private func appIdentity() -> [String: String] {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "app": info["CFBundleDisplayName"] as? String ?? "CnC RA2",
            "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "sourceBranch": info["RA2SourceBranch"] as? String ?? "",
            "sourceCommit": info["RA2SourceCommit"] as? String ?? "",
        ]
    }

    private func removeWebView() {
        if let browser = webView {
            diagnostics.recordEvent("runtime shutdown")
            browser.configuration.userContentController.removeScriptMessageHandler(forName: "ra2Diagnostics")
            browser.navigationDelegate = nil
            browser.stopLoading()
            browser.removeFromSuperview()
        }
        webView = nil
        lifecycle = nil
    }

    private func showFailure(kind: String, message: String, record: Bool) {
        startupTimeout?.cancel()
        startupTimeout = nil
        if record { diagnostics.recordError(event: kind, message: message) }
        let visible = RuntimeDiagnosticsLog.sanitize(message, secret: ownerDataToken, limit: 900)
        statusSurface.isHidden = false
        statusSurface.isUserInteractionEnabled = true
        statusLabel.text = "Runtime startup failed"
        detailLabel.text = "\(startup.lastAcknowledged?.rawValue ?? "Native launch")\n\(visible)\n\nSend User/LastLaunchDiagnostics.txt and the newest User/Debug and User/touchlog files to the Second Sun team."
        progressLabel.text = startup.progressText
        checkDataButton.setTitle("Retry", for: .normal)
        checkDataButton.isHidden = false
        spinner.stopAnimating()
    }

    private func setBusy(_ detail: String) {
        statusSurface.isHidden = false
        statusSurface.isUserInteractionEnabled = true
        detailLabel.text = detail
        checkDataButton.isHidden = true
        spinner.startAnimating()
    }

    private func observeApplicationLifecycle() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.diagnostics.recordEvent("application entered background")
                self?.lifecycle?.applicationDidEnterBackground()
            }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.diagnostics.recordEvent("application entered foreground")
                self?.lifecycle?.applicationWillEnterForeground()
            }
        })
    }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
