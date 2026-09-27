import UIKit
import WebKit
import XCTest
@testable import RA2M1

@MainActor
final class RuntimeLifecycleTests: XCTestCase {
    func testBackgroundForegroundRetainsTheSameLiveWebView() {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let lifecycle = RuntimeLifecycleCoordinator(webView: webView)

        lifecycle.applicationDidEnterBackground()
        XCTAssertEqual(lifecycle.phase, .background)
        XCTAssertTrue(lifecycle.webView === webView)
        lifecycle.applicationWillEnterForeground()
        XCTAssertEqual(lifecycle.phase, .foreground)
        XCTAssertTrue(lifecycle.webView === webView)
    }
}
