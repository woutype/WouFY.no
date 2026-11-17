package expo.modules.woufyfx

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadata
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.media.audiofx.PresetReverb
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

private const val PICK_IMAGE_REQUEST_CODE = 49182
private const val PERMISSION_REQUEST_CODE = 49183
private const val NOTIF_CHANNEL_ID = "woufy_playback_channel"
private const val NOTIF_ID = 88421

internal fun parseLocalFile(uriStr: String): File {
  val clean = if (uriStr.startsWith("file://")) uriStr.substring(7) else uriStr
  val decoded = try {
    URLDecoder.decode(clean, "UTF-8")
  } catch (_: Throwable) {
    clean
  }
  return File(decoded)
}

internal class AndroidFXPlayer(
  private val id: String,
  private val onEnded: (String) -> Unit,
  private val onSamples: (String, List<Double>) -> Unit
) {
  private var mp: MediaPlayer? = null
  private var reverb: PresetReverb? = null
  private var loaded = false
  private var playing = false
  private var durationSec = 0.0
  private var volume = 1.0f
  private var rate = 1.0f
  private var pitchCents = 0.0f
  private var reverbAmount = 0.0f
  private var spatial8d = false
  private var sampling = false
  private var phase8d = 0.0
  private var samplePhase = 0.0

  private val handler = Handler(Looper.getMainLooper())
  private var tickRunning = false

  private val tickRunnable = object : Runnable {
    override fun run() {
      var shouldReschedule = false
      var framesToEmit: List<Double>? = null
      synchronized(this@AndroidFXPlayer) {
        if (!tickRunning) return
        val player = mp
        if (player != null && loaded && playing) {
          if (spatial8d) {
            phase8d += 0.045
            val pan = sin(phase8d).toFloat() // -1..1
            val left = volume * (if (pan > 0f) (1f - pan * 0.65f) else 1f)
            val right = volume * (if (pan < 0f) (1f + pan * 0.65f) else 1f)
            try {
              player.setVolume(left.coerceIn(0f, 1f), right.coerceIn(0f, 1f))
            } catch (_: IllegalStateException) {
            } catch (_: Throwable) {}
          }
          if (sampling && volume > 0.01f) {
            samplePhase += 0.35 * rate
            val frames = ArrayList<Double>(64)
            for (i in 0 until 64) {
              val t = samplePhase + i * 0.19
              val w = (sin(t * 2.3) * 0.45 + cos(t * 5.1) * 0.35 + sin(t * 11.7) * 0.2) * volume
              frames.add(w)
            }
            framesToEmit = frames
          }
        }
        shouldReschedule = tickRunning
      }
      framesToEmit?.let { onSamples(id, it) }
      if (shouldReschedule) {
        handler.postDelayed(this, 45L)
      }
    }
  }

  private fun updateTickState() {
    val shouldRun = loaded && playing && (spatial8d || sampling)
    if (shouldRun && !tickRunning) {
      tickRunning = true
      handler.post(tickRunnable)
    } else if (!shouldRun && tickRunning) {
      tickRunning = false
      handler.removeCallbacks(tickRunnable)
    }
  }

  @Synchronized
  fun load(uriStr: String): Double {
    releasePlayer()
    val file = parseLocalFile(uriStr)
    if (!file.exists()) return 0.0

    val player = MediaPlayer()
    try {
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      )
      player.setDataSource(file.absolutePath)
      player.prepare()
    } catch (t: Throwable) {
      try {
        player.release()
      } catch (_: Throwable) {}
      throw t
    }
    durationSec = (player.duration.coerceAtLeast(0)) / 1000.0
    loaded = true
    playing = false

    player.setOnCompletionListener {
      synchronized(this@AndroidFXPlayer) {
        playing = false
        updateTickState()
      }
      onEnded(id)
    }

    mp = player
    applyVolume()
    applyReverb()
    return durationSec
  }

  @Synchronized
  fun play() {
    val player = mp ?: return
    if (!loaded) return
    try {
      applyPlaybackParams(player, forcePlay = true)
      if (!player.isPlaying) {
        player.start()
      }
      playing = true
      updateTickState()
    } catch (_: Throwable) {}
  }

  @Synchronized
  fun pause() {
    val player = mp ?: return
    try {
      if (player.isPlaying) player.pause()
    } catch (_: Throwable) {}
    playing = false
    updateTickState()
  }

  @Synchronized
  fun seek(seconds: Double) {
    val player = mp ?: return
    if (!loaded) return
    val ms = (seconds * 1000.0).toLong().coerceAtLeast(0L)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        player.seekTo(ms, MediaPlayer.SEEK_CLOSEST)
      } else {
        player.seekTo(ms.toInt())
      }
    } catch (_: Throwable) {}
  }

  @Synchronized
  fun getTime(): Double {
    val player = mp ?: return 0.0
    if (!loaded) return 0.0
    return try {
      (player.currentPosition.coerceAtLeast(0)) / 1000.0
    } catch (_: IllegalStateException) {
      0.0
    } catch (_: Throwable) {
      0.0
    }
  }

  @Synchronized
  fun getDuration(): Double = durationSec

  @Synchronized
  fun isPlaying(): Boolean = playing

  @Synchronized
  fun isLoaded(): Boolean = loaded

  @Synchronized
  fun setVolume(v: Double) {
    volume = v.toFloat().coerceIn(0f, 1f)
    applyVolume()
  }

  @Synchronized
  fun setRate(r: Double) {
    val clamped = r.toFloat().coerceIn(0.25f, 2.0f)
    if (abs(rate - clamped) < 0.0005f) return
    rate = clamped
    val player = mp
    if (player != null && loaded && playing) {
      applyPlaybackParams(player, forcePlay = false)
    }
  }

  @Synchronized
  fun setPitchCents(c: Double) {
    val clamped = c.toFloat().coerceIn(-2400f, 2400f)
    if (abs(pitchCents - clamped) < 0.5f) return
    pitchCents = clamped
    val player = mp
    if (player != null && loaded && playing) {
      applyPlaybackParams(player, forcePlay = false)
    }
  }

  @Synchronized
  fun setReverb(amount: Double) {
    reverbAmount = amount.toFloat().coerceIn(0f, 100f)
    applyReverb()
  }

  @Synchronized
  fun setSpatial(on: Boolean) {
    spatial8d = on
    if (!on) applyVolume()
    updateTickState()
  }

  fun setTempoProcessing(_on: Boolean) {
    // PlaybackParams on Android handles tempo/pitch natively
  }

  @Synchronized
  fun setSampling(on: Boolean) {
    sampling = on
    updateTickState()
  }

  private fun applyVolume() {
    val player = mp ?: return
    if (!spatial8d) {
      try {
        player.setVolume(volume, volume)
      } catch (_: Throwable) {}
    }
  }

  private fun applyPlaybackParams(player: MediaPlayer, forcePlay: Boolean) {
    try {
      val pitchRatio = 2.0.pow((pitchCents / 1200.0)).toFloat().coerceIn(0.25f, 2.0f)
      val params = PlaybackParams()
        .setAudioFallbackMode(PlaybackParams.AUDIO_FALLBACK_MODE_DEFAULT)
        .setSpeed(rate)
        .setPitch(pitchRatio)
      if (playing || forcePlay) {
        player.playbackParams = params
      }
    } catch (_: Throwable) {}
  }

  private fun applyReverb() {
    val player = mp ?: return
    try {
      if (reverbAmount <= 1f) {
        reverb?.enabled = false
        return
      }
      if (reverb == null) {
        reverb = PresetReverb(0, player.audioSessionId)
      }
      reverb?.let { rev ->
        rev.preset = when {
          reverbAmount > 35f -> PresetReverb.PRESET_LARGEHALL
          else -> PresetReverb.PRESET_MEDIUMHALL
        }
        rev.enabled = true
        player.attachAuxEffect(rev.id)
        val norm = (reverbAmount / 100f).coerceIn(0f, 1f)
        val sendLevel = norm.pow(1.3f) * 0.65f
        player.setAuxEffectSendLevel(sendLevel)
      }
    } catch (_: Throwable) {}
  }

  private fun releasePlayer() {
    tickRunning = false
    handler.removeCallbacks(tickRunnable)
    loaded = false
    playing = false
    durationSec = 0.0
    try {
      reverb?.release()
    } catch (_: Throwable) {}
    reverb = null
    try {
      mp?.stop()
    } catch (_: Throwable) {}
    try {
      mp?.release()
    } catch (_: Throwable) {}
    mp = null
  }

  @Synchronized
  fun destroy() {
    releasePlayer()
  }
}

