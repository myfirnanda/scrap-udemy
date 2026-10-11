export type TranscriptCue = { key: string; text: string };

export type TranscriptBatch = {
  availability: 'available' | 'unavailable' | 'retryable';
  reason: string | null;
  cues?: TranscriptCue[];
  scrollTop?: number;
  scrollExtent?: number;
  duration?: number | null;
  steps?: number;
  complete?: boolean;
};

export function appendTranscriptCues(all: TranscriptCue[], snapshot: TranscriptCue[]): void {
  let overlap = 0;
  for (let size = Math.min(all.length, snapshot.length); size > 0; size--) {
    if (all.slice(-size).every((cue, index) => cue.key === snapshot[index].key)) {
      overlap = size;
      break;
    }
  }
  all.push(...snapshot.slice(overlap));
}

export function transcriptPercent(batch: TranscriptBatch, previous: number): number | null {
  if (batch.complete) return 100;
  const top = batch.scrollTop;
  const extent = batch.scrollExtent;
  if (top === undefined || extent === undefined || extent <= 0) return null;
  return Math.min(99, Math.max(previous, Math.floor((top / extent) * 100)));
}

function clock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function transcriptProgressLine(percent: number | null, cueCount: number, batchNumber: number, elapsedSeconds: number, duration?: number | null): string {
  const elapsed = clock(elapsedSeconds);
  if (percent === null) return `      Transcript [aktif] ${cueCount} cue | batch ${batchNumber} | ${elapsed}`;
  const width = 20;
  const filled = Math.floor((percent / 100) * width);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  const estimate = duration && percent < 100 ? ` | ~${clock(duration * percent / 100)}/${clock(duration)}` : '';
  const label = percent < 100 ? `~${percent}%` : '100%';
  return `      Transcript [${bar}] ${label}${estimate} | ${cueCount} cue | batch ${batchNumber} | ${elapsed}`;
}

export function transcriptCompletedLine(cueCount: number): string {
  return `      Transcript [${'#'.repeat(20)}] 100% | ${cueCount} cue | tersimpan`;
}
