package expo.modules.woufyfx

import android.content.Context
import android.graphics.*
import android.media.*
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLUtils
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal data class LyricEntry(val time: Double, val text: String)

/**
 * Плавная «лента» текста для видео — та же логика, что во вкладке «Текст» основного плеера:
 * пружина damping 22 / stiffness 240 / mass 0.7, активная строка 1.03, остальные 0.95,
 * прозрачность падает с расстоянием до активной строки [1, .62, .46, .34, .26, .2].
 * Видео рендерится покадрово, поэтому пружина интегрируется детерминированно (шаг 1/480 с).
 */
internal class LyricsAnimator(private val lines: List<LyricEntry>, startTime: Double) {
  private val mass = 0.7
  private val stiffness = 240.0
  private val damping = 22.0
  private val distOpacity = floatArrayOf(1f, 0.62f, 0.46f, 0.34f, 0.26f, 0.2f)

  private var simTime = startTime
  private var targetTime = startTime
  private var focusVel = 0.0
  var focus: Double = activeIndexAt(startTime).toDouble()
    private set
  private var scrollY = 0.0
  private var scrollVel = 0.0
  private var scrollInitialized = false
  private val lineAct = DoubleArray(lines.size) { if (it == activeIndexAt(startTime)) 1.0 else 0.0 }
  private val lineVel = DoubleArray(lines.size)

  private class Built(val paint: TextPaint, val layouts: List<StaticLayout>)
  private val built = HashMap<String, Built>()

  /** Как activeLineIndex() в плеере: строка включается чуть раньше своего времени (lookahead 0.12 с) */
  private fun activeIndexAt(t: Double): Int {
    var idx = 0
    for (i in lines.indices) {
      if (t + 0.12 >= lines[i].time) idx = i else break
    }
    return idx
  }

  fun advance(t: Double) {
    targetTime = max(targetTime, t)
  }

  private fun stepSimulation(t: Double, centers: FloatArray) {
    if (lines.isEmpty()) return
    val n = lines.size
    val idx0 = activeIndexAt(simTime).coerceIn(0, n - 1)
    if (!scrollInitialized) {
      scrollY = centers[idx0].toDouble()
      scrollInitialized = true
    }
    if (t <= simTime) return
    val h = 1.0 / 480.0
    while (simTime < t) {
      val activeIdx = activeIndexAt(simTime).coerceIn(0, n - 1)
      val targetF = activeIdx.toDouble()
      val accF = (stiffness * (targetF - focus) - damping * focusVel) / mass
      focusVel += accF * h
      focus += focusVel * h

      val targetY = centers[activeIdx].toDouble()
      val accY = (stiffness * (targetY - scrollY) - damping * scrollVel) / mass
      scrollVel += accY * h
      scrollY += scrollVel * h

      for (i in 0 until n) {
        val targetA = if (i == activeIdx) 1.0 else 0.0
        val accA = (stiffness * (targetA - lineAct[i]) - damping * lineVel[i]) / mass
        lineVel[i] += accA * h
        lineAct[i] += lineVel[i] * h
      }

      simTime += h
    }
  }

  private fun opacityFor(d: Double): Float {
    if (d <= 0.0) return distOpacity[0]
    if (d >= 5.0) return distOpacity[5]
    val lo = d.toInt()
    val frac = (d - lo).toFloat()
    return distOpacity[lo] + (distOpacity[lo + 1] - distOpacity[lo]) * frac
  }

  fun draw(canvas: Canvas, rect: RectF, fontSize: Float, centered: Boolean) {
    if (lines.isEmpty()) return
    // Запас по ширине под масштаб 1.03, чтобы активная строка не переносилась иначе, чем неактивная
    val layoutW = max(10, (rect.width() / 1.06f).toInt())
    val key = "$layoutW-${(fontSize * 10f).toInt()}-$centered"
    val b = built.getOrPut(key) {
      val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textSize = fontSize
        letterSpacing = -0.018f
        color = Color.WHITE
      }
      val align = if (centered) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL
      Built(
        paint,
        lines.map {
          StaticLayout.Builder
            .obtain(it.text, 0, it.text.length, paint, layoutW)
            .setAlignment(align)
            .setIncludePad(false)
            .setLineSpacing(fontSize * 0.08f, 1f)
            .build()
        }
      )
    }

