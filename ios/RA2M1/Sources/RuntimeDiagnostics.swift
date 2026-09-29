import Foundation
import UIKit
import WebKit

enum RuntimeStartupPhase: String, CaseIterable, Equatable {
    case dataValid = "Data valid"
    case localServerReady = "Local server ready"
    case mainNavigationStarted = "Main navigation started"
    case mainNavigationFinished = "Main navigation finished"
    case webHostBootstrapAcknowledged = "Web host bootstrap acknowledged"
    case ownerDataListingAcknowledged = "Owner Data listing acknowledged"
    case ownerGameSourceValidated = "Owner game source validated"
    case tapToStartReady = "Tap-to-Start ready"
    case tapToStartAccepted = "Tap-to-Start accepted"
    case vmStartupEntered = "VM startup entered"
    case firstGameFrameObserved = "First game frame observed"

    static func bridgePhase(_ name: String) -> RuntimeStartupPhase? {
        switch name {
        case "webHostBootstrapAcknowledged": return .webHostBootstrapAcknowledged
        case "ownerDataListingAcknowledged": return .ownerDataListingAcknowledged
        case "ownerGameSourceValidated": return .ownerGameSourceValidated
        case "tapToStartReady": return .tapToStartReady
        case "tapToStartAccepted": return .tapToStartAccepted
        case "vmStartupEntered": return .vmStartupEntered
        case "firstGameFrameObserved": return .firstGameFrameObserved
        default: return nil
        }
    }
}

enum RuntimeStartupTimeoutMode: Equatable {
    case inactive
    case running
    case awaitingTap
    case completed
}

final class RuntimeStartupTimeoutScheduler {
    static let defaultInterval: TimeInterval = 180

    private let queue: DispatchQueue
    private let interval: TimeInterval
    private var workItem: DispatchWorkItem?

    init(queue: DispatchQueue = .main, interval: TimeInterval = defaultInterval) {
        self.queue = queue
        self.interval = interval
    }

    func arm(_ action: @escaping () -> Void) {
        cancel()
        let workItem = DispatchWorkItem(block: action)
        self.workItem = workItem
        queue.asyncAfter(deadline: .now() + interval, execute: workItem)
    }

    func cancel() {
        workItem?.cancel()
        workItem = nil
    }
}

struct RuntimeStartupState: Equatable {
    private(set) var acknowledged: Set<RuntimeStartupPhase> = []
    private(set) var lastAcknowledged: RuntimeStartupPhase?

    var isReady: Bool { acknowledged.contains(.firstGameFrameObserved) }
    var shouldHideStatusSurface: Bool { acknowledged.contains(.tapToStartReady) || isReady }
    var timeoutMode: RuntimeStartupTimeoutMode {
        if isReady { return .completed }
        if acknowledged.contains(.tapToStartReady) && !acknowledged.contains(.tapToStartAccepted) {
            return .awaitingTap
        }
        return acknowledged.contains(.mainNavigationStarted) ? .running : .inactive
    }

    @discardableResult
    mutating func acknowledge(_ phase: RuntimeStartupPhase) -> Bool {
        guard RuntimeStartupPhase.allCases.first(where: { !acknowledged.contains($0) }) == phase else {
            return false
        }
        acknowledged.insert(phase)
        lastAcknowledged = phase
        return true
    }

    mutating func beginRetry() {
        acknowledged = Set([.dataValid])
        lastAcknowledged = .dataValid
    }

    var progressText: String {
        RuntimeStartupPhase.allCases.map { phase in
            "\(acknowledged.contains(phase) ? "✓" : "·") \(phase.rawValue)"
        }.joined(separator: "\n")
    }

    var timeoutMessage: String {
        let phase = lastAcknowledged?.rawValue ?? "native launch"
        return "Startup timed out after \(phase). Tap Retry to restart the local host. If it stops again, send User/LastLaunchDiagnostics.txt and the newest User/Debug and User/touchlog files."
    }
}

enum RuntimeStartupOverlayHandoff {
    static func exposeTapToStart(statusSurface: UIView, webView: WKWebView, in container: UIView) {
        statusSurface.isUserInteractionEnabled = false
        statusSurface.isHidden = true
        container.bringSubviewToFront(webView)
    }

    static func showNativeStatus(statusSurface: UIView, in container: UIView) {
        statusSurface.isHidden = false
        statusSurface.isUserInteractionEnabled = true
        container.bringSubviewToFront(statusSurface)
    }
}

