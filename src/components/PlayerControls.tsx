import React, { useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AudioEngine, EngineState } from '../services/audioEngine';
import { usePosition } from '../hooks/useAudioController';
import { colors, formatTime, springs, type } from '../theme';
import { Glass, IconButton, PressableScale, Scrubber } from './ui';
import { SheetSwitcher } from './SheetSwitcher';

interface Props {
  engine: AudioEngine;
  state: EngineState;
  bpm?: number;
  bpmSource?: 'manual' | 'tag' | 'auto';
  onArtistPress: (artist: string) => void;
  onEditBpm: () => void;
  onOpenQueue: () => void;
  onOpenLyrics: () => void;
}

const Timeline: React.FC<{ engine: AudioEngine; duration: number }> = ({ engine, duration }) => {
  const pos = usePosition(engine, 100);
  const [scrub, setScrub] = useState<number | null>(null);
  const pending = useRef<{ v: number; t: number } | null>(null);

  let shown = pos;
  if (scrub !== null) shown = scrub;
  else if (pending.current) {
    if (Date.now() - pending.current.t < 450 && Math.abs(pos - pending.current.v) > 1.2) shown = pending.current.v;
    else pending.current = null;
  }

  return (
    <View>
      <Scrubber
        value={shown}
        max={duration > 0 ? duration : 1}
        disabled={duration <= 0}
        onScrub={setScrub}
        onCommit={(v) => {
          pending.current = { v, t: Date.now() };
          setScrub(null);
          engine.seek(v);
        }}
      />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatTime(shown)}</Text>
        <Text style={styles.time}>-{formatTime(Math.max(0, duration - shown))}</Text>
      </View>
    </View>
  );
};

export const PlayerControls: React.FC<Props> = ({
  engine,
  state,
  bpm,
  bpmSource,
  onArtistPress,
  onEditBpm,
  onOpenQueue,
  onOpenLyrics,
}) => {
  const track = state.queue[state.index];
  const playPop = useRef(new Animated.Value(1)).current;

  const togglePlay = () => {
    playPop.setValue(0.86);
    Animated.spring(playPop, { toValue: 1, useNativeDriver: true, ...springs.snappy }).start();
    engine.togglePlay();
  };

  const nextRepeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';

  return (
    <View style={styles.wrap}>
      {/* Название и исполнитель */}
      <View style={styles.infoRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {track?.title ?? 'Нет треков'}
          </Text>
          <PressableScale
            haptic="light"
            scaleTo={0.97}
            onPress={() => track?.artist && onArtistPress(track.artist)}
            style={{ alignSelf: 'flex-start' }}
          >
            <Text style={styles.artist} numberOfLines={1}>
              {track?.artist ?? 'Положите музыку в папку Music'}
            </Text>
          </PressableScale>
        </View>
        {track && (
          <PressableScale onPress={onEditBpm} scaleTo={0.94}>
            <Glass radius={14} style={styles.bpmChip}>
              <View style={styles.bpmInner}>
                {state.mixing && <View style={styles.mixDot} />}
                <Text style={styles.bpmText}>{bpm ? `${Math.round(bpm)} BPM` : 'BPM ?'}</Text>
                {bpmSource === 'auto' && <Text style={styles.bpmAuto}>авто</Text>}
              </View>
            </Glass>
          </PressableScale>
        )}
      </View>

      <Timeline engine={engine} duration={state.duration} />

      {/* Кнопки */}
      <View style={styles.controls}>
        <IconButton name="shuffle" size={22} box={44} active={state.shuffle} color={colors.text3} onPress={() => engine.setShuffle(!state.shuffle)} />
        <IconButton name="play-skip-back" size={32} box={56} onPress={() => engine.previous()} />
        <PressableScale onPress={togglePlay} haptic="medium" scaleTo={0.94}>
          <Animated.View style={[styles.playBtn, { transform: [{ scale: playPop }] }]}>
            <Ionicons
              name={state.isPlaying ? 'pause' : 'play'}
              size={32}
              color={colors.onAccent}
              style={{ marginLeft: state.isPlaying ? 0 : 3 }}
            />
          </Animated.View>
        </PressableScale>
        <IconButton name="play-skip-forward" size={32} box={56} onPress={() => engine.next()} />
        <View>
          <IconButton
            name="repeat"
            size={22}
            box={44}
            active={state.repeat !== 'off'}
            color={colors.text3}
            onPress={() => engine.setRepeat(nextRepeat)}
          />
          {state.repeat === 'one' && (
            <View style={styles.repeatOne} pointerEvents="none">
              <Text style={styles.repeatOneText}>1</Text>
            </View>
          )}
        </View>
      </View>

      {/* Громкость */}
      <View style={styles.volumeRow}>
        <Ionicons name="volume-low" size={16} color={colors.text3} />
        <View style={{ flex: 1, marginHorizontal: 10 }}>
          <Scrubber value={state.volume} max={1} height={4} onScrub={(v) => engine.setVolume(v)} onCommit={(v) => engine.setVolume(v)} />
        </View>
        <Ionicons name="volume-high" size={16} color={colors.text3} />
      </View>

      <SheetSwitcher onOpenQueue={onOpenQueue} onOpenLyrics={onOpenLyrics} />
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between', paddingTop: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { ...type.largeTitle, fontSize: 28, color: colors.text },
  artist: { ...type.headline, color: colors.text2, marginTop: 2 },
  bpmChip: { height: 28 },
  bpmInner: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 5 },
  bpmText: { ...type.mono, color: colors.text, fontWeight: '700' },
  bpmAuto: { fontSize: 9, fontWeight: '700', color: colors.text3, textTransform: 'uppercase' },
  mixDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.text },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  time: { ...type.mono, color: colors.text3 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  playBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repeatOne: {
    position: 'absolute',
    top: 8,
    right: 6,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repeatOneText: { fontSize: 9, fontWeight: '800', color: colors.onAccent },
  volumeRow: { flexDirection: 'row', alignItems: 'center' },
});
