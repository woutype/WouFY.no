package expo.modules.woufyfx

import android.content.Context
import android.graphics.*
import android.media.*
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal data class LyricEntry(val time: Double, val text: String)

internal object VideoCardGeneratorAndroid {

  fun dimensions(aspect: String): Pair<Int, Int> {
    return when (aspect) {
      "16:9" -> Pair(1280, 720)
      "9:16" -> Pair(720, 1280)
      "1:1"  -> Pair(960, 960)
      "4:3"  -> Pair(960, 720)
      "3:4"  -> Pair(720, 960)
      else   -> Pair(720, 1280)
    }
  }

  fun generate(
    context: Context,
    params: Map<String, Any>,
    onProgress: (Double) -> Unit
  ): String {
    val audioUri = params["audioUri"] as? String ?: ""
    val artworkUri = params["artworkUri"] as? String
    val title = params["title"] as? String ?: "Без названия"
    val artist = params["artist"] as? String ?: "Неизвестный исполнитель"
    val startSec = (params["startSec"] as? Number)?.toDouble() ?: 0.0
    val endSec = (params["endSec"] as? Number)?.toDouble() ?: 15.0
    val styleMode = params["style"] as? String ?: "underCover"
    val coverShape = params["coverShape"] as? String ?: "square"
    val aspect = params["aspect"] as? String ?: "9:16"
    @Suppress("UNCHECKED_CAST")
    val rawLines = params["lines"] as? List<Map<String, Any>> ?: emptyList()

    val duration = max(3.0, min(60.0, endSec - startSec))
    val (width, height) = dimensions(aspect)
    val fps = 30
    val totalFrames = max(1, (duration * fps).toInt())

    val lines = rawLines.mapNotNull { m ->
      val txt = m["text"] as? String ?: return@mapNotNull null
      val t = (m["time"] as? Number)?.toDouble() ?: 0.0
      LyricEntry(t, txt)
    }

    val coverBmp = loadArtwork(artworkUri, audioUri) ?: makeFallbackArtwork()
    val bgBmp = makeBlurredBackground(coverBmp, width, height)

    val outFile = File(context.cacheDir, "WouFY_Clip_${System.currentTimeMillis()}.mp4")
    if (outFile.exists()) outFile.delete()

    val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

    // Настройка MediaCodec H.264
    val mime = MediaFormat.MIMETYPE_VIDEO_AVC
    val format = MediaFormat.createVideoFormat(mime, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, width * height * 5)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }

    val encoder = MediaCodec.createEncoderByType(mime)
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    val inputSurface = encoder.createInputSurface()
    encoder.start()

    // Подготовка аудио-дорожки (если исходник m4a/aac — копируем напрямую, если mp3 — перегоняем в AAC или оставляем видео)
    val audioFile = parseLocalFile(audioUri)
    var audioExtractor: MediaExtractor? = null
    var muxerAudioTrack = -1
    var sourceAudioTrack = -1

    if (audioFile.exists()) {
      try {
        val ext = MediaExtractor()
        ext.setDataSource(audioFile.absolutePath)
        for (i in 0 until ext.trackCount) {
          val tf = ext.getTrackFormat(i)
          val m = tf.getString(MediaFormat.KEY_MIME) ?: ""
          if (m.startsWith("audio/")) {
            sourceAudioTrack = i
            ext.selectTrack(i)
            muxerAudioTrack = try {
              muxer.addTrack(tf)
            } catch (_: Throwable) {
              -1
            }
            break
          }
        }
        if (muxerAudioTrack >= 0) {
          audioExtractor = ext
        } else {
          ext.release()
        }
      } catch (_: Throwable) {}
    }

    val bufferInfo = MediaCodec.BufferInfo()
    var muxerVideoTrack = -1
    var muxerStarted = false

