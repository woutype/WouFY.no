import Foundation
import AVFoundation
import ImageIO
import UIKit

/// Высокопроизводительный нативный сканер и парсер метаданных (аналог архитектуры Spotify Local Files на iOS).
/// Сканирует папки за 2–5 мс, сначала отдаёт теги, затем формирует лёгкие миниатюры обложек через ImageIO.
public class MetadataScanner {

  // MARK: - Сканирование файлов (директории)

  public static func scanDirectory(rootURL: URL) -> [[String: Any]] {
    let fileManager = FileManager.default
    var results: [[String: Any]] = []
    let supportedExtensions = Set(["mp3", "m4a", "aac", "wav", "flac", "aif", "aiff"])
    let rootPath = rootURL.path.hasSuffix("/") ? rootURL.path : rootURL.path + "/"

    var lrcFiles = Set<String>()
    let resourceKeys: Set<URLResourceKey> = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]

    guard let enumerator = fileManager.enumerator(
      at: rootURL,
      includingPropertiesForKeys: Array(resourceKeys),
      options: [.skipsPackageDescendants],
      errorHandler: nil
    ) else {
      return []
    }

    for case let fileURL as URL in enumerator {
      let lastComponent = fileURL.lastPathComponent

      // Пропускаем скрытые файлы/папки (.woufy, .Trash и т.д.)
      if lastComponent.hasPrefix(".") {
        if (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
          enumerator.skipDescendants()
        }
        continue
      }

      let ext = fileURL.pathExtension.lowercased()
      if ext == "lrc" {
        lrcFiles.insert(fileURL.deletingPathExtension().path)
        continue
      }

      guard supportedExtensions.contains(ext) else { continue }

      guard let values = try? fileURL.resourceValues(forKeys: resourceKeys),
            values.isDirectory != true else { continue }

      let path = fileURL.path
      let relId: String
      if path.hasPrefix(rootPath) {
        relId = String(path.dropFirst(rootPath.count))
      } else {
        relId = path
      }

      let size = values.fileSize ?? 0
      let mtime = Int((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
      let basePath = fileURL.deletingPathExtension().path
      let hasLrc = lrcFiles.contains(basePath) || fileManager.fileExists(atPath: basePath + ".lrc")
      let lrcUri = hasLrc ? "file://" + basePath + ".lrc" : nil

      var dict: [String: Any] = [
        "id": relId,
        "uri": "file://" + path,
        "filename": lastComponent,
        "extension": ext == "aif" ? "aiff" : ext,
        "size": size,
        "mtime": mtime
      ]
      if let lrc = lrcUri {
        dict["lrcUri"] = lrc
      }
      results.append(dict)
    }

    return results
  }

  // MARK: - Пакетное чтение тегов и генерация обложек

  public static func extractBatch(items: [[String: Any]], coversDirURL: URL) -> [[String: Any]] {
    let fileManager = FileManager.default
    if !fileManager.fileExists(atPath: coversDirURL.path) {
      try? fileManager.createDirectory(at: coversDirURL, withIntermediateDirectories: true, attributes: nil)
    }

    var results: [[String: Any]] = []
    results.reserveCapacity(items.count)

    for item in items {
      autoreleasepool {
        guard let uriStr = item["uri"] as? String,
              let id = item["id"] as? String else { return }

        let cleanUri = uriStr.hasPrefix("file://") ? String(uriStr.dropFirst(7)) : uriStr
        let decoded = cleanUri.removingPercentEncoding ?? cleanUri
        let fileURL = URL(fileURLWithPath: decoded)

        let meta = extractSingleFile(fileURL: fileURL, id: id, coversDirURL: coversDirURL)
        results.append(meta)
      }
    }

    return results
  }

  // MARK: - Обработка отдельного файла

  private static func extractSingleFile(fileURL: URL, id: String, coversDirURL: URL) -> [String: Any] {
    let asset = AVURLAsset(url: fileURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
    let allMetadata = asset.metadata

    var title: String?
    var artist: String?
    var album: String?
    var bpm: Double?
    var trackNumber: Int?
    var discNumber: Int?
    var lyrics: String?

    // 1. Стандартные общие метаданные
    for item in AVMetadataItem.metadataItems(from: allMetadata, filteredByIdentifier: .commonIdentifierTitle) {
      if let str = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
        title = str
        break
      }
    }

    for item in AVMetadataItem.metadataItems(from: allMetadata, filteredByIdentifier: .commonIdentifierArtist) {
      if let str = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
        artist = str
        break
      }
    }

    for item in AVMetadataItem.metadataItems(from: allMetadata, filteredByIdentifier: .commonIdentifierAlbumName) {
      if let str = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
        album = str
        break
      }
    }

