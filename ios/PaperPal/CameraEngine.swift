import Foundation
import AVFoundation
import UIKit
import SwiftUI
import Combine

/// 相机：取景 + 手持一帧转成“正向”的 UIImage（供 Vision 或上传服务器）
final class CameraEngine: NSObject, ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var errorMessage: String?

    let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "paperpal.camera")
    private let ciContext = CIContext()
    private var latestBuffer: CVPixelBuffer?

    func start() async -> Bool {
        if session.isRunning { return true }
        let granted = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .video) { continuation.resume(returning: $0) }
        }
        guard granted else {
            await MainActor.run { self.errorMessage = "没有相机权限：设置 → 纸伴 → 相机，允许后再试。" }
            return false
        }
        let configured = await MainActor.run { self.configureIfNeeded() }
        guard configured else { return false }
        session.startRunning()
        await MainActor.run { self.isRunning = true }
        return true
    }

    private func configureIfNeeded() -> Bool {
        if !session.inputs.isEmpty { return true }
        session.beginConfiguration()
        session.sessionPreset = .photo
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else {
            errorMessage = "找不到相机。"
            session.commitConfiguration()
            return false
        }
        if session.canAddInput(input) { session.addInput(input) }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        return true
    }

    func stop() {
        if session.isRunning { session.stopRunning() }
        isRunning = false
        latestBuffer = nil
    }

    /// 取一帧并转成正向图片（竖屏后置相机）
    func captureImage(maxSide: CGFloat = 1600) -> UIImage? {
        guard let buffer = latestBuffer else { return nil }
        let ciImage = CIImage(cvPixelBuffer: buffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return nil }
        let raw = UIImage(cgImage: cgImage, scale: 1, orientation: .right)
        let size = raw.size
        guard size.width > 1, size.height > 1 else { return nil }
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        return renderer.image { _ in
            raw.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    func captureJPEG(quality: CGFloat = 0.82) -> Data? {
        captureImage()?.jpegData(compressionQuality: quality)
    }
}

extension CameraEngine: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestBuffer = buffer
    }
}

/// 把 AVCaptureSession 显示到 SwiftUI
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewContainer {
        let view = PreviewContainer()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewContainer, context: Context) {}

    final class PreviewContainer: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
