import Foundation
import Combine

/// 全部数据保存在本机 JSON 文件里，跟着 App 走，不联网、不注册。
final class AppStore: ObservableObject {
    @Published private(set) var books: [Book] = []
    @Published private(set) var notes: [PaperNote] = []
    @Published var progress: ReadingProgress?
    @Published var settings = AppSettings() {
        didSet { save() }
    }

    private struct Snapshot: Codable {
        var books: [Book]
        var notes: [PaperNote]
        var progress: ReadingProgress?
        var settings: AppSettings
    }

    private let fileURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("paperpal.json")
    }()

    init() {
        load()
    }

    // MARK: - 读写

    func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        guard let snapshot = try? decoder.decode(Snapshot.self, from: data) else { return }
        books = snapshot.books
        notes = snapshot.notes
        progress = snapshot.progress
        settings = snapshot.settings
    }

    func save() {
        let snapshot = Snapshot(books: books, notes: notes, progress: progress, settings: settings)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - 书

    func book(_ id: UUID) -> Book? {
        books.first { $0.id == id }
    }

    @discardableResult
    func ensureBook() -> Book {
        if let first = books.first { return first }
        let book = Book(title: "我的书")
        books.insert(book, at: 0)
        save()
        return book
    }

    @discardableResult
    func createBook(title: String, author: String = "") -> Book {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let book = Book(title: clean.isEmpty ? "我的书" : clean, author: author)
        books.insert(book, at: 0)
        save()
        return book
    }

    func deleteBook(_ id: UUID) {
        books.removeAll { $0.id == id }
        notes.removeAll { $0.bookId == id }
        if progress?.bookId == id { progress = nil }
        save()
    }

    // MARK: - 页

    /// 同一页就就地更新（保留页码与批注），否则追加
    @discardableResult
    func upsertPage(bookId: UUID, number: Int, lines: [PageLine]) -> BookPage? {
        guard let bookIndex = books.firstIndex(where: { $0.id == bookId }) else { return nil }
        var book = books[bookIndex]
        let page: BookPage
        if let pageIndex = book.pages.firstIndex(where: { $0.number == number }) {
            book.pages[pageIndex].lines = lines
            page = book.pages[pageIndex]
        } else {
            let created = BookPage(number: number, lines: lines)
            book.pages.append(created)
            page = created
        }
        book.pages.sort { $0.number < $1.number }
        book.updatedAt = Date()
        books[bookIndex] = book
        save()
        return page
    }

    func page(bookId: UUID, number: Int) -> BookPage? {
        book(bookId)?.page(number)
    }

    func nextPageNumber(bookId: UUID) -> Int {
        (book(bookId)?.lastPageNumber ?? 0) + 1
    }

    /// 最近的几页文字，用来判断是不是同一页
    func recentPageTexts(bookId: UUID, limit: Int = 8) -> [(number: Int, text: String)] {
        guard let book = book(bookId) else { return [] }
        return book.sortedPages.suffix(limit).map { ($0.number, $0.text) }
    }

    // MARK: - 批注

    func addNote(bookId: UUID, pageNumber: Int, lineIndex: Int?, text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let title = book(bookId)?.title ?? "未命名"
        notes.insert(
            PaperNote(bookId: bookId, bookTitle: title, pageNumber: pageNumber,
                      lineIndex: lineIndex, text: clean),
            at: 0
        )
        save()
    }

    func deleteNote(_ id: UUID) {
        notes.removeAll { $0.id == id }
        save()
    }

    func notes(bookId: UUID) -> [PaperNote] {
        notes.filter { $0.bookId == bookId }
    }

    // MARK: - 进度

    func setProgress(bookId: UUID, pageNumber: Int, lineIndex: Int) {
        progress = ReadingProgress(bookId: bookId, pageNumber: pageNumber, lineIndex: lineIndex)
        save()
    }

    func clearAll() {
        books = []
        notes = []
        progress = nil
        save()
    }

    // MARK: - 演示内容（汇报兜底）

    @discardableResult
    func seedDemoBook() -> Book {
        let lines = [
            "读书使人充实，讨论使人机智，笔记使人准确。",
            "读史使人明智，读诗使人灵秀，数学使人周密。",
            "科学使人深刻，伦理使人庄重，逻辑修辞使人善辩。",
            "凡有所学，皆成性格。",
        ].map { PageLine(text: $0, confidence: 0.99) }

        let existing = books.first { $0.title == "示例书籍 · 论读书" }
        if var demo = existing, let index = books.firstIndex(where: { $0.id == demo.id }) {
            demo.pages = [BookPage(number: 1, lines: lines)]
            demo.updatedAt = Date()
            books[index] = demo
            save()
            return demo
        }
        var book = Book(title: "示例书籍 · 论读书", author: "培根")
        book.pages = [BookPage(number: 1, lines: lines)]
        books.insert(book, at: 0)
        save()
        return book
    }
}
