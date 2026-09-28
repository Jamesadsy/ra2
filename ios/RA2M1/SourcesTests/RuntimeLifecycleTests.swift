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

    func testStartupReadinessWaitsForTheFirstGameFrame() {
        var startup = RuntimeStartupState()
        startup.acknowledge(.dataValid)
        startup.acknowledge(.localServerReady)
        startup.acknowledge(.mainNavigationFinished)
        startup.acknowledge(.webHostBootstrapAcknowledged)

        XCTAssertFalse(startup.isReady)
        XCTAssertFalse(startup.shouldHideStatusSurface)
        XCTAssertTrue(startup.timeoutMessage.contains("Web host bootstrap acknowledged"))

        startup.acknowledge(.ownerDataListingAcknowledged)
        startup.acknowledge(.ownerGameSourceValidated)
        startup.acknowledge(.vmStartupEntered)
        XCTAssertFalse(startup.shouldHideStatusSurface)
        startup.acknowledge(.firstGameFrameObserved)
        XCTAssertTrue(startup.isReady)
        XCTAssertTrue(startup.shouldHideStatusSurface)
    }

    func testDiagnosticFilesAreBoundedAndExcludeOwnerBytesAndCapabilityTokens() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let user = root.appendingPathComponent("User", isDirectory: true)
        let diagnostics = RuntimeDiagnosticsLog(userURL: user)
        let token = "f00dbabe1234567890abcdef12345678"
        try diagnostics.beginRun(identity: [
            "app": "CnC RA2",
            "bundleIdentifier": "org.second-sun.ra2m1",
            "version": "0.1",
            "build": "1",
            "sourceBranch": "secondsun/ra2-m1-ios-063-physical-grey-runtime",
            "sourceCommit": "12dc7ec83224fa88d98e7d2086e80cc6a1d9e5e5",
        ])
        diagnostics.setOwnerDataToken(token)
        diagnostics.recordPhase(.dataValid)
        diagnostics.recordRoute("owner/game.exe", status: 206)
        diagnostics.recordError(
            event: "unhandledrejection",
            message: "ownerDataToken=\(token) https://127.0.0.1:18108/game/.list?token=hidden",
            stack: "synthetic stack"
        )
        diagnostics.recordTouch([
            "event": "pointerdown",
            "pointerType": "touch",
            "pointerId": 1,
            "x": 17.5,
            "y": 29.25,
            "privateOwnerBytes": "MZ-retail-data-must-not-be-written",
        ])

        let debugDirectory = user.appendingPathComponent("Debug", isDirectory: true)
        let touchDirectory = user.appendingPathComponent("touchlog", isDirectory: true)
        let debug = try String(contentsOf: XCTUnwrap(FileManager.default.contentsOfDirectory(at: debugDirectory, includingPropertiesForKeys: nil).first), encoding: .utf8)
        let touch = try String(contentsOf: XCTUnwrap(FileManager.default.contentsOfDirectory(at: touchDirectory, includingPropertiesForKeys: nil).first), encoding: .utf8)
        let summary = try String(contentsOf: user.appendingPathComponent("LastLaunchDiagnostics.txt"), encoding: .utf8)

        XCTAssertTrue(summary.contains("Data valid"))
        XCTAssertTrue(summary.contains("owner/game.exe  HTTP 206"))
        XCTAssertTrue(debug.contains("unhandledrejection"))
        XCTAssertTrue(touch.contains("pointerdown"))
        for value in [summary, debug, touch] {
            XCTAssertFalse(value.contains(token))
            XCTAssertFalse(value.contains("MZ-retail-data-must-not-be-written"))
            XCTAssertFalse(value.contains("token=hidden"))
        }
        XCTAssertFalse(touch.contains("privateOwnerBytes"))
    }
}
