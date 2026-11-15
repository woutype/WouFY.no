import ExpoModulesCore
import AVFoundation
import MediaPlayer
import UIKit

/// Нативный модуль WouFY.no: плеер с реверберацией, 8D и Slowed / Speed Up на AVAudioEngine,
/// плюс собственные «Now Playing» и кнопки экрана блокировки (на время, пока работают эффекты).
public class WoufyFXModule: Module {
  private var players: [String: FXPlayer] = [:]
  private let haptics = HapticsEngine()
  private var remoteTokens: [(MPRemoteCommand, Any)] = []
  private var interruptionObserver: NSObjectProtocol?
  private var directoryWatcher: DirectoryWatcher?

  public func definition() -> ModuleDefinition {
    Name("WoufyFX")

    Events("onEnded", "onSamples", "onRemote", "onLibraryChanged")

    Function("isAvailable") { () -> Bool in
      return true
    }

    Function("create") { (id: String) -> Void in
      if self.players[id] != nil { return }
      let p = FXPlayer(id: id)
      p.onEnded = { [weak self] in
        self?.sendEvent("onEnded", ["id": id])
      }
      p.onSamples = { [weak self] frames in
        self?.sendEvent("onSamples", ["id": id, "frames": frames])
      }
      self.players[id] = p
    }

    Function("destroy") { (id: String) -> Void in
      if let p = self.players[id] {
        p.destroy()
        self.players.removeValue(forKey: id)
      }
    }

    AsyncFunction("load") { (id: String, uri: String) throws -> Double in
      guard let p = self.players[id] else { return 0 }
      let url: URL
      if uri.hasPrefix("file://") {
        guard let u = URL(string: uri) else { return 0 }
        url = u
      } else {
        url = URL(fileURLWithPath: uri)
      }
      return try p.load(url: url)
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("play") { (id: String) -> Void in
      self.players[id]?.play()
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("pause") { (id: String) -> Void in
      self.players[id]?.pause()
    }.runOnQueue(DispatchQueue.main)

    AsyncFunction("seek") { (id: String, seconds: Double) -> Void in
      self.players[id]?.seek(to: seconds)
    }.runOnQueue(DispatchQueue.main)

    Function("getTime") { (id: String) -> Double in
      return self.players[id]?.currentTime() ?? 0
    }

    Function("getDuration") { (id: String) -> Double in
      return self.players[id]?.getDuration() ?? 0
    }

    Function("isPlaying") { (id: String) -> Bool in
      return self.players[id]?.isPlaying() ?? false
    }

    Function("isLoaded") { (id: String) -> Bool in
      return self.players[id]?.isLoaded() ?? false
    }

    Function("setVolume") { (id: String, v: Double) -> Void in
      self.players[id]?.setVolume(Float(v))
    }

    Function("setRate") { (id: String, r: Double) -> Void in
      self.players[id]?.setRate(r)
    }

    Function("setPitchCents") { (id: String, c: Double) -> Void in
      self.players[id]?.setPitchCents(c)
    }

    Function("setReverb") { (id: String, amount: Double) -> Void in
      self.players[id]?.setReverb(amount)
    }

    Function("setSpatial") { (id: String, on: Bool) -> Void in
      self.players[id]?.setSpatial(on)
    }

    Function("setTempoProcessing") { (id: String, on: Bool) -> Void in
      self.players[id]?.setTempoProcessing(on)
    }

    Function("setSampling") { (id: String, on: Bool) -> Void in
      self.players[id]?.setSampling(on)
    }

    // ── Офлайн-анализ огибающей для BPM (без воспроизведения) ──

    AsyncFunction("analyzeWindow") { (uri: String, start: Double, len: Double) throws -> [String: Any] in
      let url: URL
      if uri.hasPrefix("file://") {
        guard let u = URL(string: uri) else { throw Analyzer.Failure() }
        url = u
      } else {
        url = URL(fileURLWithPath: uri)
      }
      return try Analyzer.window(url: url, start: start, len: len)
    }

    // ── Распознавание вокала (для подгона текста без таймингов) ──

    AsyncFunction("recognizeSpeech") { (uri: String, locale: String, promise: Promise) -> Void in
      let url: URL
      if uri.hasPrefix("file://") {
        guard let u = URL(string: uri) else {
          promise.reject("E_URI", "bad uri")
          return
        }
        url = u
      } else {
        url = URL(fileURLWithPath: uri)
      }
      SpeechAligner.recognize(url: url, localeId: locale) { result in
        switch result {
        case .success(let words):
          promise.resolve(words)
        case .failure(let error):
          let msg = (error as? SpeechAligner.Failure)?.message ?? error.localizedDescription
          promise.reject("E_SPEECH", msg)
        }
      }
    }

    // ── Core Haptics ──

    Function("hapticsSupported") { () -> Bool in
      return HapticsEngine.supported
    }

    Function("hapticsStart") { () -> Void in
      DispatchQueue.main.async { self.haptics.start() }
    }

    Function("hapticsStop") { () -> Void in
      DispatchQueue.main.async { self.haptics.stop() }
    }

    Function("hapticTransient") { (intensity: Double, sharpness: Double) -> Void in
      self.haptics.transient(intensity: Float(intensity), sharpness: Float(sharpness))
    }

    Function("hapticThump") { (intensity: Double) -> Void in
      self.haptics.thump(intensity: Float(intensity))
    }

    Function("hapticChannel") { (channel: Int, level: Double, sharpness: Double) -> Void in
      self.haptics.setChannel(channel, level: Float(level), sharpness: Float(sharpness))
    }

    // ── Сессия, «Now Playing» и кнопки экрана блокировки ──

    AsyncFunction("activateSession") { () -> Void in
      let s = AVAudioSession.sharedInstance()
      try? s.setCategory(.playback, mode: .default, options: [])
      try? s.setActive(true)
    }.runOnQueue(DispatchQueue.main)

    Function("setNowPlaying") { (title: String, artist: String, album: String, artworkPath: String?, duration: Double) -> Void in
      var info: [String: Any] = [
        MPMediaItemPropertyTitle: title,
        MPMediaItemPropertyArtist: artist,
        MPMediaItemPropertyAlbumTitle: album,
        MPMediaItemPropertyPlaybackDuration: duration,
        MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
        MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        MPNowPlayingInfoPropertyIsLiveStream: false,
      ]
      if let path = artworkPath {
        let clean = path.hasPrefix("file://") ? String(path.dropFirst(7)) : path
        let decoded = clean.removingPercentEncoding ?? clean
        if let img = UIImage(contentsOfFile: decoded) {
          info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
      }
      DispatchQueue.main.async {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
      }
    }

    Function("updateNowPlaying") { (position: Double, rate: Double) -> Void in
      DispatchQueue.main.async {
        let center = MPNowPlayingInfoCenter.default()
        guard var info = center.nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        center.nowPlayingInfo = info
      }
    }

    Function("clearNowPlaying") { () -> Void in
      DispatchQueue.main.async {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      }
    }

    Function("enableRemote") { (on: Bool) -> Void in
      DispatchQueue.main.async {
        if on { self.installRemote() } else { self.removeRemote() }
      }
    }

    // ── Нативное сканирование и извлечение метаданных (архитектура Spotify) ──

    AsyncFunction("nativeScanDirectory") { (directoryUri: String) -> [[String: Any]] in
      let url: URL
      if directoryUri.hasPrefix("file://") {
        guard let u = URL(string: directoryUri) else { return [] }
        url = u
      } else {
        url = URL(fileURLWithPath: directoryUri)
      }
      return MetadataScanner.scanDirectory(rootURL: url)
    }

    AsyncFunction("nativeExtractMetadata") { (items: [[String: Any]], coversDirUri: String) -> [[String: Any]] in
      let coversURL: URL
      if coversDirUri.hasPrefix("file://") {
        guard let u = URL(string: coversDirUri) else { return [] }
        coversURL = u
      } else {
        coversURL = URL(fileURLWithPath: coversDirUri)
      }
      return MetadataScanner.extractBatch(items: items, coversDirURL: coversURL)
    }

    Function("startDirectoryWatcher") { (directoryUri: String) -> Void in
      let url: URL
      if directoryUri.hasPrefix("file://") {
        guard let u = URL(string: directoryUri) else { return }
        url = u
      } else {
        url = URL(fileURLWithPath: directoryUri)
      }
      self.directoryWatcher?.stop()
      let watcher = DirectoryWatcher(url: url)
      watcher.onChange = { [weak self] in
        self?.sendEvent("onLibraryChanged", [:])
      }
      watcher.start()
      self.directoryWatcher = watcher
    }

    Function("stopDirectoryWatcher") { () -> Void in
      self.directoryWatcher?.stop()
      self.directoryWatcher = nil
    }

    OnDestroy { () -> Void in
      self.directoryWatcher?.stop()
      self.directoryWatcher = nil
      self.haptics.stop()
      self.removeRemote()
      for (_, p) in self.players { p.destroy() }
      self.players.removeAll()
    }
  }

  private func installRemote() {
    if !remoteTokens.isEmpty { return }
    let c = MPRemoteCommandCenter.shared()

    // Disable 10s/15s skip interval commands so iOS Lock Screen and Control Center show Next/Previous track buttons
    c.skipForwardCommand.removeTarget(nil)
    c.skipForwardCommand.preferredIntervals = []
    c.skipForwardCommand.isEnabled = false

    c.skipBackwardCommand.removeTarget(nil)
    c.skipBackwardCommand.preferredIntervals = []
    c.skipBackwardCommand.isEnabled = false

    c.seekForwardCommand.removeTarget(nil)
    c.seekForwardCommand.isEnabled = false

    c.seekBackwardCommand.removeTarget(nil)
    c.seekBackwardCommand.isEnabled = false

    func add(_ cmd: MPRemoteCommand, _ name: String) {
      cmd.removeTarget(nil)
      cmd.isEnabled = true
      let token = cmd.addTarget { [weak self] _ in
        self?.sendEvent("onRemote", ["command": name])
        return .success
      }
      remoteTokens.append((cmd, token))
    }
    add(c.playCommand, "play")
    add(c.pauseCommand, "pause")
    add(c.togglePlayPauseCommand, "toggle")
    add(c.nextTrackCommand, "next")
    add(c.previousTrackCommand, "previous")

    c.changePlaybackPositionCommand.isEnabled = true
    let seekToken = c.changePlaybackPositionCommand.addTarget { [weak self] event in
      if let e = event as? MPChangePlaybackPositionCommandEvent {
        self?.sendEvent("onRemote", ["command": "seek", "position": e.positionTime])
        return .success
      }
      return .commandFailed
    }
    remoteTokens.append((c.changePlaybackPositionCommand, seekToken))

    UIApplication.shared.beginReceivingRemoteControlEvents()

    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        let type = AVAudioSession.InterruptionType(rawValue: raw)
      else { return }
      if type == .began {
        self?.sendEvent("onRemote", ["command": "pause"])
      } else if type == .ended {
        let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        if AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
          self?.sendEvent("onRemote", ["command": "play"])
        }
      }
    }
  }

  private func removeRemote() {
    for (cmd, token) in remoteTokens { cmd.removeTarget(token) }
    remoteTokens.removeAll()
    if let o = interruptionObserver {
      NotificationCenter.default.removeObserver(o)
      interruptionObserver = nil
    }
  }
}
