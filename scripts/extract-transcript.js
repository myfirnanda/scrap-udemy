async (page) => {
  const panel = page.locator('[data-purpose="transcript-panel"]');
  if (!await panel.isVisible().catch(() => false)) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const toggle = page.locator('[data-purpose="transcript-toggle"]');
    if (!await toggle.count()) return { content: null, reason: 'Transcript toggle tidak tersedia.' };
    try { await toggle.click({ timeout: 3000 }); }
    catch { await toggle.evaluate(el => el.click()); }
    try { await panel.waitFor({ state: 'visible', timeout: 8000 }); }
    catch { return { content: null, reason: 'Transcript tidak tersedia.' }; }
  }
  const scroll = page.locator('[data-purpose="sidebar-content"]');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  let all = [];
  let endStable = 0;
  let lastHeight = 0;
  for (let step = 0; step < 1000; step++) {
    const snapshot = (await panel.locator('[data-purpose="cue-text"]').allTextContents())
      .map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    let overlap = 0;
    for (let size = Math.min(all.length, snapshot.length); size > 0; size--) {
      if (all.slice(-size).every((s, i) => s === snapshot[i])) { overlap = size; break; }
    }
    all.push(...snapshot.slice(overlap));
    const state = await scroll.evaluate(el => {
      const old = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + Math.max(200, el.clientHeight * .7), el.scrollHeight);
      return { moved: el.scrollTop > old, end: el.scrollTop >= el.scrollHeight - el.clientHeight - 2, height: el.scrollHeight };
    });
    // Udemy renders transcript cues lazily after scrolling. Poll for a stable
    // DOM instead of always sleeping the full 150 ms.
    let stable = 0;
    let previousCount = -1;
    let previousHeight = -1;
    for (let wait = 0; wait < 150 && stable < 2; wait += 25) {
      await page.waitForTimeout(25);
      const count = await panel.locator('[data-purpose="cue-text"]').count();
      const height = await scroll.evaluate(el => el.scrollHeight);
      if (count === previousCount && height === previousHeight) stable++;
      else stable = 0;
      previousCount = count;
      previousHeight = height;
    }
    endStable = state.end && !state.moved && state.height === lastHeight ? endStable + 1 : 0;
    lastHeight = state.height;
    if (endStable >= 3) break;
    if (step === 999) throw new Error('Transcript belum mencapai akhir setelah 1000 scroll.');
  }
  return { content: all.length ? all.join('\n\n') + '\n' : null, cueCount: all.length, reason: all.length ? null : 'Tidak ada cue transcript.' };
}
