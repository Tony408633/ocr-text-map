import Foundation

// MARK: - 服务器配置

struct ServerConfig: Codable, Equatable {
    var baseURL: String = ""
    var token: String = ""
    /// 优先使用 Windows 服务；关掉就完全用本机识别
    var enabled: Bool = false
    /// 局域网自签 HTTPS（8443）需要放开证书校验；用 HTTP 或公网隧道时不需要
    var allowSelfSignedTLS: Bool = false

    var normalizedBase: URL? {
        var text = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        return URL(string: text)
    }

    var isConfigured: Bool { normalizedBase != nil }
    var display: String { normalizedBase?.absoluteString ?? "未设置" }
}

// MARK: - 错误

enum ServerError: LocalizedError {
    case notConfigured
    case badURL
    case http(Int, String)
    case decoding
    case emptyPage

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "还没有设置电脑地址。"
        case .badURL: return "电脑地址格式不对，应该是 http://192.168.x.x:8080 这样。"
        case .http(let code, let message): return "电脑返回错误（\(code)）：\(message)"
        case .decoding: return "电脑返回的数据看不懂，可能版本不一致。"
        case .emptyPage: return "这一页还没有识别过。"
        }
    }
}

// MARK: - 接口数据结构（对应后端 /api/v1）

struct ServerLine: Decodable {
    let text: String
    let confidence: Double?
}

struct ServerPage: Decodable {
    let id: String
    let bookId: String
    let pageNumber: Int
    let lines: [ServerLine]

    var pageLines: [PageLine] {
        lines.map { PageLine(text: $0.text, confidence: $0.confidence ?? 0) }
    }
}

struct ServerBook: Decodable, Identifiable {
    let id: String
    let title: String
    let author: String?
    let pageCount: Int?
    let lastPage: Int?
}

struct ServerNote: Decodable, Identifiable {
    let id: String
    let bookId: String
    let pageNumber: Int
    let lineNumber: Int?
    let scope: String?
    let text: String
    let bookTitle: String?

    var scopeText: String {
        if scope == "page" || lineNumber == nil { return "第 \(pageNumber) 页 · 整页" }
        return "第 \(pageNumber) 页 · 第 \((lineNumber ?? 1)) 行"
    }
}

struct ServerProgress: Decodable {
    let bookId: String
    let pageNumber: Int
    let lineIndex: Int?
}

struct Bootstrap: Decodable {
    struct ServerInfo: Decodable {
        let version: String?
        let ocrReady: Bool?
    }

    let books: [ServerBook]
    let notes: [ServerNote]
    let progress: [ServerProgress]?
    let server: ServerInfo?
}

struct AutoScanResponse: Decodable {
    let action: String          // same / new / empty
    let unchanged: Bool?
    let similarity: Double?
    let page: ServerPage?
}

// MARK: - 客户端

/// iPhone 直接调用 Windows 上的纸伴服务（URLSession，无 CORS 限制）。
final class ServerClient: NSObject {
    let config: ServerConfig
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 150
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        return URLSession(
            configuration: configuration,
            delegate: config.allowSelfSignedTLS ? self : nil,
            delegateQueue: nil
        )
    }()

    init(config: ServerConfig) {
        self.config = config
        super.init()
    }

    // MARK: 基础请求

    private func request(_ path: String,
                         method: String = "GET",
                         body: Data? = nil,
                         contentType: String? = nil) async throws -> Data {
        guard let base = config.normalizedBase else { throw ServerError.badURL }
        guard let url = URL(string: base.absoluteString + path) else { throw ServerError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }
        let token = config.token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("PaperPal-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ServerError.decoding }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { $0?["error"] as? String ?? $0?["detail"] as? String } ?? "请求失败"
            throw ServerError.http(http.statusCode, message)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw ServerError.decoding
        }
    }

    // MARK: 业务接口

    @discardableResult
    func health() async throws -> Bool {
        let data = try await request("/api/health", method: "GET")
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ServerError.decoding
        }
        return (object["status"] as? String) == "ok"
    }

    func bootstrap() async throws -> Bootstrap {
        let data = try await request("/api/v1/bootstrap")
        return try decode(Bootstrap.self, from: data)
    }

    func createBook(title: String) async throws -> ServerBook {
        let payload = try JSONSerialization.data(withJSONObject: ["title": title])
        let data = try await request("/api/v1/books", method: "POST", body: payload, contentType: "application/json")
        return try decode(ServerBook.self, from: data)
    }

    func page(bookId: String, number: Int) async throws -> ServerPage {
        let data = try await request("/api/v1/books/\(bookId)/pages/\(number)")
        return try decode(ServerPage.self, from: data)
    }

    /// 免按键连续扫描：后端判断同一页 / 翻页 / 往回翻
    func autoScan(bookId: String,
                  jpeg: Data,
                  layout: String = "none",
                  rotation: Int = 0) async throws -> AutoScanResponse {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "layout", value: layout),
            URLQueryItem(name: "rotation", value: String(rotation)),
            URLQueryItem(name: "min_confidence", value: "0.4"),
            URLQueryItem(name: "max_side", value: "1280"),
        ]
        let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        let data = try await request(
            "/api/v1/books/\(bookId)/auto-scan\(query)",
            method: "POST",
            body: jpeg,
            contentType: "image/jpeg"
        )
        return try decode(AutoScanResponse.self, from: data)
    }

    func createNote(bookId: String, pageNumber: Int, lineIndex: Int?, text: String) async throws {
        var payload: [String: Any] = [
            "book_id": bookId,
            "page_number": pageNumber,
            "scope": lineIndex == nil ? "page" : "line",
            "text": text,
        ]
        if let lineIndex {
            payload["line_number"] = lineIndex + 1
        } else {
            payload["line_number"] = NSNull()
        }
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await request("/api/v1/notes", method: "POST", body: body, contentType: "application/json")
    }

    func saveProgress(bookId: String, pageNumber: Int, lineIndex: Int) async throws {
        let payload: [String: Any] = [
            "book_id": bookId,
            "page_number": pageNumber,
            "line_index": lineIndex,
        ]
        let body = try JSONSerialization.data(withJSONObject: payload)
        _ = try await request("/api/v1/progress", method: "PUT", body: body, contentType: "application/json")
    }

    func notes(bookId: String? = nil) async throws -> [ServerNote] {
        var path = "/api/v1/notes?limit=200"
        if let bookId, let escaped = bookId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "&book_id=\(escaped)"
        }
        let data = try await request(path)
        struct Response: Decodable { let notes: [ServerNote] }
        return try decode(Response.self, from: data).notes
    }

    func deleteNote(id: String) async throws {
        _ = try await request("/api/v1/notes/\(id)", method: "DELETE")
    }
}

// MARK: - 自签证书（仅局域网 HTTPS 演示用）

extension ServerClient: URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard config.allowSelfSignedTLS,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}
