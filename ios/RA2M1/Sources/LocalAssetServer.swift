import Foundation
import Network

enum LocalAssetRoute: Equatable {
    case file(URL, ownerData: Bool)
    case directory(URL)
    case notFound
    case badRequest
}

/// App-owned loopback HTTP surface required by the existing Route B fetch, Range, Worker, and IndexedDB paths.
final class LocalAssetServer {
    static let productionPort: UInt16 = 18_108
    private static let maximumHeaderBytes = 64 * 1024

    let webRoot: URL
    let ownerRoot: URL
    let port: UInt16
    private let ownerDataToken: String
    private let queue = DispatchQueue(label: "org.second-sun.ra2m1.loopback")
    private var listener: NWListener?

    init(webRoot: URL, ownerRoot: URL, port: UInt16 = productionPort, ownerDataToken: String = "") {
        self.webRoot = webRoot
        self.ownerRoot = ownerRoot
        self.port = port
        self.ownerDataToken = ownerDataToken
    }

    var origin: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        guard listener == nil else {
            completion(.success(()))
            return
        }
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            completion(.failure(ServerError.invalidPort))
            return
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: endpointPort)
        do {
            // requiredLocalEndpoint already supplies both the loopback address and fixed port.
            let server = try NWListener(using: parameters)
            listener = server
            server.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            server.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    completion(.success(()))
                case .failed(let error):
                    completion(.failure(error))
                default:
                    break
                }
            }
            server.start(queue: queue)
        } catch {
            listener = nil
            completion(.failure(error))
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    static func resolve(target: String, webRoot: URL, ownerRoot: URL) -> LocalAssetRoute {
        guard let components = URLComponents(string: "http://127.0.0.1\(target)"),
              let decodedPath = components.percentEncodedPath.removingPercentEncoding,
              !decodedPath.contains("\\"), !decodedPath.contains("\0") else {
            return .badRequest
        }
        let parts = decodedPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !parts.contains("."), !parts.contains("..") else { return .badRequest }

        if parts.first == "game" {
            if parts.count == 2, parts[1] == ".list" {
                let directory = components.queryItems?.first(where: { $0.name == "dir" })?.value ?? ""
                guard safeComponents(directory.split(separator: "/").map(String.init)) else { return .badRequest }
                return .directory(directory.isEmpty ? ownerRoot : append(directory.split(separator: "/").map(String.init), to: ownerRoot))
            }
            guard parts.count > 1, safeComponents(Array(parts.dropFirst())) else { return .badRequest }
            return .file(append(Array(parts.dropFirst()), to: ownerRoot), ownerData: true)
        }

        let publicParts = parts.isEmpty ? ["index.html"] : parts
        guard safeComponents(publicParts) else { return .badRequest }
        return .file(append(publicParts, to: webRoot), ownerData: false)
    }

    static func parseRange(_ header: String?, fileSize: UInt64) -> Result<Range<UInt64>?, RangeError> {
        guard let header else { return .success(nil) }
        guard header.lowercased().hasPrefix("bytes="), !header.contains(","), fileSize > 0 else {
            return .failure(.invalid)
        }
        let bounds = header.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2 else { return .failure(.invalid) }
        if bounds[0].isEmpty {
            guard let suffix = UInt64(bounds[1]), suffix > 0 else { return .failure(.invalid) }
            let length = min(suffix, fileSize)
            return .success((fileSize - length)..<fileSize)
        }
        guard let start = UInt64(bounds[0]), start < fileSize else { return .failure(.invalid) }
        let requestedEnd = bounds[1].isEmpty ? fileSize - 1 : UInt64(bounds[1])
        guard let end = requestedEnd, end >= start else { return .failure(.invalid) }
        return .success(start..<(min(end, fileSize - 1) + 1))
    }

    static func authorizesOwnerRequest(expectedToken: String, suppliedToken: String?) -> Bool {
        guard let suppliedToken, !expectedToken.isEmpty, expectedToken.utf8.count == suppliedToken.utf8.count else { return false }
        return zip(expectedToken.utf8, suppliedToken.utf8).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHeader(connection, bytes: Data())
    }

    private func receiveHeader(_ connection: NWConnection, bytes: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var accumulated = bytes
            if let data { accumulated.append(data) }
            if accumulated.count > Self.maximumHeaderBytes {
                self.sendSimple(431, reason: "Request Header Fields Too Large", connection: connection)
                return
            }
            if let end = accumulated.range(of: Data([13, 10, 13, 10])) {
                self.handleRequest(Data(accumulated[..<end.lowerBound]), on: connection)
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.receiveHeader(connection, bytes: accumulated)
            }
        }
    }

    private func handleRequest(_ data: Data, on connection: NWConnection) {
        guard let text = String(data: data, encoding: .utf8),
              let firstLine = text.components(separatedBy: "\r\n").first else {
            sendSimple(400, reason: "Bad Request", connection: connection)
            return
        }
        let tokens = firstLine.split(separator: " ")
        guard tokens.count == 3, let target = tokens.dropFirst().first.map(String.init) else {
            sendSimple(400, reason: "Bad Request", connection: connection)
            return
        }
        let method = String(tokens[0])
        guard method == "GET" || method == "HEAD" else {
            sendSimple(405, reason: "Method Not Allowed", connection: connection)
            return
        }
        let headerLines = text.components(separatedBy: "\r\n").dropFirst()
        var requestHeaders: [String: String] = [:]
        for line in headerLines {
            guard let separator = line.firstIndex(of: ":") else { continue }
            requestHeaders[line[..<separator].lowercased()] = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
        }

        let route = Self.resolve(target: target, webRoot: webRoot, ownerRoot: ownerRoot)
        switch route {
        case .file(_, ownerData: true), .directory:
            guard Self.authorizesOwnerRequest(expectedToken: ownerDataToken, suppliedToken: requestHeaders["x-ra2-owner-token"]) else {
                sendSimple(404, reason: "Not Found", connection: connection)
                return
            }
        default:
            break
        }

        switch route {
        case .badRequest:
            sendSimple(400, reason: "Bad Request", connection: connection)
        case .notFound:
            sendSimple(404, reason: "Not Found", connection: connection)
        case .directory(let directory):
            guard FileManager.default.fileExists(atPath: directory.path) else {
                sendSimple(404, reason: "Not Found", connection: connection)
                return
            }
            do {
                let items = try FileManager.default.contentsOfDirectory(
                    at: directory,
                    includingPropertiesForKeys: [.isSymbolicLinkKey],
                    options: [.skipsHiddenFiles]
                ).filter { (try? $0.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true }
                    .map(\.lastPathComponent).sorted()
                sendBytes(try JSONSerialization.data(withJSONObject: items), type: "application/json", ownerData: true, code: 200, range: nil, connection: connection, headOnly: method == "HEAD")
            } catch {
                sendSimple(404, reason: "Not Found", connection: connection)
            }
        case .file(let url, let ownerData):
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size >= 0 else {
                sendSimple(404, reason: "Not Found", connection: connection)
                return
            }
            let rangeResult = Self.parseRange(requestHeaders["range"], fileSize: UInt64(size))
            switch rangeResult {
            case .failure:
                let response = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */\(size)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            case .success(let byteRange):
                sendFile(url, size: UInt64(size), ownerData: ownerData, range: byteRange, connection: connection, headOnly: method == "HEAD")
            }
        }
    }

    private func sendFile(
        _ url: URL,
        size: UInt64,
        ownerData: Bool,
        range: Range<UInt64>?,
        connection: NWConnection,
        headOnly: Bool
    ) {
        let status = range == nil ? 200 : 206
        let length = range.map { $0.upperBound - $0.lowerBound } ?? size
        let start = range?.lowerBound ?? 0
        var extra = "Accept-Ranges: bytes\r\n"
        if let range { extra += "Content-Range: bytes \(range.lowerBound)-\(range.upperBound - 1)/\(size)\r\n" }
        let cache = ownerData ? "private, no-store" : "no-cache"
        let header = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Partial Content")\r\nContent-Type: \(Self.mimeType(for: url))\r\nContent-Length: \(length)\r\n\(extra)Cache-Control: \(cache)\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { error in
            guard error == nil else { connection.cancel(); return }
            if headOnly || length == 0 {
                self.finish(connection)
            } else {
                FileStreamer(url: url, connection: connection, offset: start, remaining: length, queue: self.queue).start()
            }
        })
    }

    private func sendBytes(
        _ body: Data,
        type: String,
        ownerData: Bool,
        code: Int,
        range: String?,
        connection: NWConnection,
        headOnly: Bool
    ) {
        let reason = code == 200 ? "OK" : "Not Found"
        let cache = ownerData ? "private, no-store" : "no-cache"
        let rangeHeader = range.map { "Content-Range: \($0)\r\n" } ?? ""
        let header = "HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n\(rangeHeader)Cache-Control: \(cache)\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8), completion: .contentProcessed { error in
            guard error == nil else { connection.cancel(); return }
            guard !headOnly, !body.isEmpty else { self.finish(connection); return }
            connection.send(content: body, completion: .contentProcessed { _ in self.finish(connection) })
        })
    }

    private func sendSimple(_ status: Int, reason: String, connection: NWConnection) {
        let body = Data(reason.utf8)
        let response = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { error in
            guard error == nil else { connection.cancel(); return }
            connection.send(content: body, completion: .contentProcessed { _ in self.finish(connection) })
        })
    }

    private func finish(_ connection: NWConnection) {
        connection.send(content: nil, contentContext: .defaultStream, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "woff2": return "font/woff2"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    private static func safeComponents(_ components: [String]) -> Bool {
        components.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") }
    }

    private static func append(_ components: [String], to root: URL) -> URL {
        components.reduce(root) { $0.appendingPathComponent($1, isDirectory: false) }
    }

    enum RangeError: Error { case invalid }
    private enum ServerError: Error { case invalidPort }
}

private final class FileStreamer {
    private let url: URL
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var offset: UInt64
    private var remaining: UInt64
    private var handle: FileHandle?

    init(url: URL, connection: NWConnection, offset: UInt64, remaining: UInt64, queue: DispatchQueue) {
        self.url = url
        self.connection = connection
        self.offset = offset
        self.remaining = remaining
        self.queue = queue
    }

    func start() {
        do {
            handle = try FileHandle(forReadingFrom: url)
            try handle?.seek(toOffset: offset)
            sendNext()
        } catch {
            connection.cancel()
        }
    }

    private func sendNext() {
        guard remaining > 0 else {
            try? handle?.close()
            connection.send(content: nil, contentContext: .defaultStream, isComplete: true, completion: .contentProcessed { _ in self.connection.cancel() })
            return
        }
        do {
            guard let data = try handle?.read(upToCount: Int(min(256 * 1024, remaining))), !data.isEmpty else {
                connection.cancel()
                return
            }
            remaining -= UInt64(data.count)
            offset += UInt64(data.count)
            connection.send(content: data, completion: .contentProcessed { [weak self] error in
                guard let self, error == nil else { self?.connection.cancel(); return }
                self.queue.async { self.sendNext() }
            })
        } catch {
            connection.cancel()
        }
    }
}
