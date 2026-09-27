import Foundation
import WebKit
import XCTest
@testable import RA2M1

@MainActor
final class LocalWebKitContractTests: XCTestCase {
    func testLoopbackRuntimeHasDurableBrowserStorageAcrossHostLifecycle() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let webRoot = root.appendingPathComponent("Web", isDirectory: true)
        let ownerRoot = root.appendingPathComponent("OwnerData", isDirectory: true)
        try FileManager.default.createDirectory(at: webRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ownerRoot, withIntermediateDirectories: true)
        try Data("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>ready".utf8)
            .write(to: webRoot.appendingPathComponent("index.html"))

        let server = LocalAssetServer(webRoot: webRoot, ownerRoot: ownerRoot, port: LocalAssetServer.productionPort + 1)
        let ready = expectation(description: "loopback listener ready")
        var startupError: Error?
        server.start { result in
            if case .failure(let error) = result { startupError = error }
            ready.fulfill()
        }
        await fulfillment(of: [ready], timeout: 10)
        if let startupError { throw startupError }
        defer { server.stop() }

        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let navigation = NavigationWaiter()
        webView.navigationDelegate = navigation
        let loaded = expectation(description: "local runtime loaded")
        navigation.didFinish = { loaded.fulfill() }
        webView.load(URLRequest(url: server.origin))
        await fulfillment(of: [loaded], timeout: 20)

        let secureContext = try await webView.evaluateJavaScript("window.isSecureContext") as? Bool
        let indexedDBAvailable = try await webView.evaluateJavaScript("typeof indexedDB !== 'undefined'") as? Bool
        XCTAssertEqual(secureContext, true, "The app-owned loopback origin must support secure browser features.")
        XCTAssertEqual(indexedDBAvailable, true, "Route B save/config storage requires IndexedDB.")

        let storeName = "ra2-m1-\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let wrote = try await webView.evaluateJavaScript("""
          new Promise((resolve, reject) => {
            const request = indexedDB.open('\(storeName)', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const transaction = request.result.transaction('state', 'readwrite');
              transaction.objectStore('state').put('persisted', 'save-boundary');
              transaction.oncomplete = () => resolve('written');
              transaction.onerror = () => reject(transaction.error);
            };
          })
          """) as? String
        XCTAssertEqual(wrote, "written")

        let lifecycle = RuntimeLifecycleCoordinator(webView: webView)
        lifecycle.applicationDidEnterBackground()
        lifecycle.applicationWillEnterForeground()
        let retained = try await webView.evaluateJavaScript("""
          new Promise((resolve, reject) => {
            const request = indexedDB.open('\(storeName)', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const transaction = request.result.transaction('state', 'readonly');
              const value = transaction.objectStore('state').get('save-boundary');
              value.onsuccess = () => resolve(value.result);
              value.onerror = () => reject(value.error);
            };
          })
          """) as? String
        XCTAssertEqual(retained, "persisted")
        XCTAssertTrue(lifecycle.webView === webView)
    }
}

@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    var didFinish: (() -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinish?()
    }
}
