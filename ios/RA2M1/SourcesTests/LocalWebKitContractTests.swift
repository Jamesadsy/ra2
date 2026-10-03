import Foundation
import UIKit
import WebKit
import XCTest
@testable import RA2M1

@MainActor
final class LocalWebKitContractTests: XCTestCase {
    func testVisibleLoopbackRuntimePublishesSharedAudioReaderToWorker() async throws {
        let host = try await makeProofHost(portOffset: 1, copyWorklet: true)
        defer { host.close() }
        let webView = host.webView
        let secureContext = try await webView.evaluateJavaScript("window.isSecureContext") as? Bool
        XCTAssertEqual(secureContext, true, "The app-owned loopback origin must support secure browser features.")
        let sharedAudioAvailable = try await webView.evaluateJavaScript(
            "crossOriginIsolated && typeof SharedArrayBuffer === 'function' && typeof AudioWorkletNode === 'function'"
        ) as? Bool
        XCTAssertEqual(sharedAudioAvailable, true, "074 requires shared Worklet/Worker reader truth on the actual loopback WKWebView.")
        guard sharedAudioAvailable == true else { return }
        _ = try await webView.evaluateJavaScript("""
          (() => {
            window.__ra2AudioReaderProof = 'pending';
            const proof = {phase: 'context-create', visibility: document.visibilityState,
                           moduleLoaded: false, nodeCreated: false, workerReceived: false,
                           workerShared: false, errors: []};
            let context, control, worker, workerURL, node;
            const fail = (phase, error) => {
              proof.errors.push({phase, name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 160)});
              window.__ra2AudioReaderProof = 'error';
            };
            window.__ra2AudioReaderSnapshot = () => JSON.stringify({...proof,
              visibility: document.visibilityState, contextState: context?.state,
              currentTime: context?.currentTime, words: control ? Array.from(new Int32Array(control)) : []});
            window.__ra2AudioReaderCleanup = () => {
              node?.port.postMessage({kind: 'destroy'}); node?.disconnect();
              worker?.terminate(); if(workerURL) URL.revokeObjectURL(workerURL);
              if(context) context.close().catch(error => fail('close', error));
            };
            (async () => {
              try {
                context = new AudioContext();
                proof.beforeResume = {state: context.state, time: context.currentTime};
                control = new SharedArrayBuffer(20);
                new Int32Array(control).set([0, 0, 0, 7, 1]);
                workerURL = URL.createObjectURL(new Blob([
                  "onmessage = e => { const words = new Int32Array(e.data); postMessage({kind: 'received', shared: e.data instanceof SharedArrayBuffer, words: Array.from(words)}); const timer = setInterval(() => { if(Atomics.load(words, 2) > 0) { postMessage({kind: 'progress', words: Array.from(words)}); clearInterval(timer); } }, 10); };"
                ], {type: 'text/javascript'}));
                worker = new Worker(workerURL);
                worker.onerror = event => fail('worker', {name: 'WorkerError', message: event.message});
                worker.onmessageerror = () => fail('worker-message', {name: 'DataCloneError', message: 'Worker message could not be decoded'});
                const observed = new Promise(resolve => {
                  worker.onmessage = event => {
                    if(event.data.kind === 'received') {
                      proof.workerReceived = true; proof.workerShared = event.data.shared;
                      proof.receivedWords = event.data.words;
                    } else if(event.data.kind === 'progress') resolve(event.data.words);
                  };
                });
                proof.phase = 'module-load';
                await context.audioWorklet.addModule('/reader.js'); proof.moduleLoaded = true;
                proof.phase = 'node-create';
                node = new AudioWorkletNode(context, 'ra2-pcm-stream', {outputChannelCount: [1]});
                proof.nodeCreated = true; node.onprocessorerror = () => fail('processor', {name: 'ProcessorError', message: 'Worklet processor failed'});
                node.connect(context.destination);
                worker.postMessage(control);
                node.port.postMessage({kind: 'create', channels: 1, frames: 4096, frequency: context.sampleRate,
                                       loop: true, frame: 0, readerControl: control, readerGeneration: 7});
                proof.phase = 'resume'; await context.resume();
                proof.afterResume = {state: context.state, time: context.currentTime};
                proof.phase = 'shared-progress'; proof.observedWords = await observed;
                await new Promise(resolve => setTimeout(resolve, 100));
                proof.afterProgress = {state: context.state, time: context.currentTime};
                if(proof.errors.length === 0) window.__ra2AudioReaderProof = 'shared';
                proof.phase = 'complete';
              } catch (error) { fail(proof.phase, error); }
            })();
            return 'started';
          })()
          """)
        let outcome = try await waitForString("window.__ra2AudioReaderProof", in: webView)
        let snapshot = try await webView.evaluateJavaScript("window.__ra2AudioReaderSnapshot()") as? String
        print("WO-SS-SOL-080 audio \(snapshot ?? "missing")")
        _ = try await webView.evaluateJavaScript("window.__ra2AudioReaderCleanup(); 'closed'")
        XCTAssertEqual(outcome, "shared", "The packaged Worklet must publish into the same block seen by a real WKWebView Worker. \(snapshot ?? "missing")")
        let bytes = try XCTUnwrap(snapshot?.data(using: .utf8))
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(proof["visibility"] as? String, "visible")
        XCTAssertEqual(proof["moduleLoaded"] as? Bool, true)
        XCTAssertEqual(proof["nodeCreated"] as? Bool, true)
        XCTAssertEqual(proof["workerReceived"] as? Bool, true)
        XCTAssertEqual(proof["workerShared"] as? Bool, true)
        XCTAssertEqual(proof["contextState"] as? String, "running")
        let before = try XCTUnwrap(proof["beforeResume"] as? [String: Any])
        XCTAssertGreaterThan(try XCTUnwrap(proof["currentTime"] as? Double), try XCTUnwrap(before["time"] as? Double))
        let words = try XCTUnwrap(proof["words"] as? [Int])
        XCTAssertEqual(words.count, 5)
        guard words.count == 5 else { return }
        XCTAssertGreaterThan(words[0], 0)
        XCTAssertGreaterThan(words[2], 0)
        XCTAssertEqual(words[3], 7)
        XCTAssertEqual(words[4], 1)
        XCTAssertEqual((proof["errors"] as? [[String: Any]])?.count, 0)
    }

