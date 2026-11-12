import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, type } from '../theme';
import { PressableScale } from './ui';

interface Props {
  mode: 'queue' | 'lyrics';
  onModeChange: (m: 'queue' | 'lyrics') => void;
  onClose: () => void;
  topInset: number;
  children: React.ReactNode;
}

/** Каркас вторичных экранов: вкладки-подчёркивания (как в референсе) и закрытие */
export const SheetPanel: React.FC<Props> = ({ mode, onModeChange, onClose, topInset, children }) => (
  <View style={{ flex: 1, paddingTop: topInset }}>
    <View style={styles.header}>
      <View style={styles.tabs}>
        {(['queue', 'lyrics'] as const).map((m) => {
          const on = m === mode;
          return (
            <PressableScale key={m} onPress={() => onModeChange(m)} haptic="selection" scaleTo={0.96}>
              <View style={styles.tab}>
                <Text style={[styles.tabText, !on && { color: colors.text3 }]}>{m === 'queue' ? 'Очередь' : 'Текст'}</Text>
                <View style={[styles.underline, { opacity: on ? 1 : 0 }]} />
              </View>
            </PressableScale>
          );
        })}
      </View>
      <PressableScale onPress={onClose} hitSlop={12}>
        <View style={styles.close}>
          <Ionicons name="chevron-up" size={20} color={colors.text} />
        </View>
      </PressableScale>
    </View>
    <View style={{ flex: 1 }}>{children}</View>
  </View>
);

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, height: 64 },
  tabs: { flexDirection: 'row', gap: 24 },
  tab: { paddingVertical: 6 },
  tabText: { ...type.largeTitle, fontSize: 30, color: colors.text },
  underline: { marginTop: 4, height: 3, width: 28, borderRadius: 2, backgroundColor: colors.text },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
});
