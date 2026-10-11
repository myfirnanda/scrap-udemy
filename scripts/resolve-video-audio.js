async (page) => {
  const video = page.locator('video').first();
  await video.waitFor({ state: 'attached', timeout: 15000 });
  await video.evaluate(element => element.pause());
  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return element instanceof HTMLVideoElement && element.readyState >= 2;
  }, undefined, { timeout: 15000 }).catch(() => {});

  let resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  let masterUrl = resources.find(url => /\/assets\/.*\.m3u8(?:\?|$)/i.test(url) && !/\/hls\//i.test(url));
  if (!masterUrl) {
    await video.evaluate(async element => {
      try { await element.play(); } catch {}
    });
    await page.waitForTimeout(500);
    await video.evaluate(element => element.pause());
    resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    masterUrl = resources.find(url => /\/assets\/.*\.m3u8(?:\?|$)/i.test(url) && !/\/hls\//i.test(url));
  }
  if (!masterUrl) return { availability: 'retryable', reason: 'Playlist audio/video lecture tidak ditemukan.', mediaUrl: null, duration: null };

  const resolved = await page.evaluate(async master => {
    const response = await fetch(master, { credentials: 'include' });
    if (!response.ok) return { ok: false, status: response.status, mediaUrl: null };
    const text = await response.text();
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const audioLines = lines.filter(line => line.startsWith('#EXT-X-MEDIA:') && /(?:^|,)TYPE=AUDIO(?:,|$)/.test(line));
    const preferredAudio = audioLines.find(line => /(?:^|,)DEFAULT=YES(?:,|$)/.test(line)) ?? audioLines[0];
    const audioMatch = preferredAudio?.match(/(?:^|,)URI="([^"]+)"/);
    if (audioMatch) return { ok: true, status: response.status, mediaUrl: new URL(audioMatch[1], master).href };

    const variants = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const bandwidth = Number(line.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
      const uri = lines.slice(index + 1).find(candidate => !candidate.startsWith('#'));
      if (uri) variants.push({ bandwidth, mediaUrl: new URL(uri, master).href });
    }
    variants.sort((left, right) => left.bandwidth - right.bandwidth);
    return { ok: true, status: response.status, mediaUrl: variants[0]?.mediaUrl ?? master };
  }, masterUrl);
  if (!resolved.ok || !resolved.mediaUrl) {
    return { availability: 'retryable', reason: `Playlist media tidak dapat dibaca (${resolved.status}).`, mediaUrl: null, duration: null };
  }
  const duration = await video.evaluate(element => Number.isFinite(element.duration) ? element.duration : null);
  return { availability: 'available', reason: null, mediaUrl: resolved.mediaUrl, duration };
}
