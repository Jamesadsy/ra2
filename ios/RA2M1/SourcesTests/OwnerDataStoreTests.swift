import CryptoKit
import Foundation
import XCTest
@testable import RA2M1

final class OwnerDataStoreTests: XCTestCase {
    func testAcceptedExecutablePinIsTheChairmanEA108Digest() {
        XCTAssertEqual(OwnerDataContract.executableSHA256, "6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d")
        XCTAssertEqual(OwnerDataContract.requiredFiles.count, 10)
    }

    func testCompleteFixtureImportsAtomicallyAsReadOnlyAppPrivateData() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let source = directory.appendingPathComponent("source", isDirectory: true)
        let bytes = try makeValidOwnerFolder(at: source)
        let store = OwnerDataStore(
            containerURL: directory.appendingPathComponent("Application Support/RA2/OwnerData", isDirectory: true),
            expectedExecutableSHA256: digest(bytes)
        )

        let imported = try store.importFolder(source)

        XCTAssertEqual(imported.executableSHA256, digest(bytes))
        XCTAssertEqual(imported.fileCount, OwnerDataContract.requiredFiles.count)
        XCTAssertEqual(try store.validateInstalled(), imported)
        let permissions = try FileManager.default.attributesOfItem(atPath: store.installedURL.appendingPathComponent("ra2.mix").path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o444)
        XCTAssertTrue(try store.installedURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    }

    func testIncompleteOrWrongExecutableImportCannotReplaceAcceptedPrivateSet() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let source = directory.appendingPathComponent("source", isDirectory: true)
        let acceptedBytes = try makeValidOwnerFolder(at: source)
        let store = OwnerDataStore(
            containerURL: directory.appendingPathComponent("OwnerData", isDirectory: true),
            expectedExecutableSHA256: digest(acceptedBytes)
        )
        let accepted = try store.importFolder(source)

        let wrongSource = directory.appendingPathComponent("wrong", isDirectory: true)
        _ = try makeValidOwnerFolder(at: wrongSource, executable: Data("unknown executable".utf8))
        XCTAssertThrowsError(try store.importFolder(wrongSource)) { error in
            XCTAssertEqual(error as? OwnerDataError, .executableHashMismatch)
        }
        XCTAssertEqual(try store.validateInstalled(), accepted)
        XCTAssertEqual(try Data(contentsOf: store.installedURL.appendingPathComponent("game.exe")), acceptedBytes)
    }

    func testRequiredFileInventoryRejectsPartialImport() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let partial = directory.appendingPathComponent("partial", isDirectory: true)
        try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: true)
        try Data("not an owner executable".utf8).write(to: partial.appendingPathComponent("game.exe"))

        XCTAssertThrowsError(try OwnerDataStore.validate(folder: partial, expectedExecutableSHA256: "unused")) { error in
            XCTAssertEqual(error as? OwnerDataError, .missingFiles(Array(OwnerDataContract.requiredFiles.dropFirst())))
        }
    }

    private func makeValidOwnerFolder(at url: URL, executable: Data = Data("asset-free fixture executable".utf8)) throws -> Data {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        for name in OwnerDataContract.requiredFiles {
            try (name == "game.exe" ? executable : Data("fixture".utf8)).write(to: url.appendingPathComponent(name))
        }
        return executable
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func cleanUp(_ root: URL) {
        let fileManager = FileManager.default
        let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        while let url = enumerator?.nextObject() as? URL {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            try? fileManager.setAttributes([.posixPermissions: isDirectory ? 0o755 : 0o644], ofItemAtPath: url.path)
        }
        try? fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try? fileManager.removeItem(at: root)
    }
}
