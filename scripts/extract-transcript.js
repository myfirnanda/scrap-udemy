async (page) => {
  const panel = page.locator('[data-purpose="transcript-panel"]');
  if (!await panel.isVisible().catch(() => false)) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const toggle = page.locator('[data-purpose="transcript-toggle"]');
    if (!await toggle.count()) return { content: null, availability: 'retryable', reason: 'Kontrol transcript tidak ditemukan; transcript belum dapat dikonfirmasi tidak tersedia.' };
    try { await toggle.click({ timeout: 3000 }); }
    catch { await toggle.evaluate(el => el.click()); }
    try { await panel.waitFor({ state: 'visible', timeout: 8000 }); }
    catch { return { content: null, availability: 'retryable', reason: 'Panel transcript belum siap setelah timeout.' }; }
  }
  const scroll = page.locator('[data-purpose="sidebar-content"]');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  let all = [];
  let tailStable = 0;
  let lastTailKey = '';
  const readCues = () => panel.locator('[data-purpose="cue-text"]').evaluateAll(nodes => nodes.map(node => {
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
    const container = node.closest('button, [data-purpose*="cue"]');
    const marker = [container?.getAttribute('aria-label'), container?.getAttribute('data-time'), container?.textContent]
      .filter(Boolean).join('|').trim().replace(/\s+/g, ' ');
    return { key: marker || text, text };
  }).filter(cue => cue.text));
  const appendSnapshot = snapshot => {
    let overlap = 0;
    for (let size = Math.min(all.length, snapshot.length); size > 0; size--) {
      if (all.slice(-size).every((cue, i) => cue.key === snapshot[i].key)) { overlap = size; break; }
    }
    all.push(...snapshot.slice(overlap));
  };
  for (let step = 0; step < 1000; step++) {
    const snapshot = await readCues();
    appendSnapshot(snapshot);
    await scroll.evaluate(el => {
      el.scrollTop = Math.min(el.scrollTop + Math.max(200, el.clientHeight * .7), el.scrollHeight);
    });
    // Udemy renders transcript cues lazily after scrolling. Poll for a stable
    // DOM instead of always sleeping the full 150 ms.
    let stable = 0;
    let previousCount = -1;
    let previousHeight = -1;
    for (let wait = 0; wait < 250 && (wait < 100 || stable < 3); wait += 25) {
      await page.waitForTimeout(25);
      const count = await panel.locator('[data-purpose="cue-text"]').count();
      const height = await scroll.evaluate(el => el.scrollHeight);
      if (count === previousCount && height === previousHeight) stable++;
      else stable = 0;
      previousCount = count;
      previousHeight = height;
    }
    const settledSnapshot = await readCues();
    appendSnapshot(settledSnapshot);
    const settled = await scroll.evaluate(el => ({
      end: el.scrollTop >= el.scrollHeight - el.clientHeight - 2
    }));
    const tailKey = settledSnapshot.at(-1)?.key ?? '';
    tailStable = settled.end && tailKey && tailKey === lastTailKey ? tailStable + 1 : 0;
    lastTailKey = tailKey;
    if (tailStable >= 3) break;
    if (step === 999) throw new Error('Transcript belum mencapai akhir setelah 1000 scroll.');
  }
  const finalSnapshot = await readCues();
  let finalOverlap = 0;
  for (let size = Math.min(all.length, finalSnapshot.length); size > 0; size--) {
    if (all.slice(-size).every((cue, i) => cue.key === finalSnapshot[i].key)) { finalOverlap = size; break; }
  }
  all.push(...finalSnapshot.slice(finalOverlap));
  return {
    content: all.length ? all.map(cue => cue.text).join('\n\n') + '\n' : null,
    cueCount: all.length,
    firstCue: all[0]?.text ?? null,
    lastCue: all.at(-1)?.text ?? null,
    availability: all.length ? 'available' : 'unavailable',
    reason: all.length ? null : 'Panel transcript tersedia tetapi tidak memiliki cue.'
  };
}
