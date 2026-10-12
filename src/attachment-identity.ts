export interface AttachmentIdentity {
  sourceIndex: number;
  name: string;
  href: string;
  kind?: string;
  resourceId?: string | null;
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function attachmentIdentity(value: AttachmentIdentity): string {
  if (value.resourceId) return `udemy:${value.resourceId}`;
  if (value.href) {
    try {
      const url = new URL(value.href);
      url.hash = '';
      if (url.hostname === 'udemycdn.com' || url.hostname.endsWith('.udemycdn.com')) url.search = '';
      return `url:${url.toString()}`;
    } catch {
      return `href:${value.href.trim()}`;
    }
  }
  return `fallback:${value.kind ?? 'unknown'}:${normalizedName(value.name)}`;
}

export function uniqueAttachments<T extends AttachmentIdentity>(items: T[]): T[] {
  const identities = new Set<string>();
  return items.filter(item => {
    const identity = attachmentIdentity(item);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}
