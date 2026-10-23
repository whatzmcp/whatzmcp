import { extname, basename } from 'node:path';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

const TYPES: Record<string, [MediaKind, string]> = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.webp': ['image', 'image/webp'],
  '.mp4': ['video', 'video/mp4'],
  '.3gp': ['video', 'video/3gpp'],
  '.mov': ['video', 'video/quicktime'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.m4a': ['audio', 'audio/mp4'],
  '.aac': ['audio', 'audio/aac'],
  '.ogg': ['audio', 'audio/ogg; codecs=opus'],
  '.opus': ['audio', 'audio/ogg; codecs=opus'],
  '.amr': ['audio', 'audio/amr'],
  '.wav': ['audio', 'audio/wav'],
  '.pdf': ['document', 'application/pdf'],
  '.txt': ['document', 'text/plain'],
  '.csv': ['document', 'text/csv'],
  '.zip': ['document', 'application/zip'],
  '.doc': ['document', 'application/msword'],
  '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['document', 'application/vnd.ms-excel'],
  '.xlsx': ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt': ['document', 'application/vnd.ms-powerpoint'],
  '.pptx': ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

/** Guesses the WhatsApp media kind and mimetype from a file name or URL path. */
export function detectMedia(nameOrUrl: string): { kind: MediaKind; mimetype: string; fileName: string } {
  let path = nameOrUrl;
  try {
    if (/^https?:\/\//i.test(nameOrUrl)) path = new URL(nameOrUrl).pathname;
  } catch {
    /* keep as is */
  }
  const ext = extname(path).toLowerCase();
  const [kind, mimetype] = TYPES[ext] ?? ['document', 'application/octet-stream'];
  return { kind, mimetype, fileName: basename(path) || 'file' };
}

/** Builds the Baileys message content for one media send. */
export function mediaContent(source: Buffer | { url: string }, kind: MediaKind, mimetype: string, fileName: string, caption: string) {
  const cap = caption ? { caption } : {};
  switch (kind) {
    case 'image':
      return { image: source, mimetype, ...cap };
    case 'video':
      return { video: source, mimetype, ...cap };
    case 'audio':
      // Audio messages cannot carry a caption, so audio with text goes as a document.
      return caption ? { document: source, mimetype, fileName, caption } : { audio: source, mimetype };
    default:
      return { document: source, mimetype, fileName, ...cap };
  }
}
