import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREEN_SHARE_PRESET_ID,
  SCREEN_SHARE_PRESETS,
  getScreenSharePreset,
  toDisplayVideoConstraints
} from './screen-share-quality';

describe('screen share quality presets', () => {
  it('includes profiles from 480p15 to 4k60', () => {
    expect(SCREEN_SHARE_PRESETS[0]?.id).toBe('480p15');
    expect(SCREEN_SHARE_PRESETS[SCREEN_SHARE_PRESETS.length - 1]?.id).toBe('2160p60');
  });

  it('returns default preset when id is unknown', () => {
    const fallback = getScreenSharePreset(DEFAULT_SCREEN_SHARE_PRESET_ID);
    expect(fallback.id).toBe(DEFAULT_SCREEN_SHARE_PRESET_ID);
  });

  it('builds display media constraints from preset', () => {
    const preset = getScreenSharePreset('720p30');
    expect(toDisplayVideoConstraints(preset)).toMatchObject({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 }
    });
  });
});
