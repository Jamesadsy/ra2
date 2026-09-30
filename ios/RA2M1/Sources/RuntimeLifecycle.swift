import WebKit

/// Retains the same WKWebView across app background/foreground transitions; it never reloads or recreates the game VM.
@MainActor
final class RuntimeLifecycleCoordinator {
    enum Phase: Equatable {
        case foreground
        case background
    }

    let webView: WKWebView
    let diagnostics: RuntimeDiagnosticsLog
    private(set) var phase: Phase = .foreground

    init(webView: WKWebView, diagnostics: RuntimeDiagnosticsLog) {
        self.webView = webView
        self.diagnostics = diagnostics
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
        let dispatchMs = Date().timeIntervalSince1970 * 1_000
        diagnostics.recordNativeMetrics("audio lifecycle dispatch phase=\(nextPhase) eventMs=\(timestampMs) dispatchMs=\(dispatchMs)")
        let script = "window.__RA2NativeLifecycle && window.__RA2NativeLifecycle('\(nextPhase)', \(timestampMs));"
        webView.evaluateJavaScript(script) { [diagnostics] _, error in
            let completionMs = Date().timeIntervalSince1970 * 1_000
            diagnostics.recordNativeMetrics("audio lifecycle completion phase=\(nextPhase) completionMs=\(completionMs) success=\(error == nil ? 1 : 0)")
        }
    }
}
