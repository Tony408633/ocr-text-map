import Foundation
import AVFoundation
import Combine

/// 朗读：AVSpeechSynthesizer，中文 Ting-Ting，离线可用。
final class SpeechEngine: NSObject, ObservableObject {
    @Published private(set) var isSpeaking = false
    @Published private(set) var isPaused = false

    private let synthesizer = AVSpeechSynthesizer()
    private var pending = 0
    private var finishHandler: ((Bool) -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
        configureAudioSession()
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .mixWithOthers])
        try? session.setActive(true)
    }

    /// 把长句切成 ~80 字一段，避免 iOS 中途停止
    private static func chunks(of text: String, limit: Int = 80) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        if trimmed.count <= limit { return [trimmed] }
        var result: [String] = []
        var buffer = ""
        for character in trimmed {
            buffer.append(character)
            let isBreak = "。！？；，、.!?;,".contains(character)
            if buffer.count >= limit || (isBreak && buffer.count >= 24) {
                result.append(buffer)
                buffer = ""
            }
        }
        if !buffer.isEmpty { result.append(buffer) }
        return result
    }

    func speak(_ text: String,
               rate: Float,
               pitch: Float,
               onFinish: ((Bool) -> Void)? = nil) {
        stop()
        let parts = Self.chunks(of: text)
        guard !parts.isEmpty else {
            onFinish?(false)
            return
        }
        configureAudioSession()
        finishHandler = onFinish
        pending = parts.count
        isSpeaking = true
        isPaused = false
        for part in parts {
            let utterance = AVSpeechUtterance(string: part)
            utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
            utterance.rate = min(max(rate, 0.35), 0.65)
            utterance.pitchMultiplier = min(max(pitch, 0.5), 2.0)
            utterance.volume = 1.0
            utterance.postUtteranceDelay = 0.02
            synthesizer.speak(utterance)
        }
    }

    func pause() {
        guard synthesizer.isSpeaking else { return }
        if synthesizer.pauseSpeaking(at: .immediate) {
            isPaused = true
        }
    }

    func resume() {
        guard synthesizer.isPaused else { return }
        if synthesizer.continueSpeaking() {
            isPaused = false
        }
    }

    func toggle() {
        if isPaused {
            resume()
        } else if isSpeaking {
            pause()
        }
    }

    func stop() {
        pending = 0
        finishHandler = nil
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
        isPaused = false
    }
}

extension SpeechEngine: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        isSpeaking = true
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
        isPaused = true
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        isPaused = false
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        pending -= 1
        guard pending <= 0 else { return }
        pending = 0
        isSpeaking = false
        isPaused = false
        let handler = finishHandler
        finishHandler = nil
        handler?(true)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        pending = 0
        isSpeaking = false
        isPaused = false
        let handler = finishHandler
        finishHandler = nil
        handler?(false)
    }
}

/// 让 App 在“没在朗读”时也能收到蓝牙耳机的播放/暂停键。
/// 做法：用 AVAudioEngine 循环播放一段静音，保持音频会话活跃。
final class AudioKeepAlive {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var started = false

    func start() {
        guard !started else { return }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100) else { return }
        buffer.frameLength = 44_100
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0
        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            started = true
        } catch {
            started = false
        }
    }

    func stop() {
        guard started else { return }
        player.stop()
        engine.stop()
        engine.detach(player)
        started = false
    }
}
