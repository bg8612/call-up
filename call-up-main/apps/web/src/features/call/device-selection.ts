export const pickAvailableDeviceId = (
  currentDeviceId: string,
  availableDeviceIds: string[]
) => {
  if (currentDeviceId && availableDeviceIds.includes(currentDeviceId)) {
    return {
      deviceId: currentDeviceId,
      changed: false
    };
  }

  return {
    deviceId: availableDeviceIds[0] ?? '',
    changed: Boolean(currentDeviceId)
  };
};

export const resolveAudioInputWarning = ({
  requestedDeviceId,
  actualDeviceId,
  usedFallbackDevice
}: {
  requestedDeviceId?: string;
  actualDeviceId?: string;
  usedFallbackDevice: boolean;
}) => {
  if (requestedDeviceId && actualDeviceId && actualDeviceId !== requestedDeviceId) {
    return 'Выбранный микрофон недоступен, браузер использует другое устройство. Проверьте выбор микрофона в настройках.';
  }

  if (requestedDeviceId && usedFallbackDevice) {
    return 'Не удалось открыть выбранный микрофон. Подключено устройство по умолчанию.';
  }

  return null;
};
