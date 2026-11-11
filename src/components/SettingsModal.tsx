import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Modal,
  PanResponder,
  Animated,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

export interface DJSettings {
  crossfadeEnabled: boolean;
  crossfadeDuration: number; // 1 - 15 seconds
  bpmTransitionEnabled: boolean;
  fadeVolumeEnabled: boolean;
}

interface SettingsModalProps {
  visible: boolean;
  settings: DJSettings;
  onUpdateSettings: (newSettings: DJSettings) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  visible,
  settings,
  onUpdateSettings,
  onClose,
}) => {
  const [shouldRender, setShouldRender] = useState(visible);
  const translateY = useRef(new Animated.Value(500)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      translateY.setValue(500);
      backdropOpacity.setValue(0);

      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          tension: 65,
          friction: 9,
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (shouldRender) {
      handleClose();
    }
  }, [visible]);

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 500,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShouldRender(false);
      onClose();
    });
  };

  // Pull-down gesture on grabber for 1:1 dismissal
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return gestureState.dy > 6 && Math.abs(gestureState.dx) < 20;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 70 || gestureState.vy > 0.5) {
          handleClose();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            tension: 70,
            friction: 8,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const handleToggleCrossfade = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onUpdateSettings({ ...settings, crossfadeEnabled: val });
  };

  const handleToggleBpm = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onUpdateSettings({ ...settings, bpmTransitionEnabled: val });
  };

  const handleToggleFade = (val: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onUpdateSettings({ ...settings, fadeVolumeEnabled: val });
  };

  const handleChangeDuration = (val: number) => {
    const rounded = Math.round(val);
    if (rounded !== settings.crossfadeDuration) {
      Haptics.selectionAsync();
      onUpdateSettings({ ...settings, crossfadeDuration: rounded });
    }
  };

  if (!shouldRender) return null;

  return (
    <Modal
      visible={shouldRender}
      transparent
      animationType="none"
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { opacity: backdropOpacity, backgroundColor: 'rgba(0, 0, 0, 0.65)' },
          ]}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={handleClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheetContainer,
            {
              transform: [{ translateY }],
            },
          ]}
        >
          <BlurView intensity={95} tint="dark" style={styles.blurSheet}>
            {/* Grabber with 1:1 pull down tracking */}
            <View {...panResponder.panHandlers} style={styles.grabberSection}>
              <View style={styles.grabber} />
            </View>

            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerTitleRow}>
                <Ionicons name="disc-outline" size={22} color="#c084fc" style={{ marginRight: 8 }} />
                <Text style={styles.title}>DJ Склейка треков</Text>
              </View>
              <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Main Crossfade Toggle */}
            <View style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.rowTitle}>Склейка треков (Crossfade)</Text>
                <Text style={styles.rowDesc}>Бесшовный переход между песнями</Text>
              </View>
              <Switch
                value={settings.crossfadeEnabled}
                onValueChange={handleToggleCrossfade}
                trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#9333ea' }}
                thumbColor="#ffffff"
              />
            </View>

            {/* Dependent DJ parameters */}
            {settings.crossfadeEnabled && (
              <View style={styles.subSettingsSection}>
                {/* 1. Duration Slider (1 - 15s) */}
                <View style={styles.sliderBlock}>
                  <View style={styles.sliderHeader}>
                    <Text style={styles.subTitle}>Длительность перехода</Text>
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{settings.crossfadeDuration} сек</Text>
                    </View>
                  </View>
                  <Slider
                    style={styles.slider}
                    minimumValue={1}
                    maximumValue={15}
                    step={1}
                    value={settings.crossfadeDuration}
                    onValueChange={handleChangeDuration}
                    minimumTrackTintColor="#c084fc"
                    maximumTrackTintColor="rgba(255, 255, 255, 0.15)"
                    thumbTintColor="#ffffff"
                  />
                  <View style={styles.sliderScale}>
                    <Text style={styles.scaleText}>1 сек</Text>
                    <Text style={styles.scaleText}>15 сек</Text>
                  </View>
                </View>

                {/* 2. BPM Match Toggle */}
                <View style={styles.subRow}>
                  <View style={styles.rowInfo}>
                    <Text style={styles.subTitle}>Подгон темпа (BPM Match)</Text>
                    <Text style={styles.rowDesc}>Синхронизация темпа бита перед склейкой</Text>
                  </View>
                  <Switch
                    value={settings.bpmTransitionEnabled}
                    onValueChange={handleToggleBpm}
                    trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#9333ea' }}
                    thumbColor="#ffffff"
                  />
                </View>

                {/* 3. Volume Fade In / Out */}
                <View style={styles.subRow}>
                  <View style={styles.rowInfo}>
                    <Text style={styles.subTitle}>Нарастание / затухание громкости</Text>
                    <Text style={styles.rowDesc}>Мягкий вход следующего трека</Text>
                  </View>
                  <Switch
                    value={settings.fadeVolumeEnabled}
                    onValueChange={handleToggleFade}
                    trackColor={{ false: 'rgba(255, 255, 255, 0.1)', true: '#9333ea' }}
                    thumbColor="#ffffff"
                  />
                </View>
              </View>
            )}

            {/* Quick Presets */}
            <View style={styles.presetsSection}>
              <Text style={styles.presetsLabel}>БЫСТРЫЕ ПРЕСЕТЫ</Text>
              <View style={styles.presetButtonsRow}>
                {[
                  { label: 'Клубный (3с)', duration: 3 },
                  { label: 'Стандарт (5с)', duration: 5 },
                  { label: 'Радио (8с)', duration: 8 },
                ].map((preset) => (
                  <TouchableOpacity
                    key={preset.label}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      onUpdateSettings({
                        ...settings,
                        crossfadeEnabled: true,
                        crossfadeDuration: preset.duration,
                      });
                    }}
                    style={[
                      styles.presetPill,
                      settings.crossfadeDuration === preset.duration &&
                        settings.crossfadeEnabled &&
                        styles.presetPillActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.presetText,
                        settings.crossfadeDuration === preset.duration &&
                          settings.crossfadeEnabled &&
                          styles.presetTextActive,
                      ]}
                    >
                      {preset.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </BlurView>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    width: '100%',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
  },
  blurSheet: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 38,
    backgroundColor: 'rgba(18, 9, 32, 0.88)',
    borderTopWidth: 1.5,
    borderTopColor: 'rgba(255, 255, 255, 0.15)',
  },
  grabberSection: {
    alignItems: 'center',
    paddingVertical: 10,
    width: '100%',
  },
  grabber: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  subRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
  },
  rowInfo: {
    flex: 1,
    marginRight: 16,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  rowDesc: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  subSettingsSection: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 16,
    padding: 16,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  sliderBlock: {
    marginBottom: 12,
  },
  sliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  subTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f1f5f9',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(192, 132, 252, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(192, 132, 252, 0.3)',
  },
  badgeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#c084fc',
  },
  slider: {
    width: '100%',
    height: 36,
  },
  sliderScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  scaleText: {
    fontSize: 12,
    color: '#64748b',
  },
  presetsSection: {
    marginTop: 16,
  },
  presetsLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
    marginBottom: 10,
    letterSpacing: 0.8,
  },
  presetButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  presetPill: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  presetPillActive: {
    backgroundColor: 'rgba(192, 132, 252, 0.25)',
    borderColor: '#c084fc',
  },
  presetText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  presetTextActive: {
    color: '#ffffff',
  },
});
