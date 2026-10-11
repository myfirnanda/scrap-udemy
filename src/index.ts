import fs from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import { attachExistingChrome, cli, runCode, runCodeFile } from './extension-cli.js';
import { discoverAttachmentsCode, downloadAttachmentCode, inspectPageHealthCode, navigateCode, type PageHealth } from './extension-ops.js';
import { courseFingerprint, findExistingCourse, isCourseComplete, loadManifest, plannedFile, reconcileManifest, saveManifest, type Attachment, type Lecture, type Manifest, type Section } from './manifest.js';
import { writeMarkdown } from './markdown-writer.js';
import { appendTranscriptCues, transcriptCompletedLine, transcriptPercent, transcriptProgressLine, type TranscriptBatch, type TranscriptCue } from './transcript-progress.js';
import { cleanName, courseFolderName, existsNonempty, pause, relativeResourceDir, writeJsonAtomic } from './utils.js';

type Mode = 'lecture' | 'section' | 'all';
type Availability = 'available' | 'unavailable' | 'retryable';
type HtmlResult = { html: string | null; reason: string | null; availability?: Availability };
type TextResult = { content: string | null; reason: string | null; availability?: Availability; cueCount?: number; firstCue?: string | null; lastCue?: string | null };
type LogEntry = { time: string; section: number; lecture: number; status: string; reason?: string; attachmentReason?: string };
type CourseIdentity = { courseTitle: string; courseOwner: string; courseUrl: string };
type DiscoveredAttachment = { sourceIndex: number; name: string; href: string; kind: 'download' | 'external' | 'unknown' };
type DownloadResult = { kind: 'downloaded' | 'external' | 'retryable' | 'skipped'; suggestedFilename?: string; url?: string; reason?: string };

class SecurityChallengeError extends Error {
  constructor(readonly evidence: string[]) { super(`SECURITY_CHALLENGE_DETECTED: ${evidence.join(', ')}`); }
}

class TransientNavigationError extends Error {}
class TransientContentError extends Error {}

