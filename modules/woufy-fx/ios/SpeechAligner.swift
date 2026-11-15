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
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let file = try AVAudioFile(forReading: url)
          let sr = file.processingFormat.sampleRate
          let total = Double(file.length) / max(sr, 1)
          let chunkLen = 50.0
          // два куска распознаются одновременно (трек обрабатывается почти вдвое быстрее); если телефон уже горячий — по одному
          let thermal = ProcessInfo.processInfo.thermalState.rawValue
          let concurrency = thermal >= ProcessInfo.ThermalState.serious.rawValue ? 1 : 2
          let slots = DispatchSemaphore(value: concurrency)
          let group = DispatchGroup()
          let lock = NSLock()
          var results: [(Double, [SFTranscriptionSegment])] = []
          var t = 0.0
          while t < total {
            let len = min(chunkLen, total - t)
            let seg = try exportChunk(file: file, start: t, len: len)
            let chunkStart = t
            slots.wait()
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
              let segments = recognizeChunk(rec, url: seg)
              try? FileManager.default.removeItem(at: seg)
              lock.lock()
              results.append((chunkStart, segments))
              lock.unlock()
              slots.signal()
              group.leave()
            }
            t += chunkLen
          }
          group.wait()
          lock.lock()
          let ordered = results.sorted { $0.0 < $1.0 }
          lock.unlock()
          var words: [[String: Any]] = []
          for (start, segments) in ordered {
            for s in segments {
              words.append([
                "text": s.substring,
                "start": s.timestamp + start,
                "dur": s.duration,
              ])
            }
          }
          DispatchQueue.main.async { completion(.success(words)) }
        } catch {
          DispatchQueue.main.async { completion(.failure(error)) }
        }
      }
    }
  }

  /// Кусок трека → временный файл 16 кГц, моно (для распознавания речи этого достаточно; файл в 10–20 раз меньше,
  /// чем раньше, поэтому нарезка и чтение распознавателем идут заметно быстрее). Лимит серверного распознавания ≈ 1 минута — режем по 50 секунд.
  private static func exportChunk(file: AVAudioFile, start: Double, len: Double) throws -> URL {
    let inFmt = file.processingFormat
    guard
      let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
      let conv = AVAudioConverter(from: inFmt, to: outFmt)
    else { throw Failure(message: "конвертер") }
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("woufy_\(UUID().uuidString).caf")
    let out = try AVAudioFile(forWriting: tmp, settings: outFmt.settings)
    file.framePosition = AVAudioFramePosition(start * inFmt.sampleRate)
    var remaining = AVAudioFramePosition(len * inFmt.sampleRate)
    let inCap: AVAudioFrameCount = 16384
    let ratio = outFmt.sampleRate / inFmt.sampleRate
    let outCap = AVAudioFrameCount(Double(inCap) * ratio) + 256
    guard
      let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: inCap),
      let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: outCap)
    else { throw Failure(message: "буфер") }
    while remaining > 0 {
      let n = AVAudioFrameCount(min(AVAudioFramePosition(inCap), remaining))
      try file.read(into: inBuf, frameCount: n)
      if inBuf.frameLength == 0 { break }
      var fed = false
      var convError: NSError?
      let status = conv.convert(to: outBuf, error: &convError) { _, outStatus in
        if fed {
          outStatus.pointee = .noDataNow
          return nil
        }
        fed = true
        outStatus.pointee = .haveData
        return inBuf
      }
      if status == .error { throw convError ?? Failure(message: "конвертация") }
      if outBuf.frameLength > 0 { try out.write(from: outBuf) }
      remaining -= AVAudioFramePosition(inBuf.frameLength)
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
