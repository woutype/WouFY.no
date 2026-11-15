import AVFoundation
import Foundation

/// Офлайн-анализ: читает кусок файла напрямую (без воспроизведения, без аудио-сессии) и возвращает огибающие энергии
/// для определения BPM. Работает в десятки раз быстрее реального времени и не мешает играющей музыке.
enum Analyzer {
  struct Failure: Error {}

  static func window(url: URL, start: Double, len: Double) throws -> [String: Any] {
    let f = try AVAudioFile(forReading: url)
    let sr = f.processingFormat.sampleRate
    guard sr > 0 else { throw Failure() }
    let duration = Double(f.length) / sr

    let s0 = AVAudioFramePosition(max(0, min(start, duration)) * sr)
    let want = AVAudioFramePosition(max(0, len) * sr)
    f.framePosition = s0

    let chunk: AVAudioFrameCount = 16384
    guard let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: chunk) else { throw Failure() }

    let hop = 512
    let alpha = 1.0 - exp(-2.0 * Double.pi * 160.0 / sr)
    var acc = 0.0
    var accLow = 0.0
    var n = 0
    var lp1 = 0.0
    var lp2 = 0.0
    var energies = [Double]()
    var lows = [Double]()
    var read: AVAudioFramePosition = 0

    while read < want {
      let toRead = AVAudioFrameCount(min(AVAudioFramePosition(chunk), want - read))
      if toRead == 0 { break }
      do {
        try f.read(into: buf, frameCount: toRead)
      } catch {
        break
      }
      let frames = Int(buf.frameLength)
      if frames == 0 { break }
      guard let ch = buf.floatChannelData else { break }
      let chans = Int(buf.format.channelCount)
      for i in 0..<frames {
        var v = Double(ch[0][i])
        if chans > 1 { v = (v + Double(ch[1][i])) * 0.5 }
        lp1 += alpha * (v - lp1)
        lp2 += alpha * (lp1 - lp2)
        acc += v * v
        accLow += lp2 * lp2
        n += 1
        if n == hop {
          energies.append(acc / Double(hop))
          lows.append(accLow / Double(hop))
          acc = 0
          accLow = 0
          n = 0
        }
      }
      read += AVAudioFramePosition(frames)
    }

    return [
      "energies": energies,
      "lows": lows,
      "sr": sr,
      "c": Double(s0) / sr,
      "duration": duration,
    ]
  }
}