class WoufyFXModule : Module() {
  private val players = ConcurrentHashMap<String, AndroidFXPlayer>()
  private var mediaSession: MediaSession? = null
  private var currentTitle = ""
  private var currentArtist = ""
  private var currentAlbum = "WouFY.no"
  private var currentArtBitmap: Bitmap? = null
  private var currentArtPath: String? = null
  private var currentDurationMs = 0L
  private var currentPositionMs = 0L
  private var currentRate = 0f

  private var contentObserver: ContentObserver? = null
  private var fileObservers = mutableListOf<FileObserver>()
  private val mainHandler = Handler(Looper.getMainLooper())
  private var watchDebounce: Runnable? = null

  private var pendingImagePromise: Promise? = null
  private var lastHapticAt = 0L

  override fun definition() = ModuleDefinition {
    Name("WoufyFX")

    Events("onEnded", "onSamples", "onRemote", "onLibraryChanged", "onVideoProgress")

    Function("isAvailable") {
      return@Function true
    }

    // ── Плеер с эффектами ──

    Function("create") { id: String ->
      players[id]?.destroy()
      players[id] = AndroidFXPlayer(
        id = id,
        onEnded = { pid -> sendEvent("onEnded", mapOf("id" to pid)) },
        onSamples = { pid, frames -> sendEvent("onSamples", mapOf("id" to pid, "frames" to frames)) }
      )
    }

    Function("destroy") { id: String ->
      players.remove(id)?.destroy()
    }

    AsyncFunction("load") { id: String, uri: String ->
      val p = players[id] ?: return@AsyncFunction 0.0
      return@AsyncFunction p.load(uri)
    }

    AsyncFunction("play") { id: String ->
      players[id]?.play()
    }

    AsyncFunction("pause") { id: String ->
      players[id]?.pause()
    }

    AsyncFunction("seek") { id: String, seconds: Double ->
      players[id]?.seek(seconds)
    }

    Function("getTime") { id: String ->
      return@Function players[id]?.getTime() ?: 0.0
    }

    Function("getDuration") { id: String ->
      return@Function players[id]?.getDuration() ?: 0.0
    }

    Function("isPlaying") { id: String ->
      return@Function players[id]?.isPlaying() ?: false
    }

    Function("isLoaded") { id: String ->
      return@Function players[id]?.isLoaded() ?: false
    }

    Function("setVolume") { id: String, v: Double ->
      players[id]?.setVolume(v)
    }

    Function("setRate") { id: String, r: Double ->
      players[id]?.setRate(r)
    }

    Function("setPitchCents") { id: String, c: Double ->
      players[id]?.setPitchCents(c)
    }

    Function("setReverb") { id: String, amount: Double ->
      players[id]?.setReverb(amount)
    }

    Function("setSpatial") { id: String, on: Boolean ->
      players[id]?.setSpatial(on)
    }

    Function("setTempoProcessing") { id: String, on: Boolean ->
      players[id]?.setTempoProcessing(on)
    }

    Function("setSampling") { id: String, on: Boolean ->
      players[id]?.setSampling(on)
    }

    // ── Анализ окна аудио для BPM ──

    AsyncFunction("analyzeWindow") { uri: String, start: Double, len: Double ->
      return@AsyncFunction analyzeAudioWindow(parseLocalFile(uri), start, len)
    }

    // ── Распознавание речи (заглушка: возвращает пустой массив, используются слоговые тайминги) ──

    AsyncFunction("recognizeSpeech") { _uri: String, _locale: String ->
      return@AsyncFunction emptyList<Map<String, Any>>()
    }

    // ── Тактильный отклик (Android Vibrator / VibrationEffect) ──

    Function("hapticsSupported") {
      val vib = getVibrator()
      return@Function vib?.hasVibrator() == true
    }

    Function("hapticsStart") {
      // На Android вибратор готов сразу
    }

    Function("hapticsStop") {
      try {
        getVibrator()?.cancel()
      } catch (_: Throwable) {}
    }

    Function("hapticTransient") { intensity: Double, sharpness: Double ->
      triggerHaptic(
        durationMs = if (sharpness > 0.6) 14L else 20L,
        amplitude = (intensity * 210.0).toInt().coerceIn(30, 210)
      )
    }

    Function("hapticThump") { intensity: Double ->
      triggerHaptic(
        durationMs = 30L,
        amplitude = (intensity * 255.0).toInt().coerceIn(60, 255)
      )
    }

    Function("hapticChannel") { _channel: Int, _level: Double, _sharpness: Double ->
      // Непрерывные каналы на Android отключены, чтобы не вызывать спам вибрацией
    }

    // ── Аудиосессия, MediaSession и шторка уведомлений Android ──

    AsyncFunction("activateSession") {
      val ctx = appContext.reactContext ?: return@AsyncFunction true
      try {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (am != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()
            )
            .build()
          am.requestAudioFocus(req)
        }
      } catch (_: Throwable) {}
      true
    }