    // 2. Расширенные теги (ID3, MP4 atoms, QuickTime)
    for item in allMetadata {
      let keyString = item.commonKey?.rawValue ?? (item.key as? String) ?? ""

      if title == nil && (keyString == "TIT2" || keyString == "©nam") {
        title = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if artist == nil && (keyString == "TPE1" || keyString == "©ART" || keyString == "aART") {
        artist = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if album == nil && (keyString == "TALB" || keyString == "©alb") {
        album = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if bpm == nil && (keyString == "TBPM" || keyString == "tmpo") {
        if let str = item.stringValue, let val = Double(str) {
          bpm = val
        } else if let num = item.numberValue {
          bpm = num.doubleValue
        }
      }
      let idStr = item.identifier?.rawValue ?? ""
      let isLyrics = keyString == "USLT" || keyString == "©lyr" || keyString == "lyrics" || keyString == "COMM"
        || idStr.contains("USLT") || idStr.contains("©lyr") || idStr.contains("Lyrics") || idStr.contains("lyrics")

      if lyrics == nil && isLyrics {
        if let str = item.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
          lyrics = str
        } else if let dict = item.value as? [String: Any], let txt = (dict["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !txt.isEmpty {
          lyrics = txt
        } else if let dict = item.value as? NSDictionary, let txt = (dict["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !txt.isEmpty {
          lyrics = txt
        } else if let data = item.dataValue, let str = decodeLyricsData(data), !str.isEmpty {
          lyrics = str
        }
      }
      if trackNumber == nil && (keyString == "TRCK" || keyString == "trkn") {
        if let str = item.stringValue {
          let parts = str.components(separatedBy: "/")
          if let first = parts.first, let num = Int(first.trimmingCharacters(in: .whitespaces)) {
            trackNumber = num
          }
        } else if let data = item.dataValue, data.count >= 4 {
          trackNumber = (Int(data[2]) << 8) | Int(data[3])
        }
      }
      if discNumber == nil && (keyString == "TPOS" || keyString == "disk") {
        if let str = item.stringValue {
          let parts = str.components(separatedBy: "/")
          if let first = parts.first, let num = Int(first.trimmingCharacters(in: .whitespaces)) {
            discNumber = num
          }
        } else if let data = item.dataValue, data.count >= 4 {
          discNumber = (Int(data[2]) << 8) | Int(data[3])
        }
      }
    }

    // 3. Обложка: аппаратное сжатие в лёгкий JPEG thumbnail 384x384 через ImageIO (для быстрых очередей и списков)
    var artworkUri: String?
    if let imgData = extractArtworkData(from: asset, allMetadata: allMetadata) {
      let hash = String(format: "%016llx", contentHash(imgData))
      let thumbURL = coversDirURL.appendingPathComponent("\(hash)_t.jpg")

      if FileManager.default.fileExists(atPath: thumbURL.path) {
        artworkUri = "file://" + thumbURL.path
      } else if let thumbData = makeThumbnail(from: imgData, maxPixel: 384) {
        do {
          try thumbData.write(to: thumbURL, options: .atomic)
          artworkUri = "file://" + thumbURL.path
        } catch {
          // fallback
        }
      }
    }

    var dict: [String: Any] = [
      "id": id,
      "tagged": true
    ]
    if let t = title, !t.isEmpty { dict["title"] = t }
    if let a = artist, !a.isEmpty { dict["artist"] = a }
    if let alb = album, !alb.isEmpty { dict["album"] = alb }
    if let b = bpm, b > 0 { dict["bpmTag"] = b }
    if let trk = trackNumber, trk > 0 { dict["trackNumber"] = trk }
    if let d = discNumber, d > 0 { dict["discNumber"] = d }
    if let lyr = lyrics, !lyr.isEmpty { dict["lyrics"] = lyr }
    if let art = artworkUri { dict["artworkUri"] = art }

    return dict
  }

  // MARK: - Обложки и тексты: универсальное извлечение из любых контейнеров

  private static func extractArtworkData(from asset: AVURLAsset, allMetadata: [AVMetadataItem]) -> Data? {
    func bytesOf(_ item: AVMetadataItem) -> Data? {
      if let d = item.dataValue, !d.isEmpty { return d }
      if let d = item.value as? Data, !d.isEmpty { return d }
      if let dict = item.value as? [String: Any], let d = dict["data"] as? Data, !d.isEmpty { return d }
      if let dict = item.value as? NSDictionary, let d = dict["data"] as? Data, !d.isEmpty { return d }
      return nil
    }
    for item in AVMetadataItem.metadataItems(from: allMetadata, filteredByIdentifier: .commonIdentifierArtwork) {
      if let d = bytesOf(item) { return d }
    }
    for item in AVMetadataItem.metadataItems(from: asset.commonMetadata, withKey: AVMetadataKey.commonKeyArtwork, keySpace: .common) {
      if let d = bytesOf(item) { return d }
    }
    for item in allMetadata {
      let keyStr = item.commonKey?.rawValue ?? (item.key as? String) ?? ""
      let idStr = item.identifier?.rawValue ?? ""
      if item.commonKey == .commonKeyArtwork || keyStr == "APIC" || keyStr == "PIC" || keyStr == "covr" || idStr.contains("APIC") || idStr.contains("covr") {
        if let d = bytesOf(item) { return d }
      }
    }
    return nil
  }

  private static func decodeLyricsData(_ data: Data) -> String? {
    if data.isEmpty { return nil }
    let bytes = [UInt8](data)
    // Если это сырой ID3 USLT/COMM кадр: [enc(0..3), lang(3), descriptor\0, text]
    if bytes.count > 4 && bytes[0] <= 3 &&
       bytes[1] >= 0x41 && bytes[1] <= 0x7A &&
       bytes[2] >= 0x41 && bytes[2] <= 0x7A &&
       bytes[3] >= 0x41 && bytes[3] <= 0x7A {
      let enc = bytes[0]
      var start = 4
      if enc == 1 || enc == 2 {
        while start + 1 < bytes.count {
          if bytes[start] == 0 && bytes[start + 1] == 0 {
            start += 2
            break
          }
          start += 2
        }
      } else {
        while start < bytes.count {
          if bytes[start] == 0 {
            start += 1
            break
          }
          start += 1
        }
      }
      if start < bytes.count {
        let payload = Data(bytes[start..<bytes.count])
        let encoding: String.Encoding = enc == 1 ? .utf16 : enc == 2 ? .utf16BigEndian : enc == 3 ? .utf8 : .isoLatin1
        if let s = String(data: payload, encoding: encoding)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
          return s
        }
      }
    }
    if let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      return s
    }
    if let s = String(data: data, encoding: .utf16)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      return s
    }
    return nil
  }

