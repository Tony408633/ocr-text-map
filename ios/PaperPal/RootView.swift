import SwiftUI

struct RootView: View {
    @State private var showReader = false
    @State private var readerAutoStart = true

    var body: some View {
        TabView {
            HomeView(showReader: $showReader, readerAutoStart: $readerAutoStart)
                .tabItem { Label("首页", systemImage: "house") }
            LibraryView()
                .tabItem { Label("书架", systemImage: "books.vertical") }
            NotesView()
                .tabItem { Label("批注", systemImage: "text.bubble") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
        }
        .fullScreenCover(isPresented: $showReader) {
            LiveReaderView(autoStart: readerAutoStart)
        }
    }
}

// MARK: - 首页

struct HomeView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var serverSettings: ServerSettings
    @Binding var showReader: Bool
    @Binding var readerAutoStart: Bool

    @State private var serverState = "未连接电脑"
    @State private var checking = false

    private var progressBook: Book? {
        guard let progress = store.progress else { return nil }
        return store.book(progress.bookId)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    modeChip
                    primaryActions
                    if let book = progressBook, let progress = store.progress {
                        resumeCard(book: book, progress: progress)
                    }
                    quickLinks
                    fineprint
                }
                .padding(20)
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .task { await checkServer() }
            .refreshable { await checkServer() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("纸伴 PaperPal")
                .font(.largeTitle.bold())
            Text("陪你读纸书：看、读、记，都在本机或你自己的电脑上。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var modeChip: some View {
        HStack(spacing: 8) {
            Image(systemName: serverSettings.config.enabled ? "desktopcomputer" : "iphone")
            Text(serverSettings.config.enabled ? "识别：电脑（\(serverState)）" : "识别：iPhone 本机")
                .font(.footnote)
            Spacer()
            if checking {
                ProgressView().controlSize(.small)
            } else {
                Button("刷新") { Task { await checkServer() } }
                    .font(.footnote)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(serverSettings.config.enabled ? "识别使用电脑，状态：\(serverState)" : "识别使用 iPhone 本机")
    }

    private var primaryActions: some View {
        VStack(spacing: 12) {
            Button {
                readerAutoStart = true
                showReader = true
            } label: {
                Label("放好书，自动开始读", systemImage: "book.pages")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity, minHeight: 64)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint("打开相机并连续识别，翻页后会自动接着读")

            Button {
                readerAutoStart = false
                showReader = true
            } label: {
                Label("打开阅读页（不自动扫描）", systemImage: "text.book.closed")
                    .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(.bordered)

            Button {
                store.seedDemoBook()
            } label: {
                Label("载入演示内容（面试/答辩兜底）", systemImage: "sparkles")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .font(.footnote)
        }
    }

    private func resumeCard(book: Book, progress: ReadingProgress) -> some View {
        Button {
            readerAutoStart = false
            showReader = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("继续上次阅读").font(.caption).foregroundStyle(.secondary)
                    Text(book.title).font(.headline)
                    Text("第 \(progress.pageNumber) 页 · 第 \(progress.lineIndex + 1) 行")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
    }

    private var quickLinks: some View {
        VStack(spacing: 0) {
            NavigationLink {
                DevicesView()
            } label: {
                row(icon: "headphones", title: "蓝牙耳机 / 翻页器", subtitle: "系统配对后按键就能用")
            }
            Divider()
            NavigationLink {
                ServerSetupView()
            } label: {
                row(icon: "desktopcomputer", title: "连接电脑服务", subtitle: serverSettings.config.enabled ? serverSettings.config.display : "用 Windows 做识别服务器")
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .buttonStyle(.plain)
    }

    private func row(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(14)
        .contentShape(Rectangle())
    }

    private var fineprint: some View {
        Text("相机画面只在本机处理；开启电脑服务时，照片会发到你自己电脑上的纸伴服务，不经过任何第三方。")
            .font(.caption2)
            .foregroundStyle(.secondary)
    }

    private func checkServer() async {
        guard serverSettings.config.enabled, serverSettings.config.isConfigured else {
            serverState = "未启用"
            return
        }
        checking = true
        defer { checking = false }
        let client = ServerClient(config: serverSettings.config)
        do {
            _ = try await client.health()
            let bootstrap = try await client.bootstrap()
            serverState = "已连接 · \(bootstrap.server?.version ?? "纸伴")"
        } catch {
            serverState = "连不上"
        }
    }
}
