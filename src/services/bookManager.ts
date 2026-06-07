// 书籍管理器：封装扫描、查询、进度、收藏等功能

import type { Book, BookDetail, Chapter, PluginSettings, ChapterProgress } from '../types';
import {
  scanLibrary,
  saveLibraryIndex,
  loadLibraryIndex,
  getBookDetail,
} from './scanner';

const STORAGE_KEY_SETTINGS = 'audiobook_settings_v1';
const STORAGE_KEY_PROGRESS = 'audiobook_progress_v1';

type BookWithChapters = Book & { chapters: Chapter[] };

interface StateSnapshot {
  books: Book[];
  totalBooks: number;
  libraryPath: string;
  categories: string[];
  scannedAt: number;
}

export class BookManager {
  private libraryPath = 'library';
  private books: Book[] = [];
  private chaptersByBookId: Record<string, Chapter[]> = {};
  private scannedAt = 0;
  private settings: PluginSettings = {
    libraryPath: 'library',
    favorites: [],
    recentlyPlayed: [],
  };
  private progress: Record<string, ChapterProgress> = {};

  async init(): Promise<void> {
    // 1) 加载设置
    try {
      const raw = await songloft.storage.get(STORAGE_KEY_SETTINGS);
      if (raw && typeof raw === 'object') {
        this.settings = { ...this.settings, ...(raw as Partial<PluginSettings>) };
      } else if (typeof raw === 'string') {
        this.settings = { ...this.settings, ...JSON.parse(raw) };
      }
    } catch {
      // ignore
    }
    this.libraryPath = this.settings.libraryPath || 'library';

    // 2) 加载播放进度
    try {
      const raw = await songloft.storage.get(STORAGE_KEY_PROGRESS);
      if (raw && typeof raw === 'object') {
        this.progress = raw as Record<string, ChapterProgress>;
      } else if (typeof raw === 'string') {
        this.progress = JSON.parse(raw) || {};
      }
    } catch {
      // ignore
    }

    // 3) 从缓存加载
    try {
      const cached = await loadLibraryIndex();
      if (cached && cached.books && cached.books.length > 0) {
        this.books = cached.books;
        this.chaptersByBookId = cached.chaptersByBookId || {};
        this.libraryPath = cached.libraryPath || this.libraryPath;
        songloft.log.info(`有声书插件：从缓存加载 ${this.books.length} 本书`);
      }
    } catch {
      // ignore
    }

    // 4) 实时扫描（首次安装无缓存时必须有结果）
    try {
      const state = await scanLibrary({ libraryPath: this.libraryPath });
      this.books = state.books;
      this.chaptersByBookId = state.chaptersByBookId;
      this.scannedAt = Date.now();
      await saveLibraryIndex(state);
      songloft.log.info(`有声书插件：扫描完成，共 ${this.books.length} 本书`);
    } catch (err) {
      songloft.log.warn(`有声书插件：扫描失败: ${String(err)}`);
    }
  }

  // ---------- 列表 / 查询类 ----------

