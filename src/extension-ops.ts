import { decidePageHealth } from './page-health.js';

export interface PageHealth {
  url: string;
  state: 'ready' | 'blocked' | 'transient';
  evidence: string[];
  navigationReady?: boolean;
}

export function normalCoursePlayerUrl(lectureUrl: string): string {
  const url = new URL(lectureUrl);
  url.searchParams.set('udFrontends', 'false');
  url.searchParams.delete('cteMode');
  return url.toString();
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
      const curriculum = !!document.querySelector('[data-purpose="curriculum-section-container"]');
      const expectedLecture = !expectedId || new RegExp('/(?:lecture|quiz)/' + expectedId + '(?:/|$)').test(url.pathname);
      const standaloneLab = url.searchParams.get('cteMode') === 'standalone' && !!document.querySelector('video');
      const coursePlayerReady = curriculum || (expectedLecture && standaloneLab);
      const challengeSelector = 'iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="challenge"], [data-testid*="captcha"], form[action*="challenge"]';
      const decision = decidePageHealth({
        urlPath: url.pathname,
        title,
        curriculumVisible: coursePlayerReady,
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
    const curriculum = page.locator('[data-purpose="curriculum-section-container"]').first();
    if (!await curriculum.isVisible().catch(() => false)) {
      let courseTab = page.getByRole('tab', { name: /^(?:Course content|Konten kursus)$/i }).first();
      if (!await courseTab.count()) courseTab = page.locator('[role="tab"]').first();
      await courseTab.evaluate(el => el.click());
      await curriculum.waitFor({ state: 'visible', timeout: 10000 });
    }
    const section = page.locator('[data-purpose="section-panel-${sectionIndex}"]:visible [data-purpose="section-heading"] button[aria-expanded="false"]').first();
    if (await section.count()) await section.evaluate(el => el.click());
    const item = page.locator('[data-purpose="${itemPurpose}"]:visible [data-purpose="item-title"]').first();
    await item.waitFor({ state: 'visible', timeout: 10000 });
    await item.evaluate(el => el.click());
    let navigationReady = true;
    try {
      ${lectureId
        ? `await page.waitForFunction((id) => {
            const loader = document.querySelector('[class*="curriculum-item-view--loader"]');
            const loading = loader instanceof HTMLElement && loader.getClientRects().length > 0 && getComputedStyle(loader).visibility !== 'hidden';
            return new RegExp('/(?:lecture|quiz)/' + id + '(?:/|$)').test(location.pathname) && !loading;
          }, '${lectureId}', { timeout: 10000 });`
        : `await page.waitForFunction(() => {
            const loader = document.querySelector('[class*="curriculum-item-view--loader"]');
            return !(loader instanceof HTMLElement) || loader.getClientRects().length === 0 || getComputedStyle(loader).visibility === 'hidden';
          }, undefined, { timeout: 8000 });`}
    } catch { navigationReady = false; }
    ${inspectPageBody(lectureId)}
    return { ...health, navigationReady };
  }`;
}

export function restoreLectureCode(lectureUrl: string, lectureId: string | null): string {
  return `async (page) => {
    await page.goto(${JSON.stringify(lectureUrl)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let navigationReady = true;
    try {
      await page.waitForFunction((id) => {
        const curriculum = document.querySelector('[data-purpose="curriculum-section-container"]');
        if (!curriculum) return false;
        ${lectureId ? `if (!new RegExp('/(?:lecture|quiz)/' + id + '(?:/|$)').test(location.pathname)) return false;` : ''}
            const loader = document.querySelector('[class*="curriculum-item-view--loader"]');
            const loading = loader instanceof HTMLElement && loader.getClientRects().length > 0 && getComputedStyle(loader).visibility !== 'hidden';
        return !loading;
      }, ${JSON.stringify(lectureId)}, { timeout: 10000 });
    } catch { navigationReady = false; }
    ${inspectPageBody(lectureId)}
    return { ...health, navigationReady };
  }`;
}

function attachmentLocators(sectionIndex: number, lectureIndex: number): string {
  const itemPurpose = `curriculum-item-${sectionIndex}-${lectureIndex}`;
  return `
    const item = page.locator('[data-purpose="${itemPurpose}"]:visible').first();
    const trigger = item.locator('button[aria-label="Resource list"], button[aria-label="Daftar sumber daya"], button:has-text("Resources"), button:has-text("Sumber Daya")').first();
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
        const elementId = element.getAttribute('id');
        const resourceId = elementId?.startsWith('resource-dropdown-') ? elementId.slice('resource-dropdown-'.length) : null;
        const text = (element.textContent || '').replace(/Loading/gi, '').trim().replace(/\\s+/g, ' ');
        const marker = [element.getAttribute('data-purpose'), element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ');
        const isDownload = element instanceof HTMLButtonElement || (!(element instanceof HTMLAnchorElement) && element.getAttribute('role') === 'button') || element.hasAttribute('download') || /download|attachment/i.test(marker) || /\\/asset(s)?\\//i.test(href) || /\\.(zip|7z|rar|pdf|csv|json|txt|docx?|xlsx?|pptx?|ipynb|py|js|ts|html?|css)(?:[?#]|$)/i.test(href);
        const kind = isDownload ? 'download' : href ? 'external' : 'unknown';
        return { sourceIndex, resourceId, name: text || href.split('/').pop()?.split('?')[0] || 'resource', href, kind };
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
    // The resource list can initially render an item as a button and hydrate it
    // into an external anchor shortly afterwards. Always trust the latest DOM
    // inspection before waiting for a browser download event.
    if (attachment.kind === 'external' && attachment.href) {
      return { kind: 'external', url: attachment.href, reason: 'Tautan eksternal disimpan sebagai resource.' };
    }
    if (attachment.kind === 'download' && attachment.href) {
      return { kind: 'direct', url: attachment.href, suggestedFilename: attachment.name };
    }
    const resourceElement = links.nth(attachment.sourceIndex);
    const resourceElementId = await resourceElement.getAttribute('id');
    const resourceId = resourceElementId?.startsWith('resource-dropdown-') ? resourceElementId.slice('resource-dropdown-'.length) : null;
    const startUrl = page.url();
    const eventTimeout = 15000;
    const downloadPromise = page.waitForEvent('download', { timeout: eventTimeout }).then(download => ({ kind: 'download', download })).catch(() => ({ kind: 'none' }));
    const popupPromise = page.context().waitForEvent('page', { timeout: eventTimeout }).then(popup => ({ kind: 'external', popup })).catch(() => ({ kind: 'none' }));
    const navigationPromise = page.waitForURL(url => url.href !== startUrl, { timeout: eventTimeout }).then(() => ({ kind: 'navigation', url: page.url() })).catch(() => ({ kind: 'none' }));
    const signedUrlPromise = resourceId
      ? page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.status() === 200 && url.pathname.includes('/supplementary-assets/' + resourceId + '/') && url.searchParams.get('fields[asset]') === 'download_urls';
        }, { timeout: eventTimeout }).then(async response => {
          const body = await response.json();
          const candidates = Object.values(body.download_urls ?? {}).flatMap(value => Array.isArray(value) ? value : [value]);
          const selected = candidates.map(value => typeof value === 'string' ? { file: value, label: attachment.name } : value)
            .find(value => value && typeof value.file === 'string' && value.file.toLowerCase().startsWith('https://'));
          return selected ? { kind: 'direct', url: selected.file, suggestedFilename: selected.label || attachment.name } : { kind: 'none' };
        }).catch(() => ({ kind: 'none' }))
      : Promise.resolve({ kind: 'none' });
    await resourceElement.evaluate(element => element.click());
    const event = await Promise.race([signedUrlPromise, downloadPromise, popupPromise, navigationPromise, page.waitForTimeout(eventTimeout).then(() => ({ kind: 'none' }))]);
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
    if (event.kind === 'direct') {
      return { kind: 'direct', url: event.url, suggestedFilename: event.suggestedFilename };
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
