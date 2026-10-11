async (page) => {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video instanceof HTMLVideoElement) video.pause();
  });
  const panel = page.locator('[data-purpose="transcript-panel"]');
  if (!await panel.isVisible().catch(() => false)) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const toggle = page.locator('[data-purpose="transcript-toggle"]');
    if (!await toggle.count()) return { availability: 'retryable', reason: 'Kontrol transcript tidak ditemukan; transcript belum dapat dikonfirmasi tidak tersedia.' };
    try { await toggle.click({ timeout: 3000 }); }
    catch { await toggle.evaluate(el => el.click()); }
    try { await panel.waitFor({ state: 'visible', timeout: 8000 }); }
    catch { return { availability: 'retryable', reason: 'Panel transcript belum siap setelah timeout.' }; }
  }
  await panel.locator('[data-purpose="cue-text"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
  const cueSample = async () => (await panel.locator('[data-purpose="cue-text"]').allTextContents()).slice(0, 20).join(' ');
  const isArabic = text => {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
    return arabic >= 8 && letters > 0 && arabic / letters >= 0.3;
  };
  let language = 'current';
  const originalSample = await cueSample();
  if (isArabic(originalSample)) {
    const captions = page.locator('[data-purpose="captions-dropdown-button"]');
    if (!await captions.count()) return { availability: 'retryable', reason: 'Transcript berbahasa Arab, tetapi menu caption tidak ditemukan.' };
    const englishNames = ['english', 'inggris', 'anglais', 'englisch', 'ingl\u00e9s', 'inglese', 'ingl\u00eas', 'ingilizce', 'engels', 'engelsk', 'angielski', '\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629', '\u82f1\u8bed', '\u82f1\u6587', '\u82f1\u8a9e', '\uc601\uc5b4'];
    let options = page.locator('[role="menuitemradio"]:visible');
    let labels = [];
    let englishIndex = -1;
    for (let menuAttempt = 0; menuAttempt < 2 && englishIndex < 0; menuAttempt++) {
      if (!await options.count()) await captions.evaluate(el => el.click());
      await options.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      labels = await options.allTextContents();
      englishIndex = labels.findIndex(label => englishNames.some(name => label.trim().toLocaleLowerCase().startsWith(name)));
      if (englishIndex < 0 && await options.count()) {
        await captions.evaluate(el => el.click());
        await page.waitForTimeout(100);
      }
    }
    if (englishIndex < 0) {
      const more = page.locator('[data-purpose="caption-more"]:visible');
      if (await more.count()) {
        await more.click({ force: true });
        await options.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
        options = page.locator('[role="menuitemradio"]:visible');
        labels = await options.allTextContents();
        englishIndex = labels.findIndex(label => englishNames.some(name => label.trim().toLocaleLowerCase().startsWith(name)));
      }
    }
    if (englishIndex < 0) return { availability: 'retryable', reason: 'Transcript berbahasa Arab dan caption English tidak tersedia.' };
    await options.nth(englishIndex).evaluate(el => el.click());
    await page.waitForFunction(previous => {
      const current = [...document.querySelectorAll('[data-purpose="cue-text"]')].slice(0, 20).map(node => node.textContent || '').join(' ');
      return current.trim().length > 0 && current !== previous;
    }, originalSample, { timeout: 10000 }).catch(() => {});
    const englishSample = await cueSample();
    if (isArabic(englishSample)) return { availability: 'retryable', reason: 'Caption English dipilih, tetapi transcript masih berbahasa Arab.' };
    language = 'en';
  }
  const scroll = page.locator('[data-purpose="sidebar-content"]');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  const cues = await panel.locator('[data-purpose="cue-text"]').evaluateAll(nodes => nodes.map(node => {
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
    return { key: text, text };
  }).filter(cue => cue.text));
  const metrics = await scroll.evaluate(el => ({
    scrollTop: el.scrollTop,
    scrollExtent: Math.max(0, el.scrollHeight - el.clientHeight),
    atEnd: el.scrollTop >= el.scrollHeight - el.clientHeight - 2
  }));
  const duration = await page.locator('video').first().evaluate(video => Number.isFinite(video.duration) ? video.duration : null).catch(() => null);
  return { availability: 'available', reason: null, cues, ...metrics, duration, steps: 0, complete: false, language };
}
