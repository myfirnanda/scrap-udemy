async (page) => {
  const content = page.locator('[data-purpose="safely-set-inner-html:rich-text-viewer:html"]').first();
  try { await content.waitFor({ state: 'visible', timeout: 8000 }); }
  catch { return { html: null, availability: 'retryable', reason: 'Konten artikel belum siap setelah timeout.' }; }
  const html = await content.evaluate(el => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('script, style, button, nav, [role="navigation"]').forEach(node => node.remove());
    return copy.innerHTML;
  });
  return { html: html.trim() || null, availability: html.trim() ? 'available' : 'unavailable', reason: html.trim() ? null : 'Artikel kosong.' };
}
