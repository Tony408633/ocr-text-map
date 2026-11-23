import SwiftUI

@main
struct PaperPalApp: App {
    @StateObject private var store = AppStore()
    @StateObject private var serverSettings = ServerSettings()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(serverSettings)
                .tint(Color(red: 0.06, green: 0.42, blue: 0.35))
        }
    }
}
