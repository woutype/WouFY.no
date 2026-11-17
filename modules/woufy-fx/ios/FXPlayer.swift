import AVFoundation
import Foundation

/// Один «плеер с эффектами» на AVAudioEngine.
///
/// Цепочка:
///   playerNode → timePitch → panMix ──┬── (Dry: чистый сигнал) ──────────────────────────┐
///                                      └── (Wet: wetEQ [HP 210Hz + LP 6.2kHz] → reverb) ──┴→ mainMixer
///
///  • timePitch — темп и высота тона (Slowed / Speed Up / подгон BPM при склейке) без рваного звука;
///  • panMix — 8D: звук плавно «перетекает» из уха в ухо (панорама), работает и на колонках;
///  • wetEQ + reverb — чистый концертный зал (параллельный посыл без грязи в басах и металлического шипения в верхах).
final class FXPlayer {
  let id: String

  /// Вызывается, когда трек доиграл до конца (в главной очереди)
  var onEnded: (() -> Void)?
  /// Блок моно-семплов (для визуализатора и тактильного отклика)
  var onSamples: (([Double]) -> Void)?

  private let tapLock = NSLock()
  private var sampleBuffer = [Double](repeating: 0, count: 1024)

  private let engine = AVAudioEngine()
  private let node = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let panMix = AVAudioMixerNode()
  private let dryMix = AVAudioMixerNode()
  private let wetEQ = AVAudioUnitEQ(numberOfBands: 2)
  private let reverb = AVAudioUnitReverb()
  private let wetMix = AVAudioMixerNode()

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
  /// позиция файла (сек), с которой начался текущий scheduleSegment — от неё отсчитывается точное «отрендеренное» время
  private var schedStartPos: Double = 0
  /// после паузы/простоя очередь воспроизведения пересобирается с запомненной позиции (не полагаемся на семантику node.pause)
  private var needsReschedule = false
  private var engineIdlePaused = false
  private var idleWork: DispatchWorkItem?

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
    engine.attach(dryMix)
    engine.attach(wetEQ)
    engine.attach(reverb)
    engine.attach(wetMix)

    let sr = engine.outputNode.outputFormat(forBus: 0).sampleRate
    let rateForGraph = sr > 0 ? sr : 44100
    guard let stereoFmt = AVAudioFormat(standardFormatWithSampleRate: rateForGraph, channels: 2) else { return }

    // Параллельный посыл: чистый сигнал идёт через dryMix, а в зал (reverb) уходит отфильтрованная копия
    let dryPoint = AVAudioConnectionPoint(node: dryMix, bus: 0)
    let wetPoint = AVAudioConnectionPoint(node: wetEQ, bus: 0)
    engine.connect(panMix, to: [dryPoint, wetPoint], fromBus: 0, format: stereoFmt)
    engine.connect(dryMix, to: engine.mainMixerNode, format: stereoFmt)

    engine.connect(wetEQ, to: reverb, format: stereoFmt)
    engine.connect(reverb, to: wetMix, format: stereoFmt)
    engine.connect(wetMix, to: engine.mainMixerNode, format: stereoFmt)

    // Фильтруем посыл на реверберацию: убираем гулкий суб-бас (<210 Гц) и резкий шум/сибилянты (>6.2 кГц)
    let hp = wetEQ.bands[0]
    hp.filterType = .highPass
    hp.frequency = 210
    hp.bandwidth = 0.7
    hp.bypass = false

    let lp = wetEQ.bands[1]
    lp.filterType = .lowPass
    lp.frequency = 6200
    lp.bandwidth = 0.7
    lp.bypass = false

    // .largeHall2 — чистый объёмный концертный зал с тёплым хвостом без металлического звона
    reverb.loadFactoryPreset(.largeHall2)
    reverb.wetDryMix = 100
    reverb.bypass = true // при 0% реверберации узел полностью отключён

