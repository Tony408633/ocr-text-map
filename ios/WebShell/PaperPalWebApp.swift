import SwiftUI

/// 保存“页面地址”，下次打开直接进入 App，不用再输网址。
final class WebSettings: ObservableObject {
    @Published var baseURL: String {
        didSet { save() }
    }
    @Published var allowSelfSigned: Bool {
        didSet { save() }
    }

    private let key = "paperpal.webshell.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode(Snapshot.self, from: data) {
            baseURL = saved.baseURL
            allowSelfSigned = saved.allowSelfSigned
        } else {
            baseURL = ""
            allowSelfSigned = false
        }
    }

    var url: URL? {
        var text = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        return URL(string: text)
    }

    var isReady: Bool { url != nil }

    func save() {
        let snapshot = Snapshot(baseURL: baseURL, allowSelfSigned: allowSelfSigned)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    private struct Snapshot: Codable {
        var baseURL: String
        var allowSelfSigned: Bool
    }
}

@main
struct PaperPalWebApp: App {
    @StateObject private var settings = WebSettings()

    var body: some Scene {
        WindowGroup {
            WebRootView()
                .environmentObject(settings)
                .tint(Color(red: 0.06, green: 0.42, blue: 0.35))
        }
    }
}

struct WebRootView: View {
    @EnvironmentObject private var settings: WebSettings
    @State private var showSetup = false

    var body: some View {
        Group {
            if settings.isReady {
                WebShellView(allowSelfSigned: settings.allowSelfSigned)
                    .id(settings.allowSelfSigned)   // 切换证书选项时重建
            } else {
                SetupView(firstRun: true)
            }
        }
    }
}
