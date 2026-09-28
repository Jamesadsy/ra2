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

    func testPackagedHostBridgeAcknowledgesBootstrapAndForwardsJavascriptFailures() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let webRoot = root.appendingPathComponent("Web", isDirectory: true)
        let ownerDataRoot = root.appendingPathComponent("Data", isDirectory: true)
        try FileManager.default.createDirectory(at: webRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ownerDataRoot, withIntermediateDirectories: true)
        try Data("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>ready".utf8)
            .write(to: webRoot.appendingPathComponent("index.html"))

        let server = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerDataRoot, port: LocalAssetServer.productionPort + 2, ownerDataToken: "f00dbabe1234567890abcdef12345678")
        let ready = expectation(description: "diagnostic bridge loopback listener ready")
        var startupError: Error?
        server.start { result in
            if case .failure(let error) = result { startupError = error }
            ready.fulfill()
        }
        await fulfillment(of: [ready], timeout: 10)
        if let startupError { throw startupError }
        defer { server.stop() }

        let content = WKUserContentController()
        let messages = DiagnosticMessageWaiter()
        content.add(messages, name: "ra2Diagnostics")
        content.addUserScript(RuntimeHostBridge.userScript(ownerDataToken: "f00dbabe1234567890abcdef12345678"))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let navigation = NavigationWaiter()
        webView.navigationDelegate = navigation
        let navigationFinished = expectation(description: "bridge document finished")
        var navigationError: Error?
        navigation.didFinish = { navigationFinished.fulfill() }
        navigation.didFail = { error in
            navigationError = error
            navigationFinished.fulfill()
        }
        webView.load(URLRequest(url: server.origin))
        await fulfillment(of: [navigationFinished], timeout: 20)
        if let navigationError { throw navigationError }

        let hostInstalled = try await webView.evaluateJavaScript(
            "window.__RA2Host.platform + ':' + window.__RA2Host.version + ':' + Object.isFrozen(window.__RA2Host)"
        ) as? String
        XCTAssertEqual(hostInstalled, "ios:1:true")

        let received = expectation(description: "phase, window error, unhandled rejection and bootstrap error reached native")
        received.expectedFulfillmentCount = 4
        messages.onMessage = { received.fulfill() }
        _ = try await webView.evaluateJavaScript("""
          window.__RA2NativeDiagnostics.phase('ownerDataListingAcknowledged');
          window.dispatchEvent(new ErrorEvent('error', { message: 'synthetic-window-error' }));
          window.dispatchEvent(new Event('unhandledrejection'));
          window.__RA2NativeDiagnostics.error('bootstrap', 'synthetic-bootstrap-error', 'synthetic-stack');
          'sent';
          """)
        await fulfillment(of: [received], timeout: 10)

        XCTAssertEqual(messages.bodies.compactMap { $0["phase"] as? String }.first, "ownerDataListingAcknowledged")
        XCTAssertEqual(Set(messages.bodies.compactMap { $0["event"] as? String }), Set(["window", "unhandledrejection", "bootstrap"]))
    }

    func testPackagedRouteBBundleMatchesThePrivateLoopbackRootRangeAndOwnerRoutes() async throws {
        let hostBundle = try XCTUnwrap(Bundle(identifier: "org.second-sun.ra2m1"))
        let resourceRoot = try XCTUnwrap(hostBundle.resourceURL)
        let webRoot = resourceRoot.appendingPathComponent("Web", isDirectory: true)
        let assetsRoot = webRoot.appendingPathComponent("assets", isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: webRoot.appendingPathComponent("index.html").path))
        let assetNames = try FileManager.default.contentsOfDirectory(atPath: assetsRoot.path)
        let wasmName = try XCTUnwrap(assetNames.first(where: { $0.hasPrefix("v86-") && $0.hasSuffix(".wasm") }))
        let workerName = try XCTUnwrap(assetNames.first(where: { $0.hasPrefix("vmWorker-") && $0.hasSuffix(".js") }))

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let ownerDataRoot = root.appendingPathComponent("Data", isDirectory: true)
        try FileManager.default.createDirectory(at: ownerDataRoot, withIntermediateDirectories: true)
        for name in OwnerDataContract.requiredFiles {
            try Data([0x01, 0x02]).write(to: ownerDataRoot.appendingPathComponent(name))
        }
        let token = "063-route-b-test-capability"
        let server = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerDataRoot, port: LocalAssetServer.productionPort + 3, ownerDataToken: token)
        let ready = expectation(description: "packaged Route B loopback listener ready")
        var startupError: Error?
        server.start { result in
            if case .failure(let error) = result { startupError = error }
            ready.fulfill()
        }
        await fulfillment(of: [ready], timeout: 10)
        if let startupError { throw startupError }
        defer { server.stop() }

        let (html, htmlResponse) = try await URLSession.shared.data(from: server.origin)
        XCTAssertEqual((htmlResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual((htmlResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        let index = try XCTUnwrap(String(data: html, encoding: .utf8))
        let referencePattern = try NSRegularExpression(pattern: #"(?:src|href)=(["'])(/assets/[^"']+)\1"#)
        let range = NSRange(index.startIndex..<index.endIndex, in: index)
        let references = referencePattern.matches(in: index, range: range).compactMap { match -> String? in
            guard let assetRange = Range(match.range(at: 2), in: index) else { return nil }
            return String(index[assetRange])
        }
        XCTAssertGreaterThanOrEqual(references.count, 2, "The public Route B entry must reference its packaged JavaScript and CSS.")
        for path in references {
            let url = try XCTUnwrap(URL(string: path, relativeTo: server.origin)?.absoluteURL)
            let (_, response) = try await URLSession.shared.data(from: url)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, path)
            let contentType = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
            XCTAssertTrue(contentType.hasPrefix(path.hasSuffix(".css") ? "text/css" : "text/javascript"), path)
        }

        let wasmURL = server.origin.appendingPathComponent("assets").appendingPathComponent(wasmName)
        var rangeRequest = URLRequest(url: wasmURL)
        rangeRequest.setValue("bytes=0-31", forHTTPHeaderField: "Range")
        let (wasmPrefix, rangeResponse) = try await URLSession.shared.data(for: rangeRequest)
        XCTAssertEqual((rangeResponse as? HTTPURLResponse)?.statusCode, 206)
        XCTAssertEqual((rangeResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type"), "application/wasm")
        XCTAssertTrue(((rangeResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range") ?? "").hasPrefix("bytes 0-31/"))
        XCTAssertEqual(wasmPrefix.count, 32)

        let workerURL = server.origin.appendingPathComponent("assets").appendingPathComponent(workerName)
        let (_, workerResponse) = try await URLSession.shared.data(from: workerURL)
        XCTAssertEqual((workerResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(((workerResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("text/javascript"))

        let listingURL = try XCTUnwrap(URL(string: "/game/.list?dir=ra2", relativeTo: server.origin)?.absoluteURL)
        var authorized = URLRequest(url: listingURL)
        authorized.setValue(token, forHTTPHeaderField: "X-RA2-Owner-Token")
        let (listingBytes, listingResponse) = try await URLSession.shared.data(for: authorized)
        XCTAssertEqual((listingResponse as? HTTPURLResponse)?.statusCode, 200)
        let listedNames = try XCTUnwrap(JSONSerialization.jsonObject(with: listingBytes) as? [String])
        XCTAssertEqual(Set(listedNames.map { $0.lowercased() }), Set(OwnerDataContract.requiredFiles.map { $0.lowercased() }))
        let (_, rejectedResponse) = try await URLSession.shared.data(from: listingURL)
        XCTAssertEqual((rejectedResponse as? HTTPURLResponse)?.statusCode, 404)

        let ownerFileURL = try XCTUnwrap(URL(string: "/game/ra2/game.exe", relativeTo: server.origin)?.absoluteURL)
        var ownerRead = URLRequest(url: ownerFileURL)
        ownerRead.setValue(token, forHTTPHeaderField: "X-RA2-Owner-Token")
        let (ownerBytes, ownerResponse) = try await URLSession.shared.data(for: ownerRead)
        XCTAssertEqual((ownerResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(ownerBytes, Data([0x01, 0x02]))

        let vmExecutableURL = try XCTUnwrap(URL(string: "/game/game.exe", relativeTo: server.origin)?.absoluteURL)
        var vmExecutableRead = URLRequest(url: vmExecutableURL)
        vmExecutableRead.setValue(token, forHTTPHeaderField: "X-RA2-Owner-Token")
        let (vmExecutableBytes, vmExecutableResponse) = try await URLSession.shared.data(for: vmExecutableRead)
        XCTAssertEqual((vmExecutableResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(vmExecutableBytes, Data([0x01, 0x02]))

        let (_, unauthorizedVMResponse) = try await URLSession.shared.data(from: vmExecutableURL)
        XCTAssertEqual((unauthorizedVMResponse as? HTTPURLResponse)?.statusCode, 404)
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

@MainActor
private final class DiagnosticMessageWaiter: NSObject, WKScriptMessageHandler {
    var bodies: [[String: Any]] = []
    var onMessage: (() -> Void)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any] {
            bodies.append(body)
            onMessage?()
        }
    }
}
