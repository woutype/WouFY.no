import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  LayoutAnimation,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { DJSettings, FxSettings } from '../types';
import { colors, type } from '../theme';
import { Glass, PressableScale } from './ui';
import { fxDiagnostics } from '../services/fxPlayer';
import { getStorageStats, purgeStorage, formatBytes, StorageInfo } from '../services/storageService';
import { loadCachedTracks } from '../services/library';
import { CURRENT_VERSION, installUpdate, UpdateInfo } from '../services/updateService';

interface Props {
  visible: boolean;
  settings: DJSettings;
  onUpdateSettings: (s: DJSettings) => void;
  fx: FxSettings;
  onUpdateFx: (s: FxSettings) => void;
  fxNativeReady: boolean;
  fxActive: boolean;
  musicHaptics: boolean;
  onToggleHaptics: (on: boolean) => void;
  onClose: () => void;
  trackCount: number;
  /** возвращает короткий итог («Найдено 1300 треков · новых: 12») */
  onRescan: () => Promise<string>;
  updateInfo?: UpdateInfo | null;
  onCheckUpdate?: () => Promise<UpdateInfo>;
}

const SHEET_H = 760;
const TRACK = { false: 'rgba(255,255,255,0.14)', true: 'rgba(255,255,255,0.55)' };

/** Плавное раскрытие/сворачивание вложенных блоков */
const smooth = () => LayoutAnimation.configureNext(LayoutAnimation.create(240, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));

/** Ползунок: значение показывается мгновенно, в движок уходит не чаще ~12 раз/сек, итог — по отпусканию */
const LiveSlider: React.FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (v: number) => string;
  label: string;
  onChange: (v: number) => void;
}> = ({ value, min, max, step = 1, format, label, onChange }) => {
  const [v, setV] = useState(value);
  const last = useRef(0);
  useEffect(() => setV(value), [value]);
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.sliderHead}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.badge}>{format(v)}</Text>
      </View>
      <Slider
        style={{ height: 36 }}
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        onValueChange={(x) => {
          setV(x);
          const now = Date.now();
          if (now - last.current > 80) {
            last.current = now;
            onChange(x);
          }
        }}
        onSlidingComplete={(x) => {
          setV(x);
          onChange(x);
          Haptics.selectionAsync();
        }}
        minimumTrackTintColor="#FFFFFF"
        maximumTrackTintColor="rgba(255,255,255,0.18)"
        thumbTintColor="#FFFFFF"
      />
    </View>
  );
};