  private static func artworkData(fileURL: URL) -> Data? {
    let asset = AVURLAsset(url: fileURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
    return extractArtworkData(from: asset, allMetadata: asset.metadata)
  }

  /// Стабильный (между запусками) FNV-1a хэш содержимого: одинаковые обложки → одно имя файла
  private static func contentHash(_ data: Data) -> UInt64 {
    var h: UInt64 = 0xcbf29ce484222325
    data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      for b in buf { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    }
    return h
  }

  private static func makeThumbnail(from data: Data, maxPixel: Int) -> Data? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
  }

  /// Лёгкие JPEG-миниатюры для очереди/списков. Имя = хэш содержимого + «_t»:
  /// треки одного альбома делят один файл, повторные проходы ничего не дублируют.
  public static func extractThumbnails(items: [[String: Any]], coversDirURL: URL, maxPixel: Int) -> [[String: Any]] {
    let fm = FileManager.default
    if !fm.fileExists(atPath: coversDirURL.path) {
      try? fm.createDirectory(at: coversDirURL, withIntermediateDirectories: true, attributes: nil)
    }
    var results: [[String: Any]] = []
    results.reserveCapacity(items.count)

    for item in items {
      autoreleasepool { () -> Void in
        guard let uriStr = item["uri"] as? String,
              let id = item["id"] as? String,
              let data = artworkData(fileURL: parseLocalFileURL(uriStr)) else { return }
        let thumbURL = coversDirURL.appendingPathComponent(String(format: "%016llx_t.jpg", contentHash(data)))
        if !fm.fileExists(atPath: thumbURL.path) {
          guard let jpeg = makeThumbnail(from: data, maxPixel: maxPixel),
                (try? jpeg.write(to: thumbURL, options: .atomic)) != nil else { return }
        }
        results.append(["id": id, "artworkUri": "file://" + thumbURL.path])
      }
    }
    return results
  }

