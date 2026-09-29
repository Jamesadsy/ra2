import CryptoKit
import Foundation
import XCTest
@testable import RA2M1

final class OwnerDataStoreTests: XCTestCase {
    func testAcceptedExecutablePinAndFlatDeviceAllowlist() {
        XCTAssertEqual(OwnerDataContract.executableSHA256, "6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d")
        XCTAssertEqual(OwnerDataContract.requiredFiles.count, 11)
        XCTAssertEqual(Set(OwnerDataContract.requiredFiles.map { $0.lowercased() }).count, 11)
        XCTAssertTrue(OwnerDataContract.requiredFiles.contains("Maps02.mix"))
    }

    func testSetupCreatesFilesVisibleDataAndSeparateUserFolders() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let documents = directory.appendingPathComponent("Documents", isDirectory: true)
        let store = OwnerDataStore(containerURL: documents.appendingPathComponent("CnC RA2", isDirectory: true))

        try store.prepareDocuments()

        XCTAssertEqual(store.dataURL.lastPathComponent, "Data")
        XCTAssertEqual(store.userURL.lastPathComponent, "User")
        XCTAssertEqual(store.dataURL.deletingLastPathComponent(), store.userURL.deletingLastPathComponent())
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.dataURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.userURL.path))
        XCTAssertTrue(try store.dataURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.userURL.path), [])
    }

    func testValidatedDataIsReadInPlaceAndNeverImportedToHiddenSupport() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let store = OwnerDataStore(
            containerURL: directory.appendingPathComponent("Documents/CnC RA2", isDirectory: true),
            expectedExecutableSHA256: digest(Data("fixture executable".utf8))
        )
        try store.prepareDocuments()
        let fixtureBytes = try makeValidOwnerFolder(at: store.dataURL, executable: Data("fixture executable".utf8))

        let validated = try store.validateData()

        XCTAssertEqual(validated.executableSHA256, digest(fixtureBytes))
        XCTAssertEqual(validated.fileCount, OwnerDataContract.requiredFiles.count)
        XCTAssertGreaterThan(validated.totalBytes, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.dataURL.appendingPathComponent("game.exe").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("Application Support/RA2/OwnerData").path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.userURL.path), [])
    }

    func testIncompleteDataFailsClosedWithDeterministicMissingFiles() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let partial = directory.appendingPathComponent("Data", isDirectory: true)
        try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: true)
        try Data("not the accepted executable".utf8).write(to: partial.appendingPathComponent("game.exe"))

        XCTAssertThrowsError(try OwnerDataStore.validate(folder: partial, expectedExecutableSHA256: "unused")) { error in
            XCTAssertEqual(error as? OwnerDataError, .missingFiles(Array(OwnerDataContract.requiredFiles.dropFirst())))
        }
    }

    func testSovietCampaignArchiveIsRequired() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let data = directory.appendingPathComponent("Data", isDirectory: true)
        let bytes = try makeValidOwnerFolder(at: data)
        try FileManager.default.removeItem(at: data.appendingPathComponent("Maps02.mix"))

        XCTAssertThrowsError(try OwnerDataStore.validate(folder: data, expectedExecutableSHA256: digest(bytes))) { error in
            XCTAssertEqual(error as? OwnerDataError, .missingFiles(["Maps02.mix"]))
        }
    }

    func testUnknownFileAndDirectoryAreOutsideTheFinalDeviceAllowlist() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let data = directory.appendingPathComponent("Data", isDirectory: true)
        let bytes = try makeValidOwnerFolder(at: data)
        let expectedHash = digest(bytes)

        try Data("unexpected".utf8).write(to: data.appendingPathComponent("extra.mix"))
        XCTAssertThrowsError(try OwnerDataStore.validate(folder: data, expectedExecutableSHA256: expectedHash)) { error in
            XCTAssertEqual(error as? OwnerDataError, .unsupportedEntry("extra.mix"))
        }

        try FileManager.default.removeItem(at: data.appendingPathComponent("extra.mix"))
        try FileManager.default.createDirectory(at: data.appendingPathComponent("nested", isDirectory: true), withIntermediateDirectories: false)
        XCTAssertThrowsError(try OwnerDataStore.validate(folder: data, expectedExecutableSHA256: expectedHash)) { error in
            XCTAssertEqual(error as? OwnerDataError, .unsupportedEntry("nested"))
        }
    }

    func testWrongExecutableCannotStartFromVisibleData() throws {
        let directory = try temporaryDirectory()
        defer { cleanUp(directory) }
        let data = directory.appendingPathComponent("Data", isDirectory: true)
        _ = try makeValidOwnerFolder(at: data, executable: Data("unknown executable".utf8))

        XCTAssertThrowsError(try OwnerDataStore.validate(folder: data)) { error in
            XCTAssertEqual(error as? OwnerDataError, .executableHashMismatch)
        }
    }

    func testInfoPlistExposesDocumentsToFiles() throws {
        let sourceTests = URL(fileURLWithPath: #filePath)
        let infoPlist = sourceTests
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Info.plist")
        let data = try Data(contentsOf: infoPlist)
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        XCTAssertEqual(plist["UIFileSharingEnabled"] as? Bool, true)
        XCTAssertEqual(plist["LSSupportsOpeningDocumentsInPlace"] as? Bool, true)
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
        try? FileManager.default.removeItem(at: root)
    }
}
