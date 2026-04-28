import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
const roomId = process.env.ROOM_ID ?? 'mic-check-room';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream'
  ]
});

const context = await browser.newContext({
  permissions: ['camera', 'microphone']
});

const pageA = await context.newPage();
const pageB = await context.newPage();

await pageB.addInitScript(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const wantsVideo = typeof constraints === 'object' && constraints !== null && 'video' in constraints;
    const wantsAudio = typeof constraints === 'object' && constraints !== null && 'audio' in constraints;
    if (wantsVideo || wantsAudio) {
      throw new Error('Simulated no local media for second smoke participant');
    }

    return original(constraints);
  };
});

const join = async (page, displayName) => {
  await page.goto(`${baseUrl}/?room=${roomId}`, { waitUntil: 'networkidle' });
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('.hero-strip', { timeout: 20000 });
};

try {
  await join(pageA, 'Alex');
  await join(pageB, 'Mira');

  await pageA.waitForFunction(
    () => document.body.innerText.includes('2 участников онлайн'),
    undefined,
    { timeout: 20000 }
  );
  await pageB.waitForFunction(
    () => document.body.innerText.includes('2 участников онлайн'),
    undefined,
    { timeout: 20000 }
  );

  await pageA.locator('button:has-text("Stop camera")').click();

  await pageB.waitForFunction(
    () => document.body.innerText.includes('Camera off'),
    undefined,
    { timeout: 20000 }
  );

  const audioVisibleForRemote = await pageB.locator('[data-testid="remote-camera-audio"]').count();
  if (audioVisibleForRemote < 1) {
    throw new Error('Remote audio element is missing when camera is off');
  }

  await pageA.locator('button:has-text("Mute mic")').click();

  await pageB.waitForFunction(
    () => document.body.innerText.includes('Mic off'),
    undefined,
    { timeout: 20000 }
  );

  await pageA.locator('button:has-text("Unmute mic")').click();

  await pageB.waitForFunction(
    () => document.body.innerText.includes('Mic on'),
    undefined,
    { timeout: 20000 }
  );

  console.log(
    JSON.stringify({
      ok: true,
      verified: ['camera-off-keeps-remote-audio-element', 'mute-state-propagates', 'unmute-state-propagates']
    })
  );
} finally {
  await context.close();
  await browser.close();
}
