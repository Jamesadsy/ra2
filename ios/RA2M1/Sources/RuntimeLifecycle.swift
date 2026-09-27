import WebKit

/// Retains the same WKWebView across app background/foreground transitions; it never reloads or recreates the game VM.
@MainActor
final class RuntimeLifecycleCoordinator {
    enum Phase: Equatable {
        case foreground
        case background
    }

    let webView: WKWebView
    private(set) var phase: Phase = .foreground

    init(webView: WKWebView) {
        self.webView = webView
    }

    func applicationDidEnterBackground() {
        phase = .background
        // WKWebView's document visibility event releases held touch keys and gives Route B a pagehide flush.
    }

    func applicationWillEnterForeground() {
        phase = .foreground
        // Keep the live guest and persistent WebsiteDataStore intact; audio unlock retries on the next user gesture.
    }
}