    dryMix.outputVolume = 1.0
    wetMix.outputVolume = 0.0
    wetEQ.bypass = true

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
    engineIdlePaused = false
    startEngineIfNeeded()
    schedule(from: pos)
    if was && wantsPlay { beginPlayback() }
  }

  // MARK: - Загрузка и воспроизведение

  /// Загружает файл, возвращает длительность (сек)
  func load(url: URL) throws -> Double {
    cancelIdlePause()
    wantsPlay = false
    needsReschedule = false
    engineIdlePaused = false
    generation += 1
    node.stop()
    stopSpatialTimer()
    if engine.isRunning { engine.stop() }
    // если новый файл не откроется, старый не должен остаться «текущим» (иначе следующий play() сыграет прошлый трек)
    file = nil
    duration = 0
    anchorPos = 0

    let path = url.path
    guard FileManager.default.fileExists(atPath: path) else {
      throw NSError(
        domain: "WoufyFX",
        code: 404,
        userInfo: [NSLocalizedDescriptionKey: "Файл не найден на диске: \(url.lastPathComponent)"]
      )
    }

    if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size == 0 {
      throw NSError(
        domain: "WoufyFX",
        code: 400,
        userInfo: [NSLocalizedDescriptionKey: "Файл пустой (0 байт): \(url.lastPathComponent)"]
      )
    }

    let f: AVAudioFile
    do {
      f = try AVAudioFile(forReading: url)
    } catch {
      // Попытка запасной инициализации со стандартным 32-bit float форматом (для нестандартных ID3/24-бит/ALAC/FLAC)
      if let fallback = try? AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false) {
        f = fallback
      } else {
        throw error
      }
    }

    file = f
    fileRate = f.processingFormat.sampleRate
    duration = fileRate > 0 ? Double(f.length) / fileRate : 0
    connectSource(format: f.processingFormat)
    startEngineIfNeeded()
    anchorPos = 0
    schedule(from: 0)
    applyTapState()
    // загруженный, но так и не запущенный плеер не должен вечно держать аудио-движок включённым
    // (45 с — с запасом больше, чем предзагрузка следующего трека к склейке)
    scheduleIdlePause(after: 45)
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
    schedStartPos = anchorPos
    guard remaining > 1 else {
      anchorPos = duration
      if wantsPlay {
        wantsPlay = false
        stopSpatialTimer()
        DispatchQueue.main.async { [weak self] in
          self?.onEnded?()
        }
      }
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
    cancelIdlePause()
    wantsPlay = true
    if needsReschedule || engineIdlePaused || !engine.isRunning {
      engineIdlePaused = false
      needsReschedule = false
      startEngineIfNeeded()
      schedule(from: anchorPos)
    }
    if wantsPlay { beginPlayback() }
  }

  func pause() {
    anchorPos = currentTime()
    anchorWall = CACurrentMediaTime()
    wantsPlay = false
    needsReschedule = true
    node.pause()
    stopSpatialTimer()
    scheduleIdlePause(after: 4)
  }

  func seek(to seconds: Double) {
    guard file != nil else { return }
    let was = wantsPlay
    needsReschedule = false
    schedule(from: seconds)
    if was && wantsPlay {
      beginPlayback()
    }
  }

  /// Позиция в файле. Пока играет — по реально отрендеренным семплам узла (точность до долей миллисекунды и не зависит от того,
  /// насколько поздно пришла команда play): именно по ней DJ-движок выравнивает удары двух треков. Иначе — запасной расчёт по часам.
  func currentTime() -> Double {
    if wantsPlay && node.isPlaying {
      if let t = renderedPosition() { return max(0, min(duration, t)) }
      let t = anchorPos + (CACurrentMediaTime() - anchorWall) * rate
      return max(0, min(duration, t))
    }
    return max(0, min(duration, anchorPos))
  }

  private func renderedPosition() -> Double? {
    guard let nt = node.lastRenderTime, nt.isSampleTimeValid, nt.isHostTimeValid else { return nil }
    let renderHost = AVAudioTime.seconds(forHostTime: nt.hostTime)
    // Если последний отрендеренный кадр был ДО перемотки/смены позиции — он устарел, используем anchor-время
    if renderHost < anchorWall - 0.05 { return nil }
    guard let pt = node.playerTime(forNodeTime: nt), pt.isSampleTimeValid else { return nil }
    let sr = pt.sampleRate > 0 ? pt.sampleRate : fileRate
    if sr <= 0 { return nil }
    let rendered = Double(pt.sampleTime) / sr
    let nowHost = AVAudioTime.seconds(forHostTime: mach_absolute_time())
    let ahead = max(0.0, min(0.06, nowHost - renderHost))
    return schedStartPos + rendered + ahead * rate
  }

  // MARK: - Простой

  private func cancelIdlePause() {
    idleWork?.cancel()
    idleWork = nil
  }

  /// Если плеер молчит, аудио-движок (а с ним реверберация и time-pitch) останавливается: пустая «пауза» не греет телефон
  private func scheduleIdlePause(after seconds: Double) {
    cancelIdlePause()
    let work = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      if self.wantsPlay || self.file == nil { return }
      if self.engine.isRunning {
        self.engine.pause()
        self.engineIdlePaused = true
      }
    }
    idleWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
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

  /// time-pitch — самый «дорогой» узел цепочки. Когда темп/тон не меняются (нет Slowed / Speed Up / подгона BPM) — обходим его.
  func setTempoProcessing(_ on: Bool) {
    timePitch.bypass = !on
  }

  /// amount: 0…100 (0 — без реверберации, 100 — атмосферный большой концертный зал)
  func setReverb(_ amount: Double) {
    let a = max(0, min(100, amount)) / 100.0
    let active = a > 0.001
    reverb.bypass = !active
    wetEQ.bypass = !active

    if !active {
      dryMix.outputVolume = 1.0
      wetMix.outputVolume = 0.0
      panMix.outputVolume = 1.0
      return
    }

    // Плавная кривая посыла в зал (0…0.58) и деликатное приглушение сухого сигнала на максимуме,
    // чтобы не было перегруза/клиппинга и сохранялась кристальная читаемость трека.
    let wetLevel = pow(a, 1.35) * 0.58
    let dryLevel = 1.0 - 0.18 * pow(a, 1.5)
    wetMix.outputVolume = Float(wetLevel)
    dryMix.outputVolume = Float(dryLevel)
    panMix.outputVolume = 1.0
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
    // 30 обновлений в секунду достаточно для плавной панорамы (период оборота 8 с); раньше было 60 пробуждений в секунду
    t.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(6))
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
        guard let self = self, let ch = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength)
        if n == 0 { return }
        self.tapLock.lock()
        guard let cb = self.onSamples else {
          self.tapLock.unlock()
          return
        }
        if self.sampleBuffer.count != n {
          self.sampleBuffer = [Double](repeating: 0, count: n)
        }
        let p = ch[0]
        for i in 0..<n { self.sampleBuffer[i] = Double(p[i]) }
        let frames = self.sampleBuffer
        self.tapLock.unlock()
        DispatchQueue.main.async {
          cb(frames)
        }
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
    tapLock.lock()
    onSamples = nil
    tapLock.unlock()
  }
}
