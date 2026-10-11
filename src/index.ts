import fs from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import { attachExistingChrome, cli, runCode, runCodeFile } from './extension-cli.js';
import { discoverAttachmentsCode, downloadAttachmentCode, navigateCode } from './extension-ops.js';
import { courseFingerprint, findExistingCourse, isCourseComplete, loadManifest, plannedFile, reconcileManifest, saveManifest, type Attachment, type Lecture, type Manifest, type Section } from './manifest.js';
import { writeMarkdown } from './markdown-writer.js';
import { cleanName, courseFolderName, existsNonempty, pause, relativeResourceDir, writeJsonAtomic } from './utils.js';

type Mode = 'lecture' | 'section' | 'all';
type HtmlResult = { html: string | null; reason: string | null };
type TextResult = { content: string | null; reason: string | null; cueCount?: number };
type LogEntry = { time: string; section: number; lecture: number; status: string; reason?: string; attachmentReason?: string };
type CourseIdentity = { courseTitle: string; courseOwner: string; courseUrl: string };
type DiscoveredAttachment = { sourceIndex: number; name: string; href: string; kind: 'download' | 'external' | 'unknown' };
type DownloadResult = { kind: 'downloaded' | 'external' | 'skipped'; suggestedFilename?: string; url?: string; reason?: string };

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
  if (!verified.curriculum || !/udemy\.com\/course\//i.test(verified.url)) throw new Error('Tab aktif bukan Udemy Course Player yang siap.');
  console.log(`Tab terverifikasi: ${verified.title}`);
}

function toMarkdown(html: string): string {
  return new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' }).turndown(html).trim() + '\n';
}

async function extract(lecture: Lecture): Promise<{ content: string | null; reason: string | null; type: Lecture['type'] }> {
  const types = lecture.type === 'unknown' ? (['article', 'video', 'resource'] as const) : [lecture.type];
  for (const type of types) {
    if (type === 'video') {
      const result = await runCodeFile<TextResult>('scripts/extract-transcript.js');
      if (result.content?.trim()) return { content: result.content, reason: null, type };
      if (lecture.type !== 'unknown') return { content: null, reason: result.reason, type };
    } else if (type === 'article' || type === 'resource') {
      const result = await runCodeFile<HtmlResult>(`scripts/extract-${type}.js`);
      if (result.html?.trim()) return { content: toMarkdown(result.html), reason: null, type };
      if (lecture.type !== 'unknown') return { content: null, reason: result.reason, type };
    }
  }
  return { content: null, reason: 'Konten teks tidak tersedia atau tidak didukung.', type: lecture.type };
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
    const skipped = old?.status === 'skipped' && old.kind !== undefined && item.kind !== 'external';
    const complete = old?.status === 'completed' && old.outputFile && await existsNonempty(path.join(root, old.outputFile));
    attachments.push({
      sourceIndex: item.sourceIndex,
      name: old?.name || item.name,
      href: item.href,
      kind: item.kind,
      status: skipped ? 'skipped' : complete ? 'completed' : 'pending',
      reason: skipped ? old?.reason ?? null : complete ? null : old?.reason ?? null,
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
    if (attachment.status === 'completed' || attachment.status === 'skipped') continue;
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
    if (await isCourseComplete(existing.root, existing.manifest)) {
      existing.manifest.completedAt ??= new Date().toISOString();
      await saveManifest(path.join(existing.root, 'course_manifest.json'), existing.manifest);
      console.log(`Course sudah pernah ditranskrip: "${identity.courseTitle}" oleh ${identity.courseOwner}.`);
      return;
    }
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
  if (existing) {
    const lectures = manifest.sections.flatMap(section => section.lectures);
    const finished = lectures.filter(lecture => lecture.status === 'completed' || lecture.status === 'skipped').length;
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
      const contentDone = lecture.status === 'completed' || lecture.status === 'skipped';
      const attachmentsDone = lecture.attachmentsScanned === true && (lecture.attachments ?? []).every(attachment => attachment.status === 'completed' || attachment.status === 'skipped');
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
        try {
          const state = await runCode<{ url: string; challenge: boolean }>(navigateCode(section.number - 1, lecture.number - 1, lecture.id));
          if (state.challenge) throw new Error('SECURITY_CHALLENGE_DETECTED');
          if (lecture.id && !state.url.includes(`/lecture/${lecture.id}`)) throw new Error('Navigasi lecture tidak mencapai URL yang diharapkan.');
          await syncAttachments(root, section, lecture, () => saveManifest(manifestFile, manifest));
          if (lecture.status !== 'completed' && lecture.status !== 'skipped') {
            const result = await extract(lecture);
            lecture.type = result.type;
            if (!result.content?.trim()) {
              lecture.status = 'skipped';
              lecture.reason = result.reason;
            } else {
              const relative = plannedFile(section, lecture);
              await writeMarkdown(root, relative, result.content);
              lecture.status = 'completed';
              lecture.reason = null;
              lecture.outputFile = relative;
            }
          }
          break;
        } catch (error) {
          failure = error;
          lecture.attachmentReason = String(error);
          lecture.attachmentsScanned = false;
          if (String(error).includes('SECURITY_CHALLENGE_DETECTED')) break;
          if (attempt < maxAttempts) {
            await selectUdemyTab(courseUrl);
            await pause(800 * attempt);
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
      if (lecture.reason?.includes('SECURITY_CHALLENGE_DETECTED') || lecture.attachmentReason?.includes('SECURITY_CHALLENGE_DETECTED')) throw new Error('Security challenge terdeteksi; proses dihentikan.');
      await pause(300);
    }
    if (config.mode === 'lecture' && attempted >= 1) break;
  }
  const counts = { completed: 0, skipped: 0, failed: 0, pending: 0, attachmentCompleted: 0, attachmentSkipped: 0, attachmentFailed: 0, attachmentPending: 0 };
  for (const section of manifest.sections) for (const lecture of section.lectures) {
    counts[lecture.status]++;
    if (lecture.hasResources && lecture.attachmentsScanned !== true) counts.attachmentPending++;
    for (const attachment of lecture.attachments ?? []) {
      if (attachment.status === 'completed') counts.attachmentCompleted++;
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
    : /security challenge/i.test(message) ? 3 : 1;
});
