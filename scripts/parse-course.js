async (page) => {
  let curriculum = page.locator('[data-purpose="curriculum-section-container"]:visible').first();
  if (!await curriculum.count()) {
    let tab = page.getByRole('tab', { name: /^(?:Course content|Konten kursus)$/i }).first();
    if (!await tab.count()) tab = page.locator('[role="tab"]').first();
    await tab.evaluate(el => el.click());
    curriculum = page.locator('[data-purpose="curriculum-section-container"]:visible').first();
  }
  await curriculum.waitFor({ state: 'visible', timeout: 10000 });
  const closed = curriculum.locator('[data-purpose^="section-panel-"] [data-purpose="section-heading"] button[aria-expanded="false"]');
  for (let i = 0; i < 100 && await closed.count(); i++) await closed.first().evaluate(el => el.click());
  if (await closed.count()) throw new Error('Tidak semua section berhasil dibuka.');
  const sections = await curriculum.evaluate(root => [...root.querySelectorAll('[data-purpose^="section-panel-"]')].map((section, sectionIndex) => {
    const rawTitle = section.querySelector('[data-purpose="section-heading"] button')?.textContent?.trim() ?? '';
    const title = rawTitle.replace(/^(?:Section|Bagian)\s+\d+:\s*/i, '');
    const lectures = [...section.querySelectorAll('[data-purpose^="curriculum-item-"]')].map((item, lectureIndex) => {
      const raw = item.querySelector('[data-purpose="item-title"]')?.textContent?.trim() ?? '';
      const title = raw.replace(/^\d+\.\s*/, '');
      const icons = [...item.querySelectorAll('svg use')].map(icon => icon.getAttribute('href') ?? icon.getAttribute('xlink:href'));
      const id = item.querySelector('[data-purpose="progress-toggle-button"]')?.getAttribute('aria-describedby')?.match(/(\d+)$/)?.[1] ?? null;
      const itemHref = item.querySelector('a[href*="/learn/"]')?.href ?? null;
      const isLab = !!item.querySelector('[data-purpose="lab-ribbon"]');
      let type = 'unknown';
      if (/quiz|kuis|practice test/i.test(title)) type = 'quiz';
      else if (/coding exercise|latihan coding|assignment|role play/i.test(title) || /\/learn\/quiz\/\d+/.test(itemHref ?? '')) type = 'exercise';
      else if (icons.includes('#icon-video')) type = 'video';
      else if (icons.includes('#icon-article')) type = /resource|download|source code/i.test(title) ? 'resource' : 'article';
      const hasResources = !!item.querySelector('button[aria-label="Resource list"], button[data-purpose*="resource"], button[class*="resource"]');
      const fallbackPath = type === 'exercise' ? `quiz/${id}` : `lecture/${id}`;
      return { number: lectureIndex + 1, title, type, id, url: itemHref || (id ? new URL(fallbackPath, location.href.replace(/\/learn\/.*/, '/learn/')).href : null), status: 'pending', reason: null, outputFile: null, isLab, hasResources, attachmentsScanned: !hasResources, attachmentReason: null, attachments: [] };
    });
    return { number: sectionIndex + 1, title, id: section.getAttribute('data-purpose'), lectures };
  }));
  if (!sections.length || sections.some(s => !s.title || !s.lectures.length || s.lectures.some(l => !l.title))) throw new Error('Curriculum tidak lengkap.');
  const courseTitle = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim() ?? '';
  const courseUrl = page.url().replace(/\/learn\/.*/, '/learn/');
  return { courseTitle, courseUrl, sections };
}
