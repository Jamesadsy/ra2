import CryptoKit
import Foundation

enum OwnerDataContract {
    static let executableSHA256 = "6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d"
    static let requiredFiles = [
        "game.exe",
        "ra2.mix",
        "language.mix",
        "BINKW32.DLL",
        "Blowfish.dll",
        "Maps01.mix",
        "Maps02.mix",
        "movies01.mix",
        "movies02.mix",
        "Multi.mix",
        "Theme.mix",
    ]
    static let documentsFolderName = "CnC RA2"
    static let dataFolderName = "Data"
    static let userFolderName = "User"
}

enum OwnerDataError: LocalizedError, Equatable {
    case notDirectory
    case missingFiles([String])
    case emptyFile(String)
    case executableHashMismatch
    case symbolicLink(String)
    case duplicateEntry(String)
    case unsupportedEntry(String)
    case backupExclusionFailed

    var errorDescription: String? {
        switch self {
        case .notDirectory:
            return "The CnC RA2 Data location is not an ordinary folder."
        case .missingFiles(let names):
            return "Validated RA2 M1 Data is incomplete. Missing: \(names.joined(separator: ", "))."
        case .emptyFile(let name):
            return "A required owner file is empty: \(name)."
        case .executableHashMismatch:
            return "The selected game.exe is not the accepted EA RA2 1.08 executable."
        case .symbolicLink(let path):
            return "Owner Data rejected a symbolic link: \(path)."
        case .duplicateEntry(let path):
            return "Owner Data rejected a case-insensitive duplicate: \(path)."
        case .unsupportedEntry(let path):
            return "Owner Data contains an entry outside the validated flat Data allowlist: \(path)."
        case .backupExclusionFailed:
            return "Owner Data could not be excluded from device backup."
        }
    }
}

struct OwnerDataValidation: Equatable {
    let executableSHA256: String
    let fileCount: Int
    let totalBytes: Int64
}

/// Exposes the Files-visible owner Data folder directly; User is reserved for writable player state.
final class OwnerDataStore {
    let containerURL: URL
    let dataURL: URL
    let userURL: URL
    private let fileManager: FileManager
    private let expectedExecutableSHA256: String

    init(
        containerURL: URL = OwnerDataStore.defaultContainerURL(),
        fileManager: FileManager = .default,
        expectedExecutableSHA256: String = OwnerDataContract.executableSHA256
    ) {
        self.containerURL = containerURL
        self.dataURL = containerURL.appendingPathComponent(OwnerDataContract.dataFolderName, isDirectory: true)
        self.userURL = containerURL.appendingPathComponent(OwnerDataContract.userFolderName, isDirectory: true)
        self.fileManager = fileManager
        self.expectedExecutableSHA256 = expectedExecutableSHA256.lowercased()
    }

    static func defaultContainerURL(fileManager: FileManager = .default) -> URL {
        let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documents.appendingPathComponent(OwnerDataContract.documentsFolderName, isDirectory: true)
    }

    /// Creates the Files-visible roots without copying or importing owner data.
    func prepareDocuments() throws {
        try ensureDirectory(containerURL)
        try ensureDirectory(dataURL)
        try ensureDirectory(userURL)
        try excludeFromBackup(dataURL)
    }

    func validateData() throws -> OwnerDataValidation {
        try Self.validate(
            folder: dataURL,
            expectedExecutableSHA256: expectedExecutableSHA256,
            fileManager: fileManager
        )
    }

    static func validate(
        folder: URL,
        expectedExecutableSHA256: String = OwnerDataContract.executableSHA256,
        fileManager: FileManager = .default
    ) throws -> OwnerDataValidation {
        let rootValues = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw OwnerDataError.notDirectory
        }

        let entries = try fileManager.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey],
            options: []
        ).sorted { $0.lastPathComponent.lowercased() < $1.lastPathComponent.lowercased() }
        let allowedNames = Set(OwnerDataContract.requiredFiles.map { $0.lowercased() })
        var rootFiles: [String: URL] = [:]
        var totalBytes: Int64 = 0

        for entry in entries {
            let name = entry.lastPathComponent
            let values = try entry.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])
            if values.isSymbolicLink == true { throw OwnerDataError.symbolicLink(name) }
            guard values.isRegularFile == true else { throw OwnerDataError.unsupportedEntry(name) }

            let key = name.lowercased()
            guard allowedNames.contains(key) else { throw OwnerDataError.unsupportedEntry(name) }
            guard rootFiles[key] == nil else { throw OwnerDataError.duplicateEntry(name) }
            guard let size = values.fileSize, size > 0 else { throw OwnerDataError.emptyFile(name) }
            rootFiles[key] = entry
            totalBytes += Int64(size)
        }

        let missing = OwnerDataContract.requiredFiles.filter { rootFiles[$0.lowercased()] == nil }
        if !missing.isEmpty { throw OwnerDataError.missingFiles(missing) }
        guard let executable = rootFiles["game.exe"] else {
            throw OwnerDataError.missingFiles(["game.exe"])
        }
        let digest = SHA256.hash(data: try Data(contentsOf: executable, options: [.mappedIfSafe]))
            .map { String(format: "%02x", $0) }
            .joined()
        guard digest == expectedExecutableSHA256.lowercased() else { throw OwnerDataError.executableHashMismatch }

        return OwnerDataValidation(executableSHA256: digest, fileCount: rootFiles.count, totalBytes: totalBytes)
    }

    private func ensureDirectory(_ url: URL) throws {
        if fileManager.fileExists(atPath: url.path) {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw OwnerDataError.notDirectory
            }
            return
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func excludeFromBackup(_ url: URL) throws {
        var mutableURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
        let verified = try mutableURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        guard verified == true else { throw OwnerDataError.backupExclusionFailed }
    }
}
