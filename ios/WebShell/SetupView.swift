import SwiftUI
import AVFoundation

/// 第一次打开 / 换地址时的设置页：填地址、扫码、选择演示或连电脑。
struct SetupView: View {
    var firstRun: Bool

    @EnvironmentObject private var settings: WebSettings
    @Environment(\.dismiss) private var dismiss

    @State private var draft: String = ""
    @State private var allowTLS: Bool = false
    @State private var showScanner = false
    @State private var status: String = ""

    private let demoURL = "https://tony408633.github.io/ocr-text-map/"

    var body: some View {
        NavigationStack {
            Form {
                if firstRun {
                    Section {
                        Text("纸伴的界面和功能都在网页里，服务跑在你自己的电脑上。这里填上地址，就能像 App 一样打开。")
                            .font(.callout)
                    }
                }

                Section("页面地址") {
                    TextField("https://xxx.trycloudflare.com", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("页面地址")

                    Button {
                        showScanner = true
                    } label: {
                        Label("扫描电脑上的二维码", systemImage: "qrcode.viewfinder")
                    }

                    if let paste = UIPasteboard.general.string, paste.lowercased().hasPrefix("http") {
                        Button {
                            draft = paste
                        } label: {
                            Label("从剪贴板粘贴", systemImage: "doc.on.clipboard")
                        }
                    }
                }

                Section("快速选择") {
                    Button {
                        draft = demoURL
                        allowTLS = true
                        status = "这是界面演示：能看界面，但没有电脑服务，不能识别书页。"
                    } label: {
                        Label("演示界面（GitHub Pages）", systemImage: "play.rectangle")
                    }

                    Button {
                        draft = "http://192.168.1.10:8090"
                        allowTLS = false
                        status = "把 IP 换成电脑的局域网地址；先在电脑运行 后端\\start-lan.ps1 -Port 8090。"
                    } label: {
                        Label("同一 Wi-Fi（局域网 HTTP）", systemImage: "wifi")
                    }
                }

                Section("证书") {
                    Toggle("接受自签 HTTPS 证书", isOn: $allowTLS)
                    Text("用 启动手机测试.bat（8443）时打开它；用隧道地址或局域网 HTTP 时不需要。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !status.isEmpty {
                    Section {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("电脑上对应的启动方式") {
                    Text("• 任意网络：双击 启动手机隧道.bat，把打印出的 https 地址填上面")
                    Text("• 同一 Wi-Fi：双击 启动手机测试.bat，填 https://电脑IP:8443 并打开自签证书")
                    Text("• 原生客户端专用：后端\\start-lan.ps1 -Port 8090，填 http://电脑IP:8090")
                }
                .font(.caption)
            }
            .navigationTitle(firstRun ? "连接纸伴" : "页面地址")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !firstRun {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("打开") {
                        settings.baseURL = normalized(draft)
                        settings.allowSelfSigned = allowTLS
                        if !firstRun { dismiss() }
                    }
                    .disabled(normalized(draft).isEmpty)
                }
            }
            .onAppear {
                draft = settings.baseURL
                allowTLS = settings.allowSelfSigned
            }
            .sheet(isPresented: $showScanner) {
                QRScanSheet { code in
                    showScanner = false
                    let cleaned = normalized(code)
                    draft = cleaned
                    allowTLS = cleaned.lowercased().hasPrefix("https")
                    status = "已从二维码填入地址。"
                }
                .ignoresSafeArea()
            }
        }
    }

    private func normalized(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }
        if let range = text.range(of: "/#/") {
            text = String(text[..<range.lowerBound])
        }
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }
}

/// 扫二维码（电脑「用手机打开」页上的那个）
struct QRScanSheet: UIViewControllerRepresentable {
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
