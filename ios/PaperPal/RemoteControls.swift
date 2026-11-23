import Foundation
import MediaPlayer
import AVFoundation
import Combine

/// 蓝牙耳机按键：接管“正在播放”，把播放/暂停、上一首/下一首变成纸伴指令。
final class RemoteControls: ObservableObject {
    @Published private(set) var ready = false
    @Published private(set) var lastAction = ""

    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onToggle: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?

    private let keepAlive = AudioKeepAlive()

    func activate() {
        guard !ready else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers, .duckOthers])
        try? session.setActive(true)
        keepAlive.start()

        let center = MPRemoteCommandCenter.shared()
        // 先清掉旧的处理（重复 activate 时避免一次按键触发两次）
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.togglePlayPauseCommand.removeTarget(nil)
        center.nextTrackCommand.removeTarget(nil)
        center.previousTrackCommand.removeTarget(nil)

        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = false

        center.playCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.record("播放"); self?.onPlay?() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.record("暂停"); self?.onPause?() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.record("播放/暂停"); self?.onToggle?() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.record("下一首"); self?.onNext?() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.record("上一首"); self?.onPrevious?() }
            return .success
        }
        ready = true
    }

    func deactivate() {
        keepAlive.stop()
        ready = false
    }

    func updateNowPlaying(title: String, subtitle: String) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: subtitle,
            MPNowPlayingInfoPropertyIsLiveStream: true,
        ]
        info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func setPlaying(_ playing: Bool) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func record(_ action: String) {
        lastAction = action
    }
}
