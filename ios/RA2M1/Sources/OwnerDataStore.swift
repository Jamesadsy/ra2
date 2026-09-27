import CryptoKit
import Foundation

enum OwnerDataContract {
    static let executableSHA256 = "6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d"
    static let requiredFiles = [
        "game.exe",
        "ra2.mix",
        "language.mix",
        "binkw32.dll",
        "blowfish.dll",
        "maps01.mix",
        "movies01.mix",
        "movies02.mix",
        "multi.mix",
        "theme.mix",
    ]
}

enum OwnerDataError: LocalizedError, Equatable {
    case notDirectory
    case missingFiles([String])
    case emptyFile(String)
    case executableHashMismatch
    case symbolicLink(String)
    case unsupportedEntry(String)
    case backupExclusionFailed
    case readOnlyProtectionFailed

    var errorDescription: String? {
        switch self {
        case .notDirectory:
            return "Select the extracted RA2 data folder containing game.exe."
        case .missingFiles(let names):
            return "Required EA RA2 1.08 campaign files are missing: \(names.joined(separator: ", "))."
        case .emptyFile(let name):
            return "A required owner file is empty: \(name)."
        case .executableHashMismatch:
            return "The selected game.exe is not the accepted EA RA2 1.08 executable."
        case .symbolicLink(let path):
            return "Owner data import rejected a symbolic link: \(path)."
        case .unsupportedEntry(let path):
            return "Owner data import rejected a non-file entry: \(path)."
        case .backupExclusionFailed:
            return "Owner data could not be excluded from device backup."
        case .readOnlyProtectionFailed:
            return "Owner data could not be made read-only."
        }
    }
}

struct OwnerDataValidation: Equatable {
    let executableSHA256: String
    let fileCount: Int
}

/// Keeps the retail install immutable and app-private; Route B's write cache remains in WKWebView IndexedDB.
final class OwnerDataStore {
    let containerURL: URL
    let installedURL: URL
    private let fileManager: FileManager
    private let expectedExecutableSHA256: String

    init(
        containerURL: URL = OwnerDataStore.defaultContainerURL(),
        fileManager: FileManager = .default,
        expectedExecutableSHA256: String = OwnerDataContract.executableSHA256
    ) {
        self.containerURL = containerURL
        self.installedURL = containerURL.appendingPathComponent("ra2", isDirectory: true)
        self.fileManager = fileManager
        self.expectedExecutableSHA256 = expectedExecutableSHA256.lowercased()
    }

    static func defaultContainerURL(fileManager: FileManager = .default) -> URL {
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("RA2/OwnerData", isDirectory: true)
    }

    func validateInstalled() throws -> OwnerDataValidation {
        try Self.validate(folder: installedURL, expectedExecutableSHA256: expectedExecutableSHA256, fileManager: fileManager)
    }

    /// Validates before promotion, copies into a sibling staging directory, then atomically swaps the private owner set.
    @discardableResult
    func importFolder(_ sourceURL: URL) throws -> OwnerDataValidation {
        try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
        try excludeFromBackup(containerURL)
        let sourceValidation = try Self.validate(
            folder: sourceURL,
            expectedExecutableSHA256: expectedExecutableSHA256,
            fileManager: fileManager
        )
        let staging = containerURL.appendingPathComponent(".import-\(UUID().uuidString)", isDirectory: true)
        let backup = containerURL.appendingPathComponent(".previous-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: staging) }

        try copyTree(from: sourceURL, to: staging)
        let stagedValidation = try Self.validate(
            folder: staging,
            expectedExecutableSHA256: expectedExecutableSHA256,
            fileManager: fileManager
        )
        guard stagedValidation == sourceValidation else { throw OwnerDataError.executableHashMismatch }

        let hadPrevious = fileManager.fileExists(atPath: installedURL.path)
        if hadPrevious { try fileManager.moveItem(at: installedURL, to: backup) }
        do {
            try fileManager.moveItem(at: staging, to: installedURL)
            try excludeFromBackup(installedURL)
            try setReadOnlyRecursively(installedURL)
        } catch {
            if fileManager.fileExists(atPath: installedURL.path) {
                removeReadOnlyTree(installedURL)
            }
            if hadPrevious {
                try? fileManager.moveItem(at: backup, to: installedURL)
            }
            throw error
        }
        if hadPrevious { removeReadOnlyTree(backup) }
        return stagedValidation
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
            options: [.skipsHiddenFiles]
        )
        var rootFiles: [String: URL] = [:]
        var regularFileCount = 0
        for entry in entries {
            let values = try entry.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            if values.isSymbolicLink == true { throw OwnerDataError.symbolicLink(entry.lastPathComponent) }
            if values.isRegularFile == true {
                regularFileCount += 1
                rootFiles[entry.lastPathComponent.lowercased()] = entry
            }
        }

        let missing = OwnerDataContract.requiredFiles.filter { rootFiles[$0] == nil }
        if !missing.isEmpty { throw OwnerDataError.missingFiles(missing) }
        for name in OwnerDataContract.requiredFiles {
            guard let file = rootFiles[name] else { continue }
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            if size == 0 { throw OwnerDataError.emptyFile(name) }
        }
        guard let executable = rootFiles["game.exe"] else {
            throw OwnerDataError.missingFiles(["game.exe"])
        }
        let digest = SHA256.hash(data: try Data(contentsOf: executable, options: [.mappedIfSafe]))
            .map { String(format: "%02x", $0) }
            .joined()
        guard digest == expectedExecutableSHA256.lowercased() else { throw OwnerDataError.executableHashMismatch }

        return OwnerDataValidation(executableSHA256: digest, fileCount: regularFileCount)
    }

    private func copyTree(from source: URL, to destination: URL) throws {
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
        let enumerator = fileManager.enumerator(
            at: source,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        )
        while let item = enumerator?.nextObject() as? URL {
            let values = try item.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            let relative = item.path.replacingOccurrences(of: source.path + "/", with: "")
            guard !relative.hasPrefix("/") && !relative.split(separator: "/").contains("..") else {
                throw OwnerDataError.unsupportedEntry(relative)
            }
            let target = destination.appendingPathComponent(relative)
            if values.isSymbolicLink == true { throw OwnerDataError.symbolicLink(relative) }
            if values.isDirectory == true {
                try fileManager.createDirectory(at: target, withIntermediateDirectories: true)
            } else if values.isRegularFile == true {
                try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try fileManager.copyItem(at: item, to: target)
            } else {
                throw OwnerDataError.unsupportedEntry(relative)
            }
        }
    }

    private func setReadOnlyRecursively(_ root: URL) throws {
        let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        guard let enumerator else { throw OwnerDataError.readOnlyProtectionFailed }
        while let url = enumerator.nextObject() as? URL {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            try fileManager.setAttributes([.posixPermissions: isDirectory ? 0o555 : 0o444], ofItemAtPath: url.path)
        }
        try fileManager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)
    }

    private func removeReadOnlyTree(_ root: URL) {
        let enumerator = fileManager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey])
        while let url = enumerator?.nextObject() as? URL {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            try? fileManager.setAttributes([.posixPermissions: isDirectory ? 0o755 : 0o644], ofItemAtPath: url.path)
        }
        try? fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try? fileManager.removeItem(at: root)
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
