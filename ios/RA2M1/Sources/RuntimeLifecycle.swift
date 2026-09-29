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
        dispatchLifecycle("background")
    }

    func applicationWillEnterForeground() {
        phase = .foreground
        dispatchLifecycle("foreground")
    }

    private func dispatchLifecycle(_ nextPhase: String, at date: Date = Date()) {
        let timestampMs = date.timeIntervalSince1970 * 1_000
        let script = "window.__RA2NativeLifecycle && window.__RA2NativeLifecycle('\(nextPhase)', \(timestampMs));"
        webView.evaluateJavaScript(script) { _, _ in
            // The page records lifecycle status through the existing bounded User/Debug bridge.
        }
    }
}
