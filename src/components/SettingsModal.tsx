import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, ScrollView, StyleSheet, Switch, Text, View, Pressable } from 'react-native';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { DJSettings } from '../types';
import { colors, type } from '../theme';
import { Glass, PressableScale } from './ui';

interface Props {
  visible: boolean;
  settings: DJSettings;
  onUpdateSettings: (s: DJSettings) => void;
  onClose: () => void;
  trackCount: number;
  onRescan: () => void;
  bpmInfo?: { title: string; bpm?: number; source?: 'manual' | 'tag' | 'auto' };
  onEditBpm: () => void;
}

const SOURCE_LABEL = { manual: 'вручную', tag: 'из тега', auto: 'определён автоматически' } as const;

export const SettingsModal: React.FC<Props> = ({
  visible,
  settings,
  onUpdateSettings,
  onClose,
  trackCount,
  onRescan,
  bpmInfo,
  onEditBpm,
}) => {
  const [render, setRender] = useState(visible);
  const y = useRef(new Animated.Value(700)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setRender(true);
      y.setValue(700);
      Animated.parallel([
        Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 24, stiffness: 220, mass: 1, overshootClamping: true }),
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else if (render) {
      Animated.parallel([
        Animated.timing(y, { toValue: 700, duration: 220, useNativeDriver: true }),
        Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setRender(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        y.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) y.setValue(g.dy);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 80 || g.vy > 0.4) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(y, { toValue: 700, duration: 200, useNativeDriver: true }).start(() => {
            onClose();
          });
        } else {
          Animated.spring(y, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 260, mass: 0.9 }).start();
        }
      },
    })
  ).current;

  if (!render) return null;
  const set = (p: Partial<DJSettings>) => {
    Haptics.selectionAsync();
    onUpdateSettings({ ...settings, ...p });
  };
  const track = { false: 'rgba(255,255,255,0.14)', true: 'rgba(255,255,255,0.55)' };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade, backgroundColor: 'rgba(0,0,0,0.55)' }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View style={[styles.sheet, { transform: [{ translateY: y }] }]}>
          <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(18,18,20,0.72)' }]} />
          
          {/* Верхняя зона: полоска + заголовок DJ-склейка (можно тянуть вниз для закрытия) */}
          <View {...pan.panHandlers} style={styles.grabArea}>
            <View style={styles.grabber} />
            <View style={styles.headerBar}>
              <Text style={styles.h1}>DJ-склейка</Text>
              <PressableScale onPress={onClose} hitSlop={12}>
                <View style={styles.closeBtn}>
                  <Ionicons name="close" size={18} color={colors.text2} />
                </View>
              </PressableScale>
            </View>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <View style={styles.row}>
              <View style={styles.info}>
                <Text style={styles.rowTitle}>Склейка треков</Text>
                <Text style={styles.rowDesc}>Следующий трек входит, пока текущий затухает</Text>
              </View>
              <Switch value={settings.crossfadeEnabled} onValueChange={(v) => set({ crossfadeEnabled: v })} trackColor={track} ios_backgroundColor="rgba(255,255,255,0.14)" />
            </View>

            {settings.crossfadeEnabled && (
              <Glass radius={20} style={{ marginTop: 6 }}>
                <View style={{ padding: 16 }}>
                  <View style={styles.sliderHead}>
                    <Text style={styles.rowTitle}>Длительность перехода</Text>
                    <Text style={styles.badge}>{settings.crossfadeDuration} сек</Text>
                  </View>
                  <Slider
                    style={{ height: 36 }}
                    minimumValue={1}
                    maximumValue={15}
                    step={1}
                    value={settings.crossfadeDuration}
                    onValueChange={(v) => v !== settings.crossfadeDuration && set({ crossfadeDuration: Math.round(v) })}
                    minimumTrackTintColor="#FFFFFF"
                    maximumTrackTintColor="rgba(255,255,255,0.18)"
                    thumbTintColor="#FFFFFF"
                  />
                  <View style={styles.sliderHead}>
                    <Text style={styles.scale}>1 сек</Text>
                    <Text style={styles.scale}>15 сек</Text>
                  </View>

                  <View style={[styles.row, styles.sub]}>
                    <View style={styles.info}>
                      <Text style={styles.rowTitle}>Подгон темпа (BPM)</Text>
                      <Text style={styles.rowDesc}>Оба трека одновременно подстраиваются под общий темп</Text>
                    </View>
                    <Switch value={settings.bpmTransitionEnabled} onValueChange={(v) => set({ bpmTransitionEnabled: v })} trackColor={track} ios_backgroundColor="rgba(255,255,255,0.14)" />
                  </View>
                  <View style={[styles.row, styles.sub]}>
                    <View style={styles.info}>
                      <Text style={styles.rowTitle}>Плавная громкость</Text>
                      <Text style={styles.rowDesc}>Выключено — мгновенная смена в середине перехода</Text>
                    </View>
                    <Switch value={settings.fadeVolumeEnabled} onValueChange={(v) => set({ fadeVolumeEnabled: v })} trackColor={track} ios_backgroundColor="rgba(255,255,255,0.14)" />
                  </View>
                </View>
              </Glass>
            )}

            <View style={styles.presets}>
              {[3, 5, 10].map((d) => {
                const on = settings.crossfadeEnabled && settings.crossfadeDuration === d;
                return (
                  <PressableScale key={d} style={{ flex: 1 }} onPress={() => set({ crossfadeEnabled: true, crossfadeDuration: d })}>
                    <View style={[styles.pill, on && styles.pillOn]}>
                      <Text style={[styles.pillText, on && { color: colors.onAccent }]}>{d} сек</Text>
                    </View>
                  </PressableScale>
                );
              })}
            </View>

            <Text style={[styles.h1, { marginTop: 28 }]}>Текущий трек</Text>
            <Glass radius={20}>
              <View style={[styles.row, { padding: 16 }]}>
                <View style={styles.info}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{bpmInfo?.title ?? '—'}</Text>
                  <Text style={styles.rowDesc}>
                    {bpmInfo?.bpm ? `${Math.round(bpmInfo.bpm)} BPM · ${SOURCE_LABEL[bpmInfo.source ?? 'auto']}` : 'BPM определяется автоматически…'}
                  </Text>
                </View>
                <PressableScale onPress={onEditBpm}>
                  <Text style={styles.link}>Изменить</Text>
                </PressableScale>
              </View>
            </Glass>

            <Text style={[styles.h1, { marginTop: 28 }]}>Библиотека</Text>
            <Glass radius={20}>
              <View style={[styles.row, { padding: 16 }]}>
                <View style={styles.info}>
                  <Text style={styles.rowTitle}>{trackCount} треков</Text>
                  <Text style={styles.rowDesc}>Файлы → На iPhone → Woufy → Music</Text>
                </View>
                <PressableScale onPress={onRescan}>
                  <Text style={styles.link}>Обновить</Text>
                </PressableScale>
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
  sheet: { height: '82%', borderTopLeftRadius: 32, borderTopRightRadius: 32, overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.stroke },
  grabArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  grabber: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)', marginBottom: 10 },
  headerBar: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  h1: { ...type.largeTitle, fontSize: 26, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  sub: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke, paddingTop: 14 },
  info: { flex: 1, marginRight: 14 },
  rowTitle: { ...type.headline, color: colors.text },
  rowDesc: { ...type.caption, fontSize: 13, color: colors.text2, marginTop: 2 },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: { ...type.mono, fontSize: 13, color: colors.text, fontWeight: '700' },
  scale: { ...type.caption, color: colors.text3 },
  presets: { flexDirection: 'row', gap: 10, marginTop: 14, width: '100%' },
  pill: { height: 44, width: '100%', borderRadius: 22, backgroundColor: colors.glass, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.stroke, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: colors.accent },
  pillText: { ...type.body, fontWeight: '600', color: colors.text },
  link: { ...type.body, fontWeight: '700', color: colors.text },
});