    Function("enableRemote") { on: Boolean ->
      mainHandler.post {
        if (on) ensureMediaSession() else releaseMediaSession()
      }
    }

    Function("setNowPlaying") { title: String, artist: String, album: String, artworkPath: String?, duration: Double ->
      currentTitle = title
      currentArtist = artist
      currentAlbum = album
      currentDurationMs = (duration * 1000.0).toLong().coerceAtLeast(0L)

      val needsDecode = artworkPath != currentArtPath
      currentArtPath = artworkPath

      if (needsDecode) {
        Thread {
          val bmp = if (!artworkPath.isNullOrEmpty()) {
            decodeSampledArtwork(parseLocalFile(artworkPath), 512)
          } else {
            null
          }
          mainHandler.post {
            if (currentArtPath == artworkPath) {
              currentArtBitmap = bmp
            }
            ensureMediaSession()
            updateMediaSessionMetadata()
            updateMediaNotification()
          }
        }.start()
      } else {
        mainHandler.post {
          ensureMediaSession()
          updateMediaSessionMetadata()
          updateMediaNotification()
        }
      }
    }

    Function("updateNowPlaying") { position: Double, rate: Double ->
      currentPositionMs = (position * 1000.0).toLong().coerceAtLeast(0L)
      currentRate = rate.toFloat()
      mainHandler.post {
        updateMediaSessionPlaybackState()
      }
    }

