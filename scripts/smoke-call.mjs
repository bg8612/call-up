import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
const inviteRoom = process.env.ROOM_ID ?? 'smoke-room';
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

const waitForParticipantsText = async (page, expected) => {
  await page.waitForFunction(
    (count) => document.body.innerText.includes(`${count} участников онлайн`),
    expected,
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
  await pageA.waitForSelector('.hero-strip', { timeout: 20000 });
  await waitForParticipantsText(pageA, 1);

  await pageA.locator('button:has-text("Скопировать ссылку приглашения")').click();
  const copiedInvite = await pageA.evaluate(async () => navigator.clipboard.readText());
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
  await pageB.waitForSelector('.hero-strip', { timeout: 20000 });
  await waitForParticipantsText(pageA, 2);
  await waitForParticipantsText(pageB, 2);

  await pageA.waitForFunction(
    () => document.querySelectorAll('.media-tile').length >= 2,
    undefined,
    { timeout: 20000 }
  );

  await pageB.locator('button:has-text("Leave")').click();
  await pageB.waitForSelector('.landing-card', { timeout: 20000 });
  await waitForParticipantsText(pageA, 1);

  console.log(
    JSON.stringify({
      ok: true,
      inviteUrl: copiedInvite,
      verified: ['invite-prefill', 'copy-invite-link', 'second-user-join', 'participant-count', 'leave-room']
    })
  );
} catch (error) {
  const diagnostics = {
    error: String(error),
    pageAUrl: pageA.url(),
    pageBUrl: pageB.url(),
    pageAText: await pageA.locator('body').innerText().catch(() => 'unavailable'),
    pageBText: await pageB.locator('body').innerText().catch(() => 'unavailable'),
    pageATiles: await pageA.locator('.media-tile').count().catch(() => -1),
    pageBTiles: await pageB.locator('.media-tile').count().catch(() => -1),
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
