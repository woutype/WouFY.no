import React, { useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  FlatList,
  TouchableOpacity,
  Image,
  PanResponder,
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { TrackFile } from '../services/fileScanner';
import { MiniPlayer } from './MiniPlayer';

interface QueueViewProps {
  tracks: TrackFile[];
  currentTrack: TrackFile | null;
  currentIndex: number | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onSelectTrack: (index: number) => void;
  onTogglePlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export const QueueView: React.FC<QueueViewProps> = ({
  tracks,
  currentTrack,
  currentIndex,
  searchQuery,
  onSearchChange,
  isPlaying,
  currentTime,
  duration,
  onSelectTrack,
  onTogglePlayPause,
  onNext,
  onPrevious,
  onClose,
}) => {
  // Smooth 1:1 pull down gesture to dismiss queue without sticking
  const panY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return gestureState.dy > 8 && Math.abs(gestureState.dx) < 20;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          panY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 70 || gestureState.vy > 0.5) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          Animated.timing(panY, {
            toValue: 700,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            panY.setValue(0);
          });
          onClose();
        } else {
          Animated.spring(panY, {
            toValue: 0,
            friction: 7,
            tension: 60,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return tracks;
    const query = searchQuery.toLowerCase();
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(query) ||
        (t.artist && t.artist.toLowerCase().includes(query)) ||
        t.filename.toLowerCase().includes(query)
    );
  }, [tracks, searchQuery]);

  const renderTrackItem = ({ item }: { item: TrackFile }) => {
    const originalIndex = tracks.findIndex((t) => t.id === item.id);
    const isCurrent = currentIndex === originalIndex;

    return (
      <TouchableOpacity
        activeOpacity={0.65}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onSelectTrack(originalIndex);
        }}
        style={[styles.trackRow, isCurrent && styles.trackRowActive]}
      >
        {/* Cover artwork */}
        {item.artworkUri ? (
          <Image source={{ uri: item.artworkUri }} style={styles.trackImage} />
        ) : (
          <View style={styles.trackPlaceholder}>
            <Ionicons name="musical-notes" size={20} color="#c084fc" />
          </View>
        )}

        <View style={styles.trackInfo}>
          <Text
            style={[styles.trackTitle, isCurrent && styles.trackTitleActive]}
            numberOfLines={1}
          >
            {item.title}
          </Text>
          <Text style={styles.trackArtist} numberOfLines={1}>
            {item.artist || 'NEXTIME'}
          </Text>
        </View>

        {/* Reorder / active icon */}
        <View style={styles.reorderIconContainer}>
          {isCurrent && isPlaying ? (
            <Ionicons name="volume-medium" size={18} color="#c084fc" />
          ) : (
            <Ionicons name="swap-vertical" size={18} color="#475569" />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ translateY: panY }] }]}>
      <LinearGradient colors={['#0e0717', '#1a0c28', '#0b0612']} style={styles.container}>
        {/* Top Handle / Grabber with 1:1 pull down tracking */}
        <View {...panResponder.panHandlers} style={styles.grabberSection}>
          <View style={styles.grabber} />
        </View>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Очередь</Text>
          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
            style={styles.closeBtn}
          >
            <Text style={styles.closeBtnText}>Готово</Text>
          </TouchableOpacity>
        </View>

        {/* Search Input with Active Query Display */}
        <View style={styles.searchContainer}>
          <Ionicons name="search-outline" size={17} color="#64748b" style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Поиск"
            placeholderTextColor="#64748b"
            value={searchQuery}
            onChangeText={onSearchChange}
            clearButtonMode="while-editing"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onSearchChange('');
              }}
              style={styles.clearBtn}
            >
              <Ionicons name="close-circle" size={18} color="#94a3b8" />
            </TouchableOpacity>
          )}
        </View>

        {/* Track List (Photo 6: Clean, compact Apple Music list) */}
        <FlatList
          data={filteredTracks}
          keyExtractor={(item) => item.id}
          renderItem={renderTrackItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />

        {/* Floating Mini Player Capsule */}
        {currentTrack && (
          <MiniPlayer
            track={currentTrack}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            onPress={onClose}
            onTogglePlayPause={onTogglePlayPause}
            onNext={onNext}
            onPrevious={onPrevious}
          />
        )}
      </LinearGradient>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingTop: 8,
  },
  grabberSection: {
    alignItems: 'center',
    paddingVertical: 10,
    width: '100%',
  },
  grabber: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  closeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  closeBtnText: {
    color: '#c084fc',
    fontSize: 14,
    fontWeight: '600',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 14,
    marginHorizontal: 20,
    paddingHorizontal: 12,
    height: 40,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 15,
  },
  clearBtn: {
    padding: 4,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 110,
  },
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 12,
  },
  trackRowActive: {
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
  },
  trackImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
    marginRight: 14,
  },
  trackPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: 'rgba(168, 85, 247, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  trackInfo: {
    flex: 1,
  },
  trackTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f8fafc',
  },
  trackTitleActive: {
    color: '#d8b4fe',
  },
  trackArtist: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 2,
  },
  reorderIconContainer: {
    padding: 6,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    marginLeft: 64,
  },
});