    val gap = fontSize * 0.56f
    val n = lines.size
    val centers = FloatArray(n)
    var y = 0f
    for (i in 0 until n) {
      val h = b.layouts[i].height.toFloat()
      centers[i] = y + h / 2f
      y += h + gap
    }

    stepSimulation(targetTime, centers)

    val curScrollY = scrollY.toFloat()
    val fadeZone = max(fontSize * 1.15f, rect.height() * 0.15f)

    canvas.save()
    canvas.clipRect(rect)
    for (i in 0 until n) {
      val layout = b.layouts[i]
      val h = layout.height.toFloat()
      val cy = rect.centerY() + (centers[i] - curScrollY)
      if (cy + h * 0.55f < rect.top || cy - h * 0.55f > rect.bottom) continue

      val a = lineAct[i].coerceIn(0.0, 1.0).toFloat()
      val s = 0.95f + 0.08f * lineAct[i].coerceIn(0.0, 1.05).toFloat()
      val d = max(1.0, abs(i - focus))
      val rest = opacityFor(d)
      val baseAlpha = rest + (1f - rest) * a

      val lineTop = cy - h * 0.45f
      val lineBot = cy + h * 0.45f
      val rawTop = (lineTop - rect.top + fontSize * 0.35f) / fadeZone
      val rawBot = (rect.bottom - lineBot + fontSize * 0.35f) / fadeZone
      val tEdge = min(rawTop, rawBot).coerceIn(0f, 1f)
      val edgeFade = tEdge * tEdge * (3f - 2f * tEdge)

      val alpha = baseAlpha * edgeFade
      if (alpha < 0.01f) continue

      b.paint.alpha = (alpha * 255f).toInt().coerceIn(0, 255)
      canvas.save()
      canvas.translate(if (centered) rect.centerX() else rect.left, cy)
      canvas.scale(s, s)
      canvas.translate(if (centered) -layoutW / 2f else 0f, -h / 2f)
      layout.draw(canvas)
      canvas.restore()
    }
    canvas.restore()
  }
}

private class FrameRenderCache {
  val boldTypeface: Typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  var lyrics: LyricsAnimator? = null
  val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  val pillBitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  val darkPaint = Paint()
  val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 3f
    color = Color.argb(56, 255, 255, 255)
  }
  val lyricPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    typeface = boldTypeface
  }
  val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    typeface = boldTypeface
  }
  val artistPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(160, 255, 255, 255)
  }
  val pillBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
  }
  val watermarkPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(200, 255, 255, 255)
    typeface = boldTypeface
    textAlign = Paint.Align.CENTER
  }
  val clipPath = Path()
  val bgRect = RectF()
  val coverRect = RectF()
  val innerRect = RectF()
  val metaRect = RectF()
  val lyricsRect = RectF()
  val pillRect = RectF()
  val thumbRect = RectF()
  val watermarkRect = RectF()
}

