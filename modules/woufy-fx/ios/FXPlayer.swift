import AVFoundation
import Foundation

/// Один «плеер с эффектами» на AVAudioEngine.
///
/// Цепочка:  playerNode → timePitch → panMix → preReverb → reverb → mainMixer
///
///  • timePitch — темп и высота тона (Slowed / Speed Up / подгон BPM при склейке) без рваного звука;
///  • panMix — 8D: звук плавно «перетекает» из уха в ухо (панорама + лёгкая смена громкости), работает и на колонках;
///  • reverb — реверберация (wetDryMix 0 = эффект выключен, звук проходит без изменений).
final class FXPlayer {
  let id: String

  /// Вызывается, когда трек доиграл до конца (в главной очереди)
  var onEnded: (() -> Void)?
  /// Блок моно-семплов (для визуализатора и тактильного отклика)
  var onSamples: (([Double]) -> Void)?

  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let panMix = AVAudioMixerNode()
  private let preReverb = AVAudioMixerNode()
  private let reverb = AVAudioUnitReverb()

  private var file: AVAudioFile?
  private var duration: Double = 0
  private var fileRate: Double = 44100
  private var generation = 0

  // позиция: интегрируем «якорь + время × скорость»
  private var anchorPos: Double = 0
  private var anchorWall: CFTimeInterval = 0
  private var rate: Double = 1.0
  private var wantsPlay = false
  private var graphReady = false
  private var tapInstalled = false

  private var spatialOn = false
  private var spatialTimer: DispatchSourceTimer?
  private var angle: Double = 0
  private var lastSpatialWall: CFTimeInterval = 0

  private var configObserver: NSObjectProtocol?

