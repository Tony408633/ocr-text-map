import Foundation

// MARK: - 数据模型

struct PageLine: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var text: String
    var confidence: Double = 0
    var x: Double = 0
    var y: Double = 0
    var width: Double = 0
    var height: Double = 0
}

struct BookPage: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var number: Int
    var lines: [PageLine]
    var createdAt: Date = Date()
    var text: String { lines.map(\.text).joined(separator: "\n") }
}

struct Book: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var title: String
    var author: String = ""
    var pages: [BookPage] = []
    var updatedAt: Date = Date()

    var lastPageNumber: Int { pages.map(\.number).max() ?? 0 }
    func page(_ number: Int) -> BookPage? { pages.first { $0.number == number } }
    var sortedPages: [BookPage] { pages.sorted { $0.number < $1.number } }
}

/// 批注：lineIndex 为 nil 表示整页批注
struct PaperNote: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var bookId: UUID
    var bookTitle: String
    var pageNumber: Int
    var lineIndex: Int?
    var text: String
    var createdAt: Date = Date()

    var scopeText: String {
        guard let lineIndex else { return "第 \(pageNumber) 页 · 整页" }
        return "第 \(pageNumber) 页 · 第 \(lineIndex + 1) 行"
    }
}

struct ReadingProgress: Codable, Hashable {
    var bookId: UUID
    var pageNumber: Int
    var lineIndex: Int
}

struct AppSettings: Codable, Hashable {
    /// AVSpeechUtterance 的 rate 取值 0…1，0.5 接近正常语速
    var rate: Float = 0.5
    var pitch: Float = 1.0
    var autoAdvance: Bool = true
    var autoStartCamera: Bool = true
    var fontSize: Double = 1.0
}

// MARK: - 文字相似度（用于判断“同一页 / 翻页了”）

enum TextMatch {
    private static let noise = CharacterSet(
        charactersIn: " \t\n\r，。！？、；：,.!?;:\"'“”‘’（）()《》〈〉[]【】-—_~·…"
    )

    static func normalize(_ text: String) -> String {
        String(text.unicodeScalars.filter { !noise.contains($0) }).lowercased()
    }

    static func similarity(_ left: String, _ right: String) -> Double {
        let a = normalize(left)
        let b = normalize(right)
        if a.isEmpty || b.isEmpty { return 0 }
        if a == b { return 1 }
        let xa = Array(a), xb = Array(b)
        let short = min(xa.count, xb.count)
        let long = max(xa.count, xb.count)
        if Double(short) / Double(long) < 0.45 { return 0 }
        if xa.count * xb.count > 400_000 {
            return bigramJaccard(xa, xb)
        }
        return lcsRatio(xa, xb)
    }

    /// 最长公共子序列占比：对“同一页被重新识别”很稳
    private static func lcsRatio(_ a: [Character], _ b: [Character]) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        var previous = [Int](repeating: 0, count: b.count + 1)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = 0
            for j in 1...b.count {
                if a[i - 1] == b[j - 1] {
                    current[j] = previous[j - 1] + 1
                } else {
                    current[j] = max(previous[j], current[j - 1])
                }
            }
            swap(&previous, &current)
        }
        return Double(previous[b.count]) / Double(max(a.count, b.count))
    }

    private static func bigramJaccard(_ a: [Character], _ b: [Character]) -> Double {
        func grams(_ chars: [Character]) -> Set<String> {
            guard chars.count > 1 else { return Set(chars.map(String.init)) }
            var set = Set<String>()
            for index in 0..<(chars.count - 1) {
                set.insert(String(chars[index...index + 1]))
            }
            return set
        }
        let ga = grams(a), gb = grams(b)
        guard !ga.isEmpty || !gb.isEmpty else { return 0 }
        let intersection = ga.intersection(gb).count
        let union = ga.union(gb).count
        return union == 0 ? 0 : Double(intersection) / Double(union)
    }

    /// 重新识别同一页时，找回原来那一行
    static func bestLineIndex(for target: String, in lines: [PageLine]) -> Int? {
        guard !normalize(target).isEmpty else { return nil }
        var bestIndex = 0
        var bestScore = -1.0
        for (index, line) in lines.enumerated() {
            let score = similarity(target, line.text)
            if score > bestScore {
                bestScore = score
                bestIndex = index
            }
        }
        return bestScore >= 0.3 ? bestIndex : nil
    }
}

// MARK: - 自动扫描的判定阈值（与网页版保持一致）

enum AutoScanRules {
    static let samePageThreshold = 0.72
    static let unchangedThreshold = 0.97
    static let minSharpness = 10.0
    static let stillDistance = 0.012
    static let changeDistance = 0.02
    static let tickSeconds: TimeInterval = 0.9
    static let minSendGap: TimeInterval = 1.6
    static let sampleWidth = 48
    static let sampleHeight = 64
}
