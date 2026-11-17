import AVFoundation
import UIKit
import CoreImage

enum VideoCardError: Error, LocalizedError {
  case invalidParameters
  case failedToStartWriter
  case failedToCreatePixelBuffer
  case exportFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidParameters: return "Неверные параметры для создания видео"
    case .failedToStartWriter: return "Не удалось инициализировать кодировщик видео"
    case .failedToCreatePixelBuffer: return "Ошибка создания буфера кадра"
    case .exportFailed(let msg): return msg
    }
  }
}

struct LyricItem {
  let time: Double
  let text: String
}

final class VideoCardGenerator {

  static func dimensions(for aspect: String) -> (Int, Int) {
    switch aspect {
    case "16:9": return (1280, 720)
    case "9:16": return (720, 1280)
    case "1:1":  return (960, 960)
    case "4:3":  return (960, 720)
    case "3:4":  return (720, 960)
    default:     return (720, 1280)
    }
  }

  static func generate(
    params: [String: Any],
    onProgress: @escaping (Double) -> Void,
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let audioUri = params["audioUri"] as? String ?? ""
        let artworkUri = params["artworkUri"] as? String
        let title = params["title"] as? String ?? "Без названия"
        let artist = params["artist"] as? String ?? "Неизвестный исполнитель"
        let startSec = params["startSec"] as? Double ?? 0.0
        let endSec = params["endSec"] as? Double ?? 15.0
        let styleMode = params["style"] as? String ?? "underCover" // "inCover" | "underCover" | "textOnly"
        let coverShape = params["coverShape"] as? String ?? "square" // "vinyl" | "square"
        let aspect = params["aspect"] as? String ?? "9:16"
        let rawLines = params["lines"] as? [[String: Any]] ?? []

        let duration = max(3.0, min(60.0, endSec - startSec))
        let (width, height) = dimensions(for: aspect)
        let fps = 30
        let totalFrames = max(1, Int(duration * Double(fps)))

        let lines: [LyricItem] = rawLines.compactMap { dict in
          guard let text = dict["text"] as? String else { return nil }
          let t = (dict["time"] as? Double) ?? 0.0
          return LyricItem(time: t, text: text)
        }

        // 1. Подготовка обложки и размытого фона
        let coverImage = loadArtwork(uri: artworkUri, audioUri: audioUri) ?? makeFallbackArtwork()
        let bgImage = makeBlurredBackground(from: coverImage, size: CGSize(width: width, height: height))

        // 2. Рендеринг видео-дорожки без звука во временный файл
        let tempDir = FileManager.default.temporaryDirectory
        let silentVideoURL = tempDir.appendingPathComponent("woufy_silent_\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: silentVideoURL)

        let writer = try AVAssetWriter(outputURL: silentVideoURL, fileType: .mp4)
        let videoSettings: [String: Any] = [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: width,
          AVVideoHeightKey: height,
          AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: width * height * 5,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
          ]
        ]
        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        writerInput.expectsMediaDataInRealTime = false

        let pixelBufferAttrs: [String: Any] = [
          kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32ARGB),
          kCVPixelBufferWidthKey as String: width,
          kCVPixelBufferHeightKey as String: height,
          kCVPixelBufferCGImageCompatibilityKey as String: true,
          kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
          assetWriterInput: writerInput,
          sourcePixelBufferAttributes: pixelBufferAttrs
        )

        guard writer.canAdd(writerInput) else {
          throw VideoCardError.failedToStartWriter
        }
        writer.add(writerInput)

        guard writer.startWriting() else {
          throw VideoCardError.failedToStartWriter
        }
        writer.startSession(atSourceTime: .zero)

        let colorSpace = CGColorSpaceCreateDeviceRGB()

        for frameIdx in 0..<totalFrames {
          while !writerInput.isReadyForMoreMediaData {
            Thread.sleep(forTimeInterval: 0.004)
          }

          autoreleasepool {
            guard let pool = adaptor.pixelBufferPool else { return }
            var pixelBufferOut: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBufferOut)
            guard let pixelBuffer = pixelBufferOut else { return }

            CVPixelBufferLockBaseAddress(pixelBuffer, [])
            defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

            guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
            let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

            guard let ctx = CGContext(
              data: baseAddress,
              width: width,
              height: height,
              bitsPerComponent: 8,
              bytesPerRow: bytesPerRow,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
            ) else { return }

            // Переворачиваем систему координат под UIKit (0,0 сверху слева)
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: 1.0, y: -1.0)

            UIGraphicsPushContext(ctx)
            let currentTime = startSec + (Double(frameIdx) / Double(fps))
            let elapsed = Double(frameIdx) / Double(fps)

