import Foundation
import UIKit
import Combine

enum ReaderMode: String {
    case local
    case server
}

/// 阅读核心：把“相机 → 识别（服务器优先 / 本机兜底）→ 朗读 → 保存进度”串起来。
final class ReaderModel: ObservableObject {
    @Published var mode: ReaderMode = .local
    @Published var title = "纸伴"
    @Published var pageNumber = 1
    @Published var lineIndex = 0
    @Published var lines: [PageLine] = []
    @Published var status = "准备中"
    @Published var isSpeaking = false
    @Published var autoMode = false
    @Published var busy = false
    @Published var serverMessage = ""
    @Published var lastInput = ""

    let camera = CameraEngine()
    let speech = SpeechEngine()
    let scanner = AutoScanner()
    let remote = RemoteControls()

    private var store: AppStore?
    private var config = ServerConfig()
    private var client: ServerClient?
    private var localBookId: UUID?
    private var serverBookId: String?
    private var autoAdvanceTask: Task<Void, Never>?
    private var lastSpokenStatus = Date.distantPast

    // MARK: - 派生状态

    var currentLine: PageLine? {
        lines.indices.contains(lineIndex) ? lines[lineIndex] : nil
    }

    var progressText: String {
        "第 \(pageNumber) 页 · 第 \(min(lineIndex + 1, max(lines.count, 1)))/\(max(lines.count, 1)) 行"
    }

    var modeText: String {
        switch mode {
        case .server: return "服务器识别（Windows）"
        case .local: return "本机识别（Vision）"
        }
    }

    // MARK: - 生命周期

    func attach(store: AppStore, config: ServerConfig) {
        self.store = store
        self.config = config
        self.client = config.isConfigured ? ServerClient(config: config) : nil
        configureRemote()
    }

    private func configureRemote() {
        remote.onToggle = { [weak self] in self?.togglePlay() }
        remote.onPlay = { [weak self] in self?.togglePlay() }
        remote.onPause = { [weak self] in
            guard let self else { return }
            self.speech.pause()
            self.isSpeaking = false
            self.status = "已暂停"
            self.remote.setPlaying(false)
        }
        remote.onNext = { [weak self] in self?.next() }
        remote.onPrevious = { [weak self] in self?.previous() }
    }

    func start() async {
        configureRemote()
        guard let store else { return }
        busy = true
        defer { busy = false }

        if config.enabled, config.isConfigured, let client {
            do {
                _ = try await client.health()
                let bootstrap = try await client.bootstrap()
                var book = bootstrap.books.first
                if book == nil {
                    book = try await client.createBook(title: "我的书")
                }
                guard let book else { throw ServerError.emptyPage }
                mode = .server
                serverBookId = book.id
                title = book.title
                serverMessage = "已连接电脑 · \(bootstrap.server?.version ?? "纸伴")"
                let progress = bootstrap.progress?.first { $0.bookId == book.id }
                let target = progress?.pageNumber ?? book.lastPage ?? 0
                if target > 0,
                   let page = try? await client.page(bookId: book.id, number: target),
                   !page.pageLines.isEmpty {
                    apply(lines: page.pageLines, number: page.pageNumber,
                          line: progress?.lineIndex ?? 0, announce: false)
                    status = "第 \(page.pageNumber) 页，按朗读继续"
                } else {
                    lines = []
                    status = "把书放好，打开自动扫描"
                }
                remote.updateNowPlaying(title: title, subtitle: "纸伴")
                return
            } catch {
                mode = .local
                serverMessage = "电脑连不上，已切换到本机识别：\(error.localizedDescription)"
            }
        }

        mode = .local
        let book = store.ensureBook()
        localBookId = book.id
        title = book.title
        if let progress = store.progress,
           progress.bookId == book.id,
           let page = store.page(bookId: book.id, number: progress.pageNumber),
           !page.lines.isEmpty {
            apply(lines: page.lines, number: page.pageNumber, line: progress.lineIndex, announce: false)
            status = "第 \(page.pageNumber) 页，按朗读继续"
        } else {
            status = "把书放好，打开自动扫描"
        }
        remote.updateNowPlaying(title: title, subtitle: "纸伴")
    }

    // MARK: - 自动扫描

