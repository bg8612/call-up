import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
const inviteRoom = process.env.ROOM_ID ?? `smoke${Math.floor(Math.random() * 1000)}`;
const inviteUrl = `${baseUrl}/?room=${inviteRoom}`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-http-screen-capture',
    '--auto-select-desktop-capture-source=Entire screen'
  ]
});

const context = await browser.newContext({
  permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write']
});

const pageA = await context.newPage();
const pageB = await context.newPage();
const pageAErrors = [];
const pageBErrors = [];

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

pageA.on('console', (message) => {
  if (message.type() === 'error') {
    pageAErrors.push(message.text());
  }
});
pageB.on('console', (message) => {
  if (message.type() === 'error') {
    pageBErrors.push(message.text());
  }
});
pageA.on('pageerror', (error) => pageAErrors.push(String(error)));
pageB.on('pageerror', (error) => pageBErrors.push(String(error)));

const waitForParticipantName = async (page, name) => {
  await page.waitForFunction(
    (expectedName) => document.body.innerText.includes(expectedName),
    name,
    { timeout: 20000 }
  );
};

try {
  await pageA.goto(inviteUrl, { waitUntil: 'networkidle' });
  const prefilled = await pageA.locator('input[name="roomId"]').inputValue();
  if (prefilled !== inviteRoom) {
    throw new Error(`Invite prefill failed: expected ${inviteRoom}, got ${prefilled}`);
  }

  await pageA.locator('input[name="displayName"]').fill('Alex');
  await pageA.locator('button[type="submit"]').click();
  await pageA.waitForSelector('.app-shell', { timeout: 20000 });
  await waitForParticipantName(pageA, 'Alex');

  const copiedInvite = inviteUrl;
  if (!copiedInvite.includes(`?room=${inviteRoom}`)) {
    throw new Error(`Unexpected copied invite: ${copiedInvite}`);
  }

  await pageB.goto(copiedInvite, { waitUntil: 'networkidle' });
  const prefilledSecond = await pageB.locator('input[name="roomId"]').inputValue();
  if (prefilledSecond !== inviteRoom) {
    throw new Error(`Second page invite prefill failed: expected ${inviteRoom}, got ${prefilledSecond}`);
  }

  await pageB.locator('input[name="displayName"]').fill('Mira');
  await pageB.locator('button[type="submit"]').click();
  await pageB.waitForSelector('.app-shell', { timeout: 20000 });
  await waitForParticipantName(pageA, 'Mira');
  await waitForParticipantName(pageB, 'Alex');

  await pageA.waitForFunction(
    () => document.querySelectorAll('[data-testid="media-tile"]').length >= 2,
    undefined,
    { timeout: 20000 }
  );

  await pageB.locator('[data-testid="leave-room"]').click();
  await pageB.waitForSelector('input[name="roomId"]', { timeout: 20000 });
  await pageA.waitForFunction(() => !document.body.innerText.includes('Mira'), undefined, { timeout: 20000 });

  console.log(
    JSON.stringify({
      ok: true,
      inviteUrl: copiedInvite,
      verified: ['invite-prefill', 'second-user-join', 'participant-sync', 'leave-room']
    })
  );
} catch (error) {
  const diagnostics = {
    error: String(error),
    pageAUrl: pageA.url(),
    pageBUrl: pageB.url(),
    pageAText: await pageA.locator('body').innerText().catch(() => 'unavailable'),
    pageBText: await pageB.locator('body').innerText().catch(() => 'unavailable'),
    pageATiles: await pageA.locator('[data-testid="media-tile"]').count().catch(() => -1),
    pageBTiles: await pageB.locator('[data-testid="media-tile"]').count().catch(() => -1),
    pageAErrors,
    pageBErrors
  };

  await pageA.screenshot({ path: 'artifacts-smoke-pageA.png', fullPage: true }).catch(() => {});
  await pageB.screenshot({ path: 'artifacts-smoke-pageB.png', fullPage: true }).catch(() => {});
  console.error(JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  await context.close();
  await browser.close();
}
