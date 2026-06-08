// 工具函数

import type { HTTPResponse } from '@songloft/plugin-sdk';

/** 解析 URL query string */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  const parts = query.split('&');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      out[decodeURIComponent(part)] = '';
    } else {
      out[decodeURIComponent(part.substring(0, eq))] = decodeURIComponent(part.substring(eq + 1));
    }
  }
  return out;
}

/** 构造 JSON 响应 */
export function jsonResponse<T>(data: T, statusCode = 200): HTTPResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  };
}

/** 构造错误响应 */
export function errorResponse(message: string, statusCode = 400): HTTPResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ success: false, error: message }),
  };
}

/** 自然排序（"1" < "2" < "10"） */
export function naturalCompare(a: string, b: string): number {
  const ax: Array<string | number> = [];
  const bx: Array<string | number> = [];
  const re = /(\d+)|(\D+)/g;
  let ma: RegExpExecArray | null;
  while ((ma = re.exec(a)) !== null) {
    ax.push(ma[1] ? parseInt(ma[1], 10) : ma[2].toLowerCase());
  }
  let mb: RegExpExecArray | null;
  while ((mb = re.exec(b)) !== null) {
    bx.push(mb[1] ? parseInt(mb[1], 10) : mb[2].toLowerCase());
  }
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const av = ax[i];
    const bv = bx[i];
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return av - bv;
    } else {
      const as = String(av);
      const bs = String(bv);
      if (as !== bs) return as < bs ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/** 从文件名提取扩展名（小写，带点） */
export function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx === -1) return '';
  return name.substring(idx).toLowerCase();
}

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.wma', '.opus', '.webm', '.m4b']);
export function isAudioFile(name: string): boolean {
  return AUDIO_EXTS.has(getExt(name));
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
export function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(getExt(name));
}

const DESC_NAMES = new Set(['description.txt', 'readme.txt', 'readme.md', '简介.txt', '介绍.txt']);
export function isDescFile(name: string): boolean {
  return DESC_NAMES.has(name.toLowerCase());
}

/** 根据图片扩展名返回 MIME 类型 */
export function getImageMime(name: string): string {
  const ext = getExt(name);
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

/** 根据扩展名返回 MIME 类型 */
export function getMimeFromExt(name: string): string {
  const ext = getExt(name);
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
    case '.m4b':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.wma':
      return 'audio/x-ms-wma';
    case '.opus':
      return 'audio/opus';
    default:
      return 'audio/mpeg';
  }
}

/** 简易 hash（短字符串）用于 ID */
export function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

/** 从路径中提取安全 ID（只保留字母、数字、连字符、下划线） */
export function safeId(path: string): string {
  const base = path.replace(/\\/g, '/');
  const cleaned = base
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return cleaned || hashString(path);
}

/** 去除扩展名 */
export function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? name : name.substring(0, idx);
}

/** 格式化时间（秒 → "mm:ss" 或 "hhh:mm:ss"） */
export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 根据文件大小估算时长（按 128kbps ≈ 16000 字节/秒） */
export function estimateDurationFromSize(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.floor(bytes / 16000);
}
