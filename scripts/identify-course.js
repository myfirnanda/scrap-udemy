async (page) => {
  const documentTitle = await page.title();
  const titleFromDocument = documentTitle.match(/^Course:\s*(.*?)\s*\|\s*Udemy$/i)?.[1]?.trim() ?? '';
  const titleFromHeading = (await page.locator('[data-purpose="course-title"], h1').first().textContent())?.trim() ?? '';
  const title = titleFromDocument || titleFromHeading;
  let links = page.locator('[data-purpose="instructor-bio"] a[href*="/user/"]');
  if (!await links.count()) {
    const overview = page.getByRole('tab', { name: /^(?:Overview|Gambaran Umum)$/i }).first();
    if (await overview.count()) await overview.evaluate(element => element.click());
    links = page.locator('[data-purpose="instructor-bio"] a[href*="/user/"]');
    await links.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  }
  const owners = [...new Set((await links.allTextContents())
    .map(text => text.split('|')[0].trim().replace(/\s+/g, ' '))
    .filter(Boolean))];
  if (!title) throw new Error('Judul course tidak ditemukan.');
  if (!owners.length) throw new Error('Owner/instructor course tidak ditemukan.');
  return {
    courseTitle: title,
    courseOwner: owners.join(' & '),
    courseUrl: page.url().replace(/\/learn\/.*/, '/learn/')
  };
}