            drawFrame(
              in: ctx,
              size: CGSize(width: width, height: height),
              bgImage: bgImage,
              coverImage: coverImage,
              title: title,
              artist: artist,
              lines: lines,
              currentTime: currentTime,
              elapsed: elapsed,
              duration: duration,
              styleMode: styleMode,
              coverShape: coverShape,
              aspect: aspect
            )
            UIGraphicsPopContext()

            let presentationTime = CMTime(value: CMTimeValue(frameIdx), timescale: CMTimeScale(fps))
            adaptor.append(pixelBuffer, withPresentationTime: presentationTime)
          }

          if frameIdx % 5 == 0 || frameIdx == totalFrames - 1 {
            let p = Double(frameIdx + 1) / Double(totalFrames) * 0.82
            onProgress(p)
          }
        }

        writerInput.markAsFinished()
        let sema = DispatchSemaphore(value: 0)
        writer.finishWriting {
          sema.signal()
        }
        sema.wait()

        // 3. Сведение с аудио-отрывком через AVMutableComposition
        let finalURL = tempDir.appendingPathComponent("WouFY_Clip_\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: finalURL)

        let audioURL = parseLocalFileURL(audioUri)
        let videoAsset = AVURLAsset(url: silentVideoURL)
        let audioAsset = AVURLAsset(url: audioURL)

        let composition = AVMutableComposition()
        let videoDuration = CMTime(seconds: duration, preferredTimescale: 600)

        if let vTrack = videoAsset.tracks(withMediaType: .video).first,
           let compVTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
          try? compVTrack.insertTimeRange(CMTimeRange(start: .zero, duration: min(vTrack.timeRange.duration, videoDuration)), of: vTrack, at: .zero)
        }

        if FileManager.default.fileExists(atPath: audioURL.path),
           let aTrack = audioAsset.tracks(withMediaType: .audio).first,
           let compATrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
          let audioStart = CMTime(seconds: max(0, startSec), preferredTimescale: 600)
          let maxAudioDur = max(0, CMTimeGetSeconds(audioAsset.duration) - startSec)
          let actualDur = CMTime(seconds: min(duration, maxAudioDur), preferredTimescale: 600)
          if actualDur.seconds > 0.1 {
            try? compATrack.insertTimeRange(CMTimeRange(start: audioStart, duration: actualDur), of: aTrack, at: .zero)
          }
        }

        try? FileManager.default.removeItem(at: silentVideoURL)

        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
          throw VideoCardError.exportFailed("Не удалось создать сессию экспорта")
        }
        exporter.outputURL = finalURL
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true

        let exportSema = DispatchSemaphore(value: 0)
        exporter.exportAsynchronously {
          exportSema.signal()
        }
        exportSema.wait()

        if exporter.status == .completed {
          onProgress(1.0)
          completion(.success(finalURL.absoluteString))
        } else {
          let err = exporter.error?.localizedDescription ?? "Ошибка при сборке видео с аудио"
          throw VideoCardError.exportFailed(err)
        }
      } catch {
        completion(.failure(error))
      }
    }
  }

  // MARK: - Static Image Card Generation (WouFY Card)

  static func generateImage(
    params: [String: Any],
    completion: @escaping (Result<String, Error>) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let audioUri = params["audioUri"] as? String ?? ""
      let artworkUri = params["artworkUri"] as? String
      let title = params["title"] as? String ?? "Без названия"
      let artist = params["artist"] as? String ?? "Неизвестный исполнитель"
      let styleMode = params["style"] as? String ?? "glassQuote" // "glassQuote" | "underCover" | "inCover" | "textOnly"
      let coverShape = params["coverShape"] as? String ?? "square" // "vinyl" | "square"
      let aspect = params["aspect"] as? String ?? "9:16"
      let rawLines = params["lines"] as? [String] ?? []

      let (baseW, baseH) = dimensions(for: aspect)
      // Рендерим карточку в повышенном HD-разрешении (×1.5 -> напр. 1080×1920 для 9:16)
      let width = Int(Double(baseW) * 1.5)
      let height = Int(Double(baseH) * 1.5)
      let size = CGSize(width: width, height: height)

      let coverImage = loadArtwork(uri: artworkUri, audioUri: audioUri) ?? makeFallbackArtwork()
      let bgImage = makeBlurredBackground(from: coverImage, size: size)

      UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
      guard let ctx = UIGraphicsGetCurrentContext() else {
        UIGraphicsEndImageContext()
        completion(.failure(VideoCardError.failedToCreatePixelBuffer))
        return
      }

      drawStaticCard(
        in: ctx,
        size: size,
        bgImage: bgImage,
        coverImage: coverImage,
        title: title,
        artist: artist,
        lines: rawLines,
        styleMode: styleMode,
        coverShape: coverShape
      )

      let rendered = UIGraphicsGetImageFromCurrentImageContext()
      UIGraphicsEndImageContext()

      guard let finalImage = rendered, let pngData = finalImage.pngData() else {
        completion(.failure(VideoCardError.exportFailed("Не удалось сохранить PNG изображение")))
        return
      }

      let tempDir = FileManager.default.temporaryDirectory
      let outURL = tempDir.appendingPathComponent("WouFY_Card_\(Int(Date().timeIntervalSince1970)).png")
      try? FileManager.default.removeItem(at: outURL)

      do {
        try pngData.write(to: outURL)
        completion(.success(outURL.absoluteString))
      } catch {
        completion(.failure(error))
      }
    }
  }

  private static func drawStaticCard(
    in ctx: CGContext,
    size: CGSize,
    bgImage: UIImage,
    coverImage: UIImage,
    title: String,
    artist: String,
    lines: [String],
    styleMode: String,
    coverShape: String
  ) {
    let W = size.width
    let H = size.height
    let minDim = min(W, H)
    let scale = minDim / 720.0

    bgImage.draw(in: CGRect(x: 0, y: 0, width: W, height: H))

    let isLandscape = W > H * 1.15
    let isSquare = abs(W - H) < 40

    if styleMode == "glassQuote" {
      // Фирменная стеклянная карточка цитаты (как Apple Music / Spotify Lyrics Card)
      let cardW = isLandscape ? W * 0.82 : W * 0.86
      let cardMaxH = H * 0.78
      let fontSize = minDim * (lines.count <= 2 ? 0.052 : lines.count <= 4 ? 0.044 : 0.038)

      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .left
      paragraph.lineBreakMode = .byWordWrapping
      paragraph.lineSpacing = 4 * scale

      let joinedText = lines.joined(separator: "\n\n")
      let textAttrs: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: fontSize, weight: .heavy),
        .foregroundColor: UIColor.white,
        .paragraphStyle: paragraph
      ]
      let textPad = 40 * scale
      let headerH = 82 * scale
      let bound = (joinedText as NSString).boundingRect(
        with: CGSize(width: cardW - textPad * 2, height: cardMaxH - headerH - textPad * 2),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        context: nil
      )

      let cardH = min(cardMaxH, max(240 * scale, headerH + ceil(bound.height) + textPad * 2.1))
      let cardRect = CGRect(x: (W - cardW) / 2, y: (H - cardH) / 2 - H * 0.02, width: cardW, height: cardH)

      ctx.saveGState()
      ctx.setShadow(offset: CGSize(width: 0, height: 16 * scale), blur: 36 * scale, color: UIColor(white: 0, alpha: 0.5).cgColor)
      let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 38 * scale)
      UIColor(white: 0.08, alpha: 0.66).setFill()
      cardPath.fill()
      ctx.restoreGState()

      let strokePath = UIBezierPath(roundedRect: cardRect, cornerRadius: 38 * scale)
      strokePath.lineWidth = 2.0 * scale
      UIColor(white: 1.0, alpha: 0.22).setStroke()
      strokePath.stroke()

      // Шапка внутри карточки: обложка + название + артист
      let thumbSize = 56 * scale
      let thumbRect = CGRect(x: cardRect.minX + textPad, y: cardRect.minY + textPad * 0.85, width: thumbSize, height: thumbSize)
      ctx.saveGState()
      let thumbRadius = (coverShape == "vinyl") ? thumbSize / 2 : 14 * scale
      UIBezierPath(roundedRect: thumbRect, cornerRadius: thumbRadius).addClip()
      coverImage.draw(in: thumbRect)
      ctx.restoreGState()

      let metaX = thumbRect.maxX + 16 * scale
      let metaW = cardRect.maxX - metaX - textPad
      let pMeta = NSMutableParagraphStyle()
      pMeta.alignment = .left
      pMeta.lineBreakMode = .byTruncatingTail

      (title as NSString).draw(
        in: CGRect(x: metaX, y: thumbRect.minY + 6 * scale, width: metaW, height: 26 * scale),
        withAttributes: [
          .font: UIFont.systemFont(ofSize: 20 * scale, weight: .bold),
          .foregroundColor: UIColor.white,
          .paragraphStyle: pMeta
        ]
      )
      (artist as NSString).draw(
        in: CGRect(x: metaX, y: thumbRect.minY + 32 * scale, width: metaW, height: 22 * scale),
        withAttributes: [
          .font: UIFont.systemFont(ofSize: 15 * scale, weight: .medium),
          .foregroundColor: UIColor(white: 1.0, alpha: 0.62),
          .paragraphStyle: pMeta
        ]
      )

      // Разделительная полоска
      let divY = thumbRect.maxY + 20 * scale
      let divPath = UIBezierPath()
      divPath.move(to: CGPoint(x: cardRect.minX + textPad, y: divY))
      divPath.addLine(to: CGPoint(x: cardRect.maxX - textPad, y: divY))
      divPath.lineWidth = 1.2 * scale
      UIColor(white: 1.0, alpha: 0.12).setStroke()
      divPath.stroke()

      // Строки песни
      let textRect = CGRect(
        x: cardRect.minX + textPad,
        y: divY + 20 * scale,
        width: cardW - textPad * 2,
        height: cardRect.maxY - (divY + 20 * scale) - textPad * 0.8
      )
      (joinedText as NSString).draw(in: textRect, withAttributes: textAttrs)

    } else if styleMode == "textOnly" {
      drawHeaderPill(
        in: ctx,
        cover: coverImage,
        title: title,
        artist: artist,
        centerX: W / 2,
        topY: H * 0.08,
        maxWidth: W * 0.84,
        scale: scale
      )
      let lyricsRect = CGRect(x: W * 0.09, y: H * 0.20, width: W * 0.82, height: H * 0.68)
      drawStaticLinesList(in: ctx, rect: lyricsRect, lines: lines, baseFontSize: minDim * 0.052, centered: true)

    } else if styleMode == "inCover" {
      let coverSize = isLandscape ? H * 0.76 : (isSquare ? minDim * 0.78 : W * 0.82)
      let coverX = (W - coverSize) / 2
      let coverY = isLandscape ? (H - coverSize) / 2 - H * 0.02 : H * 0.10
      let coverRect = CGRect(x: coverX, y: coverY, width: coverSize, height: coverSize)

      drawCover(in: ctx, rect: coverRect, image: coverImage, shape: coverShape, elapsed: 0, darkenOverlay: 0.58)
      let inset = coverSize * 0.10
      let innerRect = coverRect.insetBy(dx: inset, dy: inset)
      drawStaticLinesList(in: ctx, rect: innerRect, lines: lines, baseFontSize: coverSize * 0.062, centered: true)

      drawTrackMeta(
        title: title,
        artist: artist,
        rect: CGRect(x: W * 0.08, y: coverRect.maxY + H * 0.03, width: W * 0.84, height: H * 0.10),
        scale: scale,
        centered: true
      )
    } else {
      // underCover
      if isLandscape {
        let coverSize = H * 0.64
        let leftMargin = W * 0.07
        let coverY = (H - coverSize) / 2 - H * 0.04
        let coverRect = CGRect(x: leftMargin, y: coverY, width: coverSize, height: coverSize)

        drawCover(in: ctx, rect: coverRect, image: coverImage, shape: coverShape, elapsed: 0, darkenOverlay: 0.0)
        drawTrackMeta(
          title: title,
          artist: artist,
          rect: CGRect(x: leftMargin, y: coverRect.maxY + H * 0.025, width: coverSize, height: H * 0.12),
          scale: scale,
          centered: true
        )

        let rightX = coverRect.maxX + W * 0.06
        let rightW = W - rightX - W * 0.06
        let lyricsRect = CGRect(x: rightX, y: H * 0.12, width: rightW, height: H * 0.74)
        drawStaticLinesList(in: ctx, rect: lyricsRect, lines: lines, baseFontSize: minDim * 0.046, centered: false)
      } else {
        let coverSize = isSquare ? minDim * 0.38 : minDim * 0.42
        let coverX = (W - coverSize) / 2
        let coverY = H * 0.07
        let coverRect = CGRect(x: coverX, y: coverY, width: coverSize, height: coverSize)

        drawCover(in: ctx, rect: coverRect, image: coverImage, shape: coverShape, elapsed: 0, darkenOverlay: 0.0)
        let metaY = coverRect.maxY + H * 0.02
        let metaH = H * 0.075
        drawTrackMeta(
          title: title,
          artist: artist,
          rect: CGRect(x: W * 0.08, y: metaY, width: W * 0.84, height: metaH),
          scale: scale,
          centered: true
        )

        let lyricsTop = metaY + metaH + H * 0.015
        let lyricsH = H * 0.89 - lyricsTop
        let lyricsRect = CGRect(x: W * 0.08, y: lyricsTop, width: W * 0.84, height: max(120, lyricsH))
        drawStaticLinesList(in: ctx, rect: lyricsRect, lines: lines, baseFontSize: minDim * 0.046, centered: true)
      }
    }

    drawWatermarkPill(in: ctx, size: size, elapsed: 0, duration: 1, labelText: "WouFY Card")
  }

  private static func drawStaticLinesList(
    in ctx: CGContext,
    rect: CGRect,
    lines: [String],
    baseFontSize: CGFloat,
    centered: Bool
  ) {
    guard !lines.isEmpty else { return }
    ctx.saveGState()
    UIRectClip(rect)

    let countFactor: CGFloat = lines.count <= 2 ? 1.05 : lines.count <= 4 ? 0.90 : 0.76
    let fontSize = baseFontSize * countFactor

    let p = NSMutableParagraphStyle()
    p.alignment = centered ? .center : .left
    p.lineBreakMode = .byWordWrapping
    p.lineSpacing = 4

    let joined = lines.joined(separator: "\n\n")
    let attrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: fontSize, weight: .heavy),
      .foregroundColor: UIColor.white,
      .paragraphStyle: p
    ]

    let attrStr = NSAttributedString(string: joined, attributes: attrs)
    let bound = attrStr.boundingRect(
      with: CGSize(width: rect.width, height: rect.height),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil
    )

    let drawY = rect.midY - bound.height / 2
    attrStr.draw(in: CGRect(x: rect.minX, y: max(rect.minY, drawY), width: rect.width, height: ceil(bound.height) + 12))
    ctx.restoreGState()
  }

  // MARK: - Frame Drawing

  private static func drawFrame(
    in ctx: CGContext,
    size: CGSize,
    bgImage: UIImage,
    coverImage: UIImage,
    title: String,
    artist: String,
    lines: [LyricItem],
    currentTime: Double,
    elapsed: Double,
    duration: Double,
    styleMode: String,
    coverShape: String,
    aspect: String
  ) {
    let W = size.width
    let H = size.height
    let minDim = min(W, H)

    // 1. Фон (увеличенная обложка с блюром и тёмной вуалью)
    bgImage.draw(in: CGRect(x: 0, y: 0, width: W, height: H))

    let isLandscape = W > H * 1.15
    let isSquare = abs(W - H) < 40

    // Находим индекс активной строчки и прогресс внутри неё
    var activeIdx = 0
    for (i, line) in lines.enumerated() {
      if currentTime + 0.1 >= line.time {
        activeIdx = i
      } else {
        break
      }
    }

    // Плавный сдвиг при смене строчки (за первые 0.42с от начала строчки)
    var transitionProgress: CGFloat = 1.0
    if !lines.isEmpty && activeIdx < lines.count {
      let sinceLineStart = max(0.0, currentTime - lines[activeIdx].time)
      transitionProgress = CGFloat(min(1.0, sinceLineStart / 0.42))
      // easeOutCubic
      let inv = 1.0 - transitionProgress
      transitionProgress = 1.0 - inv * inv * inv
    }

    if styleMode == "textOnly" {
      // Только текст: крупно по центру + шапка трека сверху
      drawHeaderPill(
        in: ctx,
        cover: coverImage,
        title: title,
        artist: artist,
        centerX: W / 2,
        topY: H * 0.08,
        maxWidth: W * 0.84,
        scale: minDim / 720.0
      )

      let lyricsRect = CGRect(
        x: W * 0.08,
        y: H * 0.20,
        width: W * 0.84,
        height: H * 0.66
      )
      drawLyricsBlock(
        in: ctx,
        rect: lyricsRect,
        lines: lines,
        activeIdx: activeIdx,
        transition: transitionProgress,
        fontSize: minDim * 0.056,
        centered: true
      )
    } else if styleMode == "inCover" {
      // Текст переключается прямо внутри крупной обложки
      let coverSize = isLandscape ? H * 0.76 : (isSquare ? minDim * 0.78 : W * 0.82)
      let coverX = (W - coverSize) / 2
      let coverY = isLandscape ? (H - coverSize) / 2 - H * 0.02 : H * 0.11
      let coverRect = CGRect(x: coverX, y: coverY, width: coverSize, height: coverSize)

      drawCover(
        in: ctx,
        rect: coverRect,
        image: coverImage,
        shape: coverShape,
        elapsed: elapsed,
        darkenOverlay: 0.56
      )

      // Текст внутри обложки
      let inset = coverSize * 0.10
      let innerRect = coverRect.insetBy(dx: inset, dy: inset)
      drawLyricsBlock(
        in: ctx,
        rect: innerRect,
        lines: lines,
        activeIdx: activeIdx,
        transition: transitionProgress,
        fontSize: coverSize * 0.068,
        centered: true
      )

      // Название и артист под обложкой
      drawTrackMeta(
        title: title,
        artist: artist,
        rect: CGRect(x: W * 0.08, y: coverRect.maxY + H * 0.03, width: W * 0.84, height: H * 0.10),
        scale: minDim / 720.0,
        centered: true
      )
    } else {
      // "underCover": Текст переключается под обложкой (или справа от обложки в 16:9 / 4:3)
      if isLandscape {
        let coverSize = H * 0.64
        let leftMargin = W * 0.07
        let coverY = (H - coverSize) / 2 - H * 0.04
        let coverRect = CGRect(x: leftMargin, y: coverY, width: coverSize, height: coverSize)

        drawCover(
          in: ctx,
          rect: coverRect,
          image: coverImage,
          shape: coverShape,
          elapsed: elapsed,
          darkenOverlay: 0.0
        )

        drawTrackMeta(
          title: title,
          artist: artist,
          rect: CGRect(x: leftMargin, y: coverRect.maxY + H * 0.025, width: coverSize, height: H * 0.12),
          scale: minDim / 720.0,
          centered: true
        )

        let rightX = coverRect.maxX + W * 0.06
        let rightW = W - rightX - W * 0.06
        let lyricsRect = CGRect(x: rightX, y: H * 0.14, width: rightW, height: H * 0.70)
        drawLyricsBlock(
          in: ctx,
          rect: lyricsRect,
          lines: lines,
          activeIdx: activeIdx,
          transition: transitionProgress,
          fontSize: minDim * 0.052,
          centered: false
        )
      } else {
        let coverSize = isSquare ? minDim * 0.44 : W * 0.56
        let metaH = minDim * 0.095
        let coverToMetaGap = H * 0.020
        let metaToLyricsGap = H * 0.024
        let fontSize = minDim * 0.052
        let lyricsH = fontSize * 2.45 * 2.5

        let totalStackH = coverSize + coverToMetaGap + metaH + metaToLyricsGap + lyricsH
        let topY = max(H * 0.06, (H * 0.90 - totalStackH) / 2.0)

        let coverX = (W - coverSize) / 2
        let coverRect = CGRect(x: coverX, y: topY, width: coverSize, height: coverSize)

        drawCover(
          in: ctx,
          rect: coverRect,
          image: coverImage,
          shape: coverShape,
          elapsed: elapsed,
          darkenOverlay: 0.0
        )

        let metaY = coverRect.maxY + coverToMetaGap
        drawTrackMeta(
          title: title,
          artist: artist,
          rect: CGRect(x: W * 0.08, y: metaY, width: W * 0.84, height: metaH),
          scale: minDim / 640.0,
          centered: true
        )

        let lyricsTop = metaY + metaH + metaToLyricsGap
        let lyricsRect = CGRect(x: W * 0.08, y: lyricsTop, width: W * 0.84, height: lyricsH)
        drawLyricsBlock(
          in: ctx,
          rect: lyricsRect,
          lines: lines,
          activeIdx: activeIdx,
          transition: transitionProgress,
          fontSize: fontSize,
          centered: true
        )
      }
    }

    // Водяной знак-капсула WouFY.no снизу
    drawWatermarkPill(in: ctx, size: size, elapsed: elapsed, duration: duration)
  }

  private static func drawCover(
    in ctx: CGContext,
    rect: CGRect,
    image: UIImage,
    shape: String,
    elapsed: Double,
    darkenOverlay: CGFloat
  ) {
    ctx.saveGState()

    let isVinyl = (shape == "vinyl")
    let cornerRadius = isVinyl ? rect.width / 2.0 : rect.width * 0.09

    // Мягкая тень под обложкой
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: rect.height * 0.03), blur: rect.height * 0.07, color: UIColor(white: 0, alpha: 0.55).cgColor)
    let shadowPath = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
    UIColor.black.setFill()
    shadowPath.fill()
    ctx.restoreGState()

    let clipPath = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
    clipPath.addClip()

    if isVinyl {
      let center = CGPoint(x: rect.midX, y: rect.midY)
      let angle = CGFloat(elapsed * (2.0 * Double.pi / 7.5)) // 1 оборот за 7.5 сек
      ctx.saveGState()
      ctx.translateBy(x: center.x, y: center.y)
      ctx.rotate(by: angle)
      ctx.translateBy(x: -center.x, y: -center.y)
      image.draw(in: rect)
      ctx.restoreGState()
    } else {
      image.draw(in: rect)
    }

    if darkenOverlay > 0.01 {
      UIColor(white: 0.04, alpha: darkenOverlay).setFill()
      UIRectFillUsingBlendMode(rect, .normal)
    }

    if isVinyl {
      // Тонкие виниловые дорожки и центральное яблоко пластинки (если не режим текста внутри обложки)
      let center = CGPoint(x: rect.midX, y: rect.midY)
      UIColor(white: 1.0, alpha: 0.14).setStroke()
      let ring1 = UIBezierPath(arcCenter: center, radius: rect.width * 0.47, startAngle: 0, endAngle: .pi * 2, clockwise: true)
      ring1.lineWidth = 1.5
      ring1.stroke()
    }

    // Тонкая стеклянная рамка
    let borderPath = UIBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), cornerRadius: cornerRadius)
    borderPath.lineWidth = 2.0
    UIColor(white: 1.0, alpha: 0.22).setStroke()
    borderPath.stroke()

    ctx.restoreGState()
  }

  private static func drawLyricsBlock(
    in ctx: CGContext,
    rect: CGRect,
    lines: [LyricItem],
    activeIdx: Int,
    transition: CGFloat,
    fontSize: CGFloat,
    centered: Bool
  ) {
    guard !lines.isEmpty else { return }
    ctx.saveGState()
    UIRectClip(rect)

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = centered ? .center : .left
    paragraph.lineBreakMode = .byWordWrapping
    paragraph.lineSpacing = 3

    let centerY = rect.midY
    let slotStep = fontSize * 2.45
    let slideOffset = (1.0 - transition) * slotStep

    let indices = [activeIdx - 1, activeIdx, activeIdx + 1]
    for idx in indices {
      guard idx >= 0 && idx < lines.count else { continue }
      let dist = idx - activeIdx
      let text = lines[idx].text

      let isCurrent = (dist == 0)
      let isPrev = (dist == -1)
      let scale: CGFloat
      let alpha: CGFloat
      if isCurrent {
        scale = 0.86 + 0.14 * transition
        alpha = 0.36 + 0.64 * transition
      } else if isPrev && activeIdx > 0 {
        scale = 1.0 - 0.16 * transition
        alpha = 1.0 - 0.66 * transition
      } else {
        scale = 0.84
        alpha = 0.34 * transition
      }
      let actualFont = UIFont.systemFont(ofSize: fontSize * scale, weight: isCurrent ? .heavy : .bold)

      let attrs: [NSAttributedString.Key: Any] = [
        .font: actualFont,
        .foregroundColor: UIColor(white: 1.0, alpha: alpha),
        .paragraphStyle: paragraph
      ]

      let attrStr = NSAttributedString(string: text, attributes: attrs)
      let bounding = attrStr.boundingRect(
        with: CGSize(width: rect.width, height: rect.height * 0.45),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        context: nil
      )

      let targetY = centerY + CGFloat(dist) * slotStep + slideOffset - bounding.height / 2.0
      let drawRect = CGRect(
        x: rect.minX,
        y: targetY,
        width: rect.width,
        height: ceil(bounding.height) + 8
      )
      attrStr.draw(in: drawRect)
    }

    ctx.restoreGState()
  }

  private static func drawTrackMeta(
    title: String,
    artist: String,
    rect: CGRect,
    scale: CGFloat,
    centered: Bool
  ) {
    let p = NSMutableParagraphStyle()
    p.alignment = centered ? .center : .left
    p.lineBreakMode = .byTruncatingTail

    let titleFont = UIFont.systemFont(ofSize: 24 * scale, weight: .bold)
    let artistFont = UIFont.systemFont(ofSize: 17 * scale, weight: .medium)

    let titleAttrs: [NSAttributedString.Key: Any] = [
      .font: titleFont,
      .foregroundColor: UIColor.white,
      .paragraphStyle: p
    ]
    let artistAttrs: [NSAttributedString.Key: Any] = [
      .font: artistFont,
      .foregroundColor: UIColor(white: 1.0, alpha: 0.62),
      .paragraphStyle: p
    ]

    let titleH = 30 * scale
    (title as NSString).draw(
      in: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: titleH),
      withAttributes: titleAttrs
    )
    (artist as NSString).draw(
      in: CGRect(x: rect.minX, y: rect.minY + titleH + 2 * scale, width: rect.width, height: 24 * scale),
      withAttributes: artistAttrs
    )
  }

  private static func drawHeaderPill(
    in ctx: CGContext,
    cover: UIImage,
    title: String,
    artist: String,
    centerX: CGFloat,
    topY: CGFloat,
    maxWidth: CGFloat,
    scale: CGFloat
  ) {
    let pillH = 62 * scale
    let pillW = min(maxWidth, 420 * scale)
    let pillRect = CGRect(x: centerX - pillW / 2, y: topY, width: pillW, height: pillH)

    ctx.saveGState()
    let path = UIBezierPath(roundedRect: pillRect, cornerRadius: pillH / 2)
    UIColor(white: 1.0, alpha: 0.10).setFill()
    path.fill()
    path.lineWidth = 1.2
    UIColor(white: 1.0, alpha: 0.18).setStroke()
    path.stroke()

    let thumbSize = pillH - 12 * scale
    let thumbRect = CGRect(x: pillRect.minX + 6 * scale, y: pillRect.minY + 6 * scale, width: thumbSize, height: thumbSize)
    ctx.saveGState()
    UIBezierPath(roundedRect: thumbRect, cornerRadius: thumbSize / 2).addClip()
    cover.draw(in: thumbRect)
    ctx.restoreGState()

    let textX = thumbRect.maxX + 12 * scale
    let textW = pillRect.maxX - textX - 16 * scale
    let p = NSMutableParagraphStyle()
    p.alignment = .left
    p.lineBreakMode = .byTruncatingTail

    let tAttrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: 16 * scale, weight: .bold),
      .foregroundColor: UIColor.white,
      .paragraphStyle: p
    ]
    let aAttrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: 13 * scale, weight: .medium),
      .foregroundColor: UIColor(white: 1.0, alpha: 0.62),
      .paragraphStyle: p
    ]

    (title as NSString).draw(in: CGRect(x: textX, y: pillRect.minY + 11 * scale, width: textW, height: 22 * scale), withAttributes: tAttrs)
    (artist as NSString).draw(in: CGRect(x: textX, y: pillRect.minY + 32 * scale, width: textW, height: 18 * scale), withAttributes: aAttrs)
    ctx.restoreGState()
  }

  private static func drawWatermarkPill(
    in ctx: CGContext,
    size: CGSize,
    elapsed: Double,
    duration: Double,
    labelText: String = "WouFY Clip"
  ) {
    let minDim = min(size.width, size.height)
    let scale = minDim / 720.0
    let pillW = 160 * scale
    let pillH = 30 * scale
    let pillX = (size.width - pillW) / 2
    let pillY = size.height - pillH - size.height * 0.035
    let pillRect = CGRect(x: pillX, y: pillY, width: pillW, height: pillH)

    ctx.saveGState()
    let bgPath = UIBezierPath(roundedRect: pillRect, cornerRadius: pillH / 2)
    UIColor(white: 1.0, alpha: 0.10).setFill()
    bgPath.fill()
    bgPath.lineWidth = 1.0
    UIColor(white: 1.0, alpha: 0.18).setStroke()
    bgPath.stroke()

    let p = NSMutableParagraphStyle()
    p.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: 12 * scale, weight: .bold),
      .foregroundColor: UIColor(white: 1.0, alpha: 0.78),
      .paragraphStyle: p
    ]
    let label = labelText as NSString
    label.draw(in: CGRect(x: pillX, y: pillY + 7 * scale, width: pillW, height: 18 * scale), withAttributes: attrs)
    ctx.restoreGState()
  }

  // MARK: - Helpers

  private static func loadArtwork(uri: String?, audioUri: String) -> UIImage? {
    if let uri = uri, !uri.isEmpty {
      let url = parseLocalFileURL(uri)
      if let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
        return img
      }
    }
    let audioURL = parseLocalFileURL(audioUri)
    let asset = AVURLAsset(url: audioURL)
    for item in asset.commonMetadata {
      if item.commonKey == .commonKeyArtwork, let data = item.dataValue, let img = UIImage(data: data) {
        return img
      }
    }
    return nil
  }

  private static func makeFallbackArtwork() -> UIImage {
    let size = CGSize(width: 600, height: 600)
    UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
    guard let ctx = UIGraphicsGetCurrentContext() else {
      UIGraphicsEndImageContext()
      return UIImage()
    }
    let colors = [UIColor(white: 0.18, alpha: 1).cgColor, UIColor(white: 0.06, alpha: 1).cgColor] as CFArray
    if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
      ctx.drawLinearGradient(grad, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
    }
    let img = UIGraphicsGetImageFromCurrentImageContext() ?? UIImage()
    UIGraphicsEndImageContext()
    return img
  }

  private static func makeBlurredBackground(from image: UIImage, size: CGSize) -> UIImage {
    UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
    guard let ctx = UIGraphicsGetCurrentContext() else {
      UIGraphicsEndImageContext()
      return image
    }

    // Масштабируем с запасом (aspect fill * 1.25), чтобы занять весь кадр
    let imgSize = image.size
    let scale = max(size.width / max(1, imgSize.width), size.height / max(1, imgSize.height)) * 1.25
    let drawW = imgSize.width * scale
    let drawH = imgSize.height * scale
    let drawRect = CGRect(x: (size.width - drawW) / 2, y: (size.height - drawH) / 2, width: drawW, height: drawH)
    image.draw(in: drawRect)

    let scaledImg = UIGraphicsGetImageFromCurrentImageContext() ?? image
    UIGraphicsEndImageContext()

    // Применяем мягкий гауссов блюр через CoreImage + затемняющую вуаль в стиле AmbientBackground
    let ciContext = CIContext(options: nil)
    var blurred = scaledImg
    if let ciInput = CIImage(image: scaledImg),
       let filter = CIFilter(name: "CIGaussianBlur") {
      let clamped = ciInput.clampedToExtent()
      filter.setValue(clamped, forKey: kCIInputImageKey)
      filter.setValue(28.0, forKey: kCIInputRadiusKey)
      if let output = filter.outputImage?.cropped(to: ciInput.extent),
         let cgImg = ciContext.createCGImage(output, from: ciInput.extent) {
        blurred = UIImage(cgImage: cgImg)
      }
    }

    UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
    blurred.draw(in: CGRect(origin: .zero, size: size))
    UIColor(white: 0.03, alpha: 0.54).setFill()
    UIRectFillUsingBlendMode(CGRect(origin: .zero, size: size), .normal)
    let finalBg = UIGraphicsGetImageFromCurrentImageContext() ?? blurred
    UIGraphicsEndImageContext()
    return finalBg
  }
}
