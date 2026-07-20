// 本地有声书扫描器：从 pluginDataDir 下的某个目录扫描书籍/章节文件

import type { Book, Chapter } from '../types';
import {
  isAudioFile,
  isImageFile,
  isDescFile,
  naturalCompare,
  stripExt,
  safeId,
  estimateDurationFromSize,
} from '../utils/helpers';

interface ScannerState {
  books: Book[];
  chaptersByBookId: Record<string, Chapter[]>;
}

export const DEFAULT_LIBRARY_PATH = '/app/audiobook';

const MAX_SCAN_DEPTH = 6;

interface WalkResult {
  audios: string[];
  coverRel: string | null;
  descRel: string | null;
}

/**
 * 递归扫描目录，收集音频文件、封面和描述文件，最深 maxDepth 层
 * depth: 当前递归深度（0 起始）
 */
async function walkDir(
  dirPath: string,
  depth: number,
  maxDepth: number
): Promise<WalkResult> {
  const audios: string[] = [];
  let coverRel: string | null = null;
  let descRel: string | null = null;

  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    entries = (await songloft.fs.readdir(dirPath)) || [];
  } catch {
    return { audios, coverRel, descRel };
  }

  for (const e of entries) {
    const fullPath = `${dirPath}/${e.name}`;
    if (e.isDir) {
      if (depth < maxDepth) {
        try {
          await songloft.fs.stat(fullPath);
        } catch {
          continue;
        }
        const sub = await walkDir(fullPath, depth + 1, maxDepth);
        audios.push(...sub.audios);
        if (!coverRel && sub.coverRel) coverRel = sub.coverRel;
        if (!descRel && sub.descRel) descRel = sub.descRel;
      }
    } else {
      if (isAudioFile(e.name)) {
        audios.push(fullPath);
      }
      if (!coverRel && isImageFile(e.name)) {
        const lower = e.name.toLowerCase();
        const base = lower.substring(0, lower.lastIndexOf('.'));
        if (base === 'cover' || base === 'folder' || base === '封面') {
          coverRel = fullPath;
        }
      }
      if (!descRel && isDescFile(e.name)) {
        descRel = fullPath;
      }
    }
  }

  return { audios, coverRel, descRel };
}

/** 扫描整个库目录并返回索引 */
export async function scanLibrary(): Promise<ScannerState> {
  const libraryPath = DEFAULT_LIBRARY_PATH;
  const state: ScannerState = { books: [], chaptersByBookId: {} };

  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    entries = (await songloft.fs.readdir(libraryPath)) || [];
  } catch (err) {
    songloft.log.warn(`有声书库路径不存在或无法访问: ${libraryPath} (${String(err)})`);
    return state;
  }

  if (entries.length === 0) {
    songloft.log.info(`有声书库为空: ${libraryPath}`);
    return state;
  }

  const folders: string[] = [];
  const rootAudios: string[] = [];

  for (const e of entries) {
    if (e.isDir) {
      folders.push(e.name);
    } else if (isAudioFile(e.name)) {
      rootAudios.push(e.name);
    }
  }

  // 扫描每个子目录为一本书
  for (const folder of folders) {
    try {
      const result = await scanBookFolder(libraryPath, folder);
      if (result && result.chapters.length > 0) {
        state.books.push(result.book);
        state.chaptersByBookId[result.book.id] = result.chapters;
      }
    } catch (err) {
      songloft.log.warn(`扫描文件夹 '${folder}' 失败: ${String(err)}`);
    }
  }

  // 根目录散落的音频文件 → 合并到一本"未分类"书籍
  if (rootAudios.length > 0) {
    try {
      const result = await buildMiscBook(libraryPath, rootAudios);
      if (result && result.chapters.length > 0) {
        state.books.push(result.book);
        state.chaptersByBookId[result.book.id] = result.chapters;
      }
    } catch (err) {
      songloft.log.warn(`未分类音频扫描失败: ${String(err)}`);
    }
  }

  // 按最近更新时间排序
  state.books.sort((a, b) => b.updatedAt - a.updatedAt);

  songloft.log.info(`有声书扫描完成：共 ${state.books.length} 本书`);
  return state;
}

