async (page) => {
  const video = page.locator('video').first();
  await video.waitFor({ state: 'attached', timeout: 15000 });
  await video.evaluate(element => element.pause());
  await page.waitForFunction(() => {
    const element = document.querySelector('video');
    return element instanceof HTMLVideoElement && element.readyState >= 2;
  }, undefined, { timeout: 15000 }).catch(() => {});

  const apiSources = await page.evaluate(async () => {
    const lectureId = location.pathname.match(/\/lecture\/(\d+)/)?.[1];
    const resourceUrls = performance.getEntriesByType('resource').map(entry => entry.name);
    const courseId = resourceUrls.map(url => url.match(/\/subscribed-courses\/(\d+)\//)?.[1]).filter(Boolean).at(-1);
    if (!lectureId || !courseId) return [];
    const endpoint = `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset&fields[asset]=media_sources`;
    const response = await fetch(endpoint, { credentials: 'include' }).catch(() => null);
    if (!response?.ok) return [];
    const body = await response.json().catch(() => null);
    return (body?.asset?.media_sources ?? [])
      .filter(source => source?.type === 'application/x-mpegURL' && typeof source.src === 'string')
      .map(source => source.src);
  });
  const duration = await video.evaluate(element => Number.isFinite(element.duration) ? element.duration : null);
  const readableApiSources = apiSources.filter(url => !/\/cbcs\//i.test(url));
  if (readableApiSources.length) return { availability: 'available', reason: null, mediaUrl: readableApiSources[0], duration };
  if (apiSources.length) return { availability: 'unavailable', reason: 'Media lecture memakai enkripsi CBCS; audio tidak dapat diproses oleh Whisper lokal.', mediaUrl: null, duration };
  const observedPlaylist = page.waitForResponse(response => /\.m3u8(?:\?|$)/i.test(response.url()), { timeout: 5000 })
    .then(response => response.url()).catch(() => null);
  let candidates = [...readableApiSources, ...await page.evaluate(() => {
    const current = document.querySelector('video')?.currentSrc;
    const resources = performance.getEntriesByType('resource').map(entry => entry.name);
    return [current, ...resources].filter(url => typeof url === 'string' && /\.m3u8(?:\?|$)/i.test(url));
  })];
  if (!candidates.length) {
    await video.evaluate(async element => {
      try { await element.play(); } catch {}
    });
    const networkPlaylist = await observedPlaylist;
    await video.evaluate(element => element.pause());
    candidates = [...readableApiSources, ...await page.evaluate(() => {
      const current = document.querySelector('video')?.currentSrc;
      const resources = performance.getEntriesByType('resource').map(entry => entry.name);
      return [current, ...resources].filter(url => typeof url === 'string' && /\.m3u8(?:\?|$)/i.test(url));
    })];
    if (networkPlaylist) candidates.unshift(networkPlaylist);
  }
  candidates = [...new Set(candidates)].filter(url => !/\/cbcs\//i.test(url));
  candidates.sort((left, right) => {
    const score = value => /master|playlist/i.test(value) ? 0 : /index/i.test(value) ? 1 : 2;
    return score(left) - score(right);
  });
  if (!candidates.length) return { availability: 'retryable', reason: 'Playlist audio/video lecture tidak ditemukan.', mediaUrl: null, duration: null };

  const resolved = await page.evaluate(async playlists => {
    let lastStatus = 0;
    for (const master of playlists) {
      const response = await fetch(master, { credentials: 'include' }).catch(() => null);
      if (!response?.ok) { lastStatus = response?.status ?? 0; continue; }
      lastStatus = response.status;
      const text = await response.text();
      if (!text.includes('#EXTM3U')) continue;
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
    }
    return { ok: false, status: lastStatus, mediaUrl: null };
  }, candidates);
  if (!resolved.ok || !resolved.mediaUrl) {
    return { availability: 'retryable', reason: `Playlist media tidak dapat dibaca (${resolved.status}).`, mediaUrl: null, duration: null };
  }
  return { availability: 'available', reason: null, mediaUrl: resolved.mediaUrl, duration };
}
