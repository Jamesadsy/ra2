import UIKit
import WebKit
import XCTest
@testable import RA2M1

@MainActor
final class RuntimeLifecycleTests: XCTestCase {
    func testBackgroundForegroundRetainsTheSameLiveWebView() {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let diagnostics = RuntimeDiagnosticsLog(userURL: FileManager.default.temporaryDirectory)
        let lifecycle = RuntimeLifecycleCoordinator(webView: webView, diagnostics: diagnostics)

        lifecycle.applicationDidEnterBackground()
        XCTAssertEqual(lifecycle.phase, .background)
        XCTAssertTrue(lifecycle.webView === webView)
        lifecycle.applicationWillEnterForeground()
        XCTAssertEqual(lifecycle.phase, .foreground)
        XCTAssertTrue(lifecycle.webView === webView)
    }

    func testStartupReadinessWaitsForTheFirstGameFrame() {
        var startup = RuntimeStartupState()
        XCTAssertEqual(startup.timeoutMode, .inactive)
        XCTAssertTrue(startup.acknowledge(.dataValid))
        XCTAssertTrue(startup.acknowledge(.localServerReady))
        XCTAssertTrue(startup.acknowledge(.mainNavigationStarted))
        XCTAssertEqual(startup.timeoutMode, .running)
        XCTAssertTrue(startup.acknowledge(.mainNavigationFinished))
        XCTAssertTrue(startup.acknowledge(.webHostBootstrapAcknowledged))

        XCTAssertFalse(startup.isReady)
        XCTAssertFalse(startup.shouldHideStatusSurface)
        XCTAssertTrue(startup.timeoutMessage.contains("Web host bootstrap acknowledged"))

        XCTAssertTrue(startup.acknowledge(.ownerDataListingAcknowledged))
        XCTAssertTrue(startup.acknowledge(.ownerGameSourceValidated))
        XCTAssertFalse(startup.shouldHideStatusSurface)
        XCTAssertEqual(startup.timeoutMode, .running)
        XCTAssertFalse(startup.acknowledge(.vmStartupEntered))
        XCTAssertTrue(startup.acknowledge(.tapToStartReady))
        XCTAssertTrue(startup.shouldHideStatusSurface)
        XCTAssertEqual(startup.timeoutMode, .awaitingTap)
        XCTAssertFalse(startup.isReady)
        XCTAssertTrue(startup.acknowledge(.tapToStartAccepted))
        XCTAssertEqual(startup.timeoutMode, .running)
        XCTAssertTrue(startup.acknowledge(.vmStartupEntered))
        startup.acknowledge(.firstGameFrameObserved)
        XCTAssertTrue(startup.isReady)
        XCTAssertTrue(startup.shouldHideStatusSurface)
        XCTAssertEqual(startup.timeoutMode, .completed)
    }

    func testStartupPhaseOrderRejectsDuplicatesAndOutOfOrderSignals() {
        var startup = RuntimeStartupState()
        XCTAssertFalse(startup.acknowledge(.tapToStartReady))
        XCTAssertTrue(startup.acknowledge(.dataValid))
        XCTAssertFalse(startup.acknowledge(.mainNavigationStarted))
        XCTAssertTrue(startup.acknowledge(.localServerReady))
        XCTAssertTrue(startup.acknowledge(.mainNavigationStarted))
        XCTAssertFalse(startup.acknowledge(.mainNavigationStarted))

        XCTAssertEqual(RuntimeStartupPhase.bridgePhase("tapToStartReady"), .tapToStartReady)
        XCTAssertEqual(RuntimeStartupPhase.bridgePhase("tapToStartAccepted"), .tapToStartAccepted)
        XCTAssertEqual(RuntimeStartupPhase.bridgePhase("firstGameFrameObserved"), .firstGameFrameObserved)
    }

    func testStartupTimeoutIsPausedRearmedAndCancelledOnFirstFrame() async {
        XCTAssertEqual(RuntimeStartupTimeoutScheduler.defaultInterval, 180)
        let queue = DispatchQueue(label: "RA2M1Tests.startup-timeout")
        let scheduler = RuntimeStartupTimeoutScheduler(queue: queue, interval: 0.02)

        let pausedTimeout = expectation(description: "Tap-to-Start wait does not fire the startup timer")
        pausedTimeout.isInverted = true
        scheduler.arm { pausedTimeout.fulfill() }
        // tapToStartReady moves RuntimeStartupState to awaitingTap; HostViewController cancels here.
        scheduler.cancel()
        await fulfillment(of: [pausedTimeout], timeout: 0.08)

        let rearmedTimeout = expectation(description: "A post-acceptance VM startup stall reaches failure")
        scheduler.arm { rearmedTimeout.fulfill() }
        await fulfillment(of: [rearmedTimeout], timeout: 0.5)

        let firstFrameTimeout = expectation(description: "First game frame cancels the final startup timer")
        firstFrameTimeout.isInverted = true
        scheduler.arm { firstFrameTimeout.fulfill() }
        // firstGameFrameObserved moves RuntimeStartupState to completed; HostViewController cancels here.
        scheduler.cancel()
        await fulfillment(of: [firstFrameTimeout], timeout: 0.08)
    }

    func testTapGateHandoffReleasesOnlyTheNativeBlockerAndFailureCanRestoreIt() {
        let container = UIView()
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let statusSurface = UIView()
        container.addSubview(webView)
        container.addSubview(statusSurface)
        XCTAssertTrue(container.subviews.last === statusSurface)
        XCTAssertFalse(statusSurface.isHidden)
        XCTAssertTrue(statusSurface.isUserInteractionEnabled)

        RuntimeStartupOverlayHandoff.exposeTapToStart(statusSurface: statusSurface, webView: webView, in: container)
        XCTAssertTrue(statusSurface.isHidden)
        XCTAssertFalse(statusSurface.isUserInteractionEnabled)
        XCTAssertTrue(container.subviews.last === webView)

        RuntimeStartupOverlayHandoff.showNativeStatus(statusSurface: statusSurface, in: container)
        XCTAssertFalse(statusSurface.isHidden)
        XCTAssertTrue(statusSurface.isUserInteractionEnabled)
        XCTAssertTrue(container.subviews.last === statusSurface)
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
        diagnostics.recordRoute("owner/maps02.mix", status: 206)
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
        XCTAssertTrue(summary.contains("owner/maps02.mix  HTTP 206"))
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
