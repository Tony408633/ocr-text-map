import SwiftUI
import WebKit

/// 把现有的网页界面装进 iPhone，服务和页面逻辑一行都不用改。
/// 这就是“界面放在手机上，功能保持原样”的最小实现。
final class WebController: NSObject, ObservableObject {
    let webView: WKWebView

    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var errorMessage: String?
    @Published private(set) var canGoBack = false
    @Published private(set) var currentURL: URL?

    private let allowSelfSigned: Bool
    private var observations: [NSKeyValueObservation] = []
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    /// 注入给网页的原生桥：触感反馈（iOS Safari 不支持 navigator.vibrate）
    private static let bridgeScript = """
    window.paperpalNative = window.paperpalNative || {
      haptic: function () {
        try { window.webkit.messageHandlers.haptic.postMessage("tap"); } catch (e) {}
      }
    };
    """

    init(allowSelfSigned: Bool) {
        self.allowSelfSigned = allowSelfSigned

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.userContentController.addUserScript(
            WKUserScript(source: Self.bridgeScript,
                         injectionTime: .atDocumentStart,
                         forMainFrameOnly: false)
        )

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        configuration.userContentController.add(self, name: "haptic")

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false          // 去掉橡皮筋回弹，更像原生
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground

        haptic.prepare()

        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.progress = view.estimatedProgress }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.isLoading = view.isLoading }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
                DispatchQueue.main.async { self?.canGoBack = view.canGoBack }
            },
        ]
    }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "haptic")
    }

    func load(_ url: URL) {
        errorMessage = nil
        currentURL = url
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadRevalidatingCacheData
        webView.load(request)
    }

    func reload() {
        if webView.url == nil, let currentURL {
            load(currentURL)
        } else {
            errorMessage = nil
            webView.reload()
        }
    }

    func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    func openInSafari() {
        if let url = webView.url ?? currentURL {
            UIApplication.shared.open(url)
        }
    }
}

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        errorMessage = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        currentURL = webView.url
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        errorMessage = friendly(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        errorMessage = friendly(error)
    }

    /// 允许局域网自签证书（勾选“接受自签证书”时）
    func webView(_ webView: WKWebView,
                 didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard allowSelfSigned,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    /// 站外链接交给 Safari
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "http" || scheme == "https" else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func friendly(_ error: Error) -> String {
        switch (error as NSError).code {
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
            return "连不上电脑。确认纸伴服务在运行、手机和电脑在同一网络（或用隧道地址），再点重试。"
        case NSURLErrorNotConnectedToInternet:
            return "手机没有网络。"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted:
            return "证书不被信任。可以打开“接受自签证书”，或改用隧道地址。"
        case NSURLErrorTimedOut:
            return "连接超时。检查电脑防火墙是否放行，或改用公网隧道。"
        default:
            return error.localizedDescription
        }
    }
}

extension WebController: WKScriptMessageHandler {
    /// 网页通过 window.paperpalNative.haptic() 触发原生触感
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "haptic" else { return }
        haptic.impactOccurred()
    }
}

extension WebController: WKUIDelegate {
    /// 网页要用相机 / 麦克风时直接允许（系统仍会弹一次权限）
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    /// target=_blank 的链接在当前页打开，避免弹窗被忽略
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}

struct WebViewContainer: UIViewRepresentable {
    @ObservedObject var controller: WebController

    func makeUIView(context: Context) -> WKWebView {
        controller.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
