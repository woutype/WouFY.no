import CoreHaptics
import Foundation

/// Core Haptics: настоящие вибрации Taptic Engine (удары, «толчки» и непрерывный гул баса), а не только лёгкие щелчки.
final class HapticsEngine {
  private let lock = NSLock()
  private var engine: CHHapticEngine?
  private var channels: [Int: CHHapticAdvancedPatternPlayer] = [:]
  private var started = false

  static var supported: Bool {
    return CHHapticEngine.capabilitiesForHardware().supportsHaptics
  }

  func start() {
    guard HapticsEngine.supported else { return }
    lock.lock()
    if started {
      lock.unlock()
      return
    }
    do {
      let e = try CHHapticEngine()
      e.playsHapticsOnly = true
      e.isAutoShutdownEnabled = false
      e.stoppedHandler = { [weak self] _ in
        guard let self = self else { return }
        self.lock.lock()
        self.started = false
        self.channels.removeAll()
        self.lock.unlock()
      }
      e.resetHandler = { [weak self] in
        guard let self = self else { return }
        self.lock.lock()
        self.channels.removeAll()
        do {
          try self.engine?.start()
          self.started = true
        } catch {
          self.started = false
        }
        self.lock.unlock()
      }
      try e.start()
      engine = e
      started = true
      lock.unlock()
    } catch {
      lock.unlock()
      NSLog("[WoufyFX] haptics start failed: \(error)")
    }
  }

  func stop() {
    lock.lock()
    for (_, r) in channels {
      try? r.stop(atTime: CHHapticTimeImmediate)
    }
    channels.removeAll()
    let eng = engine
    engine = nil
    started = false
    lock.unlock()
    eng?.stop(completionHandler: nil)
  }

  /// Короткий удар. intensity/sharpness: 0…1 (низкая резкость — глубокий «бум», высокая — сухой «щелчок»)
  func transient(intensity: Float, sharpness: Float) {
    lock.lock()
    guard started, let e = engine else {
      lock.unlock()
      return
    }
    lock.unlock()
    let ev = CHHapticEvent(
      eventType: .hapticTransient,
      parameters: [
        CHHapticEventParameter(parameterID: .hapticIntensity, value: max(0, min(1, intensity))),
        CHHapticEventParameter(parameterID: .hapticSharpness, value: max(0, min(1, sharpness))),
      ],
      relativeTime: 0
    )
    play(events: [ev], on: e)
  }

  /// Сильный «толчок»: удар + короткая плотная вибрация (для самых мощных ударов бочки / дропов)
  func thump(intensity: Float) {
    lock.lock()
    guard started, let e = engine else {
      lock.unlock()
      return
    }
    lock.unlock()
    let i = max(0, min(1, intensity))
    let hit = CHHapticEvent(
      eventType: .hapticTransient,
      parameters: [
        CHHapticEventParameter(parameterID: .hapticIntensity, value: i),
        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.35),
      ],
      relativeTime: 0
    )
    let body = CHHapticEvent(
      eventType: .hapticContinuous,
      parameters: [
        CHHapticEventParameter(parameterID: .hapticIntensity, value: i * 0.9),
        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.12),
      ],
      relativeTime: 0.01,
      duration: 0.11
    )
    play(events: [hit, body], on: e)
  }

  private func play(events: [CHHapticEvent], on e: CHHapticEngine) {
    do {
      let pattern = try CHHapticPattern(events: events, parameters: [])
      let p = try e.makePlayer(with: pattern)
      try p.start(atTime: CHHapticTimeImmediate)
    } catch {
      // тактильный движок мог остановиться (фон/звонок) — перезапустим при следующем вызове
      try? e.start()
    }
  }

  /// Непрерывные каналы вибрации (как два мотора у DualSense): 0 — глубокий гул баса, 1 — тонкая «текстура» верхов.
  /// level 0…1 (0 — выключено), sharpness 0…1. Уровень меняется «на лету» без перезапуска.
  func setChannel(_ channel: Int, level: Float, sharpness: Float) {
    let l = max(0, min(1, level))
    if l < 0.03 {
      stopChannel(channel)
      return
    }
    lock.lock()
    guard started, let e = engine else {
      lock.unlock()
      return
    }
    do {
      if channels[channel] == nil {
        let ev = CHHapticEvent(
          eventType: .hapticContinuous,
          parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: channel == 0 ? 0.15 : 0.8),
          ],
          relativeTime: 0,
          duration: 1.0
        )
        let pattern = try CHHapticPattern(events: [ev], parameters: [])
        let p = try e.makeAdvancedPlayer(with: pattern)
        p.loopEnabled = true
        try p.start(atTime: CHHapticTimeImmediate)
        channels[channel] = p
      }
      try channels[channel]?.sendParameters(
        [
          CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: l, relativeTime: 0),
          CHHapticDynamicParameter(parameterID: .hapticSharpnessControl, value: max(0, min(1, sharpness)), relativeTime: 0),
        ],
        atTime: CHHapticTimeImmediate
      )
    } catch {
      channels[channel] = nil
    }
    lock.unlock()
  }

  func stopChannel(_ channel: Int) {
    lock.lock()
    if let r = channels[channel] {
      try? r.stop(atTime: CHHapticTimeImmediate)
    }
    channels[channel] = nil
    lock.unlock()
  }

  func stopRumble() {
    lock.lock()
    for (_, r) in channels {
      try? r.stop(atTime: CHHapticTimeImmediate)
    }
    channels.removeAll()
    lock.unlock()
  }
}