    Function("clearNowPlaying") {
      mainHandler.post {
        val ctx = appContext.reactContext ?: return@post
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        nm?.cancel(NOTIF_ID)
      }
    }

    // ── Нативное сканирование и извлечение метаданных/обложек ──

    AsyncFunction("nativeScanDirectory") { directoryUri: String ->
      ensureStoragePermission()
      return@AsyncFunction scanMusicDirectories(directoryUri)
    }

    AsyncFunction("nativeExtractMetadata") { items: List<Map<String, Any>>, coversDirUri: String ->
      val coversDir = parseLocalFile(coversDirUri)
      return@AsyncFunction extractMetadataBatch(items, coversDir)
    }

    AsyncFunction("nativeExtractThumbnails") { items: List<Map<String, Any>>, coversDirUri: String, maxPixel: Int ->
      val coversDir = parseLocalFile(coversDirUri)
      return@AsyncFunction extractThumbnailsBatch(items, coversDir, maxPixel)
    }

    AsyncFunction("nativeExtractArtwork") { uri: String, cacheDirUri: String ->
      return@AsyncFunction extractOriginalArtwork(parseLocalFile(uri), parseLocalFile(cacheDirUri), 16)
    }

    Function("startDirectoryWatcher") { directoryUri: String ->
      startWatchingDirectories(directoryUri)
    }

    Function("stopDirectoryWatcher") {
      stopWatchingDirectories()
    }

    // ── Выбор обложки из галереи телефона ──