function loadLocalEnv(): void {
  try { process.loadEnvFile(path.resolve('.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function validateCourseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('URL tidak valid. Gunakan format: https://www.udemy.com/course/<slug>/.'); }
  const coursePath = url.pathname.match(/^\/course\/([^/]+)\/?(?:learn(?:\/.*)?)?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.udemy.com' || !coursePath) {
    throw new Error('URL harus berupa course Udemy: https://www.udemy.com/course/<slug>/.');
  }
  return `https://www.udemy.com/course/${coursePath[1]}/learn/`;
}

function lectureAttempts(): number {
  const value = Number.parseInt(process.env.MAX_LECTURE_ATTEMPTS ?? '3', 10);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('MAX_LECTURE_ATTEMPTS harus berupa angka 1 sampai 10.');
  }
  return value;
}

function isRetryableLectureError(error: unknown): boolean {
  if (error instanceof TransientNavigationError) return true;
  if (error instanceof TransientContentError) return true;
  if (error instanceof SecurityChallengeError) return false;
  const message = String(error).toLowerCase();
  if (message.includes('security_challenge_detected')) return false;
  return /timeout|timed out|net::|network|connection|target page|browser has been closed|disconnected/.test(message);
}

function parseOptions(args: string[]): { mode: Mode; output: string; courseUrl: string } {
  const mode = (args[0] ?? 'all') as Mode;
  if (!['lecture', 'section', 'all'].includes(mode)) throw new Error('Mode harus lecture, section, atau all.');
  const courseArg = args.find(value => value.startsWith('--course-url='));
  if (!courseArg) throw new Error('URL course belum diberikan. Jalankan melalui npm start.');
  return {
    mode,
    output: path.resolve(process.env.OUTPUT_DIR ?? 'output'),
    courseUrl: validateCourseUrl(courseArg.slice('--course-url='.length))
  };
}

async function selectUdemyTab(courseUrl: string, allowReconnect = true): Promise<void> {
  let tabs: string;
  try { tabs = await cli(['--raw', 'tab-list']); }
  catch { tabs = ''; }
  if (!tabs.includes('- 0:')) {
    if (process.env.ZERO_CLICK_EXTENSION === '1' && !process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN)
      throw new Error('ZERO_CLICK_CONFIGURATION_REQUIRED: PLAYWRIGHT_MCP_EXTENSION_TOKEN belum tersedia di .env.');
    await attachExistingChrome();
    tabs = await cli(['--raw', 'tab-list']);
  }
  let matches = tabs.split(/\r?\n/).filter(line => /https:\/\/www\.udemy\.com\/course\/[^/]+\/learn\//i.test(line));
  if (!matches.length && process.env.ZERO_CLICK_EXTENSION === '1') {
    const target = JSON.stringify(courseUrl);
    const opened = await runCode<{ url: string; title: string; curriculum: boolean }>(`async (page) => {
      if (!page.url().startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/'))
        throw new Error('Token extension terhubung ke halaman yang tidak dikenali.');
      await page.goto(${target}, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('[data-purpose="curriculum-section-container"]').first().waitFor({ state: 'attached', timeout: 30000 });
      return page.evaluate(() => ({ url: location.href, title: document.title, curriculum: !!document.querySelector('[data-purpose="curriculum-section-container"]') }));
    }`, 120_000);
    if (!opened.curriculum) throw new Error('Course Player belum siap setelah navigasi otomatis.');
    tabs = await cli(['--raw', 'tab-list']);
    matches = tabs.split(/\r?\n/).filter(line => /https:\/\/www\.udemy\.com\/course\/[^/]+\/learn\//i.test(line));
  }
  if (matches.length !== 1) throw new Error(`Harus ada tepat satu tab Udemy Course Player yang dipilih extension; ditemukan ${matches.length}.`);
  const match = matches[0].match(/^- (\d+):/);
  if (!match) throw new Error('Indeks tab Udemy tidak dapat dibaca.');
  if (!matches[0].includes('(current)')) await cli(['tab-select', match[1]]);
  let verified: { url: string; title: string; curriculum: boolean };
  try {
    verified = await runCode<{ url: string; title: string; curriculum: boolean }>(
      'async (page) => page.evaluate(() => ({ url: location.href, title: document.title, curriculum: !!document.querySelector("[data-purpose=curriculum-section-container]") }))'
    );
  } catch (error) {
    if (!allowReconnect) throw error;
    console.warn('Koneksi Playwright Extension terputus. Menghubungkan ulang satu kali...');
    await cli(['detach']).catch(() => {});
    await attachExistingChrome();
    return selectUdemyTab(courseUrl, false);
  }
  const expectedSlug = new URL(courseUrl).pathname.match(/^\/course\/([^/]+)/)?.[1];
  const currentSlug = new URL(verified.url).pathname.match(/^\/course\/([^/]+)/)?.[1];
  if (!verified.curriculum || currentSlug !== expectedSlug) {
    const target = JSON.stringify(courseUrl);
    verified = await runCode<{ url: string; title: string; curriculum: boolean }>(`async (page) => {
      await page.goto(${target}, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('[data-purpose="curriculum-section-container"]').first().waitFor({ state: 'attached', timeout: 30000 });
      return page.evaluate(() => ({ url: location.href, title: document.title, curriculum: !!document.querySelector('[data-purpose="curriculum-section-container"]') }));
    }`, 120_000);
  }
  if (!verified.curriculum || !/udemy\.com\/course\//i.test(verified.url)) throw new Error('Tab aktif bukan Udemy Course Player yang siap.');
  console.log(`Tab terverifikasi: ${verified.title}`);
}

function toMarkdown(html: string): string {
  return new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' }).turndown(html).trim() + '\n';
}

async function extractVideoTranscript(): Promise<TextResult> {
  const started = Date.now();
  const cues: TranscriptCue[] = [];
  let batchNumber = 0;
  let totalSteps = 0;
  let percent = 0;
  let duration: number | null | undefined;
  console.log('      Transcript [menyiapkan] membuka panel dan membaca durasi video...');
  let batch = await runCodeFile<TranscriptBatch>('scripts/init-transcript.js');
  if (batch.availability !== 'available') return { content: null, availability: batch.availability, reason: batch.reason };
  appendTranscriptCues(cues, batch.cues ?? []);
  duration = batch.duration;
  console.log(transcriptProgressLine(transcriptPercent(batch, percent), cues.length, batchNumber, (Date.now() - started) / 1000, duration));

  while (!batch.complete && totalSteps < 1000) {
    batch = await runCodeFile<TranscriptBatch>('scripts/extract-transcript.js');
    if (batch.availability !== 'available') return { content: null, availability: batch.availability, reason: batch.reason };
    batchNumber++;
    totalSteps += batch.steps ?? 0;
    appendTranscriptCues(cues, batch.cues ?? []);
    duration = batch.duration ?? duration;
    const measuredPercent = transcriptPercent(batch, percent);
    const nextPercent = batch.complete ? 99 : measuredPercent;
    if (nextPercent !== null) percent = nextPercent;
    console.log(transcriptProgressLine(nextPercent, cues.length, batchNumber, (Date.now() - started) / 1000, duration));
  }

  if (!batch.complete) throw new TransientContentError('Transcript belum mencapai akhir setelah 1000 scroll.');
  if (!cues.length) return { content: null, availability: 'unavailable', reason: 'Panel transcript tersedia tetapi tidak memiliki cue.' };
  return {
    content: cues.map(cue => cue.text).join('\n\n') + '\n',
    cueCount: cues.length,
    firstCue: cues[0]?.text ?? null,
    lastCue: cues.at(-1)?.text ?? null,
    availability: 'available',
    reason: null
  };
}

async function extract(lecture: Lecture): Promise<{ content: string | null; reason: string | null; type: Lecture['type']; availability: Availability; cueCount?: number; firstCue?: string | null; lastCue?: string | null }> {
  const types = lecture.type === 'unknown' ? (['article', 'video', 'resource'] as const) : [lecture.type];
  let retryReason: string | null = null;
  for (const type of types) {
    if (type === 'video') {
      const result = await extractVideoTranscript();
      if (result.availability === 'retryable') {
        retryReason = result.reason ?? 'Transcript belum siap.';
        if (lecture.type !== 'unknown') throw new TransientContentError(retryReason);
        continue;
      }
      if (result.content?.trim()) return { content: result.content, reason: null, type, availability: 'available', cueCount: result.cueCount, firstCue: result.firstCue, lastCue: result.lastCue };
      if (lecture.type !== 'unknown') return { content: null, reason: result.reason, type, availability: 'unavailable' };
    } else if (type === 'article' || type === 'resource') {
      const result = await runCodeFile<HtmlResult>(`scripts/extract-${type}.js`);
      if (result.availability === 'retryable') {
        retryReason = result.reason ?? 'Konten belum siap.';
        if (lecture.type !== 'unknown') throw new TransientContentError(retryReason);
        continue;
      }
      if (result.html?.trim()) return { content: toMarkdown(result.html), reason: null, type, availability: 'available' };
      if (lecture.type !== 'unknown') return { content: null, reason: result.reason, type, availability: 'unavailable' };
    }
  }
  if (retryReason) throw new TransientContentError(retryReason);
  return { content: null, reason: 'Konten teks tidak tersedia atau tidak didukung.', type: lecture.type, availability: 'unavailable' };
}

async function syncAttachments(root: string, section: Section, lecture: Lecture, checkpoint: () => Promise<void>): Promise<void> {
  if (!lecture.hasResources) {
    lecture.attachments = [];
    lecture.attachmentsScanned = true;
    lecture.attachmentReason = null;
    return;
  }

  const discovered = await runCode<DiscoveredAttachment[]>(discoverAttachmentsCode(section.number - 1, lecture.number - 1));
  const previous = lecture.attachments ?? [];
  const attachments: Attachment[] = [];
  for (const item of discovered) {
    const old = previous.find(entry => entry.sourceIndex === item.sourceIndex);
    const unavailable = old?.status === 'unavailable' && old.kind !== undefined && item.kind !== 'external';
    const complete = old?.status === 'completed' && old.outputFile && await existsNonempty(path.join(root, old.outputFile));
    attachments.push({
      sourceIndex: item.sourceIndex,
      name: old?.name || item.name,
      href: item.href,
      kind: item.kind,
      status: unavailable ? 'unavailable' : complete ? 'completed' : 'pending',
      reason: unavailable ? old?.reason ?? null : complete ? null : old?.reason ?? null,
      outputFile: complete ? old.outputFile : null,
      size: complete ? old.size : null
    });
  }
  lecture.attachments = attachments;
  lecture.attachmentsScanned = true;
  lecture.attachmentReason = null;
  const firstExternalIndex = await saveExternalResourceIndex(root, section, lecture);
  if (firstExternalIndex) console.log(`      Link resource: ${firstExternalIndex}`);
  await checkpoint();

  const relativeDir = relativeResourceDir(section.number, section.title, lecture.number, lecture.title);
  const absoluteDir = path.join(root, relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true });
  let downloadPosition = 0;
  for (let position = 0; position < attachments.length; position++) {
    const attachment = attachments[position];
    if (attachment.kind === 'external') continue;
    downloadPosition++;
    if (attachment.status === 'completed' || attachment.status === 'unavailable') continue;
    const temporary = path.join(absoluteDir, `.attachment-${attachment.sourceIndex}-${process.pid}.part`);
    try {
      const result = await runCode<DownloadResult>(downloadAttachmentCode(
        section.number - 1,
        lecture.number - 1,
        attachment.sourceIndex,
        temporary
      ));
      if (result.kind === 'external') {
        if (!result.url) throw new Error('Resource membuka halaman eksternal, tetapi URL tidak dapat dibaca.');
        attachment.kind = 'external';
        attachment.href = result.url;
        const externalIndex = await saveExternalResourceIndex(root, section, lecture);
        console.log(`      Resource ${position + 1}/${attachments.length} berupa link: ${externalIndex}`);
        await checkpoint();
        continue;
      }
      if (result.kind === 'skipped') {
        attachment.status = 'skipped';
        attachment.reason = result.reason ?? 'Resource bukan file download.';
        attachment.outputFile = null;
        attachment.size = null;
        console.log(`      Resource ${position + 1}/${attachments.length} dilewati: ${attachment.reason}`);
        await checkpoint();
        continue;
      }
      if (result.kind === 'retryable') throw new TransientContentError(result.reason ?? 'Resource belum siap.');
      if (!await existsNonempty(temporary)) throw new Error('File hasil download kosong atau tidak ditemukan.');
      const originalName = result.suggestedFilename?.trim() || attachment.name;
      const savedName = `${String(downloadPosition).padStart(2, '0')}_${cleanName(originalName)}`;
      const relativeFile = path.join(relativeDir, savedName);
      const destination = path.join(root, relativeFile);
      if (await existsNonempty(destination)) await fs.rm(temporary, { force: true });
      else await fs.rename(temporary, destination);
      attachment.name = originalName;
      attachment.kind = 'download';
      attachment.outputFile = relativeFile;
      attachment.size = (await fs.stat(destination)).size;
      attachment.status = 'completed';
      attachment.reason = null;
      console.log(`      Resource ${position + 1}/${attachments.length}: ${savedName}`);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      attachment.status = 'failed';
      attachment.reason = String(error);
      console.log(`      Resource ${position + 1}/${attachments.length} gagal: ${attachment.reason}`);
    }
    await checkpoint();
  }
}

async function saveExternalResourceIndex(root: string, section: Section, lecture: Lecture): Promise<string | null> {
  const links = (lecture.attachments ?? []).filter(attachment => attachment.kind === 'external' && attachment.href);
  if (!links.length) return null;
  const relativeFile = path.join(relativeResourceDir(section.number, section.title, lecture.number, lecture.title), '00_EXTERNAL_RESOURCES.md');
  const content = [
    '# External Resources',
    '',
    `Lecture: ${lecture.number}. ${lecture.title}`,
    '',
    '> Tautan berikut adalah resource eksternal course, bukan transcript lecture.',
    '',
    ...links.flatMap((attachment, index) => [
      `${index + 1}. ${attachment.name}`,
      `   URL: ${attachment.href}`
    ])
  ].join('\n');
  await writeMarkdown(root, relativeFile, content);
  const size = (await fs.stat(path.join(root, relativeFile))).size;
  for (const attachment of links) {
    attachment.status = 'completed';
    attachment.reason = null;
    attachment.outputFile = relativeFile;
    attachment.size = size;
  }
  return relativeFile;
}

async function saveFailureDebug(root: string, section: Section, lecture: Lecture): Promise<void> {
  const dir = path.join(root, '_debug');
  await fs.mkdir(dir, { recursive: true });
  const stem = `failed_${section.number}_${lecture.number}`;
  await cli(['screenshot', `--filename=${path.join(dir, `${stem}.png`)}`]).catch(() => {});
  const result = await runCode<{ html: string }>('async (page) => page.evaluate(() => ({ html: document.body.outerHTML.slice(0, 200000) }))').catch(() => null);
  if (result) await fs.writeFile(path.join(dir, `${stem}.html`), result.html, 'utf8');
}

async function main(): Promise<void> {
  loadLocalEnv();
  const config = parseOptions(process.argv.slice(2));
  const maxAttempts = lectureAttempts();
  const courseUrl = config.courseUrl;
  await selectUdemyTab(courseUrl);

  const identity = await runCodeFile<CourseIdentity>('scripts/identify-course.js');
  identity.courseUrl = validateCourseUrl(identity.courseUrl);
  const fingerprint = courseFingerprint(identity.courseTitle, identity.courseOwner);
  const desiredRoot = path.join(config.output, courseFolderName(identity.courseTitle, identity.courseOwner));
  let existing = await findExistingCourse(config.output, identity.courseTitle, identity.courseOwner, identity.courseUrl);

  if (existing && path.resolve(existing.root) !== path.resolve(desiredRoot)) {
    try { await fs.access(desiredRoot); throw new Error(`Folder tujuan fingerprint sudah ada: ${desiredRoot}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.rename(existing.root, desiredRoot);
    existing = { ...existing, root: desiredRoot };
    console.log(`Folder output diperbarui: ${path.basename(desiredRoot)}`);
  }

  if (existing) {
    existing.manifest.courseOwner = identity.courseOwner;
    existing.manifest.fingerprint = fingerprint;
  }

  const fresh = await runCodeFile<Manifest>('scripts/parse-course.js');
  fresh.courseOwner = identity.courseOwner;
  fresh.courseUrl = identity.courseUrl;
  fresh.fingerprint = fingerprint;
  fresh.completedAt = null;
  const root = desiredRoot;
  const manifestFile = path.join(root, 'course_manifest.json');
  const logFile = path.join(root, 'scraping_log.json');
  const manifest = await reconcileManifest(fresh, existing?.manifest ?? await loadManifest(manifestFile), root);
  manifest.courseOwner = identity.courseOwner;
  manifest.fingerprint = fingerprint;
  manifest.completedAt = null;
  for (const section of manifest.sections) await fs.mkdir(path.join(root, `${section.number}_${cleanName(section.title)}`), { recursive: true });
  await saveManifest(manifestFile, manifest);
  if (await isCourseComplete(root, manifest)) {
    manifest.completedAt = new Date().toISOString();
    await saveManifest(manifestFile, manifest);
    const unavailable = manifest.sections.flatMap(section => section.lectures).filter(lecture => lecture.status === 'unavailable').length;
    console.log(unavailable
      ? `Course sudah pernah diproses dengan ${unavailable} konten tidak tersedia: "${identity.courseTitle}" oleh ${identity.courseOwner}.`
      : `Course sudah pernah ditranskrip dan curriculum terbaru sudah diperiksa: "${identity.courseTitle}" oleh ${identity.courseOwner}.`);
    return;
  }
  if (existing) {
    const lectures = manifest.sections.flatMap(section => section.lectures);
    const finished = lectures.filter(lecture => lecture.status === 'completed' || lecture.status === 'unavailable' || lecture.status === 'skipped').length;
    console.log(`Checkpoint ditemukan: ${finished}/${lectures.length} lecture sudah tersimpan. Melanjutkan sisanya...`);
  }
  let log: LogEntry[] = [];
  try { log = JSON.parse(await fs.readFile(logFile, 'utf8')) as LogEntry[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const record = async (section: Section, lecture: Lecture) => {
    log.push({ time: new Date().toISOString(), section: section.number, lecture: lecture.number, status: lecture.status, reason: lecture.reason ?? undefined, attachmentReason: lecture.attachmentReason ?? undefined });
    await writeJsonAtomic(logFile, log);
    await saveManifest(manifestFile, manifest);
  };
  let attempted = 0;
  for (const section of manifest.sections) {
    if (config.mode === 'section' && section.number > 1) break;
    console.log(`Section ${section.number}/${manifest.sections.length}: ${section.title}`);
    for (const lecture of section.lectures) {
      const contentDone = lecture.status === 'completed' || lecture.status === 'unavailable' || lecture.status === 'skipped';
      const attachments = lecture.attachments ?? [];
      const attachmentsDone = lecture.attachmentsScanned === true
        && (!lecture.hasResources || (attachments.length > 0 && attachments.every(attachment => attachment.kind && (attachment.status === 'completed' || attachment.status === 'unavailable'))));
      if (contentDone && attachmentsDone) continue;
      if (config.mode === 'lecture' && attempted >= 1) break;
      attempted++;
      console.log(`  Lecture ${lecture.number}/${section.lectures.length}: ${lecture.title} [${lecture.type}]`);
      if (lecture.type === 'quiz' || lecture.type === 'exercise') {
        lecture.status = 'skipped';
        lecture.reason = 'Jenis lecture interaktif tidak didukung.';
        if (!lecture.hasResources) {
          lecture.attachments = [];
          lecture.attachmentsScanned = true;
          lecture.attachmentReason = null;
          await record(section, lecture);
          continue;
        }
      }
      let failure: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let stage: 'navigation' | 'attachments' | 'content' = 'navigation';
        try {
          const state = await runCode<PageHealth>(navigateCode(section.number - 1, lecture.number - 1, lecture.id));
          if (state.state === 'blocked') {
            await pause(1500);
            const confirmed = await runCode<PageHealth>(inspectPageHealthCode(lecture.id));
            if (confirmed.state === 'blocked') throw new SecurityChallengeError(confirmed.evidence);
          }
          if (state.state !== 'ready' || state.navigationReady === false || (lecture.id && !state.url.includes(`/lecture/${lecture.id}`))) {
            throw new TransientNavigationError(`Navigasi lecture belum siap: ${state.evidence.join(', ') || 'course-player-or-url-not-ready'}`);
          }
          stage = 'attachments';
          await syncAttachments(root, section, lecture, () => saveManifest(manifestFile, manifest));
          stage = 'content';
          if (lecture.status !== 'completed' && lecture.status !== 'unavailable' && lecture.status !== 'skipped') {
            const result = await extract(lecture);
            lecture.type = result.type;
            if (!result.content?.trim()) {
              lecture.status = 'unavailable';
              lecture.reason = result.reason;
              lecture.outputFile = null;
            } else {
              const relative = plannedFile(section, lecture);
              await writeMarkdown(root, relative, result.content);
              if (result.type === 'video') console.log(transcriptCompletedLine(result.cueCount ?? 0));
              lecture.status = 'completed';
              lecture.reason = null;
              lecture.outputFile = relative;
              lecture.transcriptMeta = result.type === 'video' && result.cueCount !== undefined ? {
                cueCount: result.cueCount,
                firstCue: result.firstCue ?? null,
                lastCue: result.lastCue ?? null,
                extractedAt: new Date().toISOString()
              } : null;
            }
          }
          break;
        } catch (error) {
          failure = error;
          if (stage !== 'content') {
            lecture.attachmentReason = String(error);
            lecture.attachmentsScanned = false;
          }
          if (error instanceof SecurityChallengeError) break;
          if (attempt < maxAttempts && isRetryableLectureError(error)) {
            await selectUdemyTab(courseUrl);
            await pause(800 * attempt);
          } else {
            break;
          }
        }
      }
      if (lecture.status === 'pending') {
        lecture.status = 'failed';
        lecture.reason = String(failure);
        await saveFailureDebug(root, section, lecture);
      } else if (lecture.attachmentsScanned !== true) {
        await saveFailureDebug(root, section, lecture);
      }
      await record(section, lecture);
      console.log(`    ${lecture.status}${lecture.reason ? `: ${lecture.reason}` : ''}`);
      if (lecture.reason?.includes('SECURITY_CHALLENGE_DETECTED') || lecture.attachmentReason?.includes('SECURITY_CHALLENGE_DETECTED')) {
        throw new SecurityChallengeError([lecture.reason ?? lecture.attachmentReason ?? 'unknown']);
      }
      await pause(300);
    }
    if (config.mode === 'lecture' && attempted >= 1) break;
  }
  const counts = { completed: 0, unavailable: 0, skipped: 0, failed: 0, pending: 0, attachmentCompleted: 0, attachmentUnavailable: 0, attachmentSkipped: 0, attachmentFailed: 0, attachmentPending: 0 };
  for (const section of manifest.sections) for (const lecture of section.lectures) {
    counts[lecture.status]++;
    if (lecture.hasResources && (lecture.attachmentsScanned !== true || !(lecture.attachments?.length) || lecture.attachments.some(attachment => !attachment.kind))) counts.attachmentPending++;
    for (const attachment of lecture.attachments ?? []) {
      if (attachment.status === 'completed') counts.attachmentCompleted++;
      else if (attachment.status === 'unavailable') counts.attachmentUnavailable++;
      else if (attachment.status === 'skipped') counts.attachmentSkipped++;
      else if (attachment.status === 'failed') counts.attachmentFailed++;
      else counts.attachmentPending++;
    }
  }
  if (!counts.failed && !counts.pending && !counts.attachmentFailed && !counts.attachmentPending) {
    manifest.completedAt = new Date().toISOString();
    await saveManifest(manifestFile, manifest);
  }
  console.log(`Hasil: ${JSON.stringify(counts)}. Manifest: ${manifestFile}`);
  if (counts.failed || counts.pending || counts.attachmentFailed || counts.attachmentPending) process.exitCode = 2;
}

main().catch(error => {
  const message = (error as Error).message;
  console.error(message);
  process.exitCode = message.includes('ZERO_CLICK_CONFIGURATION_REQUIRED') ? 4
    : error instanceof SecurityChallengeError ? 3 : 1;
});
