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
  return { availability: 'available', reason: null, cues, ...metrics, duration, steps: 0, complete: false };
}
