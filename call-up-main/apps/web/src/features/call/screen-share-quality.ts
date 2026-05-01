export type ScreenSharePresetId =
  | '480p15'
  | '720p30'
  | '1080p30'
  | '1440p60'
  | '2160p60';

export type ScreenSharePreset = {
  id: ScreenSharePresetId;
  label: string;
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
};

export const SCREEN_SHARE_PRESETS: ScreenSharePreset[] = [
  {
    id: '480p15',
    label: '480p · 15 FPS',
    width: 854,
    height: 480,
    fps: 15,
    maxBitrate: 900_000
  },
  {
    id: '720p30',
    label: '720p · 30 FPS',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrate: 2_500_000
  },
  {
    id: '1080p30',
    label: 'Full HD · 60 FPS',
    width: 3840,
    height: 2160,
    fps: 60,
    maxBitrate: 16_000_000
  },
  {
    id: '1440p60',
    label: '1440p · 60 FPS',
    width: 2560,
    height: 1440,
    fps: 60,
    maxBitrate: 9_000_000
  },
  {
    id: '2160p60',
    label: '4K · 60 FPS',
    width: 3840,
    height: 2160,
    fps: 60,
    maxBitrate: 16_000_000
  }
];

export const DEFAULT_SCREEN_SHARE_PRESET_ID: ScreenSharePresetId = '1080p30';

export const getScreenSharePreset = (id: ScreenSharePresetId) =>
  SCREEN_SHARE_PRESETS.find((preset) => preset.id === id) ?? SCREEN_SHARE_PRESETS[0];

export const toDisplayVideoConstraints = (preset: ScreenSharePreset): MediaTrackConstraints => ({
  width: { ideal: preset.width, max: preset.width },
  height: { ideal: preset.height, max: preset.height },
  frameRate: { ideal: preset.fps, max: preset.fps }
});

export const isScreenSharePresetSatisfiedBySettings = (
  preset: ScreenSharePreset,
  settings: Pick<MediaTrackSettings, 'width' | 'height' | 'frameRate'>
) => {
  const widthOk = (settings.width ?? 0) >= Math.floor(preset.width * 0.95);
  const heightOk = (settings.height ?? 0) >= Math.floor(preset.height * 0.95);
  const fpsOk = (settings.frameRate ?? 0) >= Math.floor(preset.fps * 0.9);
  return widthOk && heightOk && fpsOk;
};
