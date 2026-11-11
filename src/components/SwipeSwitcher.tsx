import React, { useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  PanResponder,
  Animated,
  Dimensions,
  LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface SwipeSwitcherProps {
  onOpenQueue: () => void;
  onOpenLyrics: () => void;
}

const THUMB_WIDTH = 58;
const THUMB_HEIGHT = 44;
const ICON_SIZE = 44;
const PADDING = 8;

export const SwipeSwitcher: React.FC<SwipeSwitcherProps> = ({
  onOpenQueue,
  onOpenLyrics,
}) => {
  // Default fallback container width based on screen width minus padding
  const [containerWidth, setContainerWidth] = useState(
    Math.min(SCREEN_WIDTH - 48, 340)
  );

  const panX = useRef(new Animated.Value(0)).current;
  const isTriggered = useRef(false);

  // Center position of thumb
  const centerX = (containerWidth - THUMB_WIDTH) / 2;
  // Maximum travel from center to icon boundary
  const maxTravel = Math.max(60, centerX - PADDING);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 6;
      },
      onPanResponderGrant: () => {
        isTriggered.current = false;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_, gestureState) => {
        // Allow traveling the FULL distance from center to left/right icon
        const clampedX = Math.max(-maxTravel, Math.min(maxTravel, gestureState.dx));
        panX.setValue(clampedX);

        const threshold = maxTravel * 0.65;
        if (!isTriggered.current) {
          if (clampedX >= threshold || clampedX <= -threshold) {
            isTriggered.current = true;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
        } else {
          if (clampedX < threshold && clampedX > -threshold) {
            isTriggered.current = false;
          }
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        const threshold = maxTravel * 0.65;
        if (gestureState.dx >= threshold) {
          onOpenQueue(); // Dragged completely to Queue
        } else if (gestureState.dx <= -threshold) {
          onOpenLyrics(); // Dragged completely to Lyrics
        }

        // Return to dead center smoothly with spring
        Animated.spring(panX, {
          toValue: 0,
          friction: 7,
          tension: 75,
          useNativeDriver: false,
        }).start();
      },
    })
  ).current;

  const onLayout = (e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    if (width > 0 && Math.abs(width - containerWidth) > 2) {
      setContainerWidth(width);
    }
  };

  // Interpolations
  const rotateRightIcon = panX.interpolate({
    inputRange: [0, maxTravel],
    outputRange: ['0deg', '360deg'],
    extrapolate: 'clamp',
  });

  const rotateLeftIcon = panX.interpolate({
    inputRange: [-maxTravel, 0],
    outputRange: ['-360deg', '0deg'],
    extrapolate: 'clamp',
  });

  // Center handle fades out when slider moves toward an icon
  const handleOpacity = panX.interpolate({
    inputRange: [-35, 0, 35],
    outputRange: [0, 1, 0],
    extrapolate: 'clamp',
  });

  // Target icon inside the slider scales subtly for emphasis
  const rightIconScale = panX.interpolate({
    inputRange: [0, maxTravel],
    outputRange: [0.9, 1.15],
    extrapolate: 'clamp',
  });

  const leftIconScale = panX.interpolate({
    inputRange: [-maxTravel, 0],
    outputRange: [1.15, 0.9],
    extrapolate: 'clamp',
  });

  const rightIconOpacity = panX.interpolate({
    inputRange: [0, maxTravel * 0.7],
    outputRange: [0.55, 1],
    extrapolate: 'clamp',
  });

  const leftIconOpacity = panX.interpolate({
    inputRange: [-maxTravel * 0.7, 0],
    outputRange: [1, 0.55],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.container} onLayout={onLayout}>
      {/* Left Target: Lyrics (Apple Music style text/lyrics bubble) */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenLyrics();
        }}
        style={[styles.iconTouch, { left: PADDING + (THUMB_WIDTH - ICON_SIZE) / 2 }]}
      >
        <Animated.View
          style={[
            styles.iconWrapper,
            {
              opacity: leftIconOpacity,
              transform: [{ rotate: rotateLeftIcon }, { scale: leftIconScale }],
            },
          ]}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={21} color="#c084fc" />
        </Animated.View>
      </TouchableOpacity>

      {/* Right Target: Queue (List) */}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onOpenQueue();
        }}
        style={[styles.iconTouch, { right: PADDING + (THUMB_WIDTH - ICON_SIZE) / 2 }]}
      >
        <Animated.View
          style={[
            styles.iconWrapper,
            {
              opacity: rightIconOpacity,
              transform: [{ rotate: rotateRightIcon }, { scale: rightIconScale }],
            },
          ]}
        >
          <Ionicons name="list" size={23} color="#c084fc" />
        </Animated.View>
      </TouchableOpacity>

      {/* Central Sliding Thumb: Moves across the full track to envelop the icon */}
      <Animated.View
        style={[
          styles.thumb,
          {
            left: centerX,
            transform: [{ translateX: panX }],
          },
        ]}
        {...panResponder.panHandlers}
      >
        <Animated.View style={[styles.thumbHandle, { opacity: handleOpacity }]} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 56,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 28,
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    marginTop: 8,
    position: 'relative',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  iconTouch: {
    position: 'absolute',
    top: (56 - ICON_SIZE) / 2,
    width: ICON_SIZE,
    height: ICON_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
  },
  iconWrapper: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumb: {
    position: 'absolute',
    top: (56 - THUMB_HEIGHT) / 2,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    backgroundColor: 'rgba(192, 132, 252, 0.28)',
    borderWidth: 1.5,
    borderColor: 'rgba(192, 132, 252, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#a855f7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    zIndex: 5,
  },
  thumbHandle: {
    width: 16,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
});
