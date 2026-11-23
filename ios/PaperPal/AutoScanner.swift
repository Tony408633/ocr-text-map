import Foundation
import UIKit
import Combine

enum ScanDecision {
    case skipped(String)
    case updated(lines: [PageLine], pageNumber: Int, isNew: Bool, unchanged: Bool, similarity: Double)
    case failed(String)
}

/// 连续自动扫描的“节奏控制”：只负责判断什么时候该拍一帧，识别交给外面（服务器或 Vision）。
final class AutoScanner: ObservableObject {
    @Published private(set) var running = false

    var camera: CameraEngine?
    /// 真正执行识别（由 ReaderModel 按“服务器优先 / 本机识别”注入）
    var perform: ((UIImage) async -> ScanDecision)?
    /// 结果回到主线程
    var onDecision: ((ScanDecision) -> Void)?

    private var timer: Timer?
    private var busy = false
    private var lastGray: [UInt8]?
    private var lastSent = Date.distantPast

    func start() {
        guard !running else { return }
        running = true
        busy = false
        lastGray = nil
        lastSent = .distantPast
        let timer = Timer(timeInterval: AutoScanRules.tickSeconds, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick()
    }

    func stop() {
        running = false
        timer?.invalidate()
        timer = nil
        busy = false
    }

    private func tick() {
        guard running, !busy, let camera, let perform else { return }
        guard let image = camera.captureImage(maxSide: 1400) else { return }
        guard let analysis = analyze(image) else { return }

        let now = Date()
        let sinceSent = now.timeIntervalSince(lastSent)
        let isFirst = lastSent == .distantPast
        let moved = distance(lastGray, analysis.gray)

        if !isFirst && analysis.sharpness < AutoScanRules.minSharpness {
            deliver(.skipped("画面有点糊"))
            return
        }
        if !isFirst && moved < AutoScanRules.stillDistance && sinceSent < 6 {
            return
        }
        if !isFirst && moved < AutoScanRules.changeDistance && sinceSent < AutoScanRules.minSendGap {
            return
        }
        guard sinceSent >= AutoScanRules.minSendGap else { return }

        busy = true
        lastSent = now
        lastGray = analysis.gray

        Task { [weak self] in
            let decision = await perform(image)
            guard let self else { return }
            self.busy = false
            self.deliver(decision)
        }
    }

    private func deliver(_ decision: ScanDecision) {
        DispatchQueue.main.async { [weak self] in
            self?.onDecision?(decision)
        }
    }

    // MARK: - 画面分析

    private func analyze(_ image: UIImage) -> (gray: [UInt8], sharpness: Double)? {
        guard let cgImage = image.cgImage else { return nil }
        let width = AutoScanRules.sampleWidth
        let height = AutoScanRules.sampleHeight
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(
                data: raw.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .low
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }

        var gray = [UInt8](repeating: 0, count: width * height)
        for index in 0..<(width * height) {
            let r = Double(pixels[index * 4])
            let g = Double(pixels[index * 4 + 1])
            let b = Double(pixels[index * 4 + 2])
            gray[index] = UInt8(max(0, min(255, 0.299 * r + 0.587 * g + 0.114 * b)))
        }
        return (gray, sharpness(gray, width: width, height: height))
    }

    private func sharpness(_ gray: [UInt8], width: Int, height: Int) -> Double {
        guard width > 2, height > 2 else { return 0 }
        var sum = 0.0
        var square = 0.0
        var count = 0
        for y in 1..<(height - 1) {
            for x in 1..<(width - 1) {
                let index = y * width + x
                let value = -4 * Double(gray[index])
                    + Double(gray[index - 1])
                    + Double(gray[index + 1])
                    + Double(gray[index - width])
                    + Double(gray[index + width])
                sum += value
                square += value * value
                count += 1
            }
        }
        guard count > 0 else { return 0 }
        let mean = sum / Double(count)
        return square / Double(count) - mean * mean
    }

    private func distance(_ left: [UInt8]?, _ right: [UInt8]) -> Double {
        guard let left, left.count == right.count else { return 1 }
        var total = 0.0
        for index in 0..<left.count {
            total += abs(Double(left[index]) - Double(right[index]))
        }
        return total / Double(left.count) / 255
    }
}
