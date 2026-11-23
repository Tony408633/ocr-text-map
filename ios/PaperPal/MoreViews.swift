import SwiftUI
import UIKit
import AVFoundation

// MARK: - 书架

struct LibraryView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var serverSettings: ServerSettings
    @State private var serverBooks: [ServerBook] = []
    @State private var serverMessage = ""

    var body: some View {
        NavigationStack {
            List {
                if store.books.isEmpty {
                    Section {
                        Text("还没有扫描过的书。回首页点「放好书，自动开始读」。")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("本机书架") {
                        ForEach(store.books) { book in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(book.title).font(.headline)
                                Text("\(book.pages.count) 页 · 最近 \(book.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                        .onDelete { offsets in
                            offsets.map { store.books[$0].id }.forEach { store.deleteBook($0) }
                        }
                    }
                }

                if serverSettings.config.enabled {
                    Section("电脑上的书") {
                        if serverBooks.isEmpty {
                            Text(serverMessage.isEmpty ? "正在读取…" : serverMessage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(serverBooks) { book in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(book.title).font(.headline)
                                Text("\(book.pageCount ?? 0) 页 · 已读到第 \(book.lastPage ?? 0) 页")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("书架")
            .task { await loadServerBooks() }
            .refreshable { await loadServerBooks() }
        }
    }

    private func loadServerBooks() async {
        guard serverSettings.config.enabled, serverSettings.config.isConfigured else {
            serverBooks = []
            return
        }
        let client = ServerClient(config: serverSettings.config)
        do {
            let bootstrap = try await client.bootstrap()
            serverBooks = bootstrap.books
            serverMessage = ""
        } catch {
            serverBooks = []
            serverMessage = "电脑连不上：\(error.localizedDescription)"
        }
    }
}

// MARK: - 批注

struct NotesView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var serverSettings: ServerSettings
    @StateObject private var speech = SpeechEngine()
    @State private var serverNotes: [ServerNote] = []
    @State private var serverMessage = ""

    var body: some View {
        NavigationStack {
            List {
                Section("本机批注") {
                    if store.notes.isEmpty {
                        Text("还没有批注。阅读页右上角可以添加。")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.notes) { note in
                        noteRow(title: note.text, meta: "《\(note.bookTitle)》 · \(note.scopeText)") {
                            speech.speak(note.text, rate: 0.5, pitch: 1.0)
                        } onDelete: {
                            store.deleteNote(note.id)
                        }
                    }
                }

                if serverSettings.config.enabled {
                    Section("电脑上的批注") {
                        if serverNotes.isEmpty {
                            Text(serverMessage.isEmpty ? "正在读取…" : serverMessage)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(serverNotes) { note in
                            noteRow(title: note.text, meta: "《\(note.bookTitle ?? "未命名")》 · \(note.scopeText)") {
                                speech.speak(note.text, rate: 0.5, pitch: 1.0)
                            } onDelete: nil
                        }
                    }
                }
            }
            .navigationTitle("我的批注")
            .task { await loadServerNotes() }
            .refreshable { await loadServerNotes() }
        }
    }

    private func noteRow(title: String, meta: String, onPlay: @escaping () -> Void, onDelete: (() -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.body)
            Text(meta).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 16) {
                Button {
                    onPlay()
                } label: {
                    Label("听", systemImage: "speaker.wave.2")
                }
                .buttonStyle(.borderless)
                if let onDelete {
                    Button(role: .destructive) {
                        onDelete()
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                    .buttonStyle(.borderless)
                }
            }
            .font(.caption)
        }
        .padding(.vertical, 2)
    }

    private func loadServerNotes() async {
        guard serverSettings.config.enabled, serverSettings.config.isConfigured else { return }
        let client = ServerClient(config: serverSettings.config)
        do {
            serverNotes = try await client.notes()
            serverMessage = ""
        } catch {
            serverNotes = []
            serverMessage = "电脑连不上：\(error.localizedDescription)"
        }
    }
}

// MARK: - 设置

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var serverSettings: ServerSettings
    @State private var showClearConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section("识别方式") {
                    Toggle("使用电脑识别（Windows）", isOn: $serverSettings.config.enabled)
                    NavigationLink {
                        ServerSetupView()
                    } label: {
                        LabeledContent("电脑地址", value: serverSettings.config.display)
                    }
                    Text(serverSettings.config.enabled
                         ? "识别和批注保存到电脑；连不上时自动切换为本机 Vision 识别。"
                         : "完全在 iPhone 本机识别，不依赖电脑。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("朗读") {
                    VStack(alignment: .leading) {
                        Text("语速 \(String(format: "%.2f", store.settings.rate))")
                            .font(.caption)
                        Slider(value: $store.settings.rate, in: 0.35...0.65, step: 0.01)
                            .accessibilityLabel("朗读语速")
                    }
                    VStack(alignment: .leading) {
                        Text("音高 \(String(format: "%.2f", store.settings.pitch))")
                            .font(.caption)
                        Slider(value: $store.settings.pitch, in: 0.7...1.4, step: 0.05)
                            .accessibilityLabel("朗读音高")
                    }
                    Toggle("每行读完自动下一行", isOn: $store.settings.autoAdvance)
                }

                Section("显示") {
                    VStack(alignment: .leading) {
                        Text("字号 \(Int(store.settings.fontSize * 100))%")
                            .font(.caption)
                        Slider(value: $store.settings.fontSize, in: 0.85...1.6, step: 0.05)
                            .accessibilityLabel("正文字号")
                    }
                }

                Section("数据") {
                    Button("载入演示内容") { store.seedDemoBook() }
                    Button("清空所有本机数据", role: .destructive) { showClearConfirm = true }
                }

                Section("关于") {
                    LabeledContent("版本", value: "1.0 (MVP)")
                    LabeledContent("本机识别", value: "Apple Vision · 离线")
                    LabeledContent("朗读", value: "AVSpeechSynthesizer · 中文")
                    NavigationLink("蓝牙耳机与翻页器") { DevicesView() }
                }
            }
            .navigationTitle("设置")
            .confirmationDialog("确定清空？", isPresented: $showClearConfirm, titleVisibility: .visible) {
                Button("清空所有本机数据", role: .destructive) { store.clearAll() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("书架、页、批注和进度都会被删除。")
            }
        }
    }
}

// MARK: - 蓝牙设备

struct DevicesView: View {
    var body: some View {
        List {
            Section("iPhone 上怎么连耳机 / 翻页器") {
                Text("1. 打开系统「设置 → 蓝牙」，让耳机或翻页器进入配对模式并选中。")
                Text("2. 回到纸伴，进入阅读页。")
                Text("3. 按一下耳机上的播放 / 暂停键：纸伴会暂停或继续朗读。")
                Text("4. 按上一首 / 下一首：上一行 / 下一行。")
            }
            .font(.callout)

            Section("支持的按键") {
                LabeledContent("播放 / 暂停", value: "暂停或继续朗读")
                LabeledContent("上一首", value: "上一行")
                LabeledContent("下一首", value: "下一行")
                LabeledContent("蓝牙键盘 空格", value: "暂停 / 继续")
                LabeledContent("蓝牙键盘 PageUp / PageDown", value: "上一行 / 下一行")
            }

            Section("说明") {
                Text("iPhone 上没有 Web Bluetooth，所以不能在 App 里“搜索设备”。耳机和翻页器都是系统蓝牙设备，配对后在纸伴里按一下按键就能用。")
                    .font(.caption)
                Text("部分耳机的双击 / 长按是由耳机自己处理的，不会传给手机；遇到这种情况请改用播放 / 暂停键或换设备。")
                    .font(.caption)
            }

            Section {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("打开系统设置", systemImage: "gear")
                }
            }
        }
        .navigationTitle("蓝牙设备")
    }
}

// MARK: - 连接电脑

struct ServerSetupView: View {
    @EnvironmentObject private var serverSettings: ServerSettings
    @State private var status = ""
    @State private var testing = false
    @State private var showScanner = false

    var body: some View {
        Form {
            Section("电脑地址") {
                TextField("http://192.168.1.10:8080", text: $serverSettings.config.baseURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("电脑地址")
                TextField("访问令牌（可留空）", text: $serverSettings.config.token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("使用这台电脑识别", isOn: $serverSettings.config.enabled)
                Toggle("接受自签 HTTPS 证书（局域网 8443）", isOn: $serverSettings.config.allowSelfSignedTLS)
            }

            Section {
                Button {
                    showScanner = true
                } label: {
                    Label("扫描电脑上的二维码", systemImage: "qrcode.viewfinder")
                }
                Button {
                    if let text = UIPasteboard.general.string {
                        serverSettings.config.baseURL = text
                    }
                } label: {
                    Label("从剪贴板粘贴", systemImage: "doc.on.clipboard")
                }
                Button {
                    Task { await test() }
                } label: {
                    HStack {
                        Label("测试连接", systemImage: "bolt.horizontal")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(testing)
                if !status.isEmpty {
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(status.hasPrefix("✅") ? Color.green : Color.orange)
                }
            }

            Section("电脑上要做什么") {
                Text("方式 A（同一个 Wi-Fi，最省事）：双击「启动手机测试.bat」，地址填 https://电脑IP:8443，并打开“接受自签证书”。")
                Text("方式 B（任意网络）：双击「启动手机隧道.bat」，把出现的 https://…trycloudflare.com 填进上面的地址。")
                Text("方式 C（原生客户端专用，HTTP）：运行 后端\\start-lan.ps1，地址填 http://电脑IP:8080，不需要证书。")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .navigationTitle("连接电脑")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                showScanner = false
                var text = code
                while text.hasSuffix("/") { text.removeLast() }
                if let range = text.range(of: "/#/") {
                    text = String(text[..<range.lowerBound])
                }
                serverSettings.config.baseURL = text
                serverSettings.config.enabled = true
                serverSettings.config.allowSelfSignedTLS = text.lowercased().hasPrefix("https")
                Task { await test() }
            }
            .ignoresSafeArea()
        }
    }

    private func test() async {
        testing = true
        defer { testing = false }
        guard serverSettings.config.isConfigured else {
            status = "先填电脑地址，例如 http://192.168.1.10:8080"
            return
        }
        let client = ServerClient(config: serverSettings.config)
        do {
            _ = try await client.health()
            let bootstrap = try await client.bootstrap()
            status = "✅ 已连接：\(bootstrap.server?.version ?? "纸伴")，\(bootstrap.books.count) 本书"
            serverSettings.config.enabled = true
        } catch {
            status = "❌ 连不上：\(error.localizedDescription)"
        }
    }
}

// MARK: - 扫二维码

struct QRScannerView: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configure()
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.layer.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !handled,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else { return }
        handled = true
        session.stopRunning()
        onCode?(value)
    }
}