    fun drainEncoder(endOfStream: Boolean) {
      if (endOfStream) {
        encoder.signalEndOfInputStream()
      }
      while (true) {
        val outIdx = encoder.dequeueOutputBuffer(bufferInfo, 10000L)
        if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
          if (!endOfStream) break
        } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          if (!muxerStarted) {
            muxerVideoTrack = muxer.addTrack(encoder.outputFormat)
            muxer.start()
            muxerStarted = true
          }
        } else if (outIdx >= 0) {
          val encodedData = encoder.getOutputBuffer(outIdx)
          if (encodedData != null && bufferInfo.size > 0 && muxerStarted) {
            if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              encodedData.position(bufferInfo.offset)
              encodedData.limit(bufferInfo.offset + bufferInfo.size)
              muxer.writeSampleData(muxerVideoTrack, encodedData, bufferInfo)
            }
          }
          encoder.releaseOutputBuffer(outIdx, false)
          if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
            break
          }
        }
      }
    }

    for (frameIdx in 0 until totalFrames) {
      val canvas = inputSurface.lockHardwareCanvas()
      try {
        val currentTime = startSec + frameIdx.toDouble() / fps.toDouble()
        val elapsed = frameIdx.toDouble() / fps.toDouble()
        drawFrame(
          canvas = canvas,
          W = width.toFloat(),
          H = height.toFloat(),
          bgBmp = bgBmp,
          coverBmp = coverBmp,
          title = title,
          artist = artist,
          lines = lines,
          currentTime = currentTime,
          elapsed = elapsed,
          styleMode = styleMode,
          coverShape = coverShape
        )
      } finally {
        inputSurface.unlockCanvasAndPost(canvas)
      }

      drainEncoder(false)

      if (frameIdx % 5 == 0 || frameIdx == totalFrames - 1) {
        onProgress((frameIdx + 1).toDouble() / totalFrames.toDouble() * 0.88)
      }
    }

    drainEncoder(true)

    // Дописываем аудио-дорожку, если совместима с MP4 контейнером
    if (muxerStarted && muxerAudioTrack >= 0 && audioExtractor != null) {
      try {
        val startUs = (startSec * 1_000_000.0).toLong()
        val endUs = ((startSec + duration) * 1_000_000.0).toLong()
        audioExtractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
        val buf = ByteBuffer.allocate(256 * 1024)
        val aInfo = MediaCodec.BufferInfo()
        while (true) {
          val sampleSize = audioExtractor.readSampleData(buf, 0)
          if (sampleSize < 0) break
          val sampleTime = audioExtractor.sampleTime
          if (sampleTime > endUs) break
          if (sampleTime >= startUs) {
            aInfo.offset = 0
            aInfo.size = sampleSize
            aInfo.presentationTimeUs = (sampleTime - startUs).coerceAtLeast(0L)
            aInfo.flags = audioExtractor.sampleFlags
            muxer.writeSampleData(muxerAudioTrack, buf, aInfo)
          }
          audioExtractor.advance()
        }
      } catch (_: Throwable) {
      } finally {
        try { audioExtractor.release() } catch (_: Throwable) {}
      }
    }

    try { encoder.stop() } catch (_: Throwable) {}
    try { encoder.release() } catch (_: Throwable) {}
    try { inputSurface.release() } catch (_: Throwable) {}
    if (muxerStarted) {
      try { muxer.stop() } catch (_: Throwable) {}
    }
    try { muxer.release() } catch (_: Throwable) {}

    onProgress(1.0)
    return "file://${outFile.absolutePath}"
  }

  fun generateImage(
    context: Context,
    params: Map<String, Any>
  ): String {
    val audioUri = params["audioUri"] as? String ?: ""
    val artworkUri = params["artworkUri"] as? String
    val title = params["title"] as? String ?: "Без названия"
    val artist = params["artist"] as? String ?: "Неизвестный исполнитель"
    val styleMode = params["style"] as? String ?: "glassQuote"
    val coverShape = params["coverShape"] as? String ?: "square"
    val aspect = params["aspect"] as? String ?: "9:16"
    @Suppress("UNCHECKED_CAST")
    val lines = params["lines"] as? List<String> ?: emptyList()

    val (baseW, baseH) = dimensions(aspect)
    val width = (baseW * 1.5).toInt()
    val height = (baseH * 1.5).toInt()

    val coverBmp = loadArtwork(artworkUri, audioUri) ?: makeFallbackArtwork()
    val bgBmp = makeBlurredBackground(coverBmp, width, height)

    val outBmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(outBmp)
    drawStaticCard(
      canvas = canvas,
      W = width.toFloat(),
      H = height.toFloat(),
      bgBmp = bgBmp,
      coverBmp = coverBmp,
      title = title,
      artist = artist,
      lines = lines,
      styleMode = styleMode,
      coverShape = coverShape
    )

    val outFile = File(context.cacheDir, "WouFY_Card_${System.currentTimeMillis()}.png")
    if (outFile.exists()) outFile.delete()
    outFile.outputStream().use { fos ->
      outBmp.compress(Bitmap.CompressFormat.PNG, 100, fos)
    }
    return "file://${outFile.absolutePath}"
  }

  private fun drawStaticCard(
    canvas: Canvas,
    W: Float,
    H: Float,
    bgBmp: Bitmap,
    coverBmp: Bitmap,
    title: String,
    artist: String,
    lines: List<String>,
    styleMode: String,
    coverShape: String
  ) {
    val minDim = min(W, H)
    val scale = minDim / 720f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    canvas.drawBitmap(bgBmp, null, RectF(0f, 0f, W, H), paint)

    val isLandscape = W > H * 1.15f
    val isSquare = abs(W - H) < 40f

    if (styleMode == "glassQuote") {
      val cardW = if (isLandscape) W * 0.82f else W * 0.86f
      val cardMaxH = H * 0.78f
      val fontSize = minDim * (if (lines.size <= 2) 0.052f else if (lines.size <= 4) 0.044f else 0.038f)

      val joined = lines.joinToString("\n\n")
      val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = fontSize
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      }
      val textPad = 40f * scale
      val headerH = 82f * scale
      val layout = StaticLayout.Builder
        .obtain(joined, 0, joined.length, tp, (cardW - textPad * 2).toInt().coerceAtLeast(10))
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setLineSpacing(4f * scale, 1f)
        .setIncludePad(false)
        .build()

      val cardH = min(cardMaxH, max(240f * scale, headerH + layout.height + textPad * 2.1f))
      val cardRect = RectF((W - cardW) / 2f, (H - cardH) / 2f - H * 0.02f, (W + cardW) / 2f, (H + cardH) / 2f - H * 0.02f)

      val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(170, 20, 20, 24)
        style = Paint.Style.FILL
      }
      val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(56, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 2f * scale
      }
      canvas.drawRoundRect(cardRect, 38f * scale, 38f * scale, bgPaint)
      canvas.drawRoundRect(cardRect, 38f * scale, 38f * scale, strokePaint)

      val thumbSize = 56f * scale
      val thumbRect = RectF(cardRect.left + textPad, cardRect.top + textPad * 0.85f, cardRect.left + textPad + thumbSize, cardRect.top + textPad * 0.85f + thumbSize)
      canvas.save()
      val rThumb = if (coverShape == "vinyl") thumbSize / 2f else 14f * scale
      val clip = Path().apply { addRoundRect(thumbRect, rThumb, rThumb, Path.Direction.CW) }
      canvas.clipPath(clip)
      canvas.drawBitmap(coverBmp, null, thumbRect, paint)
      canvas.restore()

      val metaX = thumbRect.right + 16f * scale
      val metaW = cardRect.right - metaX - textPad
      val tPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 20f * scale
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      }
      val aPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(160, 255, 255, 255)
        textSize = 15f * scale
      }
      canvas.drawText(TextUtils.ellipsize(title, tPaint, metaW, TextUtils.TruncateAt.END).toString(), metaX, thumbRect.top + 26f * scale, tPaint)
      canvas.drawText(TextUtils.ellipsize(artist, aPaint, metaW, TextUtils.TruncateAt.END).toString(), metaX, thumbRect.top + 48f * scale, aPaint)

      val divY = thumbRect.bottom + 20f * scale
      val divPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(32, 255, 255, 255)
        strokeWidth = 1.2f * scale
      }
      canvas.drawLine(cardRect.left + textPad, divY, cardRect.right - textPad, divY, divPaint)

      canvas.save()
      canvas.translate(cardRect.left + textPad, divY + 20f * scale)
      layout.draw(canvas)
      canvas.restore()

    } else if (styleMode == "textOnly") {
      drawHeaderPill(canvas, coverBmp, title, artist, W / 2f, H * 0.08f, W * 0.84f, scale)
      drawStaticLinesList(canvas, RectF(W * 0.09f, H * 0.20f, W * 0.91f, H * 0.88f), lines, minDim * 0.052f, true)
    } else if (styleMode == "inCover") {
      val coverSize = if (isLandscape) H * 0.76f else if (isSquare) minDim * 0.78f else W * 0.82f
      val coverX = (W - coverSize) / 2f
      val coverY = if (isLandscape) (H - coverSize) / 2f - H * 0.02f else H * 0.10f
      val coverRect = RectF(coverX, coverY, coverX + coverSize, coverY + coverSize)
      drawCover(canvas, coverRect, coverBmp, coverShape, 0.0, 0.58f)
      val inset = coverSize * 0.10f
      drawStaticLinesList(canvas, RectF(coverRect.left + inset, coverRect.top + inset, coverRect.right - inset, coverRect.bottom - inset), lines, coverSize * 0.062f, true)
      drawTrackMeta(canvas, title, artist, RectF(W * 0.08f, coverRect.bottom + H * 0.03f, W * 0.92f, coverRect.bottom + H * 0.13f), scale, true)
    } else {
      if (isLandscape) {
        val coverSize = H * 0.64f
        val leftMargin = W * 0.07f
        val coverY = (H - coverSize) / 2f - H * 0.04f
        val coverRect = RectF(leftMargin, coverY, leftMargin + coverSize, coverY + coverSize)
        drawCover(canvas, coverRect, coverBmp, coverShape, 0.0, 0f)
        drawTrackMeta(canvas, title, artist, RectF(leftMargin, coverRect.bottom + H * 0.025f, leftMargin + coverSize, coverRect.bottom + H * 0.145f), scale, true)
        drawStaticLinesList(canvas, RectF(coverRect.right + W * 0.06f, H * 0.12f, W * 0.94f, H * 0.86f), lines, minDim * 0.046f, false)
      } else {
        val coverSize = if (isSquare) minDim * 0.38f else minDim * 0.42f
        val coverX = (W - coverSize) / 2f
        val coverY = H * 0.07f
        val coverRect = RectF(coverX, coverY, coverX + coverSize, coverY + coverSize)
        drawCover(canvas, coverRect, coverBmp, coverShape, 0.0, 0f)
        val metaY = coverRect.bottom + H * 0.02f
        val metaH = H * 0.075f
        drawTrackMeta(canvas, title, artist, RectF(W * 0.08f, metaY, W * 0.92f, metaY + metaH), scale, true)
        drawStaticLinesList(canvas, RectF(W * 0.08f, metaY + metaH + H * 0.015f, W * 0.92f, H * 0.89f), lines, minDim * 0.046f, true)
      }
    }

    drawWatermarkPill(canvas, W, H, scale, "WouFY Card")
  }

  private fun drawStaticLinesList(
    canvas: Canvas,
    rect: RectF,
    lines: List<String>,
    baseFontSize: Float,
    centered: Boolean
  ) {
    if (lines.isEmpty()) return
    canvas.save()
    canvas.clipRect(rect)
    val countFactor = if (lines.size <= 2) 1.05f else if (lines.size <= 4) 0.90f else 0.76f
    val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = baseFontSize * countFactor
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    val joined = lines.joinToString("\n\n")
    val align = if (centered) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL
    val layout = StaticLayout.Builder
      .obtain(joined, 0, joined.length, tp, rect.width().toInt().coerceAtLeast(10))
      .setAlignment(align)
      .setLineSpacing(4f, 1f)
      .setIncludePad(false)
      .build()
    val drawY = max(rect.top, rect.centerY() - layout.height / 2f)
    canvas.translate(rect.left, drawY)
    layout.draw(canvas)
    canvas.restore()
  }

  private fun drawFrame(
    canvas: Canvas,
    W: Float,
    H: Float,
    bgBmp: Bitmap,
    coverBmp: Bitmap,
    title: String,
    artist: String,
    lines: List<LyricEntry>,
    currentTime: Double,
    elapsed: Double,
    styleMode: String,
    coverShape: String
  ) {
    val minDim = min(W, H)
    val scale = minDim / 720f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

    // 1. Фон
    canvas.drawBitmap(bgBmp, null, RectF(0f, 0f, W, H), paint)

    val isLandscape = W > H * 1.15f
    val isSquare = abs(W - H) < 40f

    var activeIdx = 0
    for (i in lines.indices) {
      if (currentTime + 0.1 >= lines[i].time) {
        activeIdx = i
      } else {
        break
      }
    }

    var transition = 1f
    if (lines.isNotEmpty() && activeIdx < lines.size) {
      val since = max(0.0, currentTime - lines[activeIdx].time).toFloat()
      val t = min(1f, since / 0.42f)
      val inv = 1f - t
      transition = 1f - inv * inv * inv
    }

    if (styleMode == "textOnly") {
      drawHeaderPill(canvas, coverBmp, title, artist, W / 2f, H * 0.08f, W * 0.84f, scale)
      drawLyricsBlock(
        canvas = canvas,
        rect = RectF(W * 0.08f, H * 0.20f, W * 0.92f, H * 0.86f),
        lines = lines,
        activeIdx = activeIdx,
        transition = transition,
        fontSize = minDim * 0.056f,
        centered = true
      )
    } else if (styleMode == "inCover") {
      val coverSize = if (isLandscape) H * 0.76f else if (isSquare) minDim * 0.78f else W * 0.82f
      val coverX = (W - coverSize) / 2f
      val coverY = if (isLandscape) (H - coverSize) / 2f - H * 0.02f else H * 0.11f
      val coverRect = RectF(coverX, coverY, coverX + coverSize, coverY + coverSize)

      drawCover(canvas, coverRect, coverBmp, coverShape, elapsed, 0.56f)

      val inset = coverSize * 0.10f
      val innerRect = RectF(coverRect.left + inset, coverRect.top + inset, coverRect.right - inset, coverRect.bottom - inset)
      drawLyricsBlock(
        canvas = canvas,
        rect = innerRect,
        lines = lines,
        activeIdx = activeIdx,
        transition = transition,
        fontSize = coverSize * 0.068f,
        centered = true
      )

      drawTrackMeta(
        canvas = canvas,
        title = title,
        artist = artist,
        rect = RectF(W * 0.08f, coverRect.bottom + H * 0.03f, W * 0.92f, coverRect.bottom + H * 0.13f),
        scale = scale,
        centered = true
      )
    } else {
      if (isLandscape) {
        val coverSize = H * 0.64f
        val leftMargin = W * 0.07f
        val coverY = (H - coverSize) / 2f - H * 0.04f
        val coverRect = RectF(leftMargin, coverY, leftMargin + coverSize, coverY + coverSize)

        drawCover(canvas, coverRect, coverBmp, coverShape, elapsed, 0f)
        drawTrackMeta(
          canvas = canvas,
          title = title,
          artist = artist,
          rect = RectF(leftMargin, coverRect.bottom + H * 0.025f, leftMargin + coverSize, coverRect.bottom + H * 0.145f),
          scale = scale,
          centered = true
        )

        val rightX = coverRect.right + W * 0.06f
        val lyricsRect = RectF(rightX, H * 0.14f, W * 0.94f, H * 0.84f)
        drawLyricsBlock(
          canvas = canvas,
          rect = lyricsRect,
          lines = lines,
          activeIdx = activeIdx,
          transition = transition,
          fontSize = minDim * 0.052f,
          centered = false
        )
      } else {
        val coverSize = if (isSquare) minDim * 0.44f else W * 0.56f
        val metaH = minDim * 0.095f
        val coverToMetaGap = H * 0.020f
        val metaToLyricsGap = H * 0.024f
        val fontSize = minDim * 0.052f
        val lyricsH = fontSize * 2.45f * 2.5f

        val totalStackH = coverSize + coverToMetaGap + metaH + metaToLyricsGap + lyricsH
        val topY = maxOf(H * 0.06f, (H * 0.90f - totalStackH) / 2f)

        val coverX = (W - coverSize) / 2f
        val coverRect = RectF(coverX, topY, coverX + coverSize, topY + coverSize)

        drawCover(canvas, coverRect, coverBmp, coverShape, elapsed, 0f)

        val metaY = coverRect.bottom + coverToMetaGap
        drawTrackMeta(
          canvas = canvas,
          title = title,
          artist = artist,
          rect = RectF(W * 0.08f, metaY, W * 0.92f, metaY + metaH),
          scale = minDim / 640f,
          centered = true
        )

        val lyricsTop = metaY + metaH + metaToLyricsGap
        val lyricsRect = RectF(W * 0.08f, lyricsTop, W * 0.92f, lyricsTop + lyricsH)
        drawLyricsBlock(
          canvas = canvas,
          rect = lyricsRect,
          lines = lines,
          activeIdx = activeIdx,
          transition = transition,
          fontSize = fontSize,
          centered = true
        )
      }
    }

    drawWatermarkPill(canvas, W, H, scale)
  }

  private fun drawCover(
    canvas: Canvas,
    rect: RectF,
    bmp: Bitmap,
    shape: String,
    elapsed: Double,
    darkenOverlay: Float
  ) {
    canvas.save()
    val isVinyl = shape == "vinyl"
    val radius = if (isVinyl) rect.width() / 2f else rect.width() * 0.09f

    val path = Path().apply {
      addRoundRect(rect, radius, radius, Path.Direction.CW)
    }
    canvas.clipPath(path)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    if (isVinyl) {
      val deg = ((elapsed * (360.0 / 7.5)) % 360.0).toFloat()
      canvas.save()
      canvas.rotate(deg, rect.centerX(), rect.centerY())
      canvas.drawBitmap(bmp, null, rect, paint)
      canvas.restore()
    } else {
      canvas.drawBitmap(bmp, null, rect, paint)
    }

    if (darkenOverlay > 0.01f) {
      val darkPaint = Paint().apply {
        color = Color.argb((darkenOverlay * 255).toInt(), 10, 10, 12)
      }
      canvas.drawRect(rect, darkPaint)
    }

    val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 3f
      color = Color.argb(56, 255, 255, 255)
    }
    canvas.drawRoundRect(rect, radius, radius, borderPaint)
    canvas.restore()
  }

  private fun drawLyricsBlock(
    canvas: Canvas,
    rect: RectF,
    lines: List<LyricEntry>,
    activeIdx: Int,
    transition: Float,
    fontSize: Float,
    centered: Boolean
  ) {
    if (lines.isEmpty()) return
    canvas.save()
    canvas.clipRect(rect)

    val centerY = rect.centerY()
    val slotStep = fontSize * 2.45f
    val slideOffset = (1f - transition) * (slotStep * 0.42f)

    for (idx in listOf(activeIdx - 1, activeIdx, activeIdx + 1)) {
      if (idx < 0 || idx >= lines.size) continue
      val dist = idx - activeIdx
      val isCurrent = dist == 0
      val scale = if (isCurrent) (0.94f + 0.06f * transition) else 0.84f
      val alpha = if (isCurrent) ((0.55f + 0.45f * transition) * 255).toInt() else (0.34f * 255).toInt()

      val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(alpha.coerceIn(0, 255), 255, 255, 255)
        textSize = fontSize * scale
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      }

      val align = if (centered) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL
      val layout = StaticLayout.Builder
        .obtain(lines[idx].text, 0, lines[idx].text.length, tp, rect.width().toInt().coerceAtLeast(10))
        .setAlignment(align)
        .setIncludePad(false)
        .build()

      val targetY = centerY + dist * slotStep + slideOffset - layout.height / 2f
      canvas.save()
      canvas.translate(rect.left, targetY)
      layout.draw(canvas)
      canvas.restore()
    }

    canvas.restore()
  }

  private fun drawTrackMeta(
    canvas: Canvas,
    title: String,
    artist: String,
    rect: RectF,
    scale: Float,
    centered: Boolean
  ) {
    val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = 24f * scale
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      textAlign = if (centered) Paint.Align.CENTER else Paint.Align.LEFT
    }
    val artistPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(160, 255, 255, 255)
      textSize = 17f * scale
      textAlign = if (centered) Paint.Align.CENTER else Paint.Align.LEFT
    }

    val x = if (centered) rect.centerX() else rect.left
    val truncTitle = TextUtils.ellipsize(title, titlePaint, rect.width(), TextUtils.TruncateAt.END).toString()
    val truncArtist = TextUtils.ellipsize(artist, artistPaint, rect.width(), TextUtils.TruncateAt.END).toString()

    canvas.drawText(truncTitle, x, rect.top + 24f * scale, titlePaint)
    canvas.drawText(truncArtist, x, rect.top + 50f * scale, artistPaint)
  }

  private fun drawHeaderPill(
    canvas: Canvas,
    cover: Bitmap,
    title: String,
    artist: String,
    centerX: Float,
    topY: Float,
    maxWidth: Float,
    scale: Float
  ) {
    val pillH = 62f * scale
    val pillW = min(maxWidth, 420f * scale)
    val rect = RectF(centerX - pillW / 2f, topY, centerX + pillW / 2f, topY + pillH)

    val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(28, 255, 255, 255)
      style = Paint.Style.FILL
    }
    canvas.drawRoundRect(rect, pillH / 2f, pillH / 2f, bgPaint)

    val thumbSize = pillH - 12f * scale
    val thumbRect = RectF(rect.left + 6f * scale, rect.top + 6f * scale, rect.left + 6f * scale + thumbSize, rect.top + 6f * scale + thumbSize)
    canvas.save()
    val clip = Path().apply { addRoundRect(thumbRect, thumbSize / 2f, thumbSize / 2f, Path.Direction.CW) }
    canvas.clipPath(clip)
    canvas.drawBitmap(cover, null, thumbRect, Paint(Paint.FILTER_BITMAP_FLAG))
    canvas.restore()

    val textX = thumbRect.right + 12f * scale
    val tPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = 16f * scale
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
    val aPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(160, 255, 255, 255)
      textSize = 13f * scale
    }
    val maxW = rect.right - textX - 14f * scale
    canvas.drawText(TextUtils.ellipsize(title, tPaint, maxW, TextUtils.TruncateAt.END).toString(), textX, rect.top + 26f * scale, tPaint)
    canvas.drawText(TextUtils.ellipsize(artist, aPaint, maxW, TextUtils.TruncateAt.END).toString(), textX, rect.top + 46f * scale, aPaint)
  }

  private fun drawWatermarkPill(canvas: Canvas, W: Float, H: Float, scale: Float, labelText: String = "WouFY Clip") {
    val pillW = 160f * scale
    val pillH = 30f * scale
    val rect = RectF((W - pillW) / 2f, H - pillH - H * 0.035f, (W + pillW) / 2f, H - H * 0.035f)
    val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(26, 255, 255, 255)
    }
    canvas.drawRoundRect(rect, pillH / 2f, pillH / 2f, bgPaint)
    val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.argb(200, 255, 255, 255)
      textSize = 12f * scale
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      textAlign = Paint.Align.CENTER
    }
    canvas.drawText(labelText, rect.centerX(), rect.centerY() + 4f * scale, tp)
  }

  private fun loadArtwork(artworkUri: String?, audioUri: String): Bitmap? {
    if (!artworkUri.isNullOrEmpty()) {
      val f = parseLocalFile(artworkUri)
      if (f.exists()) {
        BitmapFactory.decodeFile(f.absolutePath)?.let { return it }
      }
    }
    val af = parseLocalFile(audioUri)
    if (af.exists()) {
      val ret = MediaMetadataRetriever()
      try {
        ret.setDataSource(af.absolutePath)
        val pic = ret.embeddedPicture
        if (pic != null) return BitmapFactory.decodeByteArray(pic, 0, pic.size)
      } catch (_: Throwable) {
      } finally {
        try { ret.release() } catch (_: Throwable) {}
      }
    }
    return null
  }

  private fun makeFallbackArtwork(): Bitmap {
    val bmp = Bitmap.createBitmap(400, 400, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    c.drawColor(Color.rgb(28, 28, 34))
    return bmp
  }

  private fun makeBlurredBackground(src: Bitmap, width: Int, height: Int): Bitmap {
    // Быстрое и качественное размытие через масштабирование вниз и плавный билинейный апскейл + тёмная вуаль
    val smallW = 48
    val smallH = max(1, (smallW * height) / max(1, width))
    val tiny = Bitmap.createScaledBitmap(src, smallW, smallH, true)
    val blurred = Bitmap.createScaledBitmap(tiny, width, height, true)
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    val scale = max(width.toFloat() / blurred.width, height.toFloat() / blurred.height) * 1.2f
    val dw = blurred.width * scale
    val dh = blurred.height * scale
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    c.drawBitmap(blurred, null, RectF((width - dw) / 2f, (height - dh) / 2f, (width + dw) / 2f, (height + dh) / 2f), paint)
    c.drawColor(Color.argb(145, 8, 8, 10))
    return out
  }
}
