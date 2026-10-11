async (page) => {
  const panel = page.locator('[data-purpose="transcript-panel"]');
  if (!await panel.isVisible().catch(() => false)) return { availability: 'retryable', reason: 'Panel transcript tidak lagi terbuka.' };
  const scroll = page.locator('[data-purpose="sidebar-content"]');
  let all = [];
  let tailStable = 0;
  let lastTailKey = '';
  const readCues = () => panel.locator('[data-purpose="cue-text"]').evaluateAll(nodes => nodes.map(node => {
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
    return { key: text, text };
  }).filter(cue => cue.text));
  const appendSnapshot = snapshot => {
    let overlap = 0;
    for (let size = Math.min(all.length, snapshot.length); size > 0; size--) {
      if (all.slice(-size).every((cue, i) => cue.key === snapshot[i].key)) { overlap = size; break; }
    }
    all.push(...snapshot.slice(overlap));
  };
  let steps = 0;
  let complete = false;
  for (; steps < 12; steps++) {
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
    if (tailStable >= 3) { complete = true; steps++; break; }
  }
  const metrics = await scroll.evaluate(el => ({
    scrollTop: el.scrollTop,
    scrollExtent: Math.max(0, el.scrollHeight - el.clientHeight),
    atEnd: el.scrollTop >= el.scrollHeight - el.clientHeight - 2
  }));
  const duration = await page.locator('video').first().evaluate(video => Number.isFinite(video.duration) ? video.duration : null).catch(() => null);
  return { availability: 'available', reason: null, cues: all, ...metrics, duration, steps, complete };
}
