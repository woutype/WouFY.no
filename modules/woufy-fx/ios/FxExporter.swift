import AVFoundation
import Foundation

final class FxExporter {
  static func export(
    uri: String,
    title: String,
    speed: Double,
    reverbAmount: Double,
    spatial8d: Bool,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let inputURL = parseLocalFileURL(uri)
        guard FileManager.default.fileExists(atPath: inputURL.path) else {
          throw NSError(domain: "WoufyFX", code: 404, userInfo: [NSLocalizedDescriptionKey: "Аудиофайл не найден"])
        }

        let inputFile = try AVAudioFile(forReading: inputURL)
        let format = inputFile.processingFormat
        let sampleRate = format.sampleRate > 0 ? format.sampleRate : 44100
        let channels = max(AVAudioChannelCount(2), format.channelCount)
        guard let renderFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels) else {
          throw NSError(domain: "WoufyFX", code: 500, userInfo: [NSLocalizedDescriptionKey: "Неверный формат аудио"])
        }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let timePitch = AVAudioUnitTimePitch()
        let panMix = AVAudioMixerNode()
        let dryMix = AVAudioMixerNode()
        let wetEQ = AVAudioUnitEQ(numberOfBands: 2)
        let reverb = AVAudioUnitReverb()
        let wetMix = AVAudioMixerNode()

        engine.attach(player)
        engine.attach(timePitch)
        engine.attach(panMix)
        engine.attach(dryMix)
        engine.attach(wetEQ)
        engine.attach(reverb)
        engine.attach(wetMix)

        engine.connect(player, to: timePitch, format: format)
        engine.connect(timePitch, to: panMix, format: format)

        let dryPoint = AVAudioConnectionPoint(node: dryMix, bus: 0)
        let wetPoint = AVAudioConnectionPoint(node: wetEQ, bus: 0)
        engine.connect(panMix, to: [dryPoint, wetPoint], fromBus: 0, format: renderFormat)
        engine.connect(dryMix, to: engine.mainMixerNode, format: renderFormat)
        engine.connect(wetEQ, to: reverb, format: renderFormat)
        engine.connect(reverb, to: wetMix, format: renderFormat)
        engine.connect(wetMix, to: engine.mainMixerNode, format: renderFormat)

        let clampedSpeed = max(0.25, min(2.0, speed))
        timePitch.rate = Float(clampedSpeed)
        timePitch.pitch = clampedSpeed != 1.0 ? Float(1200.0 * log2(clampedSpeed)) : 0.0
        timePitch.bypass = abs(clampedSpeed - 1.0) < 0.001

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

        reverb.loadFactoryPreset(.largeHall2)
        reverb.wetDryMix = 100

        let a = max(0.0, min(100.0, reverbAmount)) / 100.0
        let revActive = a > 0.001
        reverb.bypass = !revActive
        wetEQ.bypass = !revActive
        if revActive {
          wetMix.outputVolume = Float(pow(a, 1.35) * 0.58)
          dryMix.outputVolume = Float(1.0 - 0.18 * pow(a, 1.5))
        } else {
          wetMix.outputVolume = 0.0
          dryMix.outputVolume = 1.0
        }

        let maxFrames: AVAudioFrameCount = 4096
        try engine.enableManualRenderingMode(.offline, format: renderFormat, maximumFrameCount: maxFrames)
        try engine.start()

        player.scheduleFile(inputFile, at: nil, completionHandler: nil)
        player.play()

        let safeName = title.replacingOccurrences(of: "/", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        let fileName = (safeName.isEmpty ? "WouFY_FX" : safeName) + "_FX.m4a"
        let outURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: outURL)

        let outSettings: [String: Any] = [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: sampleRate,
          AVNumberOfChannelsKey: channels,
          AVEncoderBitRateKey: 256_000,
        ]
        var outFile: AVAudioFile? = try AVAudioFile(forWriting: outURL, settings: outSettings)

        guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: maxFrames) else {
          throw NSError(domain: "WoufyFX", code: 500, userInfo: [NSLocalizedDescriptionKey: "Ошибка буфера рендера"])
        }

        let inputDuration = Double(inputFile.length) / sampleRate
        let expectedOutSec = (inputDuration / clampedSpeed) + (revActive ? 2.2 : 0.2)
        let targetTotalFrames = AVAudioFramePosition(expectedOutSec * sampleRate)
        var renderedFrames: AVAudioFramePosition = 0
        var angle: Double = 0
        var insufficientRetries = 0
        var renderDone = false

        while renderedFrames < targetTotalFrames && !renderDone {
          let framesToRender = min(maxFrames, AVAudioFrameCount(targetTotalFrames - renderedFrames))
          if spatial8d {
            let dt = Double(framesToRender) / sampleRate
            angle += (2.0 * Double.pi) * dt / 8.0
            if angle > 2.0 * Double.pi { angle -= 2.0 * Double.pi }
            panMix.pan = Float(sin(angle) * 0.95)
          }
          let status = try engine.renderOffline(framesToRender, to: buffer)
          switch status {
          case .success:
            insufficientRetries = 0
            try outFile?.write(from: buffer)
            renderedFrames += AVAudioFramePosition(buffer.frameLength)
          case .insufficientDataFromInputNode:
            insufficientRetries += 1
            if insufficientRetries > 4 {
              renderDone = true
            } else {
              Thread.sleep(forTimeInterval: 0.002)
            }
          case .cannotDoInCurrentContext:
            Thread.sleep(forTimeInterval: 0.002)
          case .error:
            throw NSError(domain: "WoufyFX", code: 500, userInfo: [NSLocalizedDescriptionKey: "Ошибка рендеринга эффекта"])
          @unknown default:
            renderDone = true
          }
        }

        player.stop()
        engine.stop()
        outFile = nil
        completion(.success(outURL.absoluteString))
      } catch {
        completion(.failure(error))
      }
    }
  }
}
