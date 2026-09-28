import Foundation
import XCTest
@testable import RA2M1

final class LocalAssetServerTests: XCTestCase {
    func testPublicAndOwnerRoutesStayInTheirAssignedRoots() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let web = root.appendingPathComponent("Web", isDirectory: true)
        let data = root.appendingPathComponent("Documents/CnC RA2/Data", isDirectory: true)
        let publicFile = web.appendingPathComponent("assets/main.js")
        let ownerFile = data.appendingPathComponent("game.exe")
        try FileManager.default.createDirectory(at: publicFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: ownerFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("public".utf8).write(to: publicFile)
        try Data("private".utf8).write(to: ownerFile)

        XCTAssertEqual(LocalAssetServer.resolve(target: "/assets/main.js", webRoot: web, ownerDataRoot: data), .file(publicFile, ownerData: false))
        XCTAssertEqual(LocalAssetServer.resolve(target: "/game/ra2/game.exe", webRoot: web, ownerDataRoot: data), .file(ownerFile, ownerData: true))
        XCTAssertEqual(LocalAssetServer.resolve(target: "/game/.list?dir=ra2", webRoot: web, ownerDataRoot: data), .directory(data))
        XCTAssertEqual(LocalAssetServer.resolve(target: "/game/ra2", webRoot: web, ownerDataRoot: data), .directory(data))
    }

    func testEncodedAndPlainTraversalAreRejected() {
        let root = FileManager.default.temporaryDirectory
        for target in ["/game/../secret", "/game/%2e%2e/secret", "/%2e%2e/private", "/game/ra2/%5c..%5csecret"] {
            XCTAssertEqual(LocalAssetServer.resolve(target: target, webRoot: root, ownerDataRoot: root), .badRequest, target)
        }
    }

    func testOwnerRouteCannotReachSiblingUserData() {
        let root = FileManager.default.temporaryDirectory
        XCTAssertEqual(
            LocalAssetServer.resolve(target: "/game/User/game.exe", webRoot: root, ownerDataRoot: root.appendingPathComponent("Data")),
            .badRequest
        )
        XCTAssertEqual(
            LocalAssetServer.resolve(target: "/game/.list?dir=User", webRoot: root, ownerDataRoot: root.appendingPathComponent("Data")),
            .badRequest
        )
    }

    func testByteRangesSupportOpenEndedAndSuffixFormsAndRejectMultipleRanges() throws {
        XCTAssertEqual(try LocalAssetServer.parseRange("bytes=4-9", fileSize: 20).get(), 4..<10)
        XCTAssertEqual(try LocalAssetServer.parseRange("bytes=7-", fileSize: 20).get(), 7..<20)
        XCTAssertEqual(try LocalAssetServer.parseRange("bytes=-5", fileSize: 20).get(), 15..<20)
        XCTAssertThrowsError(try LocalAssetServer.parseRange("bytes=0-1,4-5", fileSize: 20).get())
    }

    func testOwnerDataRouteRequiresPerLaunchCapability() {
        XCTAssertTrue(LocalAssetServer.authorizesOwnerRequest(expectedToken: "a1b2c3d4", suppliedToken: "a1b2c3d4"))
        XCTAssertFalse(LocalAssetServer.authorizesOwnerRequest(expectedToken: "a1b2c3d4", suppliedToken: nil))
        XCTAssertFalse(LocalAssetServer.authorizesOwnerRequest(expectedToken: "a1b2c3d4", suppliedToken: "wrong"))
        XCTAssertFalse(LocalAssetServer.authorizesOwnerRequest(expectedToken: "", suppliedToken: ""))
    }

    func testDiagnosticsMapSameOriginRouteBRequestsWithoutLoggingQueryTokens() {
        XCTAssertEqual(LocalAssetServer.diagnosticRoute(target: "/"), "public/index.html")
        XCTAssertEqual(LocalAssetServer.diagnosticRoute(target: "/assets/index-DfPGVsaw.js?cache=1"), "public/assets/index-dfpgvsaw.js")
        XCTAssertEqual(LocalAssetServer.diagnosticRoute(target: "/game/.list?dir=ra2&token=private"), "owner/.list")
        XCTAssertEqual(LocalAssetServer.diagnosticRoute(target: "/game/ra2/game.exe?token=private"), "owner/game.exe")
        XCTAssertEqual(LocalAssetServer.diagnosticRoute(target: "/game/User/LastLaunchDiagnostics.txt"), "owner/other")
    }

    func testPackagedWebRuntimeUsesRouteBJavaScriptCssAndWasmMimeTypes() {
        XCTAssertEqual(LocalAssetServer.mimeType(for: URL(fileURLWithPath: "/Web/index.html")), "text/html; charset=utf-8")
        XCTAssertEqual(LocalAssetServer.mimeType(for: URL(fileURLWithPath: "/Web/assets/index.js")), "text/javascript; charset=utf-8")
        XCTAssertEqual(LocalAssetServer.mimeType(for: URL(fileURLWithPath: "/Web/assets/index.css")), "text/css; charset=utf-8")
        XCTAssertEqual(LocalAssetServer.mimeType(for: URL(fileURLWithPath: "/Web/assets/v86.wasm")), "application/wasm")
        XCTAssertEqual(LocalAssetServer.mimeType(for: URL(fileURLWithPath: "/Web/assets/vmWorker.js")), "text/javascript; charset=utf-8")
    }
}
