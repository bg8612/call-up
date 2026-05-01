import { describe, expect, it } from 'vitest';
import { pickAvailableDeviceId, resolveAudioInputWarning } from './device-selection';

describe('pickAvailableDeviceId', () => {
  it('keeps current id when it is still available', () => {
    expect(pickAvailableDeviceId('mic-2', ['mic-1', 'mic-2', 'mic-3'])).toEqual({
      deviceId: 'mic-2',
      changed: false
    });
  });

  it('falls back to first available device when current disappears', () => {
    expect(pickAvailableDeviceId('mic-2', ['mic-1', 'mic-3'])).toEqual({
      deviceId: 'mic-1',
      changed: true
    });
  });

  it('returns empty id when no device is available', () => {
    expect(pickAvailableDeviceId('mic-2', [])).toEqual({
      deviceId: '',
      changed: true
    });
  });
});

describe('resolveAudioInputWarning', () => {
  it('returns mismatch warning when actual device differs from requested', () => {
    expect(
      resolveAudioInputWarning({
        requestedDeviceId: 'mic-usb',
        actualDeviceId: 'default',
        usedFallbackDevice: false
      })
    ).toContain('браузер использует другое устройство');
  });

  it('returns fallback warning when requested device could not be opened', () => {
    expect(
      resolveAudioInputWarning({
        requestedDeviceId: 'mic-usb',
        actualDeviceId: undefined,
        usedFallbackDevice: true
      })
    ).toContain('устройство по умолчанию');
  });

  it('returns null when request is satisfied', () => {
    expect(
      resolveAudioInputWarning({
        requestedDeviceId: 'mic-usb',
        actualDeviceId: 'mic-usb',
        usedFallbackDevice: false
      })
    ).toBeNull();
  });
});