async function scanBookFolder(
  libraryPath: string,
  folder: string
): Promise<{ book: Book; chapters: Chapter[] } | null> {
  const folderRel = `${libraryPath}/${folder}`;

  try {
    await songloft.fs.stat(folderRel);
  } catch {
    return null;
  }

  const result = await walkDir(folderRel, 0, MAX_SCAN_DEPTH);

  if (result.audios.length === 0) return null;

  result.audios.sort((a, b) => naturalCompare(a, b));

  const chapters: Chapter[] = [];
  let latestMod = 0;
  let totalSize = 0;

  for (let i = 0; i < result.audios.length; i++) {
    const rel = result.audios[i];
    try {
      const st = await songloft.fs.stat(rel);
      const size = Number(st.size || 0);
      const mod = Number(st.modTime || 0);
      if (mod > latestMod) latestMod = mod;
      totalSize += size;

      const fileName = rel.substring(rel.lastIndexOf('/') + 1);

      chapters.push({
        id: `${safeId(folder)}-ch${String(i + 1).padStart(3, '0')}`,
        index: i + 1,
        title: stripExt(fileName),
        duration: estimateDurationFromSize(size),
        fileSize: size,
        fileRelPath: rel,
        modTime: mod,
      });
    } catch (err) {
      songloft.log.warn(`stat 失败: ${rel} (${String(err)})`);
    }
  }

  if (chapters.length === 0) return null;

  let coverRel = result.coverRel;
  let descRel = result.descRel;

  // 如果在子目录中未找到命名封面，尝试根目录的任何图片
  if (!coverRel) {
    try {
      const rootEntries = (await songloft.fs.readdir(folderRel)) || [];
      for (const e of rootEntries) {
        if (!e.isDir && isImageFile(e.name)) {
          coverRel = `${folderRel}/${e.name}`;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  let description = '';
  let category = '默认';
  let tags: string[] = [];
  let author = '未知';
  let coverRatio = '';

  // 优先读取 metadata.json
  try {
    const metaRaw = await songloft.fs.readFile(`${folderRel}/metadata.json`);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      if (meta.description) description = meta.description;
      if (meta.category) category = meta.category;
      if (meta.tags) tags = meta.tags;
      if (meta.author) author = meta.author;
      if (meta.coverRatio) coverRatio = meta.coverRatio;
    }
  } catch {
    // metadata.json 不存在或解析失败，走旧逻辑
  }

  if (!description && descRel) {
    try {
      description = ((await songloft.fs.readFile(descRel)) || '').trim();
    } catch {
      description = '';
    }
  }

  const book: Book = {
    id: safeId(folder),
    title: folder,
    author,
    coverUrl: coverRel,
    coverRatio,
    description: description || `共 ${chapters.length} 章`,
    category,
    tags,
    updatedAt: latestMod || Date.now(),
    chapterCount: chapters.length,
    totalSize,
    folderRelPath: folderRel,
  };

  return { book, chapters };
}

async function buildMiscBook(
  libraryPath: string,
  audios: string[]
): Promise<{ book: Book; chapters: Chapter[] } | null> {
  if (audios.length === 0) return null;
  audios.sort((a, b) => naturalCompare(a, b));

  const chapters: Chapter[] = [];
  let latestMod = 0;
  let totalSize = 0;

  for (let i = 0; i < audios.length; i++) {
    const rel = `${libraryPath}/${audios[i]}`;
    try {
      const st = await songloft.fs.stat(rel);
      const size = Number(st.size || 0);
      const mod = Number(st.modTime || 0);
      if (mod > latestMod) latestMod = mod;
      totalSize += size;
      chapters.push({
        id: `misc-ch${String(i + 1).padStart(3, '0')}`,
        index: i + 1,
        title: stripExt(audios[i]),
        duration: estimateDurationFromSize(size),
        fileSize: size,
        fileRelPath: rel,
        modTime: mod,
      });
    } catch {
      // ignore
    }
  }

  if (chapters.length === 0) return null;

  const book: Book = {
    id: 'misc-audio',
    title: '未分类音频',
    author: '未知',
    coverUrl: null,
    coverRatio: '',
    description: '有声书库根目录下的零散音频文件',
    category: '未分类',
    tags: [],
    updatedAt: latestMod || Date.now(),
    chapterCount: chapters.length,
    totalSize,
    folderRelPath: libraryPath,
  };

  return { book, chapters };
}

// ---------- 索引持久化 ----------

const STORAGE_KEY = 'audiobook_library_v1';

export async function saveLibraryIndex(state: ScannerState): Promise<void> {
  try {
    await songloft.storage.set(STORAGE_KEY, state as unknown as Record<string, unknown>);
  } catch (err) {
    songloft.log.warn(`saveLibraryIndex 失败: ${String(err)}`);
  }
}

export async function loadLibraryIndex(): Promise<ScannerState | null> {
  try {
    const raw = await songloft.storage.get(STORAGE_KEY);
    if (!raw) return null;
    return raw as unknown as ScannerState;
  } catch {
    return null;
  }
}

/** 辅助：根据 bookId 从 state 中获取 BookDetail */
export function getBookDetail(state: ScannerState, bookId: string): (Book & { chapters: Chapter[] }) | null {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return null;
  const chapters = state.chaptersByBookId[bookId] || [];
  return { ...book, chapters };
}
