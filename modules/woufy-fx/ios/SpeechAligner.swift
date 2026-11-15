import AVFoundation
import Foundation
import Speech

/// Распознавание вокала в треке встроенным Speech.framework (по возможности — на устройстве).
/// Возвращает слова с временем начала; JS сопоставляет их с известным текстом песни и получает тайминги строк.
enum SpeechAligner {
  struct Failure: Error {
    let message: String
  }

  static func recognize(url: URL, localeId: String, completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async { completion(.failure(Failure(message: "нет разрешения на распознавание речи"))) }
        return
      }
      guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)), rec.isAvailable else {
        DispatchQueue.main.async { completion(.failure(Failure(message: "язык \(localeId) недоступен"))) }
        return
      }
      DispatchQueue.global(qos: .utility).async {
        do {
          let file = try AVAudioFile(forReading: url)
          let sr = file.processingFormat.sampleRate
          let total = Double(file.length) / max(sr, 1)
          let chunkLen = 50.0
          var words: [[String: Any]] = []
          var t = 0.0
          while t < total {
            let len = min(chunkLen, total - t)
            let seg = try exportChunk(file: file, start: t, len: len)
            let segments = recognizeChunk(rec, url: seg)
            try? FileManager.default.removeItem(at: seg)
            for s in segments {
              words.append([
                "text": s.substring,
                "start": s.timestamp + t,
                "dur": s.duration,
              ])
            }
            t += chunkLen
          }
          DispatchQueue.main.async { completion(.success(words)) }
        } catch {
          DispatchQueue.main.async { completion(.failure(error)) }
        }
      }
    }
  }

  /// Кусок трека → временный файл (лимит серверного распознавания ≈ 1 минута, поэтому режем по 50 секунд)
  private static func exportChunk(file: AVAudioFile, start: Double, len: Double) throws -> URL {
    let fmt = file.processingFormat
    let sr = fmt.sampleRate
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("woufy_\(UUID().uuidString).caf")
    let out = try AVAudioFile(forWriting: tmp, settings: fmt.settings)
    file.framePosition = AVAudioFramePosition(start * sr)
    var remaining = AVAudioFramePosition(len * sr)
    let cap: AVAudioFrameCount = 32768
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap) else { throw Failure(message: "буфер") }
    while remaining > 0 {
      let n = AVAudioFrameCount(min(AVAudioFramePosition(cap), remaining))
      try file.read(into: buf, frameCount: n)
      if buf.frameLength == 0 { break }
      try out.write(from: buf)
      remaining -= AVAudioFramePosition(buf.frameLength)
    }
    return tmp
  }

  private static func recognizeChunk(_ rec: SFSpeechRecognizer, url: URL) -> [SFTranscriptionSegment] {
    let sem = DispatchSemaphore(value: 0)
    var out: [SFTranscriptionSegment] = []
    let req = SFSpeechURLRecognitionRequest(url: url)
    req.shouldReportPartialResults = false
    if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    var task: SFSpeechRecognitionTask?
    task = rec.recognitionTask(with: req) { result, error in
      if let r = result, r.isFinal {
        out = r.bestTranscription.segments
        sem.signal()
      } else if error != nil {
        sem.signal()
      }
    }
    if sem.wait(timeout: .now() + 120) == .timedOut { task?.cancel() }
    return out
  }
}