  init(id: String) {
    self.id = id
    setupGraph()
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: .main
    ) { [weak self] _ in
      self?.handleConfigChange()
    }
  }

  deinit {
    if let o = configObserver { NotificationCenter.default.removeObserver(o) }
  }

  // MARK: - Граф

  private func setupGraph() {
    engine.attach(node)
    engine.attach(timePitch)
    engine.attach(panMix)
    engine.attach(preReverb)
    engine.attach(reverb)

    let sr = engine.outputNode.outputFormat(forBus: 0).sampleRate
    let rateForGraph = sr > 0 ? sr : 44100
    guard let stereoFmt = AVAudioFormat(standardFormatWithSampleRate: rateForGraph, channels: 2) else { return }

    // panMix → preReverb: панорама (pan) действует на соединение микшера со следующим микшером
    engine.connect(panMix, to: preReverb, format: stereoFmt)
    engine.connect(preReverb, to: reverb, format: stereoFmt)
    engine.connect(reverb, to: engine.mainMixerNode, format: stereoFmt)

    reverb.loadFactoryPreset(.cathedral)
    reverb.wetDryMix = 0

    panMix.pan = 0
    panMix.outputVolume = 1
    timePitch.rate = 1
    timePitch.pitch = 0
    graphReady = true
  }

  /// Соединяет источник с цепочкой под формат конкретного файла (разные треки — разная частота дискретизации)
  private func connectSource(format: AVAudioFormat) {
    engine.disconnectNodeOutput(node)
    engine.disconnectNodeOutput(timePitch)
    engine.connect(node, to: timePitch, format: format)
    engine.connect(timePitch, to: panMix, format: format)
  }

  private func startEngineIfNeeded() {
    if engine.isRunning { return }
    do {
      engine.prepare()
      try engine.start()
    } catch {
      NSLog("[WoufyFX] engine start failed: \(error)")
    }
  }

  private func handleConfigChange() {
    guard file != nil else { return }
    let pos = currentTime()
    let was = wantsPlay
    startEngineIfNeeded()
    schedule(from: pos)
    if was { beginPlayback() }
  }

  // MARK: - Загрузка и воспроизведение

  /// Загружает файл, возвращает длительность (сек)
  func load(url: URL) throws -> Double {
    wantsPlay = false
    generation += 1
    node.stop()
    stopSpatialTimer()
    if engine.isRunning { engine.stop() }

    let f = try AVAudioFile(forReading: url)
    file = f
    fileRate = f.processingFormat.sampleRate
    duration = fileRate > 0 ? Double(f.length) / fileRate : 0
    connectSource(format: f.processingFormat)
    startEngineIfNeeded()
    anchorPos = 0
    schedule(from: 0)
    applyTapState()
    return duration
  }

  private func schedule(from pos: Double) {
    guard let f = file else { return }
    generation += 1
    let gen = generation
    node.stop()
    let clamped = max(0, min(pos, duration))
    let startFrame = AVAudioFramePosition(clamped * fileRate)
    let remaining = f.length - startFrame
    anchorPos = Double(startFrame) / max(fileRate, 1)
    anchorWall = CACurrentMediaTime()
    guard remaining > 1 else {
      anchorPos = duration
      return
    }
    node.scheduleSegment(
      f,
      startingFrame: startFrame,
      frameCount: AVAudioFrameCount(remaining),
      at: nil,
      completionCallbackType: .dataPlayedBack
    ) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, self.generation == gen, self.wantsPlay else { return }
        self.wantsPlay = false
        self.anchorPos = self.duration
        self.stopSpatialTimer()
        self.onEnded?()
      }
    }
  }

  private func beginPlayback() {
    startEngineIfNeeded()
    anchorWall = CACurrentMediaTime()
    node.play()
    if spatialOn { startSpatialTimer() }
  }

  func play() {
    guard file != nil else { return }
    if wantsPlay && node.isPlaying { return }
    wantsPlay = true
    beginPlayback()
  }

  func pause() {
    anchorPos = currentTime()
    anchorWall = CACurrentMediaTime()
    wantsPlay = false
    node.pause()
    stopSpatialTimer()
  }

  func seek(to seconds: Double) {
    guard file != nil else { return }
    let was = wantsPlay
    schedule(from: seconds)
    if was {
      wantsPlay = true
      beginPlayback()
    }
  }

  func currentTime() -> Double {
    if wantsPlay && node.isPlaying {
      let t = anchorPos + (CACurrentMediaTime() - anchorWall) * rate
      return max(0, min(duration, t))
    }
    return max(0, min(duration, anchorPos))
  }

  func getDuration() -> Double { duration }
  func isPlaying() -> Bool { wantsPlay && node.isPlaying }
  func isLoaded() -> Bool { file != nil }

  // MARK: - Параметры

  func setVolume(_ v: Float) {
    engine.mainMixerNode.outputVolume = max(0, min(1, v))
  }

  func setRate(_ r: Double) {
    // перед сменой скорости фиксируем позицию, чтобы интеграл не «прыгнул»
    anchorPos = currentTime()
    anchorWall = CACurrentMediaTime()
    rate = max(0.25, min(4.0, r))
    timePitch.rate = Float(rate)
  }

  func setPitchCents(_ c: Double) {
    timePitch.pitch = Float(max(-2400, min(2400, c)))
  }

  /// amount: 0…100 (0 — без реверберации, 100 — почти полностью «в зале»)
  func setReverb(_ amount: Double) {
    let a = max(0, min(100, amount)) / 100.0
    // быстро набирает слышимость уже на малых значениях; на максимуме ≈ 92% обработанного сигнала
    reverb.wetDryMix = Float(100.0 * (1.0 - pow(1.0 - a, 1.6)) * 0.92)
    // реверберация «съедает» громкость — компенсируем
    panMix.outputVolume = Float(1.0 + 0.25 * a)
  }

  func setSpatial(_ on: Bool) {
    spatialOn = on
    if on {
      if wantsPlay { startSpatialTimer() }
    } else {
      stopSpatialTimer()
      panMix.pan = 0
    }
  }

  // MARK: - 8D: звук перетекает из левого уха в правое и обратно (≈ 8 секунд на оборот)

  private func startSpatialTimer() {
    if spatialTimer != nil { return }
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    lastSpatialWall = CACurrentMediaTime()
    t.schedule(deadline: .now(), repeating: .milliseconds(16))
    t.setEventHandler { [weak self] in
      guard let self = self else { return }
      let now = CACurrentMediaTime()
      let dt = now - self.lastSpatialWall
      self.lastSpatialWall = now
      self.angle += (2.0 * Double.pi) * dt / 8.0
      if self.angle > 2.0 * Double.pi { self.angle -= 2.0 * Double.pi }
      // sin — из уха в ухо; когда звук «сзади» (cos < 0) он чуть тише и глуше — эффект вращения вокруг головы
      self.panMix.pan = Float(sin(self.angle) * 0.95)
    }
    spatialTimer = t
    t.resume()
  }

  private func stopSpatialTimer() {
    spatialTimer?.cancel()
    spatialTimer = nil
  }

  // MARK: - Семплы для визуализатора / тактильного отклика

  private var samplingWanted = false

  func setSampling(_ on: Bool) {
    samplingWanted = on
    applyTapState()
  }

  private func applyTapState() {
    let mixer = engine.mainMixerNode
    if samplingWanted && !tapInstalled && engine.isRunning {
      mixer.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
        guard let self = self, let cb = self.onSamples else { return }
        guard let ch = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength)
        if n == 0 { return }
        var out = [Double](repeating: 0, count: n)
        let p = ch[0]
        for i in 0..<n { out[i] = Double(p[i]) }
        cb(out)
      }
      tapInstalled = true
    } else if !samplingWanted && tapInstalled {
      mixer.removeTap(onBus: 0)
      tapInstalled = false
    }
  }

  // MARK: - Уничтожение

  func destroy() {
    wantsPlay = false
    generation += 1
    stopSpatialTimer()
    if tapInstalled {
      engine.mainMixerNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    node.stop()
    if engine.isRunning { engine.stop() }
    file = nil
    onEnded = nil
    onSamples = nil
  }
}
