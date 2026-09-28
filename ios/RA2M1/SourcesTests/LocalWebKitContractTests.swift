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
        let ownerDataRoot = root.appendingPathComponent("Documents/CnC RA2/Data", isDirectory: true)
        try FileManager.default.createDirectory(at: webRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ownerDataRoot, withIntermediateDirectories: true)
        try Data("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>ready".utf8)
            .write(to: webRoot.appendingPathComponent("index.html"))

        let server = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerDataRoot, port: LocalAssetServer.productionPort + 1)
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
        let navigationFinished = expectation(description: "loopback navigation completed")
        var navigationError: Error?
        navigation.didFinish = { navigationFinished.fulfill() }
        navigation.didFail = { error in
            navigationError = error
            navigationFinished.fulfill()
        }
        webView.load(URLRequest(url: server.origin))
        await fulfillment(of: [navigationFinished], timeout: 20)
        if let navigationError { throw navigationError }

        let secureContext = try await webView.evaluateJavaScript("window.isSecureContext") as? Bool
        let indexedDBAvailable = try await webView.evaluateJavaScript("typeof indexedDB !== 'undefined'") as? Bool
        XCTAssertEqual(secureContext, true, "The app-owned loopback origin must support secure browser features.")
        XCTAssertEqual(indexedDBAvailable, true, "Route B save/config storage requires IndexedDB.")

        let storeName = "ra2-m1-\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let writeStarted = try await webView.evaluateJavaScript("""
          (() => {
            window.__ra2M1StorageWrite = 'pending';
            const request = indexedDB.open('\(storeName)', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onerror = () => { window.__ra2M1StorageWrite = 'error'; };
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction('state', 'readwrite');
              transaction.objectStore('state').put('persisted', 'save-boundary');
              transaction.oncomplete = () => {
                window.__ra2M1StorageWrite = 'written';
                database.close();
              };
              transaction.onerror = () => { window.__ra2M1StorageWrite = 'error'; };
            };
            return 'started';
          })()
          """) as? String
        XCTAssertEqual(writeStarted, "started")
        let wrote = try await waitForString("window.__ra2M1StorageWrite", in: webView)
        XCTAssertEqual(wrote, "written")

        let lifecycle = RuntimeLifecycleCoordinator(webView: webView)
        lifecycle.applicationDidEnterBackground()
        lifecycle.applicationWillEnterForeground()
        let readStarted = try await webView.evaluateJavaScript("""
          (() => {
            window.__ra2M1StorageRead = 'pending';
            const request = indexedDB.open('\(storeName)', 1);
            request.onerror = () => { window.__ra2M1StorageRead = 'error'; };
            request.onsuccess = () => {
              const database = request.result;
              const transaction = database.transaction('state', 'readonly');
              const value = transaction.objectStore('state').get('save-boundary');
              value.onsuccess = () => {
                window.__ra2M1StorageRead = typeof value.result === 'string' ? value.result : 'missing';
                database.close();
              };
              value.onerror = () => { window.__ra2M1StorageRead = 'error'; };
            };
            return 'started';
          })()
          """) as? String
        XCTAssertEqual(readStarted, "started")
        let retained = try await waitForString("window.__ra2M1StorageRead", in: webView)
        XCTAssertEqual(retained, "persisted")
        XCTAssertTrue(lifecycle.webView === webView)
    }

    private func waitForString(_ expression: String, in webView: WKWebView) async throws -> String? {
        for _ in 0..<100 {
            if let value = try await webView.evaluateJavaScript(expression) as? String, value != "pending" {
                return value
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        return nil
    }
}

@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    var didFinish: (() -> Void)?
    var didFail: ((Error) -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinish?()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        didFail?(error)
    }
}
