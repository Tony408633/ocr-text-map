import SwiftUI

/// 全屏显示网页：没有地址栏、没有标签页，看起来就是一个 App。
struct WebShellView: View {
    @EnvironmentObject private var settings: WebSettings
    @StateObject private var controller: WebController
    @State private var showSetup = false

    init(allowSelfSigned: Bool) {
        _controller = StateObject(wrappedValue: WebController(allowSelfSigned: allowSelfSigned))
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                WebViewContainer(controller: controller)
                    .ignoresSafeArea(edges: .bottom)

                if controller.isLoading {
                    ProgressView(value: controller.progress)
                        .progressViewStyle(.linear)
                        .frame(height: 2)
                }

                if let message = controller.errorMessage {
                    errorCard(message)
                        .padding(20)
                        .transition(.opacity)
                }
            }

            toolbar
        }
        .background(Color(.systemBackground))
        .task(id: settings.baseURL) {
            if let url = settings.url {
                controller.load(url)
            }
        }
        .sheet(isPresented: $showSetup) {
            SetupView(firstRun: false)
                .environmentObject(settings)
        }
    }

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("打不开这个页面", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("重试") { controller.reload() }
                    .buttonStyle(.borderedProminent)
                Button("换个地址") { showSetup = true }
                    .buttonStyle(.bordered)
                Button("用 Safari 打开") { controller.openInSafari() }
                    .buttonStyle(.borderless)
                    .font(.footnote)
            }
        }
        .padding(16)
        .frame(maxWidth: 420)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 12, y: 4)
        .accessibilityElement(children: .contain)
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            toolButton("返回", icon: "chevron.left", enabled: controller.canGoBack) {
                controller.goBack()
            }
            toolButton("刷新", icon: "arrow.clockwise", enabled: true) {
                controller.reload()
            }
            toolButton("换地址", icon: "link", enabled: true) {
                showSetup = true
            }
            toolButton("用 Safari", icon: "safari", enabled: true) {
                controller.openInSafari()
            }
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
        .background(.bar)
    }

    private func toolButton(_ title: String, icon: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 18, weight: .medium))
                Text(title).font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .foregroundStyle(enabled ? Color.accentColor : Color.secondary.opacity(0.5))
        .accessibilityLabel(title)
    }
}
