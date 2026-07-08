// HTTP 路由处理器：使用 SDK 的 createRouter()

import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest } from '@songloft/plugin-sdk';
import { parseQuery, jsonResponse, errorResponse, getImageMime } from '../utils/helpers';
import { BookManager } from '../services/bookManager';
import { ensurePlayablePath, needsTranscode, isCacheReady, getCacheInfo, clearCache, probeDuration } from '../services/transcoder';

type AppRouter = ReturnType<typeof createRouter>;

/** 将相对封面路径解析为 data URI */
async function resolveCoverUrl(relPath: string | null): Promise<string | null> {
  if (!relPath) return null;
  try {
    const base64 = await songloft.fs.readFile(relPath, { encoding: 'base64' });
    const mime = getImageMime(relPath);
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

/** 注册所有 API 路由到 router */
export function registerHandlers(router: AppRouter, bm: BookManager): void {
  // ---------- GET /api/books —— 书籍列表 ----------
  router.get('/api/books', async (req: HTTPRequest) => {
    const q = parseQuery(req.query || '');
    const result = bm.list({
      page: parseInt(q.page || '1', 10),
      pageSize: parseInt(q.pageSize || '24', 10),
      keyword: q.keyword,
      category: q.category,
      favoritesOnly: q.favoritesOnly === '1' || q.favoritesOnly === 'true',
      sortBy: (q.sortBy as any) || 'updatedAt',
    });
    const booksWithMeta = await Promise.all(result.books.map(async (b) => ({
      ...b,
      coverUrl: await resolveCoverUrl(b.coverUrl),
      isFavorite: bm.isFavorite(b.id),
    })));
    return jsonResponse({
      success: true,
      data: { ...result, books: booksWithMeta },
    });
  });

  // ---------- GET /api/categories —— 分类列表 ----------
  router.get('/api/categories', async () => {
    return jsonResponse({
      success: true,
      data: { categories: bm.getCategories(), tags: bm.getTags() },
    });
  });

  // ---------- GET /api/snapshot —— 整体状态 ----------
  router.get('/api/snapshot', async () => {
    return jsonResponse({ success: true, data: bm.getSnapshot() });
  });

  // ---------- GET /api/recently-played —— 最近播放 ----------
  router.get('/api/recently-played', async () => {
    const recent = bm.getRecentlyPlayed();
    const enriched = (await Promise.all(recent.map(async (item) => {
        const book = bm.getBookById(item.bookId);
        if (!book) return null;
        const chapter = book.chapters.find((c) => c.id === item.chapterId);
        return {
          bookId: item.bookId,
          chapterId: item.chapterId,
          at: item.at,
          bookTitle: book.title,
          chapterTitle: chapter?.title || '',
          coverUrl: await resolveCoverUrl(book.coverUrl),
          fileRelPath: chapter?.fileRelPath || '',
        };
      })))
      .filter((x) => x !== null);
    return jsonResponse({ success: true, data: { items: enriched } });
  });

  // ---------- POST /api/rescan —— 触发重新扫描 ----------
  router.post('/api/rescan', async () => {
    const r = await bm.rescan();
    return jsonResponse({
      success: true,
      message: `重新扫描完成：${r.totalBooks} 本书，${r.totalChapters} 章节`,
      data: r,
    });
  });

  // ---------- GET /api/books/:id —— 书籍详情（含章节） ----------
  router.get('/api/books/:id', async (req: HTTPRequest, params: Record<string, string>) => {
    const book = bm.getBookById(params.id);
    if (!book) return errorResponse('未找到该书籍', 404);
    return jsonResponse({
      success: true,
      data: {
        ...book,
        coverUrl: await resolveCoverUrl(book.coverUrl),
        chapters: book.chapters.map((c) => ({
          ...c,
          progress: bm.getProgress(book.id, c.id),
        })),
        isFavorite: bm.isFavorite(book.id),
      },
    });
  });

  // ---------- GET /api/books/:id/favorite —— 收藏状态 ----------
  router.get('/api/books/:id/favorite', async (req: HTTPRequest, params: Record<string, string>) => {
    return jsonResponse({
      success: true,
      data: { bookId: params.id, isFavorite: bm.isFavorite(params.id) },
    });
  });

  // ---------- POST /api/books/:id/favorite —— 切换收藏 ----------
  router.post('/api/books/:id/favorite', async (req: HTTPRequest, params: Record<string, string>) => {
    const isFav = await bm.toggleFavorite(params.id);
    return jsonResponse({ success: true, data: { bookId: params.id, isFavorite: isFav } });
  });

  // ---------- GET /api/books/:id/chapters/:chapterId/progress ----------
  router.get(
    '/api/books/:id/chapters/:chapterId/progress',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const progress = bm.getProgress(params.id, params.chapterId);
      return jsonResponse({
        success: true,
        data: { bookId: params.id, chapterId: params.chapterId, progress },
      });
    }
  );

  // ---------- POST /api/books/:id/chapters/:chapterId/progress ----------
  router.post(
    '/api/books/:id/chapters/:chapterId/progress',
    async (req: HTTPRequest, params: Record<string, string>) => {
      let payload: Record<string, unknown> = {};
      try {
        if (req.body) {
          const bodyStr = typeof req.body === 'string' ? req.body : '';
          payload = JSON.parse(bodyStr);
        }
      } catch {
        payload = {};
      }
      const q = parseQuery(req.query || '');
      const position = Number(payload.position !== undefined ? payload.position : q.position || 0);
      const duration = Number(payload.duration !== undefined ? payload.duration : q.duration || 0);
      const completed = payload.completed !== undefined ? Boolean(payload.completed) : undefined;
      const p = await bm.setProgress(params.id, params.chapterId, position, duration, completed);
      return jsonResponse({
        success: true,
        data: { bookId: params.id, chapterId: params.chapterId, progress: p },
      });
    }
  );

  // ---------- GET /api/books/:id/chapters/:chapterId/audio —— 音频文件（serveFile 直出） ----------
  router.get(
    '/api/books/:id/chapters/:chapterId/audio',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const chapter = bm.getChapter(params.id, params.chapterId);
      if (!chapter) return errorResponse('未找到章节', 404);

      if (needsTranscode(chapter.fileRelPath)) {
        const ready = await isCacheReady(chapter.fileRelPath);
        if (!ready) {
          return jsonResponse({ success: false, error: '音频转码中，请稍后再试', transcoding: true }, 503);
        }
      }

      try {
        const playablePath = await ensurePlayablePath(chapter.fileRelPath);
        return { serveFile: { filePath: playablePath } } as any;
      } catch (err) {
        songloft.log.warn(`音频读取失败: ${chapter.fileRelPath} (${String(err)})`);
        return errorResponse('音频文件读取失败', 500);
      }
    }
  );

  // ---------- GET /api/books/:id/chapters/:chapterId/preload —— 提前转码 ----------
  //   ?check=1 仅查询缓存状态，不触发实际转码
  //   无 check 参数时触发后台转码后立即返回，前端轮询 ?check=1 等待就绪
  const pendingTranscodes = new Set<string>();
  router.get(
    '/api/books/:id/chapters/:chapterId/preload',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const chapter = bm.getChapter(params.id, params.chapterId);
      if (!chapter) return errorResponse('未找到章节', 404);

      const q = parseQuery(req.query || '');
      const checkOnly = q.check === '1';

      if (checkOnly) {
        const ready = await isCacheReady(chapter.fileRelPath);
        // 优先用已持久化的真实时长，避免重复 ffprobe
        const progress = bm.getProgress(params.id, params.chapterId);
        const duration = progress.duration > 0
          ? progress.duration
          : await probeDuration(chapter.fileRelPath);
        return jsonResponse({
          success: true,
          data: { ready, transcoding: !ready && pendingTranscodes.has(chapter.fileRelPath), duration },
        });
      }

      const ready = await isCacheReady(chapter.fileRelPath);
      if (ready) return jsonResponse({ success: true, data: { ready: true } });

      if (pendingTranscodes.has(chapter.fileRelPath)) {
        return jsonResponse({ success: true, data: { ready: false, transcoding: true } });
      }
      pendingTranscodes.add(chapter.fileRelPath);

      ensurePlayablePath(chapter.fileRelPath)
        .then(() => { pendingTranscodes.delete(chapter.fileRelPath); })
        .catch(() => { pendingTranscodes.delete(chapter.fileRelPath); });

      // 提前 probe 精确时长并持久化，避免切歌时现等 ffprobe
      const p = bm.getProgress(params.id, params.chapterId);
      if (!p.duration) {
        probeDuration(chapter.fileRelPath).then((d) => {
          if (d > 0) bm.setProgress(params.id, params.chapterId, 0, d).catch(() => {});
        });
      }

      return jsonResponse({ success: true, data: { ready: false, transcoding: true } });
    }
  );

  // ---------- GET /api/books/:id/metadata —— 获取元数据（供编辑弹窗预填） ----------
  router.get(
    '/api/books/:id/metadata',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const book = bm.getBookById(params.id);
      if (!book) return errorResponse('未找到该书籍', 404);
      return jsonResponse({
        success: true,
        data: {
          title: book.title,
          description: book.description,
          category: book.category,
          tags: book.tags,
          author: book.author,
          coverRatio: book.coverRatio || '',
          coverUrl: await resolveCoverUrl(book.coverUrl),
        },
      });
    }
  );

  // ---------- PUT /api/books/:id/metadata —— 更新元数据 ----------
  router.put(
    '/api/books/:id/metadata',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { description, category, tags, author, coverRatio } = body;
      try {
        await bm.updateMetadata(params.id, { description, category, tags, author, coverRatio });
        const book = bm.getBookById(params.id);
        return jsonResponse({
          success: true,
          data: {
            description: book.description,
            category: book.category,
            tags: book.tags,
            author: book.author,
            coverRatio: book.coverRatio || '',
            coverUrl: await resolveCoverUrl(book.coverUrl),
          },
        });
      } catch (e) {
        return errorResponse(String(e), 500);
      }
    }
  );

  // ---------- POST /api/books/:id/cover —— 更新封面 ----------
  router.post(
    '/api/books/:id/cover',
    async (req: HTTPRequest, params: Record<string, string>) => {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { base64 } = body;
      if (!base64) return errorResponse('请提供 base64 图片数据', 400);
      try {
        const coverDataUri = await bm.updateCover(params.id, base64);
        return jsonResponse({ success: true, data: { coverUrl: coverDataUri } });
      } catch (e) {
        return errorResponse(String(e), 500);
      }
    }
  );

  // ---------- GET /api/cache/info —— 缓存信息 ----------
  router.get('/api/cache/info', async () => {
    const info = await getCacheInfo();
    return jsonResponse({ success: true, data: info });
  });

  // ---------- POST /api/cache/clean —— 清理缓存 ----------
  router.post('/api/cache/clean', async () => {
    const result = await clearCache();
    return jsonResponse({ success: true, data: result });
  });
}