  list(options: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    category?: string;
    favoritesOnly?: boolean;
    sortBy?: 'updatedAt' | 'title' | 'chapterCount';
  }): { total: number; books: Book[]; page: number; pageSize: number } {
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize || 24));
    const keyword = (options.keyword || '').trim().toLowerCase();
    const category = (options.category || '').trim();

    let list = this.books.slice();

    if (keyword) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(keyword) ||
          b.author.toLowerCase().includes(keyword) ||
          b.description.toLowerCase().includes(keyword) ||
          (b.tags || []).some((t) => t.toLowerCase().includes(keyword))
      );
    }
    if (category) {
      list = list.filter((b) => b.category === category);
    }
    if (options.favoritesOnly) {
      const favSet = new Set(this.settings.favorites);
      list = list.filter((b) => favSet.has(b.id));
    }

    const sortBy = options.sortBy || 'updatedAt';
    if (sortBy === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    else if (sortBy === 'chapterCount') list.sort((a, b) => b.chapterCount - a.chapterCount);
    else list.sort((a, b) => b.updatedAt - a.updatedAt);

    const total = list.length;
    const start = (page - 1) * pageSize;
    return {
      total,
      books: list.slice(start, start + pageSize),
      page,
      pageSize,
    };
  }

  getBookById(bookId: string): BookWithChapters | null {
    return getBookDetail(
      {
        libraryPath: this.libraryPath,
        books: this.books,
        chaptersByBookId: this.chaptersByBookId,
      },
      bookId
    );
  }

  getChapter(bookId: string, chapterId: string): Chapter | null {
    const chapters = this.chaptersByBookId[bookId];
    if (!chapters) return null;
    return chapters.find((c) => c.id === chapterId) || null;
  }

  getCategories(): string[] {
    const set = new Set<string>();
    set.add('全部');
    for (const b of this.books) set.add(b.category);
    return Array.from(set);
  }

  getTags(): string[] {
    const set = new Set<string>();
    for (const b of this.books) for (const t of b.tags || []) set.add(t);
    return Array.from(set);
  }

  getSnapshot(): StateSnapshot & { recentlyPlayed: PluginSettings['recentlyPlayed']; settings: PluginSettings } {
    return {
      books: this.books,
      totalBooks: this.books.length,
      libraryPath: this.libraryPath,
      categories: this.getCategories(),
      scannedAt: this.scannedAt,
      recentlyPlayed: this.settings.recentlyPlayed,
      settings: { ...this.settings },
    };
  }

  getRecentlyPlayed(): PluginSettings['recentlyPlayed'] {
    return this.settings.recentlyPlayed.slice(0, 20);
  }

  // ---------- 收藏 ----------

  isFavorite(bookId: string): boolean {
    return this.settings.favorites.includes(bookId);
  }

  async toggleFavorite(bookId: string): Promise<boolean> {
    const idx = this.settings.favorites.indexOf(bookId);
    if (idx === -1) this.settings.favorites.push(bookId);
    else this.settings.favorites.splice(idx, 1);
    await this.saveSettings();
    return this.settings.favorites.includes(bookId);
  }

  // ---------- 播放进度 ----------

  getProgress(bookId: string, chapterId: string): ChapterProgress {
    const key = `${bookId}::${chapterId}`;
    const p = this.progress[key];
    if (p) return p;
    return { position: 0, duration: 0, updatedAt: 0 };
  }

  async setProgress(
    bookId: string,
    chapterId: string,
    position: number,
    duration: number
  ): Promise<ChapterProgress> {
    const key = `${bookId}::${chapterId}`;
    const p: ChapterProgress = {
      position: Math.max(0, Math.floor(position)),
      duration: Math.max(0, Math.floor(duration)),
      updatedAt: Date.now(),
    };
    this.progress[key] = p;
    try {
      await songloft.storage.set(
        STORAGE_KEY_PROGRESS,
        this.progress as unknown as Record<string, unknown>
      );
    } catch (err) {
      songloft.log.warn(`保存播放进度失败: ${String(err)}`);
    }
    await this.addRecentlyPlayed(bookId, chapterId);
    return p;
  }

  async addRecentlyPlayed(bookId: string, chapterId: string): Promise<void> {
    const list = this.settings.recentlyPlayed.filter(
      (x) => !(x.bookId === bookId && x.chapterId === chapterId)
    );
    list.unshift({ bookId, chapterId, at: Date.now() });
    this.settings.recentlyPlayed = list.slice(0, 30);
    await this.saveSettings();
  }

  // ---------- 设置持久化 ----------

  private async saveSettings(): Promise<void> {
    try {
      await songloft.storage.set(
        STORAGE_KEY_SETTINGS,
        this.settings as unknown as Record<string, unknown>
      );
    } catch (err) {
      songloft.log.warn(`保存 plugin 设置失败: ${String(err)}`);
    }
  }

  async setLibraryPath(path: string): Promise<void> {
    this.libraryPath = path;
    this.settings.libraryPath = path;
    await this.saveSettings();
  }

  // ---------- 重新扫描 ----------

  async rescan(): Promise<{ totalBooks: number; totalChapters: number }> {
    const state = await scanLibrary({ libraryPath: this.libraryPath });
    this.books = state.books;
    this.chaptersByBookId = state.chaptersByBookId;
    this.scannedAt = Date.now();
    await saveLibraryIndex(state);

    let totalChapters = 0;
    for (const b of this.books) totalChapters += b.chapterCount;
    return { totalBooks: this.books.length, totalChapters };
  }

  getSettings(): PluginSettings {
    return { ...this.settings };
  }
}