    AsyncFunction("pickImage") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      pendingImagePromise?.reject("E_CANCELLED", "New image picker request started", null)
      pendingImagePromise = promise
      val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).apply {
        type = "image/*"
      }
      try {
        activity.startActivityForResult(intent, PICK_IMAGE_REQUEST_CODE)
      } catch (_: Throwable) {
        pendingImagePromise = null
        promise.resolve(null)
      }
    }

    OnActivityResult { activity, payload ->
      if (payload.requestCode == PICK_IMAGE_REQUEST_CODE) {
        val promise = pendingImagePromise
        pendingImagePromise = null
        if (promise == null) return@OnActivityResult
        if (payload.resultCode != Activity.RESULT_OK || payload.data?.data == null) {
          promise.resolve(null)
          return@OnActivityResult
        }
        val uri = payload.data!!.data!!
        try {
          activity.contentResolver.openInputStream(uri)?.use { input ->
            val outFile = File(activity.cacheDir, "cover_${UUID.randomUUID()}.jpg")
            FileOutputStream(outFile).use { output ->
              input.copyTo(output)
            }
            promise.resolve("file://${outFile.absolutePath}")
          } ?: promise.resolve(null)
        } catch (_: Throwable) {
          promise.resolve(null)
        }
      }
    }

    // ── Автообновление APK внутри приложения (Android) ──

    AsyncFunction("installApk") { fileUri: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val apkFile = parseLocalFile(fileUri)
      if (!apkFile.exists()) return@AsyncFunction false
      return@AsyncFunction try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
          val permIntent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${ctx.packageName}")
          ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          ctx.startActivity(permIntent)
        }
        val contentUri = FileProvider.getUriForFile(
          ctx,
          "${ctx.packageName}.woufyfx.provider",
          apkFile
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(contentUri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(installIntent)
        true
      } catch (_: Throwable) {
        false
      }
    }

    AsyncFunction("generateVideoCard") { params: Map<String, Any>, promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.reject("E_VIDEO", "Контекст недоступен", null)
        return@AsyncFunction
      }
      Thread {
        try {
          val uri = VideoCardGeneratorAndroid.generate(ctx, params) { p ->
            sendEvent("onVideoProgress", mapOf("progress" to p))
          }
          promise.resolve(uri)
        } catch (t: Throwable) {
          promise.reject("E_VIDEO", t.message ?: "Ошибка генерации видео", t)
        }
      }.start()
    }

    AsyncFunction("generateImageCard") { params: Map<String, Any>, promise: Promise ->
      val ctx = appContext.reactContext
      if (ctx == null) {
        promise.reject("E_IMAGE", "Контекст недоступен", null)
        return@AsyncFunction
      }
      Thread {
        try {
          val uri = VideoCardGeneratorAndroid.generateImage(ctx, params)
          promise.resolve(uri)
        } catch (t: Throwable) {
          promise.reject("E_IMAGE", t.message ?: "Ошибка генерации карточки", t)
        }
      }.start()
    }

    AsyncFunction("shareFile") { fileUri: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val file = parseLocalFile(fileUri)
      if (!file.exists()) return@AsyncFunction false
      return@AsyncFunction try {
        val contentUri = FileProvider.getUriForFile(
          ctx,
          "${ctx.packageName}.woufyfx.provider",
          file
        )
        val lowerName = file.name.lowercase()
        val mime = when {
          lowerName.endsWith(".png") -> "image/png"
          lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg") -> "image/jpeg"
          lowerName.endsWith(".m4a") -> "audio/mp4"
          lowerName.endsWith(".mp3") -> "audio/mpeg"
          lowerName.endsWith(".aac") -> "audio/aac"
          lowerName.endsWith(".mp4") -> "video/mp4"
          else -> "*/*"
        }
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
          type = mime
          putExtra(Intent.EXTRA_STREAM, contentUri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(shareIntent, "Поделиться WouFY").apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(chooser)
        true
      } catch (_: Throwable) {
        false
      }
    }

    OnDestroy {
      stopWatchingDirectories()
      releaseMediaSession()
      for ((_, p) in players) p.destroy()
      players.clear()
    }
  }

  // MARK: - MediaSession & Notification

  private fun decodeSampledArtwork(file: File, maxDim: Int): Bitmap? {
    if (!file.exists()) return null
    return try {
      val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.absolutePath, boundsOpts)
      var sampleSize = 1
      val maxSide = max(boundsOpts.outWidth, boundsOpts.outHeight)
      if (maxSide > maxDim) {
        while (maxSide / sampleSize > maxDim) {
          sampleSize *= 2
        }
      }
      val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
      BitmapFactory.decodeFile(file.absolutePath, decodeOpts)
    } catch (_: Throwable) {
      null
    }
  }

  private fun ensureMediaSession() {
    if (mediaSession != null) return
    val ctx = appContext.reactContext ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        if (nm?.getNotificationChannel(NOTIF_CHANNEL_ID) == null) {
          val ch = NotificationChannel(
            NOTIF_CHANNEL_ID,
            "WouFY.no Воспроизведение",
            NotificationManager.IMPORTANCE_LOW
          ).apply {
            description = "Управление воспроизведением музыки WouFY.no"
            setShowBadge(false)
          }
          nm?.createNotificationChannel(ch)
        }
      }

      val session = MediaSession(ctx, "WoufyMediaSession")
      session.setCallback(object : MediaSession.Callback() {
        override fun onPlay() {
          sendEvent("onRemote", mapOf("command" to "play"))
        }

        override fun onPause() {
          sendEvent("onRemote", mapOf("command" to "pause"))
        }

        override fun onSkipToNext() {
          sendEvent("onRemote", mapOf("command" to "next"))
        }

        override fun onSkipToPrevious() {
          sendEvent("onRemote", mapOf("command" to "previous"))
        }

        override fun onSeekTo(pos: Long) {
          sendEvent("onRemote", mapOf("command" to "seek", "position" to (pos / 1000.0)))
        }
      })
      session.isActive = true
      mediaSession = session
      updateMediaSessionPlaybackState()
    } catch (_: Throwable) {}
  }

  private fun updateMediaSessionMetadata() {
    val session = mediaSession ?: return
    try {
      val builder = MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
        .putString(MediaMetadata.METADATA_KEY_ALBUM, currentAlbum)
        .putLong(MediaMetadata.METADATA_KEY_DURATION, currentDurationMs)
      currentArtBitmap?.let { bmp ->
        builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp)
        builder.putBitmap(MediaMetadata.METADATA_KEY_ART, bmp)
      }
      session.setMetadata(builder.build())
    } catch (_: Throwable) {}
  }

  private fun updateMediaSessionPlaybackState() {
    val session = mediaSession ?: return
    try {
      val state = if (currentRate > 0.01f) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
      val actions = PlaybackState.ACTION_PLAY or
        PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or
        PlaybackState.ACTION_SKIP_TO_NEXT or
        PlaybackState.ACTION_SKIP_TO_PREVIOUS or
        PlaybackState.ACTION_SEEK_TO

      val pb = PlaybackState.Builder()
        .setActions(actions)
        .setState(state, currentPositionMs, currentRate)
        .build()
      session.setPlaybackState(pb)
    } catch (_: Throwable) {}
  }

  private fun updateMediaNotification() {
    val ctx = appContext.reactContext ?: return
    val session = mediaSession ?: return
    if (currentTitle.isEmpty()) return
    try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val contentIntent = if (launchIntent != null) {
        PendingIntent.getActivity(
          ctx,
          0,
          launchIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      } else null

      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(ctx, NOTIF_CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(ctx)
      }

      builder
        .setContentTitle(currentTitle)
        .setContentText(currentArtist)
        .setSubText(currentAlbum)
        .setSmallIcon(ctx.applicationInfo.icon)
        .setOngoing(currentRate > 0.01f)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken))

      if (contentIntent != null) {
        builder.setContentIntent(contentIntent)
      }
      currentArtBitmap?.let { builder.setLargeIcon(it) }

      nm.notify(NOTIF_ID, builder.build())
    } catch (_: Throwable) {}
  }

  private fun releaseMediaSession() {
    try {
      val ctx = appContext.reactContext
      val nm = ctx?.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      nm?.cancel(NOTIF_ID)
    } catch (_: Throwable) {}
    try {
      mediaSession?.isActive = false
      mediaSession?.release()
    } catch (_: Throwable) {}
    mediaSession = null
  }

  // MARK: - Haptics

  private fun getVibrator(): Vibrator? {
    val ctx = appContext.reactContext ?: return null
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val vm = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
      vm?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
  }

  private fun triggerHaptic(durationMs: Long, amplitude: Int) {
    val now = System.currentTimeMillis()
    if (now - lastHapticAt < 28L) return
    lastHapticAt = now
    try {
      val vib = getVibrator() ?: return
      if (!vib.hasVibrator()) return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vib.vibrate(VibrationEffect.createOneShot(durationMs, amplitude.coerceIn(1, 255)))
      } else {
        @Suppress("DEPRECATION")
        vib.vibrate(durationMs)
      }
    } catch (_: Throwable) {}
  }

  // MARK: - Разрешения и сканирование папок с музыкой

  private fun ensureStoragePermission() {
    val ctx = appContext.reactContext ?: return
    val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Manifest.permission.READ_MEDIA_AUDIO
    } else {
      Manifest.permission.READ_EXTERNAL_STORAGE
    }
    if (ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED) {
      return
    }
    val activity = appContext.currentActivity ?: return
    val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      arrayOf(Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
    } else {
      arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    mainHandler.post {
      try {
        ActivityCompat.requestPermissions(activity, perms, PERMISSION_REQUEST_CODE)
      } catch (_: Throwable) {}
    }
    // Ждём ответа пользователя до 12 секунд, чтобы первый же скан сразу нашёл все треки
    val start = System.currentTimeMillis()
    while (System.currentTimeMillis() - start < 12000L) {
      if (ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED) {
        break
      }
      try {
        Thread.sleep(200L)
      } catch (_: Throwable) {
        break
      }
    }
  }

  private fun scanMusicDirectories(directoryUri: String): List<Map<String, Any>> {
    val supportedExts = setOf("mp3", "m4a", "aac", "wav", "flac", "aif", "aiff")
    val docRoot = parseLocalFile(directoryUri)
    val docRootPath = if (docRoot.absolutePath.endsWith("/")) docRoot.absolutePath else "${docRoot.absolutePath}/"

    val roots = LinkedHashSet<File>()
    roots.add(docRoot)

    try {
      val pubMusic = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)
      if (pubMusic != null) {
        val woufyDir = File(pubMusic, "WouFY")
        if (!woufyDir.exists()) {
          try { woufyDir.mkdirs() } catch (_: Throwable) {}
        }
        roots.add(pubMusic)
      }
    } catch (_: Throwable) {}

    try {
      val pubDownload = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
      if (pubDownload != null && pubDownload.exists()) {
        roots.add(pubDownload)
      }
    } catch (_: Throwable) {}

    try {
      val extMusic = appContext.reactContext?.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
      if (extMusic != null) {
        if (!extMusic.exists()) extMusic.mkdirs()
        roots.add(extMusic)
      }
    } catch (_: Throwable) {}

    val audioFiles = ArrayList<File>()
    val lrcPaths = HashSet<String>()
    val seenCanonical = HashSet<String>()

    fun walkDir(dir: File, depth: Int) {
      if (depth > 6 || !dir.exists() || !dir.isDirectory) return
      val name = dir.name
      if (name.startsWith(".") || name.equals("Android", ignoreCase = true)) return
      val children = dir.listFiles() ?: return
      for (f in children) {
        if (f.name.startsWith(".")) continue
        if (f.isDirectory) {
          walkDir(f, depth + 1)
        } else if (f.isFile) {
          val ext = f.extension.lowercase()
          if (ext == "lrc") {
            val base = f.absolutePath.substringBeforeLast(".")
            lrcPaths.add(base)
          } else if (supportedExts.contains(ext)) {
            val canon = try { f.canonicalPath } catch (_: Throwable) { f.absolutePath }
            if (seenCanonical.add(canon)) {
              audioFiles.add(f)
            }
          }
        }
      }
    }

    for (r in roots) {
      walkDir(r, 0)
    }

    val results = ArrayList<Map<String, Any>>(audioFiles.size)
    for (f in audioFiles) {
      val path = f.absolutePath
      val relId = if (path.startsWith(docRootPath)) {
        path.substring(docRootPath.length)
      } else {
        path.trimStart('/')
      }
      val ext = f.extension.lowercase().let { if (it == "aif") "aiff" else it }
      val basePath = path.substringBeforeLast(".")
      val hasLrc = lrcPaths.contains(basePath) || File("$basePath.lrc").exists()

      val map = HashMap<String, Any>()
      map["id"] = relId
      map["uri"] = "file://$path"
      map["filename"] = f.name
      map["extension"] = ext
      map["size"] = f.length()
      map["mtime"] = f.lastModified()
      if (hasLrc) {
        map["lrcUri"] = "file://$basePath.lrc"
      }
      results.add(map)
    }

    return results
  }

  // MARK: - Метаданные и обложки (MediaMetadataRetriever + BitmapFactory)

  private fun contentHash(data: ByteArray): ULong {
    var h: ULong = 0xcbf29ce484222325uL
    val prime: ULong = 0x100000001b3uL
    for (b in data) {
      h = (h xor (b.toInt() and 0xFF).toULong()) * prime
    }
    return h
  }

  private fun sniffImageExtension(data: ByteArray): String {
    if (data.size >= 4) {
      val b0 = data[0].toInt() and 0xFF
      val b1 = data[1].toInt() and 0xFF
      val b2 = data[2].toInt() and 0xFF
      val b3 = data[3].toInt() and 0xFF
      if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47) return "png"
      if (b0 == 0x52 && b1 == 0x49 && b2 == 0x46 && b3 == 0x46) return "webp"
    }
    return "jpg"
  }

  private fun makeThumbnail(data: ByteArray, maxPixel: Int): ByteArray? {
    return try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

      var sampleSize = 1
      val longest = max(bounds.outWidth, bounds.outHeight)
      while (longest / (sampleSize * 2) >= maxPixel) {
        sampleSize *= 2
      }

      val decodeOpts = BitmapFactory.Options().apply {
        inSampleSize = sampleSize
        inPreferredConfig = Bitmap.Config.RGB_565
      }
      val bmp = BitmapFactory.decodeByteArray(data, 0, data.size, decodeOpts) ?: return null
      val w = bmp.width
      val h = bmp.height
      val maxDim = max(w, h)
      val scaled = if (maxDim > maxPixel) {
        val ratio = maxPixel.toFloat() / maxDim.toFloat()
        val nw = (w * ratio).toInt().coerceAtLeast(1)
        val nh = (h * ratio).toInt().coerceAtLeast(1)
        val s = Bitmap.createScaledBitmap(bmp, nw, nh, true)
        if (s !== bmp) bmp.recycle()
        s
      } else {
        bmp
      }

      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, 78, out)
      scaled.recycle()
      out.toByteArray()
    } catch (_: Throwable) {
      null
    }
  }

  private fun extractMetadataBatch(items: List<Map<String, Any>>, coversDir: File): List<Map<String, Any>> {
    if (!coversDir.exists()) coversDir.mkdirs()
    val results = ArrayList<Map<String, Any>>(items.size)

    for (item in items) {
      val id = item["id"] as? String ?: continue
      val uriStr = item["uri"] as? String ?: continue
      val file = parseLocalFile(uriStr)

      val dict = HashMap<String, Any>()
      dict["id"] = id
      dict["tagged"] = true

      if (file.exists()) {
        val retriever = MediaMetadataRetriever()
        try {
          retriever.setDataSource(file.absolutePath)
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.trim()?.takeIf { it.isNotEmpty() }?.let {
            dict["title"] = it
          }
          val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)?.trim()?.takeIf { it.isNotEmpty() }
            ?: retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)?.trim()?.takeIf { it.isNotEmpty() }
          if (artist != null) dict["artist"] = artist

          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)?.trim()?.takeIf { it.isNotEmpty() }?.let {
            dict["album"] = it
          }
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)?.let { trkStr ->
            trkStr.split("/").firstOrNull()?.trim()?.toIntOrNull()?.takeIf { it > 0 }?.let {
              dict["trackNumber"] = it
            }
          }
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)?.let { dStr ->
            dStr.split("/").firstOrNull()?.trim()?.toIntOrNull()?.takeIf { it > 0 }?.let {
              dict["discNumber"] = it
            }
          }

          val pic = retriever.embeddedPicture
          if (pic != null && pic.isNotEmpty()) {
            val hashHex = java.lang.Long.toUnsignedString(contentHash(pic).toLong(), 16).padStart(16, '0')
            val thumbFile = File(coversDir, "${hashHex}_t.jpg")
            if (thumbFile.exists()) {
              dict["artworkUri"] = "file://${thumbFile.absolutePath}"
            } else {
              val thumbBytes = makeThumbnail(pic, 384)
              if (thumbBytes != null) {
                try {
                  thumbFile.writeBytes(thumbBytes)
                  dict["artworkUri"] = "file://${thumbFile.absolutePath}"
                } catch (_: Throwable) {}
              }
            }
          }
        } catch (_: Throwable) {
        } finally {
          try { retriever.release() } catch (_: Throwable) {}
        }
      }
      results.add(dict)
    }
    return results
  }

  private fun extractThumbnailsBatch(items: List<Map<String, Any>>, coversDir: File, maxPixel: Int): List<Map<String, Any>> {
    if (!coversDir.exists()) coversDir.mkdirs()
    val results = ArrayList<Map<String, Any>>(items.size)

    for (item in items) {
      val id = item["id"] as? String ?: continue
      val uriStr = item["uri"] as? String ?: continue
      val file = parseLocalFile(uriStr)
      if (!file.exists()) continue

      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(file.absolutePath)
        val pic = retriever.embeddedPicture
        if (pic != null && pic.isNotEmpty()) {
          val hashHex = java.lang.Long.toUnsignedString(contentHash(pic).toLong(), 16).padStart(16, '0')
          val thumbFile = File(coversDir, "${hashHex}_t.jpg")
          if (!thumbFile.exists()) {
            val jpeg = makeThumbnail(pic, maxPixel)
            if (jpeg != null) {
              try { thumbFile.writeBytes(jpeg) } catch (_: Throwable) {}
            }
          }
          if (thumbFile.exists()) {
            results.add(mapOf("id" to id, "artworkUri" to "file://${thumbFile.absolutePath}"))
          }
        }
      } catch (_: Throwable) {
      } finally {
        try { retriever.release() } catch (_: Throwable) {}
      }
    }
    return results
  }

  private fun extractOriginalArtwork(file: File, cacheDir: File, keep: Int): String? {
    if (!file.exists()) return null
    val retriever = MediaMetadataRetriever()
    val pic: ByteArray? = try {
      retriever.setDataSource(file.absolutePath)
      retriever.embeddedPicture
    } catch (_: Throwable) {
      null
    } finally {
      try { retriever.release() } catch (_: Throwable) {}
    }
    if (pic == null || pic.isEmpty()) return null

    if (!cacheDir.exists()) cacheDir.mkdirs()
    val hashHex = java.lang.Long.toUnsignedString(contentHash(pic).toLong(), 16).padStart(16, '0')
    val ext = sniffImageExtension(pic)
    val outFile = File(cacheDir, "$hashHex.$ext")
    if (outFile.exists()) {
      outFile.setLastModified(System.currentTimeMillis())
    } else {
      try {
        outFile.writeBytes(pic)
      } catch (_: Throwable) {
        return null
      }
    }
    pruneCache(cacheDir, keep)
    return "file://${outFile.absolutePath}"
  }

  private fun pruneCache(dir: File, keep: Int) {
    try {
      val files = dir.listFiles()?.filter { it.isFile } ?: return
      if (files.size <= keep) return
      val sorted = files.sortedByDescending { it.lastModified() }
      for (f in sorted.drop(keep)) {
        try { f.delete() } catch (_: Throwable) {}
      }
    } catch (_: Throwable) {}
  }

  // MARK: - Наблюдатель за файловой системой (MediaStore ContentObserver + FileObserver)

  private fun notifyLibraryChangedDebounced() {
    watchDebounce?.let { mainHandler.removeCallbacks(it) }
    val r = Runnable {
      sendEvent("onLibraryChanged", emptyMap<String, Any>())
    }
    watchDebounce = r
    mainHandler.postDelayed(r, 500L)
  }

  private fun startWatchingDirectories(directoryUri: String) {
    stopWatchingDirectories()
    val ctx = appContext.reactContext ?: return

    try {
      val obs = object : ContentObserver(mainHandler) {
        override fun onChange(selfChange: Boolean) {
          notifyLibraryChangedDebounced()
        }
      }
      ctx.contentResolver.registerContentObserver(
        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
        true,
        obs
      )
      contentObserver = obs
    } catch (_: Throwable) {}

    val dirsToWatch = listOfNotNull(
      parseLocalFile(directoryUri),
      try { Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC) } catch (_: Throwable) { null },
      try { Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS) } catch (_: Throwable) { null }
    )

    for (d in dirsToWatch) {
      if (!d.exists() || !d.isDirectory) continue
      try {
        val mask = FileObserver.CREATE or FileObserver.DELETE or FileObserver.MOVED_FROM or FileObserver.MOVED_TO or FileObserver.CLOSE_WRITE
        @Suppress("DEPRECATION")
        val fo = object : FileObserver(d.absolutePath, mask) {
          override fun onEvent(event: Int, path: String?) {
            if (path != null && !path.startsWith(".")) {
              notifyLibraryChangedDebounced()
            }
          }
        }
        fo.startWatching()
        fileObservers.add(fo)
      } catch (_: Throwable) {}
    }
  }

  private fun stopWatchingDirectories() {
    watchDebounce?.let { mainHandler.removeCallbacks(it) }
    watchDebounce = null
    try {
      contentObserver?.let { appContext.reactContext?.contentResolver?.unregisterContentObserver(it) }
    } catch (_: Throwable) {}
    contentObserver = null
    for (fo in fileObservers) {
      try { fo.stopWatching() } catch (_: Throwable) {}
    }
    fileObservers.clear()
  }

  // MARK: - Анализ окна аудио (BPM)

  private fun analyzeAudioWindow(file: File, startSec: Double, lenSec: Double): Map<String, Any> {
    val empty = mapOf(
      "energies" to emptyList<Double>(),
      "lows" to emptyList<Double>(),
      "sr" to 44100,
      "c" to 1024,
      "duration" to 0.0
    )
    if (!file.exists()) return empty
    val retriever = MediaMetadataRetriever()
    val durSec = try {
      retriever.setDataSource(file.absolutePath)
      val d = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      d / 1000.0
    } catch (_: Throwable) {
      0.0
    } finally {
      try { retriever.release() } catch (_: Throwable) {}
    }
    if (durSec <= 0.0) return empty
    return mapOf(
      "energies" to emptyList<Double>(),
      "lows" to emptyList<Double>(),
      "sr" to 44100,
      "c" to 1024,
      "duration" to durSec
    )
  }
}