enum RuntimeHostBridge {
    static func userScript(ownerDataToken: String) -> WKUserScript {
        let host: [String: Any] = [
            "platform": "ios",
            "version": 1,
            "ownerDataToken": ownerDataToken,
        ]
        let hostJSON = (try? JSONSerialization.data(withJSONObject: host))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let source = """
        (() => {
          const send = (value) => {
            try {
              const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ra2Diagnostics;
              if (handler) handler.postMessage(value);
            } catch (_) {}
          };
          const clip = (value, limit) => String(value == null ? '' : value).slice(0, limit);
          Object.defineProperty(window, '__RA2Host', {
            value: Object.freeze(\(hostJSON)), enumerable: false, configurable: false, writable: false
          });
          const api = Object.freeze({
            phase: (phase) => send({ kind: 'phase', phase: clip(phase, 64) }),
            error: (event, message, stack) => send({
              kind: 'error', event: clip(event, 48), message: clip(message, 1200), stack: clip(stack, 1800)
            }),
            touch: (record) => send(Object.assign({ kind: 'touch' }, record || {})),
            metrics: (record) => send(Object.assign({ kind: 'metrics' }, record || {})),
            event: (event) => send({ kind: 'event', event: clip(event, 80) }),
            lifecycle: (phase, nativeTimestampMs) => {
              if (phase !== 'background' && phase !== 'foreground') return;
              window.dispatchEvent(new CustomEvent('ra2-native-lifecycle', {
                detail: { phase, nativeTimestampMs: Number(nativeTimestampMs) }
              }));
              api.metrics({ event: 'lifecycle', lifecyclePhase: `native-${phase}`, nativeTimestampMs });
            }
          });
          Object.defineProperty(window, '__RA2NativeDiagnostics', {
            value: api, enumerable: false, configurable: false, writable: false
          });
          Object.defineProperty(window, '__RA2NativeLifecycle', {
            value: api.lifecycle, enumerable: false, configurable: false, writable: false
          });
          window.addEventListener('error', (event) => {
            const error = event && event.error;
            api.error('window', event && event.message || 'JavaScript window error', error && error.stack || '');
          });
          window.addEventListener('unhandledrejection', (event) => {
            const reason = event && event.reason;
            api.error('unhandledrejection', reason && reason.message || String(reason), reason && reason.stack || '');
          });
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}

final class RuntimeDiagnosticsLog {
    static let maximumRetainedRuns = 4
    private static let maximumDebugBytes = 256 * 1024
    private static let maximumDebugLines = 1024
    private static let maximumTouchBytes = 512 * 1024
    private static let maximumTouchRecords = 2500

    private let userURL: URL
    private let fileManager: FileManager
    private let lock = NSRecursiveLock()
    private var debugURL: URL?
    private var touchURL: URL?
    private var summaryURL: URL
    private var debugBytes = 0
    private var debugLines = 0
    private var touchBytes = 0
    private var touchRecords = 0
    private var startedAt = Date()
    private var sourceIdentity: [String: String] = [:]
    private var currentPhase = "Native launch"
    private var phaseTimeline: [String] = []
    private var recentRoutes: [String] = []
    private var lastError: String?
    private var ownerDataToken: String?

    init(userURL: URL, fileManager: FileManager = .default) {
        self.userURL = userURL
        self.fileManager = fileManager
        self.summaryURL = userURL.appendingPathComponent("LastLaunchDiagnostics.txt")
    }

    func beginRun(identity: [String: String], now: Date = Date()) throws {
        lock.lock()
        defer { lock.unlock() }
        let debugDirectory = userURL.appendingPathComponent("Debug", isDirectory: true)
        let touchDirectory = userURL.appendingPathComponent("touchlog", isDirectory: true)
        try fileManager.createDirectory(at: debugDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: touchDirectory, withIntermediateDirectories: true)
        try Self.retainOldRuns(in: debugDirectory, prefix: "DEBUG_", limit: Self.maximumRetainedRuns - 1, fileManager: fileManager)
        try Self.retainOldRuns(in: touchDirectory, prefix: "touch-", limit: Self.maximumRetainedRuns - 1, fileManager: fileManager)

        startedAt = now
        sourceIdentity = identity
        currentPhase = "Native launch"
        phaseTimeline = []
        recentRoutes = []
        lastError = nil
        debugBytes = 0
        debugLines = 0
        touchBytes = 0
        touchRecords = 0
        debugURL = try Self.createRunFile(in: debugDirectory, prefix: "DEBUG_", date: now, suffix: ".LOG", fileManager: fileManager)
        touchURL = try Self.createRunFile(in: touchDirectory, prefix: "touch-", date: now, suffix: ".log", fileManager: fileManager)
        appendDebugLocked("CnC RA2 diagnostic run started")
        for key in ["app", "bundleIdentifier", "version", "build", "sourceBranch", "sourceCommit"] {
            if let value = identity[key], !value.isEmpty {
                let loggedValue = key == "sourceCommit" ? String(value.prefix(12)) : Self.sanitize(value, secret: ownerDataToken)
                appendDebugLocked("\(key): \(loggedValue)")
            }
        }
        updateSummaryLocked()
    }

    func setOwnerDataToken(_ token: String) {
        lock.lock()
        ownerDataToken = token
        lock.unlock()
    }

    func recordPhase(_ phase: RuntimeStartupPhase, at date: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        let timestamp = Self.isoTimestamp(date)
        currentPhase = phase.rawValue
        phaseTimeline.append("\(timestamp)  \(phase.rawValue)")
        if phaseTimeline.count > 32 { phaseTimeline.removeFirst(phaseTimeline.count - 32) }
        appendDebugLocked("phase: \(phase.rawValue)")
        updateSummaryLocked()
    }

    func recordEvent(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        let allowed = Set([
            "LocalAssetServer listener ready", "LocalAssetServer failed", "WebKit navigation started",
            "WebKit navigation finished", "WebKit provisional navigation failed", "WebKit navigation failed",
            "WebContent process terminated", "runtime retry requested", "runtime shutdown",
            "application entered background", "application entered foreground", "native viewport changed",
            "web bootstrap entry executed", "web AppShell mounted",
        ])
        let safeEvent: String
        if allowed.contains(event) {
            safeEvent = event
        } else if event.hasPrefix("vm status: "),
                  ["loading", "starting", "running", "paused", "stopped", "exited", "blocked", "error"]
                    .contains(String(event.dropFirst("vm status: ".count))) {
            safeEvent = event
        } else {
            return
        }
        appendDebugLocked(safeEvent)
        if event == "native viewport changed" { updateSummaryLocked() }
    }

    func recordRoute(_ route: String, status: Int) {
        lock.lock()
        defer { lock.unlock() }
        let safeRoute = Self.safeRoute(route)
        guard !safeRoute.isEmpty else { return }
        let line = "\(Self.isoTimestamp(Date()))  \(safeRoute)  HTTP \(min(max(status, 100), 599))"
        recentRoutes.append(line)
        if recentRoutes.count > 24 { recentRoutes.removeFirst(recentRoutes.count - 24) }
        appendDebugLocked(line)
        updateSummaryLocked()
    }

    func recordError(event: String, message: String, stack: String = "") {
        lock.lock()
        defer { lock.unlock() }
        let safeEvent = Self.safeErrorKind(event)
        let safeMessage = Self.sanitize(message, secret: ownerDataToken, limit: 1200)
        let safeStack = Self.sanitize(stack, secret: ownerDataToken, limit: 1800)
        lastError = "\(safeEvent): \(safeMessage)"
        appendDebugLocked("error[\(safeEvent)]: \(safeMessage)")
        if !safeStack.isEmpty { appendDebugLocked("stack[\(safeEvent)]: \(safeStack)") }
        updateSummaryLocked()
    }

    func recordTouch(_ body: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        guard let url = touchURL, touchRecords < Self.maximumTouchRecords, touchBytes < Self.maximumTouchBytes else { return }

        let kind = Self.allowedTouchKind(body["event"] as? String)
        guard let kind else { return }
        var record: [String: Any] = ["timestamp": Self.isoTimestamp(Date()), "event": kind]
        if let pointerType = body["pointerType"] as? String, ["touch", "mouse", "pen", "unknown"].contains(pointerType) {
            record["pointerType"] = pointerType
        }
        for key in ["pointerId", "button", "buttons"] {
            if let number = Self.boundedInteger(body[key], range: -1...32767) { record[key] = number }
        }
        for key in ["x", "y", "deltaX", "deltaY", "translationX", "translationY", "viewportWidth", "viewportHeight", "devicePixelRatio", "pressure"] {
            if let number = Self.boundedNumber(body[key], range: -32768...32768) { record[key] = number }
        }
        for key in ["startX", "startY", "endX", "endY", "logicalStartX", "logicalStartY", "logicalEndX", "logicalEndY", "mouseDeltaX", "mouseDeltaY", "cameraDeltaX", "cameraDeltaY", "mouseFlags", "mouseFlagsDuringGesture", "modifiers"] {
            if let number = Self.boundedNumber(body[key], range: -32768...32768) { record[key] = number }
        }
        if let sequence = body["wmSequence"] as? String,
           sequence.range(of: "^(WM_MOUSEMOVE|WM_LBUTTONDOWN|WM_LBUTTONUP|WM_RBUTTONDOWN|WM_RBUTTONUP|WM_CANCELMODE)(>(WM_MOUSEMOVE|WM_LBUTTONDOWN|WM_LBUTTONUP|WM_RBUTTONDOWN|WM_RBUTTONUP|WM_CANCELMODE)){0,31}$", options: .regularExpression) != nil {
            record["wmSequence"] = sequence
        }
        if let flags = body["mouseFlagsSequence"] as? String,
           flags.range(of: "^(0|1|2|3)(>(0|1|2|3)){0,31}$", options: .regularExpression) != nil {
            record["mouseFlagsSequence"] = flags
        }
        if let orientation = body["orientation"] as? String,
           ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "unknown"].contains(orientation) {
            record["orientation"] = orientation
        }
        if let gesture = body["gesture"] as? String,
           ["pending", "drag", "selectDrag", "selectionReplaced", "emptySelection", "longPress", "twoPending", "twoDrag", "twoPan", "singleTap", "twoTap", "cancelled", "released", "joystick", "touchControlsShown", "touchControlsHidden"].contains(gesture) {
            record["gesture"] = gesture
        }
        if let mode = body["mode"] as? String,
           ["controlsShown", "controlsHidden", "controlsCollapsed", "controlsExpanded"].contains(mode) {
            record["mode"] = mode
        }
        if let mapped = body["mappedGuestEvent"] as? String,
           ["WM_MOUSEMOVE", "WM_LBUTTONDOWN", "WM_LBUTTONUP", "WM_RBUTTONDOWN", "WM_RBUTTONUP", "WM_KEYDOWN", "WM_KEYUP"].contains(mapped) {
            record["mappedGuestEvent"] = mapped
        }
        guard JSONSerialization.isValidJSONObject(record),
              let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        let bytes = Data((line + "\n").utf8)
        guard touchBytes + bytes.count <= Self.maximumTouchBytes else { return }
        append(bytes, to: url)
        touchBytes += bytes.count
        touchRecords += 1
    }

    func recordWebMetrics(_ body: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        let keys = ["viewportWidth", "viewportHeight", "screenWidth", "screenHeight", "devicePixelRatio",
                    "safeAreaTop", "safeAreaRight", "safeAreaBottom", "safeAreaLeft", "nativeTimestampMs",
                    "workerObservedAtEpochMs", "workerResponseMs", "guestLogicFrame", "guestLogicFrameDelta",
                    "guestTimeMs", "guestTimeDeltaMs", "guestClockPaused", "workerRunning", "workerResponsive",
                    "hypercallPending", "pendingFileReads", "pendingFileWrites", "rangePrefetchPending",
                    "rangePrefetchSpeculating", "lifecycleCycles", "flushOk", "safeToResume",
                    "audioContextTimeSeconds", "audioContextDeltaSeconds", "audioContextSampleRateHz", "audioPlayingBuffers", "audioSourceCount",
                    "audioStreamCount", "audioWorkletCount", "audioStaleWorklets", "audioStaleWorkletsDetected", "audioLiveProcessorCount", "audioSampleRateHz",
                    "audioFrequencyHz", "audioChannels", "audioBitsPerSample", "audioBlockAlign", "audioFormatCount",
                    "audioSourceStartCount", "audioStreamStartCount", "audioWorkletStartCount", "audioDynamicStreamWrites", "audioDynamicStreamWriteRateHz",
                    "audioBufferCreateCount", "audioBufferDuplicateCount", "audioBufferCursorFrames", "audioBufferTotalFrames",
                    "audioContextIdentity", "audioContextCreationCount", "audioLifecycleRecoveryPending", "audioSuspendCallAttempted",
                    "audioSuspendSucceeded", "audioAutomaticResumeAttempted", "audioAutomaticResumeResult",
                    "audioTrustedGestureAttemptCount", "audioTrustedGestureResumeResult", "audioTrustedInteractionTrusted",
                    "audioLiveStreamedBuffers", "audioWorkletModuleLoaded",
                    "audioBufferFrequencyHz", "audioBufferSampleRateHz", "audioBufferChannels", "audioBufferBitsPerSample",
                    "audioBufferWriteCount", "audioBufferWriteAgeMs", "audioBufferFrequencyChanges",
                    "audioActiveBufferWriteCount", "audioMaxActiveBufferWriteAgeMs", "audioActiveBufferFrequencyChanges",
                    "audioMinActiveFrequencyHz", "audioMaxActiveFrequencyHz",
                    "audioBufferPlaying", "audioBufferLooping", "audioUnlockResult", "binkSetSoundSystemCalls", "binkOpenDirectSoundCalls",
                    "binkOpenCalls", "binkDoFrameCalls", "binkNextFrameCalls", "binkWaitCalls", "directSoundCreateBufferCalls",
                    "directSoundLockCalls", "directSoundUnlockCalls", "directSoundPlayCalls", "directSoundSetFrequencyCalls", "winmmTimeGetTimeCalls",
                    "guestWidth", "guestHeight", "canvasCssWidth", "canvasCssHeight",
                    "canvasBackingWidth", "canvasBackingHeight", "fps", "firstGestureTimestampMs"]
        var fields: [String] = []
        for key in keys {
            if let value = Self.boundedNumber(body[key], range: 0...10_000_000_000_000) { fields.append("\(key)=\(value)") }
        }
        for key in ["event", "lifecyclePhase", "documentVisibility", "audioContextState", "rendererBackend", "workerPhase", "recoveryReason"] {
            if let value = body[key] as? String,
               value.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil {
                fields.append("\(key)=\(value)")
            }
        }
        if let value = body["audioBufferStates"] as? String,
           value.count <= 512,
           value.range(of: "^[A-Za-z0-9_:;.-]{1,512}$", options: .regularExpression) != nil {
            fields.append("audioBufferStates=\(value)")
        }
        if let orientation = body["orientation"] as? String,
           ["portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight", "unknown"].contains(orientation) {
            fields.append("orientation=\(orientation)")
        }
        guard !fields.isEmpty else { return }
        appendDebugLocked("WKWebView metrics: \(fields.joined(separator: " "))")
    }

    func recordNativeMetrics(_ detail: String) {
        lock.lock()
        defer { lock.unlock() }
        appendDebugLocked("UIKit metrics: \(Self.sanitize(detail, secret: ownerDataToken, limit: 500))")
    }

    static func sanitize(_ value: String, secret: String? = nil, limit: Int = 1200) -> String {
        var safe = value
        if let secret, !secret.isEmpty {
            safe = safe.replacingOccurrences(of: secret, with: "<redacted-token>", options: [.caseInsensitive])
        }
        safe = replace(pattern: "(?i)(ownerDataToken|x-ra2-owner-token)(\\s*[:=]\\s*)[^\\s,;]+", in: safe, template: "$1$2<redacted>")
        safe = replace(pattern: "(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,64}(?![A-Fa-f0-9])", in: safe, template: "<redacted-token>")
        safe = replace(pattern: "(https?://[^\\s)]+)\\?[^\\s)]*", in: safe, template: "$1?<redacted-query>")
        let printable = safe.unicodeScalars.map { scalar -> String in
            if CharacterSet.controlCharacters.contains(scalar) { return " " }
            return String(scalar)
        }.joined()
        return String(printable.prefix(max(0, limit)))
    }

    private func appendDebugLocked(_ message: String) {
        guard let url = debugURL, debugLines < Self.maximumDebugLines else { return }
        let safe = Self.sanitize(message, secret: ownerDataToken, limit: 1800)
        let bytes = Data("\(Self.isoTimestamp(Date()))  \(safe)\n".utf8)
        guard debugBytes + bytes.count <= Self.maximumDebugBytes else { return }
        append(bytes, to: url)
        debugBytes += bytes.count
        debugLines += 1
    }

    private func updateSummaryLocked() {
        let identity = ["app", "bundleIdentifier", "version", "build", "sourceBranch", "sourceCommit"]
            .compactMap { key in
                sourceIdentity[key].map { value in
                    let loggedValue = key == "sourceCommit" ? String(value.prefix(12)) : Self.sanitize(value, secret: ownerDataToken, limit: 200)
                    return "\(key): \(loggedValue)"
                }
            }
        let routeLines = recentRoutes.suffix(12)
        var lines = [
            "CnC RA2 — last launch diagnostics",
            "startedUTC: \(Self.isoTimestamp(startedAt))",
            "lastAcknowledgedPhase: \(Self.sanitize(currentPhase, secret: ownerDataToken, limit: 120))",
        ]
        lines.append(contentsOf: identity)
        lines.append("phaseTimeline:")
        lines.append(contentsOf: phaseTimeline.suffix(18).map { "- \($0)" })
        lines.append("recentLocalRoutes:")
        lines.append(contentsOf: routeLines.map { "- \($0)" })
        let errorText = lastError.map { Self.sanitize($0, secret: ownerDataToken, limit: 1200) } ?? "none"
        lines.append("lastError: \(errorText)")
        let contents = lines.joined(separator: "\n") + "\n"
        let summary = String(contents.prefix(12000))
        try? Data(summary.utf8).write(to: summaryURL, options: .atomic)
    }

    private func append(_ bytes: Data, to url: URL) {
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: bytes)
            try handle.synchronize()
        } catch {
            return
        }
    }

    private static func safeErrorKind(_ event: String) -> String {
        ["window", "unhandledrejection", "bootstrap", "fatalVM", "audio", "navigation", "webContent", "ownerData", "startup"].contains(event)
            ? event : "runtime"
    }

    private static func allowedTouchKind(_ event: String?) -> String? {
        guard let event else { return nil }
        return ["pointerdown", "pointermove", "pointerup", "pointercancel", "gesture", "mapped", "mode", "viewport"].contains(event)
            ? event : nil
    }

    private static func safeRoute(_ route: String) -> String {
        if route == "public/index.html" || route == "public/other" || route == "owner/.list" || route == "owner/other" {
            return route
        }
        if route.hasPrefix("owner/") {
            let name = String(route.dropFirst("owner/".count)).lowercased()
            let allowlist = Set(["game.exe", "ra2.mix", "language.mix", "binkw32.dll", "blowfish.dll",
                                "maps01.mix", "maps02.mix", "movies01.mix", "movies02.mix", "multi.mix", "theme.mix"])
            return allowlist.contains(name) ? "owner/\(name)" : ""
        }
        if route.hasPrefix("public/assets/") {
            let name = String(route.dropFirst("public/assets/".count))
            return name.range(of: "^[A-Za-z0-9._-]{1,96}$", options: .regularExpression) != nil
                ? "public/assets/\(name)" : "public/other"
        }
        return ""
    }

    private static func boundedNumber(_ value: Any?, range: ClosedRange<Double>) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.doubleValue
        guard result.isFinite else { return nil }
        return min(max(result, range.lowerBound), range.upperBound)
    }

    private static func boundedInteger(_ value: Any?, range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.intValue
        return min(max(result, range.lowerBound), range.upperBound)
    }

    private static func replace(pattern: String, in value: String, template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return value }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.stringByReplacingMatches(in: value, range: range, withTemplate: template)
    }

    private static func isoTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func retainOldRuns(in directory: URL, prefix: String, limit: Int, fileManager: FileManager) throws {
        let urls = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])
            .filter { $0.lastPathComponent.hasPrefix(prefix) && $0.pathExtension.lowercased() == (prefix == "DEBUG_" ? "log" : "log") }
            .sorted {
                let first = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let second = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return first > second
            }
        for old in urls.dropFirst(max(0, limit)) { try fileManager.removeItem(at: old) }
    }

    private static func createRunFile(in directory: URL, prefix: String, date: Date, suffix: String, fileManager: FileManager) throws -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let base = "\(prefix)\(formatter.string(from: date))"
        var candidate = directory.appendingPathComponent(base + suffix)
        var duplicate = 2
        while fileManager.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent("\(base)-\(duplicate)\(suffix)")
            duplicate += 1
        }
        try Data().write(to: candidate, options: [.atomic])
        return candidate
    }
}
