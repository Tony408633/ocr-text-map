import Foundation
import Combine

/// 服务器地址 / 令牌，存在 UserDefaults，可随时改。
final class ServerSettings: ObservableObject {
    @Published var config: ServerConfig {
        didSet { save() }
    }

    private let key = "paperpal.server.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode(ServerConfig.self, from: data) {
            config = saved
        } else {
            config = ServerConfig()
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(config) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    func update(_ transform: (inout ServerConfig) -> Void) {
        var next = config
        transform(&next)
        config = next
    }
}