  /// Оригинал обложки (байты из тега без перекодирования) для главного экрана.
  /// Пишется во временный кэш; хранятся только `keep` последних файлов.
  public static func extractOriginalArtwork(fileURL: URL, cacheDirURL: URL, keep: Int) -> String? {
    guard let data = artworkData(fileURL: fileURL) else { return nil }
    let fm = FileManager.default
    try? fm.createDirectory(at: cacheDirURL, withIntermediateDirectories: true, attributes: nil)
    let name = String(format: "%016llx", contentHash(data)) + "." + sniffImageExtension(data: data)
    let url = cacheDirURL.appendingPathComponent(name)
    if fm.fileExists(atPath: url.path) {
      try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    } else {
      do { try data.write(to: url, options: .atomic) } catch { return nil }
    }
    pruneCache(cacheDirURL, keep: keep)
    return "file://" + url.path
  }

  private static func pruneCache(_ dir: URL, keep: Int) {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
    ), files.count > keep else { return }
    func mtime(_ u: URL) -> Date {
      return (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
    }
    let sorted = files.sorted { (l: URL, r: URL) -> Bool in mtime(l) > mtime(r) }
    for f in sorted.dropFirst(keep) { try? fm.removeItem(at: f) }
  }

  // MARK: - Определение формата изображения без декодирования

  private static func sniffImageExtension(data: Data) -> String {
    guard data.count >= 4 else { return "jpg" }
    let bytes = [UInt8](data.prefix(4))
    if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
      return "jpg"
    }
    if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 {
      return "png"
    }
    if bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 {
      return "webp"
    }
    return "jpg"
  }
}

// MARK: - Наблюдатель за файловой системой (Kernel DispatchSource)

public class DirectoryWatcher {
  private var source: DispatchSourceFileSystemObject?
  private var fileDescriptor: CInt = -1
  private let url: URL
  private let queue = DispatchQueue(label: "com.woufy.directoryWatcher")
  private var timer: DispatchSourceTimer?
  public var onChange: (() -> Void)?

  public init(url: URL) {
    self.url = url
  }

  public func start() {
    queue.async { [weak self] in
      guard let self = self else { return }
      self.stopLocked()
      let fd = open(self.url.path, O_EVTONLY)
      guard fd != -1 else { return }
      self.fileDescriptor = fd

      let src = DispatchSource.makeFileSystemObjectSource(
        fileDescriptor: fd,
        eventMask: [.write, .extend, .rename, .delete],
        queue: self.queue
      )

      src.setEventHandler { [weak self] in
        self?.debounceNotify()
      }

      let fdToClose = fd
      src.setCancelHandler {
        close(fdToClose)
      }

      self.source = src
      src.resume()
    }
  }

  private func debounceNotify() {
    timer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .milliseconds(400))
    t.setEventHandler { [weak self] in
      DispatchQueue.main.async {
        self?.onChange?()
      }
    }
    timer = t
    t.resume()
  }

  private func stopLocked() {
    timer?.cancel()
    timer = nil
    if let s = source {
      s.cancel()
      source = nil
    }
    fileDescriptor = -1
  }

  public func stop() {
    queue.async { [weak self] in
      self?.stopLocked()
    }
  }

  deinit {
    timer?.cancel()
    source?.cancel()
  }
}