const ToggleRow: React.FC<{ title: string; desc?: string; value: boolean; onChange: (v: boolean) => void; sub?: boolean }> = ({
  title,
  desc,
  value,
  onChange,
  sub,
}) => (
  <View style={[styles.row, sub && styles.sub]}>
    <View style={styles.info}>
      <Text style={styles.rowTitle}>{title}</Text>
      {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
    </View>
    <Switch value={value} onValueChange={onChange} trackColor={TRACK} ios_backgroundColor="rgba(255,255,255,0.14)" />
  </View>
);

export const SettingsModal: React.FC<Props> = ({
  visible,
  settings,
  onUpdateSettings,
  fx,
  onUpdateFx,
  fxNativeReady,
  fxActive,
  musicHaptics,
  onToggleHaptics,
  onClose,
  trackCount,
  onRescan,
  updateInfo,
  onCheckUpdate,
}) => {
  const [render, setRender] = useState(visible);
  const y = useRef(new Animated.Value(SHEET_H + 100)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [cleaningStorage, setCleaningStorage] = useState(false);
  const [storageCleanNote, setStorageCleanNote] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateNote, setUpdateNote] = useState('');

  useEffect(() => {
    if (visible) {
      setRender(true);
      getStorageStats().then(setStorageInfo).catch(() => {});
      y.setValue(SHEET_H + 100);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 26, stiffness: 230, mass: 1, overshootClamping: true }),
        Animated.timing(fade, { toValue: 1, duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
    } else if (render) {
      Animated.parallel([
        Animated.timing(y, { toValue: SHEET_H + 100, duration: 240, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start(({ finished }) => finished && setRender(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => y.stopAnimation(),
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) y.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 90 || g.vy > 0.5) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(y, { toValue: SHEET_H + 100, duration: 200, useNativeDriver: true }).start(() => onCloseRef.current());
        } else {
          Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260, mass: 0.9 }).start();
        }
      },
    })
  ).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const setDj = (p: Partial<DJSettings>) => {
    Haptics.selectionAsync();
    smooth();
    onUpdateSettings({ ...settings, ...p });
  };
  const setFx = useCallback(
    (p: Partial<FxSettings>, haptic = true) => {
      if (haptic) Haptics.selectionAsync();
      smooth();
      onUpdateFx({ ...fx, ...p });
    },
    [fx, onUpdateFx]
  );
  const setFxLive = (p: Partial<FxSettings>) => onUpdateFx({ ...fx, ...p }); // ползунки: без анимации раскладки

  const rescan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanNote('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const note = await onRescan();
      setScanNote(note);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setScanNote('Не удалось обновить библиотеку');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setScanning(false);
    }
  };

  const cleanStorage = async () => {
    if (cleaningStorage) return;
    setCleaningStorage(true);
    setStorageCleanNote('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const tracks = await loadCachedTracks();
      const activeCovers = new Set<string>();
      for (const t of tracks) {
        if (t.artworkUri) {
          const file = t.artworkUri.split('/').pop();
          if (file) activeCovers.add(file);
        }
      }
      const freed = await purgeStorage(activeCovers);
      await onRescan();
      const fresh = await getStorageStats();
      setStorageInfo(fresh);
      setStorageCleanNote(`Очищено! Освобождено: ${formatBytes(freed)}`);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setStorageCleanNote('Ошибка при очистке');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCleaningStorage(false);
    }
  };

  const handleCheckUpdate = async () => {
    if (checkingUpdate || !onCheckUpdate) return;
    setCheckingUpdate(true);
    setUpdateNote('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const info = await onCheckUpdate();
      if (info.hasUpdate) {
        setUpdateNote(`Доступна новая версия v${info.latestVersion}`);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setUpdateNote(`Установлена последняя версия (v${CURRENT_VERSION})`);
        Haptics.selectionAsync();
      }
    } catch {
      setUpdateNote('Не удалось проверить обновления');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo || updatingApp) return;
    setUpdatingApp(true);
    setUpdateProgress(Platform.OS === 'android' ? 0.01 : null);
    setUpdateNote('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await installUpdate(updateInfo, (p) => setUpdateProgress(p));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setUpdateNote('Ошибка при загрузке обновления');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setUpdatingApp(false);
      setUpdateProgress(null);
    }
  };

  if (!render) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade, backgroundColor: 'rgba(0,0,0,0.55)' }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: y }] }]}>
          <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(18,18,20,0.72)' }]} />

          <View {...pan.panHandlers} style={styles.grabArea}>
            <View style={styles.grabber} />
            <View style={styles.headerBar}>
              <Text style={styles.h1}>Настройки</Text>
              <PressableScale onPress={onClose} hitSlop={12}>
                <View style={styles.closeBtn}>
                  <Ionicons name="close" size={18} color={colors.text2} />
                </View>
              </PressableScale>
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            {updateInfo?.hasUpdate && (
              <Glass radius={20} style={{ marginTop: 8, marginBottom: 16 }}>
                <View style={{ padding: 16 }}>
                  <View style={[styles.row, { paddingVertical: 0 }]}>
                    <View style={styles.info}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <View style={styles.updateDotInline} />
                        <Text style={styles.rowTitle}>Доступно обновление v{updateInfo.latestVersion}</Text>
                      </View>
                      <Text style={styles.rowDesc}>
                        {updatingApp && updateProgress !== null
                          ? `Скачивание APK: ${Math.round(updateProgress * 100)}%`
                          : updateInfo.notes || `Текущая версия: v${CURRENT_VERSION}`}
                      </Text>
                    </View>
                    <PressableScale onPress={handleInstallUpdate} disabled={updatingApp} haptic="medium">
                      <View style={styles.updateBtn}>
                        {updatingApp ? (
                          <ActivityIndicator size="small" color={colors.onAccent} />
                        ) : (
                          <Text style={styles.updateBtnText}>Обновить</Text>
                        )}
                      </View>
                    </PressableScale>
                  </View>
                  {updatingApp && updateProgress !== null && (
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${Math.round(updateProgress * 100)}%` }]} />
                    </View>
                  )}
                </View>
              </Glass>
            )}

            {/* ───── DJ-склейка ───── */}
            <Text style={styles.section}>DJ-склейка</Text>
            <ToggleRow
              title="Склейка треков"
              desc="Следующий трек входит, пока текущий затухает"
              value={settings.crossfadeEnabled}
              onChange={(v) => setDj({ crossfadeEnabled: v })}
            />

            {settings.crossfadeEnabled && (
              <Glass radius={20} style={{ marginTop: 6 }}>
                <View style={{ padding: 16 }}>
                  <LiveSlider
                    label="Длительность перехода"
                    value={settings.crossfadeDuration}
                    min={1}
                    max={15}
                    step={1}
                    format={(v) => `${Math.round(v)} сек`}
                    onChange={(v) => v !== settings.crossfadeDuration && onUpdateSettings({ ...settings, crossfadeDuration: Math.round(v) })}
                  />
                  <View style={styles.sliderHead}>
                    <Text style={styles.scale}>1 сек</Text>
                    <Text style={styles.scale}>15 сек</Text>
                  </View>
                  <ToggleRow
                    sub
                    title="Подгон темпа (BPM)"
                    desc="Оба трека одновременно подстраиваются под общий темп"
                    value={settings.bpmTransitionEnabled}
                    onChange={(v) => setDj({ bpmTransitionEnabled: v })}
                  />
                  <ToggleRow
                    sub
                    title="Плавная громкость"
                    desc="Включено — мягкая S-кривая, выключено — линейный переход"
                    value={settings.fadeVolumeEnabled}
                    onChange={(v) => setDj({ fadeVolumeEnabled: v })}
                  />
                </View>
              </Glass>
            )}

            <View style={styles.presets}>
              {[3, 5, 10].map((d) => {
                const on = settings.crossfadeEnabled && settings.crossfadeDuration === d;
                return (
                  <PressableScale key={d} style={{ flex: 1 }} onPress={() => setDj({ crossfadeEnabled: true, crossfadeDuration: d })}>
                    <View style={[styles.pill, on && styles.pillOn]}>
                      <Text style={[styles.pillText, on && { color: colors.onAccent }]}>{d} сек</Text>
                    </View>
                  </PressableScale>
                );
              })}
            </View>

            {/* ───── Звуковые эффекты ───── */}
            <Text style={[styles.section, { marginTop: 30 }]}>Звук</Text>
            <ToggleRow
              title="Включить звуковые эффекты"
              desc="Реверберация, 8D, Slowed, Speed Up"
              value={fx.enabled}
              onChange={(v) => setFx({ enabled: v })}
            />

            {fx.enabled && (
              <Glass radius={20} style={{ marginTop: 6 }}>
                <View style={{ padding: 16 }}>
                  <ToggleRow
                    title="Реверберация"
                    desc="Эффект «зала»: звук слегка тянется после удара"
                    value={fx.reverb}
                    onChange={(v) => setFx({ reverb: v })}
                  />
                  {fx.reverb && (
                    <LiveSlider
                      label="Количество реверберации"
                      value={fx.reverbAmount}
                      min={0}
                      max={100}
                      format={(v) => `${Math.round(v)}%`}
                      onChange={(v) => setFxLive({ reverbAmount: Math.round(v) })}
                    />
                  )}

                  <ToggleRow sub title="8D аудио" desc="Звук плавно кружит вокруг головы (лучше в наушниках)" value={fx.spatial8d} onChange={(v) => setFx({ spatial8d: v })} />

                  <ToggleRow
                    sub
                    title="Slowed"
                    desc="Медленнее и ниже по тону"
                    value={fx.slowed}
                    onChange={(v) => setFx({ slowed: v, speedUp: v ? false : fx.speedUp })}
                  />
                  {fx.slowed && (
                    <View style={styles.nested}>
                      <ToggleRow
                        title="Reverb для Slowed"
                        value={fx.slowedReverb}
                        onChange={(v) => setFx({ slowedReverb: v })}
                      />
                      {fx.slowedReverb && (
                        <LiveSlider
                          label="Количество"
                          value={fx.slowedReverbAmount}
                          min={0}
                          max={100}
                          format={(v) => `${Math.round(v)}%`}
                          onChange={(v) => setFxLive({ slowedReverbAmount: Math.round(v) })}
                        />
                      )}
                    </View>
                  )}

                  <ToggleRow
                    sub
                    title="Speed Up"
                    desc="Быстрее и выше по тону"
                    value={fx.speedUp}
                    onChange={(v) => setFx({ speedUp: v, slowed: v ? false : fx.slowed })}
                  />
                </View>
              </Glass>
            )}
            {(fx.enabled || musicHaptics) && (
              <Text style={styles.note}>
                {(() => {
                  const d = fxDiagnostics();
                  const env = d.expoGo ? 'Expo Go' : 'собственная сборка';
                  return `Диагностика: ${env} · модуль ${d.moduleFound ? 'найден' : 'НЕ найден'} · движок ${fxActive ? 'включён' : 'не включён'} · загрузок ${d.loads}${d.lastError ? ' · ошибка: ' + d.lastError : ''}`;
                })()}
              </Text>
            )}
            {fx.enabled && (
              <Text style={styles.note}>
                {fxNativeReady
                  ? fxActive
                    ? 'Нативный движок эффектов: работает.'
                    : 'Нативный движок эффектов: готов (включится вместе с реверберацией или 8D).'
                  : fxDiagnostics().expoGo
                  ? 'Вы открыли приложение в Expo Go. Expo Go не умеет загружать собственные нативные модули, поэтому реверберация, 8D, бесшовный подгон BPM и Core Haptics там недоступны (работают только Slowed и Speed Up). Установите сборку .ipa (GitHub → Actions → Build iOS IPA) или dev-сборку: npx expo run:ios.'
                  : 'Нативный движок не вошёл в эту сборку. Пересоберите проект с нуля: npx expo prebuild --platform ios --clean (папка modules/woufy-fx должна лежать в корне проекта).'}
              </Text>
            )}

            {/* ───── Тактильный отклик ───── */}
            <View style={{ marginTop: 18 }}>
              <ToggleRow
                title="Тактильный отклик под музыку"
                desc="Вибрация в такт ударным и басу трека"
                value={musicHaptics}
                onChange={(v) => {
                  Haptics.selectionAsync();
                  onToggleHaptics(v);
                }}
              />
            </View>

            {/* ───── Библиотека ───── */}
            <Text style={[styles.section, { marginTop: 30, marginBottom: 10 }]}>Библиотека</Text>
            <Glass radius={20} style={{ marginBottom: 16 }}>
              <View style={[styles.row, { padding: 16 }]}>
                <View style={styles.info}>
                  <Text style={styles.rowTitle}>
                    {trackCount} {trackCount % 10 === 1 && trackCount % 100 !== 11 ? 'трек' : trackCount % 10 >= 2 && trackCount % 10 <= 4 && (trackCount % 100 < 12 || trackCount % 100 > 14) ? 'трека' : 'треков'}
                  </Text>
                  <Text style={styles.rowDesc}>
                    {scanNote ||
                      (Platform.OS === 'android'
                        ? 'Папки Music / Music/WouFY / Download'
                        : 'Файлы → На iPhone → WouFY.no → Music')}
                  </Text>
                </View>
                <PressableScale onPress={rescan} disabled={scanning} haptic="none">
                  {scanning ? <ActivityIndicator color={colors.text} /> : <Text style={styles.link}>Обновить</Text>}
                </PressableScale>
              </View>
            </Glass>

            {/* ───── Память и кэш ───── */}
            <Text style={[styles.section, { marginTop: 14, marginBottom: 10 }]}>Память и кэш</Text>
            <Glass radius={20} style={{ marginBottom: 16 }}>
              <View style={[styles.row, { padding: 16 }]}>
                <View style={styles.info}>
                  <Text style={styles.rowTitle}>
                    {storageInfo ? storageInfo.formattedTotal : 'Вычисление…'}
                  </Text>
                  <Text style={styles.rowDesc}>
                    {storageCleanNote ||
                      (storageInfo
                        ? `Обложек: ${storageInfo.coversCount} · Корзина: ${formatBytes(storageInfo.trashBytes)}`
                        : 'Кэш обложек, корзина .Trash и временные данные')}
                  </Text>
                </View>
                <PressableScale onPress={cleanStorage} disabled={cleaningStorage} haptic="none">
                  {cleaningStorage ? <ActivityIndicator color={colors.text} /> : <Text style={styles.link}>Очистить</Text>}
                </PressableScale>
              </View>
            </Glass>

            {/* ───── Обновление приложения ───── */}
            <Text style={[styles.section, { marginTop: 14, marginBottom: 10 }]}>Обновление приложения</Text>
            <Glass radius={20} style={{ marginBottom: 30 }}>
              <View style={{ padding: 16 }}>
                <View style={[styles.row, { paddingVertical: 0 }]}>
                  <View style={styles.info}>
                    <Text style={styles.rowTitle}>
                      WouFY.no v{CURRENT_VERSION}
                    </Text>
                    <Text style={styles.rowDesc}>
                      {updatingApp && updateProgress !== null
                        ? `Загрузка обновления: ${Math.round(updateProgress * 100)}%`
                        : updateNote ||
                          (updateInfo?.hasUpdate
                            ? `Доступна новая версия v${updateInfo.latestVersion}`
                            : 'Автопроверка обновлений при входе')}
                    </Text>
                  </View>
                  {updateInfo?.hasUpdate ? (
                    <PressableScale onPress={handleInstallUpdate} disabled={updatingApp} haptic="medium">
                      <View style={styles.updateBtn}>
                        {updatingApp ? (
                          <ActivityIndicator size="small" color={colors.onAccent} />
                        ) : (
                          <Text style={styles.updateBtnText}>Обновить</Text>
                        )}
                      </View>
                    </PressableScale>
                  ) : (
                    <PressableScale onPress={handleCheckUpdate} disabled={checkingUpdate} haptic="none">
                      {checkingUpdate ? <ActivityIndicator color={colors.text} /> : <Text style={styles.link}>Проверить</Text>}
                    </PressableScale>
                  )}
                </View>
                {updatingApp && updateProgress !== null && (
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.round(updateProgress * 100)}%` }]} />
                  </View>
                )}
              </View>
            </Glass>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { height: '84%', borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  grabArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  grabber: { width: 32, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 10 },
  headerBar: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 20, paddingBottom: 60 },
  h1: { ...type.largeTitle, fontSize: 28, color: colors.text },
  section: { ...type.title, fontSize: 20, color: colors.text, marginTop: 12, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  sub: { marginTop: 10, borderTopWidth: 1, borderColor: 'rgba(255,255,255,0.08)', paddingTop: 14 },
  nested: { marginLeft: 6, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(255,255,255,0.12)', marginTop: 2 },
  info: { flex: 1, marginRight: 14 },
  rowTitle: { ...type.headline, color: colors.text },
  rowDesc: { ...type.caption, fontSize: 13, color: colors.text2, marginTop: 2 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { ...type.mono, fontSize: 13, color: colors.text, fontWeight: '700' },
  scale: { ...type.caption, color: colors.text3 },
  presets: { flexDirection: 'row', gap: 10, marginTop: 14, width: '100%' },
  pill: { height: 44, width: '100%', borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { ...type.body, fontWeight: '600', color: colors.text },
  link: { ...type.body, fontWeight: '700', color: colors.text },
  note: { ...type.caption, fontSize: 12, color: colors.text3, marginTop: 8, lineHeight: 17 },
  updateDotInline: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#34C759' },
  updateBtn: {
    paddingHorizontal: 16,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateBtnText: { ...type.body, fontSize: 14, fontWeight: '700', color: colors.onAccent },
  progressTrack: {
    marginTop: 12,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
});