    func startAuto() async {
        guard !autoMode else { return }
        if !camera.isRunning {
            let ok = await camera.start()
            if !ok {
                status = camera.errorMessage ?? "相机打不开"
                return
            }
        }
        let serverContext: (client: ServerClient, bookId: String)? = {
            guard mode == .server, let client, let bookId = serverBookId else { return nil }
            return (client, bookId)
        }()
        let localContext: (store: AppStore, bookId: UUID)? = {
            guard let store, let bookId = localBookId else { return nil }
            return (store, bookId)
        }()

        scanner.camera = camera
        scanner.perform = { image in
            if let serverContext {
                guard let jpeg = image.jpegData(compressionQuality: 0.82) else {
                    return .failed("照片生成失败")
                }
                do {
                    let response = try await serverContext.client.autoScan(
                        bookId: serverContext.bookId, jpeg: jpeg
                    )
                    guard let page = response.page else {
                        return .skipped("没看清，再稳一点")
                    }
                    return .updated(
                        lines: page.pageLines,
                        pageNumber: page.pageNumber,
                        isNew: response.action == "new",
                        unchanged: response.unchanged ?? false,
                        similarity: response.similarity ?? 0
                    )
                } catch {
                    return .failed(error.localizedDescription)
                }
            }
            guard let localContext else { return .failed("还没有书") }
            guard let cgImage = image.cgImage else { return .failed("照片生成失败") }
            do {
                let recognized = try await OCREngine.recognize(cgImage: cgImage, orientation: .up)
                guard !recognized.isEmpty else { return .skipped("没有看清文字") }
                return await MainActor.run {
                    Self.decideLocally(recognized, store: localContext.store, bookId: localContext.bookId)
                }
            } catch {
                return .failed(error.localizedDescription)
            }
        }
        scanner.onDecision = { [weak self] decision in
            self?.handle(decision)
        }

        autoMode = true
        remote.activate()
        scanner.start()
        status = "自动扫描中：把书放好，翻页会自动读"
        announce("自动扫描已开启。把书放好，翻页后我会接着读。")
    }

    func stopAuto() {
        autoMode = false
        scanner.stop()
        if !isSpeaking {
            camera.stop()
        }
        status = "已停止自动扫描"
    }

    private static func decideLocally(_ recognized: [PageLine],
                                      store: AppStore,
                                      bookId: UUID) -> ScanDecision {
        let text = recognized.map(\.text).joined(separator: "\n")
        let recent = store.recentPageTexts(bookId: bookId)
        var bestNumber = 0
        var bestScore = 0.0
        for item in recent {
            let score = TextMatch.similarity(text, item.text)
            if score > bestScore {
                bestScore = score
                bestNumber = item.number
            }
        }
        if bestNumber > 0, bestScore >= AutoScanRules.samePageThreshold {
            let unchanged = bestScore >= AutoScanRules.unchangedThreshold
            if !unchanged {
                store.upsertPage(bookId: bookId, number: bestNumber, lines: recognized)
            }
            return .updated(lines: recognized, pageNumber: bestNumber,
                            isNew: false, unchanged: unchanged, similarity: bestScore)
        }
        let number = store.nextPageNumber(bookId: bookId)
        store.upsertPage(bookId: bookId, number: number, lines: recognized)
        return .updated(lines: recognized, pageNumber: number,
                        isNew: true, unchanged: false, similarity: bestScore)
    }

    private func handle(_ decision: ScanDecision) {
        switch decision {
        case .skipped(let reason):
            setStatus(reason)
        case .failed(let message):
            setStatus("识别失败：\(message)")
        case .updated(let newLines, let number, let isNew, let unchanged, _):
            if isNew {
                apply(lines: newLines, number: number, line: 0, announce: false)
                speech.stop()
                speakCurrent(announcePage: true)
            } else if !unchanged {
                let keep = currentLine?.text ?? ""
                let previousIndex = lineIndex
                lines = newLines
                pageNumber = number
                if let matched = TextMatch.bestLineIndex(for: keep, in: newLines) {
                    lineIndex = matched
                } else {
                    lineIndex = min(previousIndex, max(newLines.count - 1, 0))
                }
                saveProgress()
                setStatus("第 \(number) 页已更新")
            } else {
                setStatus("第 \(number) 页 · 已看清")
            }
        }
    }

