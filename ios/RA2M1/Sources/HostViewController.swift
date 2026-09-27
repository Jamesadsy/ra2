import AVFoundation
import UniformTypeIdentifiers
import UIKit
import WebKit

@MainActor
final class HostViewController: UIViewController, UIDocumentPickerDelegate, WKNavigationDelegate {
    private let ownerStore = OwnerDataStore()
    private let statusLabel = UILabel()
    private let detailLabel = UILabel()
    private let importButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)
    private var webView: WKWebView?
    private var server: LocalAssetServer?
    private var lifecycle: RuntimeLifecycleCoordinator?
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.043, blue: 0.047, alpha: 1)
        configureImportSurface()
        observeApplicationLifecycle()
        validateExistingInstall()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        server?.stop()
    }

    private func configureImportSurface() {
        statusLabel.text = "Red Alert 2 — M1 iPhone host"
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "ra2-host-status"

        detailLabel.text = "Import your official EA RA2 1.08 data folder. Owner data stays private to this device."
        detailLabel.textColor = UIColor(white: 0.78, alpha: 1)
        detailLabel.font = .systemFont(ofSize: 16)
        detailLabel.textAlignment = .center
        detailLabel.numberOfLines = 0
        detailLabel.accessibilityIdentifier = "ra2-host-detail"

        importButton.setTitle("Import official EA RA2 1.08 data", for: .normal)
        importButton.setTitleColor(.white, for: .normal)
        importButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        importButton.backgroundColor = UIColor(red: 0.42, green: 0.12, blue: 0.1, alpha: 1)
        importButton.layer.cornerRadius = 10
        importButton.contentEdgeInsets = UIEdgeInsets(top: 16, left: 22, bottom: 16, right: 22)
        importButton.addTarget(self, action: #selector(chooseOwnerFolder), for: .touchUpInside)
        importButton.accessibilityIdentifier = "ra2-owner-import"

        spinner.color = .white
        spinner.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [statusLabel, detailLabel, importButton, spinner])
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

    private func validateExistingInstall() {
        setBusy(true, detail: "Checking private owner data…")
        DispatchQueue.global(qos: .userInitiated).async { [ownerStore] in
            let result = Result { try ownerStore.validateInstalled() }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.startRuntime()
                case .failure:
                    self.setBusy(false, detail: "Select the extracted ra2 folder prepared from your official EA installation.")
                }
            }
        }
    }

    @objc private func chooseOwnerFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let source = urls.first else { return }
        let hasSecurityScope = source.startAccessingSecurityScopedResource()
        setBusy(true, detail: "Validating and privately importing EA RA2 1.08…")
        DispatchQueue.global(qos: .userInitiated).async { [ownerStore] in
            let result = Result { try ownerStore.importFolder(source) }
            if hasSecurityScope { source.stopAccessingSecurityScopedResource() }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                switch result {
                case .success:
                    self.startRuntime()
                case .failure(let error):
                    self.setBusy(false, detail: error.localizedDescription)
                }
            }
        }
    }

    private func startRuntime() {
        do {
            try ownerStore.validateInstalled()
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
        let localServer = LocalAssetServer(webRoot: webRoot, ownerRoot: ownerStore.containerURL, ownerDataToken: ownerDataToken)
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
        importButton.isHidden = true
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
        importButton.isHidden = false
        importButton.setTitle("Resume Route B", for: .normal)
        importButton.removeTarget(self, action: #selector(chooseOwnerFolder), for: .touchUpInside)
        importButton.addTarget(self, action: #selector(resumeRuntime), for: .touchUpInside)
    }

    @objc private func resumeRuntime() {
        guard let webView, server != nil else { return }
        webView.reload()
        statusLabel.isHidden = true
        detailLabel.isHidden = true
        importButton.isHidden = true
    }

    private func setBusy(_ busy: Bool, detail: String) {
        statusLabel.isHidden = false
        detailLabel.isHidden = false
        detailLabel.text = detail
        importButton.isHidden = busy
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
