import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme';
import { TrackFile } from '../types';
import { getArtistAvatar, getCachedArtistAvatar } from '../services/artistAvatars';

interface Props {
  artist: string;
  tracks?: TrackFile[];
  size?: number;
}

export const ArtistAvatar: React.FC<Props> = React.memo(({ artist, tracks, size = 44 }) => {
  const [uri, setUri] = useState<string | null>(() => getCachedArtistAvatar(artist));
  const fadeAnim = useRef(new Animated.Value(uri ? 1 : 0)).current;

  useEffect(() => {
    let active = true;
    const cached = getCachedArtistAvatar(artist);
    if (cached) {
      setUri(cached);
      fadeAnim.setValue(1);
      return;
    }

    getArtistAvatar(artist, tracks).then((res) => {
      if (active && res) {
        setUri(res);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true,
        }).start();
      }
    });

    return () => {
      active = false;
    };
  }, [artist, tracks, fadeAnim]);

  const rad = size / 2;

  return (
    <View style={[styles.avatarWrap, { width: size, height: size, borderRadius: rad }]}>
      {/* Плейсхолдер: матовое стекло + силуэт */}
      <View style={[StyleSheet.absoluteFill, styles.avatarPlaceholder]}>
        <Ionicons name="person" size={Math.round(size * 0.44)} color={colors.accent} />
      </View>
      {/* Плавное проявление официального фото поверх плейсхолдера */}
      {uri ? (
        <Animated.Image
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { opacity: fadeAnim, borderRadius: rad }]}
          resizeMode="cover"
          onError={() => setUri(null)}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  avatarWrap: {
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
