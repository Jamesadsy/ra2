import AVFoundation
import UIKit
import WebKit

@MainActor
final class HostViewController: UIViewController, WKNavigationDelegate {
    private let ownerStore = OwnerDataStore()
    private let statusLabel = UILabel()
    private let detailLabel = UILabel()
    private let checkDataButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)
    private var webView: WKWebView?
    private var server: LocalAssetServer?
    private var lifecycle: RuntimeLifecycleCoordinator?
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.043, blue: 0.047, alpha: 1)
        configureSetupSurface()
        observeApplicationLifecycle()
        checkOwnerDataAndStartRuntime()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        server?.stop()
    }

    private func configureSetupSurface() {
        statusLabel.text = "CnC RA2 — M1 iPhone host"
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "ra2-host-status"

        detailLabel.text = "Copy the contents of the validated RA2 Data stage in Files to On My iPhone → CnC RA2 → Data. Keep User separate for writable state."
        detailLabel.textColor = UIColor(white: 0.78, alpha: 1)
        detailLabel.font = .systemFont(ofSize: 16)
        detailLabel.textAlignment = .center
        detailLabel.numberOfLines = 0
        detailLabel.accessibilityIdentifier = "ra2-host-detail"

        checkDataButton.setTitle("Check Data and start", for: .normal)
        checkDataButton.setTitleColor(.white, for: .normal)
        checkDataButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        checkDataButton.backgroundColor = UIColor(red: 0.42, green: 0.12, blue: 0.1, alpha: 1)
        checkDataButton.layer.cornerRadius = 10
        checkDataButton.contentEdgeInsets = UIEdgeInsets(top: 16, left: 22, bottom: 16, right: 22)
        checkDataButton.addTarget(self, action: #selector(checkOwnerDataAndStartRuntime), for: .touchUpInside)
        checkDataButton.accessibilityIdentifier = "ra2-owner-data-check"

        spinner.color = .white
        spinner.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [statusLabel, detailLabel, checkDataButton, spinner])
        stack.axis = .vertical
        stack.spacing = 22
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28),
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            detailLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
        ])
    }

    @objc private func checkOwnerDataAndStartRuntime() {
        setBusy(true, detail: "Preparing Files-visible Data and User folders…")
        DispatchQueue.global(qos: .userInitiated).async { [ownerStore] in
            let result = Result {
                try ownerStore.prepareDocuments()
                return try ownerStore.validateData()
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.startRuntime()
                case .failure(let error):
                    self.setBusy(
                        false,
                        detail: "Place only the validated RA2 M1 Data files in Files → On My iPhone → CnC RA2 → Data. User stays separate. \(error.localizedDescription)"
                    )
                }
            }
        }
    }

    private func startRuntime() {
        do {
            try ownerStore.validateData()
        } catch {
            setBusy(false, detail: error.localizedDescription)
            return
        }
        setBusy(true, detail: "Starting the offline Route B host…")
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else {
            setBusy(false, detail: "The public Route B application bundle is missing.")
            return
        }
        let ownerDataToken = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let localServer = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerStore.dataURL, ownerDataToken: ownerDataToken)
        server = localServer
        localServer.start { [weak self] outcome in
            DispatchQueue.main.async {
                guard let self else { return }
                switch outcome {
                case .success:
                    self.showWebRuntime(at: localServer.origin, ownerDataToken: ownerDataToken)
                case .failure(let error):
                    self.setBusy(false, detail: "The private loopback host could not start: \(error.localizedDescription)")
                }
            }
        }
    }

    private func showWebRuntime(at origin: URL, ownerDataToken: String) {
        guard webView == nil else { return }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let hostScript = WKUserScript(
            source: "window.__RA2Host = Object.freeze({ platform: 'ios', version: 1, ownerDataToken: '\(ownerDataToken)' });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        configuration.userContentController.addUserScript(hostScript)
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
        view.addSubview(browser)
        NSLayoutConstraint.activate([
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            browser.topAnchor.constraint(equalTo: view.topAnchor),
            browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        statusLabel.isHidden = true
        detailLabel.isHidden = true
        checkDataButton.isHidden = true
        browser.load(URLRequest(url: origin))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == "http", url.host == "127.0.0.1",
              url.port == Int(LocalAssetServer.productionPort) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        runtimeFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        runtimeFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        runtimeFailed(NSError(domain: "RA2M1Host", code: 1, userInfo: [NSLocalizedDescriptionKey: "The iOS web runtime stopped. Tap Resume to reload the public app; the guest session will restart."]))
    }

    private func runtimeFailed(_ error: Error) {
        statusLabel.isHidden = false
        statusLabel.text = "Route B host stopped"
        detailLabel.isHidden = false
        detailLabel.text = error.localizedDescription
        checkDataButton.isHidden = false
        checkDataButton.setTitle("Resume Route B", for: .normal)
        checkDataButton.removeTarget(nil, action: nil, for: .touchUpInside)
        checkDataButton.addTarget(self, action: #selector(resumeRuntime), for: .touchUpInside)
    }

    @objc private func resumeRuntime() {
        guard let webView, server != nil else { return }
        webView.reload()
        statusLabel.isHidden = true
        detailLabel.isHidden = true
        checkDataButton.isHidden = true
    }

    private func setBusy(_ busy: Bool, detail: String) {
        statusLabel.isHidden = false
        detailLabel.isHidden = false
        detailLabel.text = detail
        checkDataButton.isHidden = busy
        busy ? spinner.startAnimating() : spinner.stopAnimating()
    }

    private func observeApplicationLifecycle() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.lifecycle?.applicationDidEnterBackground() }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.lifecycle?.applicationWillEnterForeground() }
        })
    }
}
