import Foundation
import Vision
import CoreGraphics

/// 用 Apple Vision 在**本机**识别中文，离线、免费、不需要服务器。
enum OCREngine {

    static func recognize(cgImage: CGImage,
                          orientation: CGImagePropertyOrientation = .right) async throws -> [PageLine] {
        try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            func finish(_ result: Result<[PageLine], Error>) {
                guard !resumed else { return }
                resumed = true
                switch result {
                case .success(let lines): continuation.resume(returning: lines)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }

            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    finish(.failure(error))
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                var lines: [PageLine] = []
                for observation in observations {
                    guard let candidate = observation.topCandidates(1).first else { continue }
                    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    let box = observation.boundingBox
                    lines.append(
                        PageLine(
                            text: text,
                            confidence: Double(candidate.confidence),
                            x: Double(box.minX),
                            y: Double(1 - box.maxY),
                            width: Double(box.width),
                            height: Double(box.height)
                        )
                    )
                }
                // 按阅读顺序排序：先上后下，同一行从左到右
                lines.sort { left, right in
                    if abs(left.y - right.y) < 0.02 { return left.x < right.x }
                    return left.y < right.y
                }
                finish(.success(lines))
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    finish(.failure(error))
                }
            }
        }
    }
}

enum OCRError: LocalizedError {
    case noText

    var errorDescription: String? {
        switch self {
        case .noText: return "没有看清文字，调整一下角度或光线。"
        }
    }
}
