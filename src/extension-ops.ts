import { decidePageHealth } from './page-health.js';

export interface PageHealth {
  url: string;
  state: 'ready' | 'blocked' | 'transient';
  evidence: string[];
  navigationReady?: boolean;
}

function inspectPageBody(lectureId: string | null): string {
  return `
    const expectedLectureId = ${JSON.stringify(lectureId)};
    const health = await page.evaluate((expectedId) => {
      const decidePageHealth = ${decidePageHealth.toString()};
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const url = new URL(location.href);
      const title = document.title.trim().toLowerCase();
      const text = document.body.innerText.trim();
      const curriculum = [...document.querySelectorAll('[data-purpose="curriculum-section-container"]')].some(visible);
      const expectedLecture = !expectedId || url.pathname.includes('/lecture/' + expectedId);
      const challengeSelector = 'iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="challenge"], [data-testid*="captcha"], form[action*="challenge"]';
      const decision = decidePageHealth({
        urlPath: url.pathname,
        title,
        curriculumVisible: curriculum,
        expectedLecture,
        visibleChallengeElement: [...document.querySelectorAll(challengeSelector)].some(visible),
        shortChallengePage: text.length < 3000 && /verify you are human|security challenge|unusual traffic|enable javascript and cookies|you have been blocked/i.test(text)
      });
      return {
        url: location.href,
        ...decision
      };
    }, expectedLectureId);
  `;
}

export function inspectPageHealthCode(lectureId: string | null): string {
  return `async (page) => {
    ${inspectPageBody(lectureId)}
    return health;
  }`;
}

export function navigateCode(sectionIndex: number, lectureIndex: number, lectureId: string | null): string {
  const itemPurpose = `curriculum-item-${sectionIndex}-${lectureIndex}`;
  return `async (page) => {
    await page.getByRole('tab', { name: 'Course content' }).first().evaluate(el => el.click());
    const section = page.locator('[data-purpose="section-panel-${sectionIndex}"]:visible [data-purpose="section-heading"] button[aria-expanded="false"]').first();
    if (await section.count()) await section.evaluate(el => el.click());
    const item = page.locator('[data-purpose="${itemPurpose}"]:visible [data-purpose="item-title"]').first();
    await item.waitFor({ state: 'visible', timeout: 10000 });
    await item.evaluate(el => el.click());
    let navigationReady = true;
    try {
      ${lectureId
        ? `await page.waitForFunction((id) => location.pathname.includes('/lecture/' + id) && !document.querySelector('[class*="curriculum-item-view--loader"]'), '${lectureId}', { timeout: 15000 });`
        : `await page.waitForFunction(() => !document.querySelector('[class*="curriculum-item-view--loader"]'), undefined, { timeout: 8000 });`}
    } catch { navigationReady = false; }
    ${inspectPageBody(lectureId)}
    return { ...health, navigationReady };
  }`;
}

function attachmentLocators(sectionIndex: number, lectureIndex: number): string {
  const itemPurpose = `curriculum-item-${sectionIndex}-${lectureIndex}`;
  return `
    const item = page.locator('[data-purpose="${itemPurpose}"]:visible').first();
    const trigger = item.locator('button[aria-label="Resource list"], button:has-text("Resources")').first();
    if (!await trigger.count()) return [];
    const resourceBox = trigger.locator('xpath=..');
    const links = resourceBox.locator('li a[href], li button, [role="listitem"] a[href], [role="listitem"] button, [role="listitem"] [role="button"]');
    if (await trigger.getAttribute('aria-expanded') === 'true' && !await links.count()) await trigger.evaluate(el => el.click());
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.evaluate(el => el.click());
    await links.first().waitFor({ state: 'attached', timeout: 10000 });
    await resourceBox.locator('img[alt="Loading"]').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    const resources = [];
    for (let index = 0; index < await links.count(); index++) {
      const link = links.nth(index);
      const info = await link.evaluate((element, sourceIndex) => {
        const href = element instanceof HTMLAnchorElement ? element.href : '';
        const text = (element.textContent || '').replace(/Loading/gi, '').trim().replace(/\\s+/g, ' ');
        const marker = [element.getAttribute('data-purpose'), element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ');
        const isDownload = element instanceof HTMLButtonElement || (!(element instanceof HTMLAnchorElement) && element.getAttribute('role') === 'button') || element.hasAttribute('download') || /download|attachment/i.test(marker) || /\\/asset(s)?\\//i.test(href) || /\\.(zip|7z|rar|pdf|csv|json|txt|docx?|xlsx?|pptx?|ipynb|py|js|ts|html?|css)(?:[?#]|$)/i.test(href);
        const kind = isDownload ? 'download' : href ? 'external' : 'unknown';
        return { sourceIndex, name: text || href.split('/').pop()?.split('?')[0] || 'resource', href, kind };
      }, index);
      resources.push(info);
    }
  `;
}

export function discoverAttachmentsCode(sectionIndex: number, lectureIndex: number): string {
  return `async (page) => {
    ${attachmentLocators(sectionIndex, lectureIndex)}
    return resources;
  }`;
}

export function downloadAttachmentCode(sectionIndex: number, lectureIndex: number, sourceIndex: number, targetFile: string): string {
  return `async (page) => {
    ${attachmentLocators(sectionIndex, lectureIndex)}
    const attachment = resources.find(item => item.sourceIndex === ${sourceIndex});
    if (!attachment) throw new Error('Attachment tidak lagi ditemukan pada Resource list.');
    const startUrl = page.url();
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).then(download => ({ kind: 'download', download })).catch(() => ({ kind: 'none' }));
    const popupPromise = page.context().waitForEvent('page', { timeout: 30000 }).then(popup => ({ kind: 'external', popup })).catch(() => ({ kind: 'none' }));
    const navigationPromise = page.waitForURL(url => url.href !== startUrl, { timeout: 30000 }).then(() => ({ kind: 'navigation', url: page.url() })).catch(() => ({ kind: 'none' }));
    await links.nth(attachment.sourceIndex).click({ force: true });
    const event = await Promise.race([downloadPromise, popupPromise, navigationPromise, page.waitForTimeout(30000).then(() => ({ kind: 'none' }))]);
    if (event.kind === 'external') {
      await event.popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const url = event.popup.url();
      await event.popup.close().catch(() => {});
      return { kind: 'external', url, reason: 'Tautan eksternal disimpan sebagai resource.' };
    }
    if (event.kind === 'navigation') {
      const url = event.url;
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return { kind: 'external', url, reason: 'Tautan eksternal disimpan sebagai resource.' };
    }
    if (event.kind !== 'download') {
      if (page.url() !== startUrl) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return { kind: 'retryable', reason: 'Resource tidak menghasilkan event download dalam batas waktu.' };
    }
    const download = event.download;
    await download.saveAs(${JSON.stringify(targetFile)});
    const failure = await download.failure();
    if (failure) throw new Error(failure);
    return { kind: 'downloaded', suggestedFilename: download.suggestedFilename() };
  }`;
}