private class EglBitmapSurfaceRenderer(
  private val surface: Surface,
  private val width: Int,
  private val height: Int
) {
  private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
  private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
  private var program = 0
  private var textureId = 0
  private var posHandle = 0
  private var texHandle = 0
  private var texInitialized = false

  private val vertexBuffer: FloatBuffer = ByteBuffer.allocateDirect(16 * 4)
    .order(ByteOrder.nativeOrder())
    .asFloatBuffer()
    .apply {
      put(floatArrayOf(
        // x, y, u, v (flip V so Bitmap top-left maps to GL top-left)
        -1f, -1f, 0f, 1f,
         1f, -1f, 1f, 1f,
        -1f,  1f, 0f, 0f,
         1f,  1f, 1f, 0f
      ))
      position(0)
    }

  init {
    eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    if (eglDisplay == EGL14.EGL_NO_DISPLAY) throw RuntimeException("eglGetDisplay failed")
    val version = IntArray(2)
    if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) {
      throw RuntimeException("eglInitialize failed")
    }
    val attribList = intArrayOf(
      EGL14.EGL_RED_SIZE, 8,
      EGL14.EGL_GREEN_SIZE, 8,
      EGL14.EGL_BLUE_SIZE, 8,
      EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      0x3142, 1, // EGL_RECORDABLE_ANDROID
      EGL14.EGL_NONE
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val numConfigs = IntArray(1)
    if (!EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, 1, numConfigs, 0) || configs[0] == null) {
      throw RuntimeException("eglChooseConfig failed")
    }
    val ctxAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
    eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, ctxAttribs, 0)
    if (eglContext == EGL14.EGL_NO_CONTEXT) throw RuntimeException("eglCreateContext failed")
    val surfAttribs = intArrayOf(EGL14.EGL_NONE)
    eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], surface, surfAttribs, 0)
    if (eglSurface == EGL14.EGL_NO_SURFACE) throw RuntimeException("eglCreateWindowSurface failed")
    if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) {
      throw RuntimeException("eglMakeCurrent failed")
    }

    val vs = compileShader(
      GLES20.GL_VERTEX_SHADER,
      "attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex; void main() { gl_Position = vec4(aPos, 0.0, 1.0); vTex = aTex; }"
    )
    val fs = compileShader(
      GLES20.GL_FRAGMENT_SHADER,
      "precision mediump float; uniform sampler2D uTex; varying vec2 vTex; void main() { gl_FragColor = texture2D(uTex, vTex); }"
    )
    program = GLES20.glCreateProgram()
    GLES20.glAttachShader(program, vs)
    GLES20.glAttachShader(program, fs)
    GLES20.glLinkProgram(program)
    GLES20.glDeleteShader(vs)
    GLES20.glDeleteShader(fs)

    posHandle = GLES20.glGetAttribLocation(program, "aPos")
    texHandle = GLES20.glGetAttribLocation(program, "aTex")

    val texIds = IntArray(1)
    GLES20.glGenTextures(1, texIds, 0)
    textureId = texIds[0]
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
  }

  private fun compileShader(type: Int, src: String): Int {
    val shader = GLES20.glCreateShader(type)
    GLES20.glShaderSource(shader, src)
    GLES20.glCompileShader(shader)
    return shader
  }

  fun drawBitmap(bitmap: Bitmap, ptsNs: Long) {
    GLES20.glViewport(0, 0, width, height)
    GLES20.glUseProgram(program)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureId)
    if (!texInitialized) {
      GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
      texInitialized = true
    } else {
      GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bitmap)
    }

    vertexBuffer.position(0)
    GLES20.glEnableVertexAttribArray(posHandle)
    GLES20.glVertexAttribPointer(posHandle, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)

    vertexBuffer.position(2)
    GLES20.glEnableVertexAttribArray(texHandle)
    GLES20.glVertexAttribPointer(texHandle, 2, GLES20.GL_FLOAT, false, 16, vertexBuffer)

    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

    EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs)
    EGL14.eglSwapBuffers(eglDisplay, eglSurface)
  }

  fun release() {
    if (textureId != 0) {
      GLES20.glDeleteTextures(1, intArrayOf(textureId), 0)
      textureId = 0
    }
    if (program != 0) {
      GLES20.glDeleteProgram(program)
      program = 0
    }
    if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, eglSurface)
      if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(eglDisplay, eglContext)
      EGL14.eglTerminate(eglDisplay)
    }
    eglSurface = EGL14.EGL_NO_SURFACE
    eglContext = EGL14.EGL_NO_CONTEXT
    eglDisplay = EGL14.EGL_NO_DISPLAY
  }
}

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
    val fps = 60
    val totalFrames = max(1, (duration * fps).toInt())

    val lines = rawLines.mapNotNull { m ->
      val txt = m["text"] as? String ?: return@mapNotNull null
      val t = (m["time"] as? Number)?.toDouble() ?: 0.0
      LyricEntry(t, txt)
    }

    val coverBmp = loadArtwork(artworkUri, audioUri) ?: makeFallbackArtwork()
    val bgBmp = makeBlurredBackground(coverBmp, width, height)
    val frameBmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val frameCanvas = Canvas(frameBmp)
    val renderCache = FrameRenderCache()
    renderCache.lyrics = LyricsAnimator(lines, startSec)

    val outFile = File(context.cacheDir, "WouFY_Clip_${System.currentTimeMillis()}.mp4")
    if (outFile.exists()) outFile.delete()

    var muxer: MediaMuxer? = null
    var encoder: MediaCodec? = null
    var inputSurface: Surface? = null
    var eglRenderer: EglBitmapSurfaceRenderer? = null
    var audioExtractor: MediaExtractor? = null
    var muxerStarted = false
    var videoSampleCount = 0

    try {
      val localMuxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = localMuxer

      // Настройка MediaCodec H.264
      val mime = MediaFormat.MIMETYPE_VIDEO_AVC
      val format = MediaFormat.createVideoFormat(mime, width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(MediaFormat.KEY_BIT_RATE, width * height * 9)
        setInteger(MediaFormat.KEY_FRAME_RATE, fps)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }

      val localEncoder = MediaCodec.createEncoderByType(mime)
      encoder = localEncoder
      localEncoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      val localSurface = localEncoder.createInputSurface()
      inputSurface = localSurface
      localEncoder.start()
      val localEgl = EglBitmapSurfaceRenderer(localSurface, width, height)
      eglRenderer = localEgl

      // Подготовка аудио-дорожки (если исходник m4a/aac — копируем напрямую, если mp3 — перегоняем в AAC или оставляем видео)
      val audioFile = parseLocalFile(audioUri)
      var muxerAudioTrack = -1
      var audioMaxInputSize = 256 * 1024

      if (audioFile.exists()) {
        try {
          val ext = MediaExtractor()
          ext.setDataSource(audioFile.absolutePath)
          for (i in 0 until ext.trackCount) {
            val tf = ext.getTrackFormat(i)
            val m = tf.getString(MediaFormat.KEY_MIME) ?: ""
            if (m.startsWith("audio/")) {
              ext.selectTrack(i)
              if (tf.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                audioMaxInputSize = max(audioMaxInputSize, tf.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
              }
              muxerAudioTrack = try {
                localMuxer.addTrack(tf)
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

      fun drainEncoder(endOfStream: Boolean) {
        if (endOfStream) {
          localEncoder.signalEndOfInputStream()
        }
        var eosRetries = 0
        while (true) {
          val outIdx = localEncoder.dequeueOutputBuffer(bufferInfo, 10000L)
          if (outIdx == MediaCodec.INFO_TRY_AGAIN_LATER) {
            if (!endOfStream) break
            if (++eosRetries > 200) break
          } else if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            if (!muxerStarted) {
              muxerVideoTrack = localMuxer.addTrack(localEncoder.outputFormat)
              localMuxer.start()
              muxerStarted = true
            }
          } else if (outIdx >= 0) {
            eosRetries = 0
            val encodedData = localEncoder.getOutputBuffer(outIdx)
            if (encodedData != null && bufferInfo.size > 0 && muxerStarted) {
              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                encodedData.position(bufferInfo.offset)
                encodedData.limit(bufferInfo.offset + bufferInfo.size)
                localMuxer.writeSampleData(muxerVideoTrack, encodedData, bufferInfo)
                videoSampleCount++
              }
            }
            localEncoder.releaseOutputBuffer(outIdx, false)
            if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
              break
            }
          }
        }
      }

      val frameDurationNs = 1_000_000_000L / fps.toLong()
      for (frameIdx in 0 until totalFrames) {
        val currentTime = startSec + frameIdx.toDouble() / fps.toDouble()
        val elapsed = frameIdx.toDouble() / fps.toDouble()
        renderCache.lyrics?.advance(currentTime)
        drawFrame(
          canvas = frameCanvas,
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
          coverShape = coverShape,
          cache = renderCache
        )
        localEgl.drawBitmap(frameBmp, frameIdx.toLong() * frameDurationNs)

        drainEncoder(false)

        if (frameIdx % 5 == 0 || frameIdx == totalFrames - 1) {
          onProgress((frameIdx + 1).toDouble() / totalFrames.toDouble() * 0.88)
        }
      }

      drainEncoder(true)

      // Дописываем аудио-дорожку, если совместима с MP4 контейнером
      val ext = audioExtractor
      if (muxerStarted && muxerAudioTrack >= 0 && ext != null) {
        try {
          val startUs = (startSec * 1_000_000.0).toLong()
          val endUs = ((startSec + duration) * 1_000_000.0).toLong()
          ext.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
          var buf = ByteBuffer.allocate(audioMaxInputSize)
          val aInfo = MediaCodec.BufferInfo()
          while (true) {
            val sampleSize = try {
              ext.readSampleData(buf, 0)
            } catch (_: IllegalArgumentException) {
              buf = ByteBuffer.allocate(buf.capacity() * 2)
              ext.readSampleData(buf, 0)
            }
            if (sampleSize < 0) break
            val sampleTime = ext.sampleTime
            if (sampleTime > endUs) break
            if (sampleTime >= startUs) {
              aInfo.offset = 0
              aInfo.size = sampleSize
              aInfo.presentationTimeUs = (sampleTime - startUs).coerceAtLeast(0L)
              aInfo.flags = ext.sampleFlags
              localMuxer.writeSampleData(muxerAudioTrack, buf, aInfo)
            }
            ext.advance()
          }
        } catch (_: Throwable) {}
      }
    } finally {
      try { audioExtractor?.release() } catch (_: Throwable) {}
      try { eglRenderer?.release() } catch (_: Throwable) {}
      try { encoder?.stop() } catch (_: Throwable) {}
      try { encoder?.release() } catch (_: Throwable) {}
      try { inputSurface?.release() } catch (_: Throwable) {}
      if (muxerStarted && videoSampleCount > 0) {
        try { muxer?.stop() } catch (_: Throwable) {}
      }
      try { muxer?.release() } catch (_: Throwable) {}
      try { frameBmp.recycle() } catch (_: Throwable) {}
      try { bgBmp.recycle() } catch (_: Throwable) {}
      try { coverBmp.recycle() } catch (_: Throwable) {}
    }

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
    val outFile = File(context.cacheDir, "WouFY_Card_${System.currentTimeMillis()}.png")

    try {
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

      if (outFile.exists()) outFile.delete()
      outFile.outputStream().use { fos ->
        outBmp.compress(Bitmap.CompressFormat.PNG, 100, fos)
      }
    } finally {
      try { outBmp.recycle() } catch (_: Throwable) {}
      try { bgBmp.recycle() } catch (_: Throwable) {}
      try { coverBmp.recycle() } catch (_: Throwable) {}
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
      canvas.clipRect(cardRect)
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
    coverShape: String,
    cache: FrameRenderCache = FrameRenderCache()
  ) {
    val minDim = min(W, H)
    val scale = minDim / 720f

    // 1. Фон
    cache.bgRect.set(0f, 0f, W, H)
    canvas.drawBitmap(bgBmp, null, cache.bgRect, cache.bitmapPaint)

    val isLandscape = W > H * 1.15f
    val isSquare = abs(W - H) < 40f

    if (styleMode == "textOnly") {
      drawHeaderPill(canvas, coverBmp, title, artist, W / 2f, H * 0.08f, W * 0.84f, scale, cache)
      cache.lyricsRect.set(W * 0.08f, H * 0.20f, W * 0.92f, H * 0.86f)
      drawLyricsBlock(
        canvas = canvas,
        rect = cache.lyricsRect,
        fontSize = minDim * 0.056f,
        centered = true,
        cache = cache
      )
    } else if (styleMode == "inCover") {
      val coverSize = if (isLandscape) H * 0.76f else if (isSquare) minDim * 0.78f else W * 0.82f
      val coverX = (W - coverSize) / 2f
      val coverY = if (isLandscape) (H - coverSize) / 2f - H * 0.02f else H * 0.11f
      cache.coverRect.set(coverX, coverY, coverX + coverSize, coverY + coverSize)

      drawCover(canvas, cache.coverRect, coverBmp, coverShape, elapsed, 0.56f, cache)

      val inset = coverSize * 0.10f
      cache.innerRect.set(
        cache.coverRect.left + inset,
        cache.coverRect.top + inset,
        cache.coverRect.right - inset,
        cache.coverRect.bottom - inset
      )
      drawLyricsBlock(
        canvas = canvas,
        rect = cache.innerRect,
        fontSize = coverSize * 0.068f,
        centered = true,
        cache = cache
      )

      cache.metaRect.set(W * 0.08f, cache.coverRect.bottom + H * 0.03f, W * 0.92f, cache.coverRect.bottom + H * 0.13f)
      drawTrackMeta(
        canvas = canvas,
        title = title,
        artist = artist,
        rect = cache.metaRect,
        scale = scale,
        centered = true,
        cache = cache
      )
    } else {
      if (isLandscape) {
        val coverSize = H * 0.64f
        val leftMargin = W * 0.07f
        val coverY = (H - coverSize) / 2f - H * 0.04f
        cache.coverRect.set(leftMargin, coverY, leftMargin + coverSize, coverY + coverSize)

        drawCover(canvas, cache.coverRect, coverBmp, coverShape, elapsed, 0f, cache)
        cache.metaRect.set(leftMargin, cache.coverRect.bottom + H * 0.025f, leftMargin + coverSize, cache.coverRect.bottom + H * 0.145f)
        drawTrackMeta(
          canvas = canvas,
          title = title,
          artist = artist,
          rect = cache.metaRect,
          scale = scale,
          centered = true,
          cache = cache
        )

        val rightX = cache.coverRect.right + W * 0.06f
        cache.lyricsRect.set(rightX, H * 0.14f, W * 0.94f, H * 0.84f)
        drawLyricsBlock(
          canvas = canvas,
          rect = cache.lyricsRect,
          fontSize = minDim * 0.052f,
          centered = false,
          cache = cache
        )
      } else {
        val coverSize = if (isSquare) minDim * 0.38f else min(W * 0.50f, H * 0.36f)
        val metaH = minDim * 0.090f
        val coverToMetaGap = H * 0.018f
        val metaToLyricsGap = H * 0.014f
        val fontSize = minDim * 0.052f
        val topY = if (isSquare) H * 0.055f else H * 0.068f

        val coverX = (W - coverSize) / 2f
        cache.coverRect.set(coverX, topY, coverX + coverSize, topY + coverSize)

        drawCover(canvas, cache.coverRect, coverBmp, coverShape, elapsed, 0f, cache)

        val metaY = cache.coverRect.bottom + coverToMetaGap
        cache.metaRect.set(W * 0.08f, metaY, W * 0.92f, metaY + metaH)
        drawTrackMeta(
          canvas = canvas,
          title = title,
          artist = artist,
          rect = cache.metaRect,
          scale = minDim / 640f,
          centered = true,
          cache = cache
        )

        val lyricsTop = metaY + metaH + metaToLyricsGap
        val lyricsH = max(fontSize * 4.2f, H * 0.895f - lyricsTop)
        cache.lyricsRect.set(W * 0.08f, lyricsTop, W * 0.92f, lyricsTop + lyricsH)
        drawLyricsBlock(
          canvas = canvas,
          rect = cache.lyricsRect,
          fontSize = fontSize,
          centered = true,
          cache = cache
        )
      }
    }

    drawWatermarkPill(canvas, W, H, scale, cache = cache)
  }

  private fun drawCover(
    canvas: Canvas,
    rect: RectF,
    bmp: Bitmap,
    shape: String,
    elapsed: Double,
    darkenOverlay: Float,
    cache: FrameRenderCache = FrameRenderCache()
  ) {
    canvas.save()
    val isVinyl = shape == "vinyl"
    val radius = if (isVinyl) rect.width() / 2f else rect.width() * 0.09f

    cache.clipPath.reset()
    cache.clipPath.addRoundRect(rect, radius, radius, Path.Direction.CW)
    canvas.clipPath(cache.clipPath)

    if (isVinyl) {
      val deg = ((elapsed * (360.0 / 7.5)) % 360.0).toFloat()
      canvas.save()
      canvas.rotate(deg, rect.centerX(), rect.centerY())
      canvas.drawBitmap(bmp, null, rect, cache.bitmapPaint)
      canvas.restore()
    } else {
      canvas.drawBitmap(bmp, null, rect, cache.bitmapPaint)
    }

    if (darkenOverlay > 0.01f) {
      cache.darkPaint.color = Color.argb((darkenOverlay * 255).toInt(), 10, 10, 12)
      canvas.drawRect(rect, cache.darkPaint)
    }

    canvas.drawRoundRect(rect, radius, radius, cache.borderPaint)
    canvas.restore()
  }

  private fun drawLyricsBlock(
    canvas: Canvas,
    rect: RectF,
    fontSize: Float,
    centered: Boolean,
    cache: FrameRenderCache
  ) {
    cache.lyrics?.draw(canvas, rect, fontSize, centered)
  }

  private fun drawTrackMeta(
    canvas: Canvas,
    title: String,
    artist: String,
    rect: RectF,
    scale: Float,
    centered: Boolean,
    cache: FrameRenderCache = FrameRenderCache()
  ) {
    val textAlign = if (centered) Paint.Align.CENTER else Paint.Align.LEFT
    cache.titlePaint.textSize = 24f * scale
    cache.titlePaint.textAlign = textAlign
    cache.artistPaint.textSize = 17f * scale
    cache.artistPaint.textAlign = textAlign

    val x = if (centered) rect.centerX() else rect.left
    val truncTitle = TextUtils.ellipsize(title, cache.titlePaint, rect.width(), TextUtils.TruncateAt.END).toString()
    val truncArtist = TextUtils.ellipsize(artist, cache.artistPaint, rect.width(), TextUtils.TruncateAt.END).toString()

    canvas.drawText(truncTitle, x, rect.top + 24f * scale, cache.titlePaint)
    canvas.drawText(truncArtist, x, rect.top + 50f * scale, cache.artistPaint)
  }

  private fun drawHeaderPill(
    canvas: Canvas,
    cover: Bitmap,
    title: String,
    artist: String,
    centerX: Float,
    topY: Float,
    maxWidth: Float,
    scale: Float,
    cache: FrameRenderCache = FrameRenderCache()
  ) {
    val pillH = 62f * scale
    val pillW = min(maxWidth, 420f * scale)
    cache.pillRect.set(centerX - pillW / 2f, topY, centerX + pillW / 2f, topY + pillH)

    cache.pillBgPaint.color = Color.argb(28, 255, 255, 255)
    canvas.drawRoundRect(cache.pillRect, pillH / 2f, pillH / 2f, cache.pillBgPaint)

    val thumbSize = pillH - 12f * scale
    cache.thumbRect.set(
      cache.pillRect.left + 6f * scale,
      cache.pillRect.top + 6f * scale,
      cache.pillRect.left + 6f * scale + thumbSize,
      cache.pillRect.top + 6f * scale + thumbSize
    )
    canvas.save()
    cache.clipPath.reset()
    cache.clipPath.addRoundRect(cache.thumbRect, thumbSize / 2f, thumbSize / 2f, Path.Direction.CW)
    canvas.clipPath(cache.clipPath)
    canvas.drawBitmap(cover, null, cache.thumbRect, cache.pillBitmapPaint)
    canvas.restore()

    val textX = cache.thumbRect.right + 12f * scale
    cache.titlePaint.textSize = 16f * scale
    cache.titlePaint.textAlign = Paint.Align.LEFT
    cache.artistPaint.textSize = 13f * scale
    cache.artistPaint.textAlign = Paint.Align.LEFT
    val maxW = cache.pillRect.right - textX - 14f * scale
    canvas.drawText(TextUtils.ellipsize(title, cache.titlePaint, maxW, TextUtils.TruncateAt.END).toString(), textX, cache.pillRect.top + 26f * scale, cache.titlePaint)
    canvas.drawText(TextUtils.ellipsize(artist, cache.artistPaint, maxW, TextUtils.TruncateAt.END).toString(), textX, cache.pillRect.top + 46f * scale, cache.artistPaint)
  }

  private fun drawWatermarkPill(
    canvas: Canvas,
    W: Float,
    H: Float,
    scale: Float,
    labelText: String = "WouFY Clip",
    cache: FrameRenderCache = FrameRenderCache()
  ) {
    val pillW = 160f * scale
    val pillH = 30f * scale
    cache.watermarkRect.set((W - pillW) / 2f, H - pillH - H * 0.035f, (W + pillW) / 2f, H - H * 0.035f)
    cache.pillBgPaint.color = Color.argb(26, 255, 255, 255)
    canvas.drawRoundRect(cache.watermarkRect, pillH / 2f, pillH / 2f, cache.pillBgPaint)
    cache.watermarkPaint.textSize = 12f * scale
    canvas.drawText(labelText, cache.watermarkRect.centerX(), cache.watermarkRect.centerY() + 4f * scale, cache.watermarkPaint)
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
    if (tiny !== src) tiny.recycle()
    val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    try {
      val c = Canvas(out)
      val scale = max(width.toFloat() / blurred.width, height.toFloat() / blurred.height) * 1.2f
      val dw = blurred.width * scale
      val dh = blurred.height * scale
      val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
      c.drawBitmap(blurred, null, RectF((width - dw) / 2f, (height - dh) / 2f, (width + dw) / 2f, (height + dh) / 2f), paint)
      c.drawColor(Color.argb(145, 8, 8, 10))
    } finally {
      if (blurred !== out) blurred.recycle()
    }
    return out
  }
}