    private func apply(lines newLines: [PageLine], number: Int, line: Int, announce shouldAnnounce: Bool) {
        lines = newLines
        pageNumber = number
        lineIndex = min(max(line, 0), max(newLines.count - 1, 0))
        saveProgress()
        remote.updateNowPlaying(title: title, subtitle: "第 \(number) 页")
    }

    // MARK: - 朗读

    func speakCurrent(announcePage: Bool = false) {
        autoAdvanceTask?.cancel()
        guard let line = currentLine else {
            setStatus("这一页还没有文字")
            return
        }
        let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            next()
            return
        }
        let prefix = announcePage ? "第 \(pageNumber) 页。" : ""
        isSpeaking = true
        remote.setPlaying(true)
        setStatus("正在朗读第 \(lineIndex + 1) 行", speak: false)
        speech.speak(
            prefix + text,
            rate: store?.settings.rate ?? 0.5,
            pitch: store?.settings.pitch ?? 1.0
        ) { [weak self] finished in
            guard let self else { return }
            self.isSpeaking = false
            self.remote.setPlaying(false)
            guard finished else { return }
            self.saveProgress()
            self.advanceIfNeeded()
        }
    }

    private func advanceIfNeeded() {
        guard store?.settings.autoAdvance == true else { return }
        guard lineIndex < lines.count - 1 else {
            setStatus("这一页读完了")
            return
        }
        autoAdvanceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.next() }
        }
    }

    func togglePlay() {
        if speech.isPaused {
            speech.resume()
            isSpeaking = true
            remote.setPlaying(true)
            status = "继续朗读"
        } else if speech.isSpeaking {
            speech.pause()
            isSpeaking = false
            remote.setPlaying(false)
            status = "已暂停"
        } else {
            speakCurrent()
        }
    }

    func next() {
        guard !lines.isEmpty else { return }
        if lineIndex < lines.count - 1 {
            lineIndex += 1
            speakCurrent()
        } else {
            setStatus("已经是这一页最后一行")
        }
    }

    func previous() {
        guard !lines.isEmpty else { return }
        lineIndex = max(0, lineIndex - 1)
        speakCurrent()
    }

    func jump(to index: Int) {
        guard lines.indices.contains(index) else { return }
        lineIndex = index
        speakCurrent()
    }

    // MARK: - 进度 / 批注

    func saveProgress() {
        guard let store else { return }
        if mode == .server, let client, let bookId = serverBookId {
            Task {
                try? await client.saveProgress(bookId: bookId, pageNumber: pageNumber, lineIndex: lineIndex)
            }
        }
        if let bookId = localBookId {
            store.setProgress(bookId: bookId, pageNumber: pageNumber, lineIndex: lineIndex)
        }
    }

    enum NoteScope {
        case line
        case page
    }

    func addNote(_ text: String, scope: NoteScope) async {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if mode == .server, let client, let bookId = serverBookId {
            do {
                try await client.createNote(
                    bookId: bookId,
                    pageNumber: pageNumber,
                    lineIndex: scope == .page ? nil : lineIndex,
                    text: clean
                )
                setStatus("批注已保存到电脑")
                announce("批注已保存")
            } catch {
                setStatus("批注保存失败：\(error.localizedDescription)")
            }
            return
        }
        guard let store, let bookId = localBookId else { return }
        store.addNote(bookId: bookId, pageNumber: pageNumber,
                      lineIndex: scope == .page ? nil : lineIndex, text: clean)
        setStatus("批注已保存")
        announce("批注已保存")
    }

    // MARK: - 停止

    func stopEverything() {
        autoAdvanceTask?.cancel()
        scanner.stop()
        speech.stop()
        camera.stop()
        remote.deactivate()
        autoMode = false
        isSpeaking = false
    }

    // MARK: - 状态提示

    private func setStatus(_ text: String, speak: Bool = false) {
        status = text
        if speak {
            announce(text)
        }
    }

    private func announce(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
        let now = Date()
        guard now.timeIntervalSince(lastSpokenStatus) > 6 else { return }
        lastSpokenStatus = now
        if !speech.isSpeaking {
            speech.speak(text, rate: store?.settings.rate ?? 0.5, pitch: store?.settings.pitch ?? 1.0)
        }
    }
}