    func testVisibleLoopbackStorageCommitsBeforeAndRetainsAcrossHostLifecycle() async throws {
        // Independent page, origin and database: an audio timeout cannot cause storage assertions.
        let host = try await makeProofHost(portOffset: 4, copyWorklet: false)
        defer { host.close() }
        let webView = host.webView
        let secureContext = try await webView.evaluateJavaScript("window.isSecureContext") as? Bool
        let indexedDBAvailable = try await webView.evaluateJavaScript("typeof indexedDB !== 'undefined'") as? Bool
        XCTAssertEqual(secureContext, true)
        XCTAssertEqual(indexedDBAvailable, true, "Route B save/config storage requires IndexedDB.")
        let storeName = "ra2-m1-\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        let writeStarted = try await webView.evaluateJavaScript("""
          (() => {
            window.__ra2M1StorageWrite = 'pending';
            const proof = window.__ra2StorageDiagnostics = {phase: 'open', visibility: document.visibilityState, errors: []};
            const fail = window.__ra2StorageFail = (phase, error) => {
              proof.errors.push({phase, name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 160)});
              window.__ra2M1StorageWrite = 'error'; window.__ra2M1StorageRead = 'error';
            };
            try {
              const request = indexedDB.open('\(storeName)', 1);
              request.onblocked = () => fail('open-blocked', {name: 'BlockedError', message: 'Database open was blocked'});
              request.onerror = () => fail('open', request.error);
              request.onupgradeneeded = () => request.result.createObjectStore('state');
              request.onsuccess = () => {
                const database = request.result;
                try {
                  proof.phase = 'write-transaction';
                  const transaction = database.transaction('state', 'readwrite');
                  const put = transaction.objectStore('state').put('persisted', 'save-boundary');
                  put.onerror = () => fail('put-request', put.error);
                  transaction.oncomplete = () => {
                    proof.phase = 'committed'; window.__ra2M1StorageWrite = 'written'; database.close();
                  };
                  transaction.onerror = () => fail('write-transaction', transaction.error);
                  transaction.onabort = () => { fail('write-abort', transaction.error); database.close(); };
                } catch(error) { database.close(); fail('write-setup', error); }
              };
            } catch(error) { fail('open-setup', error); }
            return 'started';
          })()
          """) as? String
        XCTAssertEqual(writeStarted, "started")
        let wrote = try await waitForString("window.__ra2M1StorageWrite", in: webView)
        try await reportStorage(webView, phase: "write")
        XCTAssertEqual(wrote, "written")
        guard wrote == "written" else { return }
        try await startStorageRead(storeName, in: webView)
        let cleanRead = try await waitForString("window.__ra2M1StorageRead", in: webView)
        try await reportStorage(webView, phase: "before-lifecycle")
        XCTAssertEqual(cleanRead, "persisted", "A clean attached WKWebView must commit and read before any synthetic lifecycle event.")
        guard cleanRead == "persisted" else { return }

        let diagnostics = RuntimeDiagnosticsLog(userURL: host.root)
        let lifecycle = RuntimeLifecycleCoordinator(webView: webView, diagnostics: diagnostics)
        lifecycle.applicationDidEnterBackground()
        lifecycle.applicationWillEnterForeground()
        try await startStorageRead(storeName, in: webView)
        let retained = try await waitForString("window.__ra2M1StorageRead", in: webView)
        try await reportStorage(webView, phase: "after-lifecycle")
        XCTAssertEqual(retained, "persisted")
        XCTAssertTrue(lifecycle.webView === webView)
        _ = try await webView.evaluateJavaScript("indexedDB.deleteDatabase('\(storeName)'); 'closed'")
    }

    private func startStorageRead(_ storeName: String, in webView: WKWebView) async throws {
        let started = try await webView.evaluateJavaScript("""
          (() => {
            window.__ra2M1StorageRead = 'pending';
            const proof = window.__ra2StorageDiagnostics;
            const fail = window.__ra2StorageFail;
            proof.phase = 'read-open';
            try {
              const request = indexedDB.open('\(storeName)', 1);
              request.onerror = () => fail('read-open', request.error);
              request.onblocked = () => fail('read-blocked', {name: 'BlockedError', message: 'Database read was blocked'});
              request.onsuccess = () => {
                const database = request.result;
                try {
                  const transaction = database.transaction('state', 'readonly');
                  const value = transaction.objectStore('state').get('save-boundary');
                  let result = 'missing';
                  value.onsuccess = () => { result = typeof value.result === 'string' ? value.result : 'missing'; };
                  value.onerror = () => fail('read-request', value.error);
                  transaction.oncomplete = () => {
                    proof.phase = 'read-complete'; window.__ra2M1StorageRead = result; database.close();
                  };
                  transaction.onerror = () => fail('read-transaction', transaction.error);
                  transaction.onabort = () => { fail('read-abort', transaction.error); database.close(); };
                } catch(error) { database.close(); fail('read-setup', error); }
              };
            } catch(error) { fail('read-open-setup', error); }
            return 'started';
          })()
          """) as? String
        XCTAssertEqual(started, "started")
    }

    private func reportStorage(_ webView: WKWebView, phase: String) async throws {
        let snapshot = try await webView.evaluateJavaScript("JSON.stringify({...window.__ra2StorageDiagnostics, visibility: document.visibilityState})") as? String
        print("WO-SS-SOL-080 storage \(phase) \(snapshot ?? "missing")")
    }

    private func makeProofHost(portOffset: UInt16, copyWorklet: Bool) async throws -> WebKitProofHost {
        let host = try WebKitProofHost(portOffset: portOffset, copyWorklet: copyWorklet)
        let ready = expectation(description: "independent loopback listener ready")
        var startupError: Error?
        host.server.start { result in
            if case .failure(let error) = result { startupError = error }
            ready.fulfill()
        }
        await fulfillment(of: [ready], timeout: 10)
        if let startupError { host.close(); throw startupError }
        let loaded = expectation(description: "independent loopback navigation completed")
        var navigationError: Error?
        host.navigation.didFinish = { loaded.fulfill() }
        host.navigation.didFail = { error in navigationError = error; loaded.fulfill() }
        host.webView.navigationDelegate = host.navigation
        host.webView.load(URLRequest(url: host.server.origin))
        await fulfillment(of: [loaded], timeout: 20)
        if let navigationError { host.close(); throw navigationError }
        print("WO-SS-SOL-080 native window=\(host.webView.window != nil) key=\(host.window.isKeyWindow) bounds=\(host.webView.bounds) windowHidden=\(host.window.isHidden) viewHidden=\(host.webView.isHidden) appState=\(UIApplication.shared.applicationState.rawValue)")
        XCTAssertTrue(host.webView.window === host.window)
        XCTAssertNotNil(host.webView.superview)
        XCTAssertFalse(host.window.isHidden)
        XCTAssertFalse(host.webView.isHidden)
        XCTAssertGreaterThan(host.webView.bounds.width, 0)
        XCTAssertGreaterThan(host.webView.bounds.height, 0)
        let visibility = try await waitForString("document.visibilityState === 'visible' ? 'visible' : 'pending'", in: host.webView)
        print("WO-SS-SOL-080 document visibility=\(visibility ?? "timeout")")
        XCTAssertEqual(visibility, "visible", "Real rendering and storage require a qualified visible test host.")
        return host
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

        let received = expectation(description: "startup phases, window error, unhandled rejection and bootstrap error reached native")
        received.expectedFulfillmentCount = 6
        messages.onMessage = { received.fulfill() }
        _ = try await webView.evaluateJavaScript("""
          window.__RA2NativeDiagnostics.phase('ownerDataListingAcknowledged');
          window.__RA2NativeDiagnostics.phase('tapToStartReady');
          window.__RA2NativeDiagnostics.phase('tapToStartAccepted');
          window.dispatchEvent(new ErrorEvent('error', { message: 'synthetic-window-error' }));
          window.dispatchEvent(new Event('unhandledrejection'));
          window.__RA2NativeDiagnostics.error('bootstrap', 'synthetic-bootstrap-error', 'synthetic-stack');
          'sent';
          """)
        await fulfillment(of: [received], timeout: 10)

        XCTAssertEqual(messages.bodies.compactMap { $0["phase"] as? String }, [
            "ownerDataListingAcknowledged", "tapToStartReady", "tapToStartAccepted",
        ])
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
            let physicalName: String
            switch name.lowercased() {
            case "maps01.mix": physicalName = "MAPS01.MIX"
            case "maps02.mix": physicalName = "MAPS02.MIX"
            case "movies01.mix": physicalName = "MOVIES01.MIX"
            default: physicalName = name
            }
            try Data([0x01, 0x02]).write(to: ownerDataRoot.appendingPathComponent(physicalName))
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

        let divergentCaseRequests = [
            "/game/maps01.mix",
            "/game/Maps01.mix",
            "/game/ra2/maps01.mix",
            "/game/maps02.mix",
            "/game/Maps02.mix",
            "/game/ra2/maps02.mix",
            "/game/movies01.mix",
            "/game/ra2/movies01.mix",
        ]
        for path in divergentCaseRequests {
            let url = try XCTUnwrap(URL(string: path, relativeTo: server.origin)?.absoluteURL)
            var request = URLRequest(url: url)
            request.setValue(token, forHTTPHeaderField: "X-RA2-Owner-Token")
            let (bytes, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, path)
            XCTAssertEqual(bytes, Data([0x01, 0x02]), path)
        }

        let mapsURL = try XCTUnwrap(URL(string: "/game/maps02.mix", relativeTo: server.origin)?.absoluteURL)
        let (_, unauthorizedMapsResponse) = try await URLSession.shared.data(from: mapsURL)
        XCTAssertEqual((unauthorizedMapsResponse as? HTTPURLResponse)?.statusCode, 404)

        for path in [
            "/game/mininuke%20-%20added%2011/30.vxl",
            "/game/ra2/mininuke%20-%20added%2011/30.vxl",
            "/game/unknown.vxl",
            "/game/ra2/unknown.mix",
        ] {
            let (_, missingResponse) = try await URLSession.shared.data(
                from: try XCTUnwrap(URL(string: path, relativeTo: server.origin)?.absoluteURL)
            )
            XCTAssertEqual((missingResponse as? HTTPURLResponse)?.statusCode, 404, path)
        }
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
private final class WebKitProofHost {
    let root: URL
    let server: LocalAssetServer
    let webView: WKWebView
    let navigation = NavigationWaiter()
    let window: UIWindow
    private let previousWindow: UIWindow?

    init(portOffset: UInt16, copyWorklet: Bool) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let webRoot = root.appendingPathComponent("Web", isDirectory: true)
        let ownerRoot = root.appendingPathComponent("Data", isDirectory: true)
        try FileManager.default.createDirectory(at: webRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ownerRoot, withIntermediateDirectories: true)
        try Data("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>ready".utf8)
            .write(to: webRoot.appendingPathComponent("index.html"))
        if copyWorklet {
            let hostBundle = try XCTUnwrap(Bundle(identifier: "org.second-sun.ra2m1"))
            let assets = try XCTUnwrap(hostBundle.resourceURL).appendingPathComponent("Web/assets", isDirectory: true)
            let reader = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: assets.path)
                .first(where: { $0.hasPrefix("pcmStreamWorklet-") && $0.hasSuffix(".js") }))
            try FileManager.default.copyItem(at: assets.appendingPathComponent(reader), to: webRoot.appendingPathComponent("reader.js"))
        }
        server = LocalAssetServer(webRoot: webRoot, ownerDataRoot: ownerRoot, port: LocalAssetServer.productionPort + portOffset)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let bounds = UIScreen.main.bounds
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height), configuration: configuration)
        previousWindow = (UIApplication.shared.delegate as? AppDelegate)?.window
        window = UIWindow(frame: bounds)
        let controller = UIViewController()
        controller.view = UIView(frame: bounds)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(webView)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
    }

    func close() {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.removeFromSuperview()
        window.isHidden = true
        window.rootViewController = nil
        previousWindow?.makeKeyAndVisible()
        server.stop()
        try? FileManager.default.removeItem(at: root)
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
