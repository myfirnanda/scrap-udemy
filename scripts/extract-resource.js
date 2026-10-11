async (page) => {
  const rich = page.locator('[data-purpose="safely-set-inner-html:rich-text-viewer:html"]').first();
  if (await rich.isVisible().catch(() => false)) {
    const html = await rich.evaluate(el => el.innerHTML);
    return { html: html.trim() || null, reason: html.trim() ? null : 'Resource tidak memiliki penjelasan teks.' };
  }
  const content = page.locator('[class*="text-viewer--content"]').first();
  if (!await content.isVisible().catch(() => false)) return { html: null, reason: 'Materi resource tidak tersedia.' };
  const html = await content.evaluate(el => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[class*="main-heading"], [class*="resources-heading"], button[download], script, style').forEach(node => node.remove());
    copy.querySelectorAll('ul').forEach(list => { if (!list.textContent?.trim()) list.remove(); });
    return copy.innerHTML.trim();
  });
  return { html: html || null, reason: html ? null : 'Hanya tersedia file unduhan biner tanpa penjelasan teks.' };
}
