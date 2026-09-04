// ================================================================
// 日志系统（供前端日志面板展示）
// ================================================================

const MAX_LOGS = 200;
const webhooks: Array<{ time: number; type: string; action: string; detail: string; result: string | null }> = [];

/** 向内存日志追加一条记录（前端日志面板用），跳过连续重复 */
function pushWebhookLog(type: string, action: string, detail: string, result: string | null): void {
  const entry = { time: Date.now(), type, action, detail, result };
  // 如果最近一条完全相同则跳过，防止快速重试产生刷屏
  if (webhooks.length > 0) {
    const last = webhooks[webhooks.length - 1];
    if (last.type === entry.type && last.action === entry.action && last.detail === entry.detail && last.result === entry.result) {
      return;
    }
  }
  webhooks.push(entry);
  if (webhooks.length > MAX_LOGS) webhooks.shift();
}

/** 将中文意图名映射到类型图标 */
function intentToType(intent: string): string {
  switch (intent) {
    case 'PLAY_EPISODE': return 'voice';
    case 'PLAY_BOOK': return 'voice';
    case 'NEXT_EPISODE': return 'voice';
    case 'PREV_EPISODE': return 'voice';
    default: return 'speaker';
  }
}

// HTTP 路由处理器：使用 SDK 的 createRouter()

import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest } from '@songloft/plugin-sdk';
import { parseQuery, jsonResponse, errorResponse, getImageMime } from '../utils/helpers';
import { BookManager } from '../services/bookManager';
import { ensurePlayablePath, needsTranscode, isCacheReady, getCacheInfo, clearCache, probeDuration } from '../services/transcoder';
import { parseIntent } from '../services/intentParser';

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

  // ---------- POST /api/rescan —— 异步触发重新扫描（防 504 超时） ----------
  router.post('/api/rescan', async () => {
    bm.rescan().catch((err) => songloft.log.warn(`后台重扫异常: ${String(err)}`));
    return jsonResponse({ success: true, data: { scanning: true } });
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

      // ?seek=N：遥控推送音响时从第 N 秒起播（宿主 serveFile.seekSeconds 能力，SDK v2.13.2+）
      const q = parseQuery(req.query || '');
      const seekSeconds = Number(q.seek || 0);

      try {
        const playablePath = await ensurePlayablePath(chapter.fileRelPath);
        if (seekSeconds > 0) {
          // 已持久化的真实时长，用于宿主侧 ffmpeg 进程超时保护
          const progress = bm.getProgress(params.id, params.chapterId);
          return {
            serveFile: {
              filePath: playablePath,
              seekSeconds,
              durationSeconds: progress.duration > 0 ? progress.duration : undefined,
            },
          } as any;
        }
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

  // ================================================================
  // Webhook 语音命令接收（来自 miot-plus）
  // ================================================================

  // POST /api/webhook/said —— 接收外部推送的用户口令文本，解析并执行有声书意图
  router.post('/api/webhook/said', async (req: HTTPRequest) => {
    try {
      // Webhook 开关检查
      if (!bm.isWebhookEnabled()) {
        return jsonResponse({ success: false, error: 'Webhook 未启用' }, 503);
      }

      // Token 认证（query param ?token=xxx 或 header X-Webhook-Token）
      const q = parseQuery(req.query || '');
      const queryToken = (q.token as string) || '';
      const headerToken = (req.headers as Record<string, string>)?.['X-Webhook-Token'] || '';
      const token = queryToken || headerToken;
      if (!bm.verifyWebhookToken(token)) {
        pushWebhookLog('error', '认证失败', `无效或缺失 token`, '❌');
        return jsonResponse({ success: false, error: '认证失败' }, 401);
      }

      let bodyObj: Record<string, unknown> = {};
      try {
        const raw = typeof req.body === 'string' ? req.body : '';
        if (raw) bodyObj = JSON.parse(raw);
      } catch { /* ignore */ }

      // 提取用户说的话：可能是直接传 message，也可能是从 miot-plus webhook payload 中提取 question
      const directMsg = bodyObj.message as string | undefined;
      const messages = bodyObj.messages as Array<Record<string, unknown>> | undefined;
      const query = extractQuestion(messages ?? [], directMsg);

      if (!query || !query.trim()) {
        pushWebhookLog('speaker', '空消息', `忽略空请求`, '❌');
        return jsonResponse({ success: true, data: { executed: false, reason: 'empty_message' } });
      }

      // 解析意图
      const intent = parseIntent(query.trim());
      if (!intent) {
        // 不是有声书相关的口令，返回成功但不执行（让 miot-plus 自己处理）
        songloft.log.info(`[webhook] non-matching intent: "${query}"`);
        pushWebhookLog('speaker', '意图未匹配', `msg="${query}"`, null);
        return jsonResponse({ success: true, data: { executed: false, reason: 'no_match' } });
      }

      songloft.log.info(`[webhook] matched intent: ${intent.intent} book="${intent.bookTitle}" chapter=${intent.chapterIndex}`);
      pushWebhookLog('voice', '意图匹配', `msg="${query}" ${intent.intent} book="${intent.bookTitle}" chapter=${intent.chapterIndex}`, null);

      // 解析目标设备（必须来自 webhook payload）
      const target = await resolveDeviceTarget(bodyObj);
      if ('reason' in target) {
        pushWebhookLog('error', '设备查找', target.reason, '❌');
        return jsonResponse({ success: false, error: target.reason });
      }

      // 执行操作
      const ok = await executeAudiobookAction(bm, intent, target.accountId, target.deviceId);
      if (!ok) {
        pushWebhookLog('error', '执行失败', `msg="${query}" ${intent.intent} book="${intent.bookTitle}"`, '❌');
        return jsonResponse({ success: false, error: '执行失败' });
      }

      pushWebhookLog('voice', intent.intent === 'PLAY_EPISODE' ? '播放章节' : (intent.intent === 'PLAY_BOOK' ? '播放书籍' : (intent.intent === 'NEXT_EPISODE' ? '下一集' : '上一集')), `msg="${query}"`, '✅');
      return jsonResponse({ success: true, data: { executed: true, intent: intent.intent, bookTitle: intent.bookTitle } });
    } catch (e: any) {
      songloft.log.error(`[webhook] error: ${String(e)}`);
      pushWebhookLog('error', '处理异常', e.message || String(e), '❌');
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /api/webhook/config —— 获取 Webhook 配置信息（含 URL）
  router.get('/api/webhook/config', async () => {
    const enabled = bm.isWebhookEnabled();
    const path = generateWebhookUrl();
    const token = bm.getWebhookToken();
    const serverHost = bm.getSettings().serverHost || '';
    return jsonResponse({
      success: true,
      data: { enabled, url: path, token, serverHost },
    });
  });

  // POST /api/webhook/toggle —— 切换 Webhook 开关
  router.post('/api/webhook/toggle', async (req: HTTPRequest) => {
    try {
      let bodyObj: Record<string, unknown> = {};
      try {
        const raw = typeof req.body === 'string' ? req.body : '';
        if (raw) bodyObj = JSON.parse(raw);
      } catch { /* ignore */ }
      const enabled = !!bodyObj.enabled;
      const serverHost = typeof bodyObj.server_host === 'string' ? bodyObj.server_host : undefined;
      await bm.setWebhookEnabled(enabled, serverHost);
      return jsonResponse({ success: true, data: { enabled } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // POST /api/webhook/regenerate-token —— 重新生成 webhook token
  router.post('/api/webhook/regenerate-token', async () => {
    try {
      const newToken = await bm.regenerateWebhookToken();
      songloft.log.info('[webhook] token regenerated');
      pushWebhookLog('config', 'token 已更新', null, null);
      return jsonResponse({ success: true, data: { token: newToken } });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });

  // GET /api/logs —— 获取日志（供前端日志面板展示）
  router.get('/api/logs', async () => {
    return jsonResponse({ success: true, data: webhooks });
  });

  // POST /api/logs —— 清空所有日志
  router.post('/api/logs', async () => {
    webhooks.length = 0;
    return jsonResponse({ success: true, data: { cleared: true } });
  });

  // POST /api/logs/write —— 前端推送音响时写入日志（供前端日志面板展示）
  router.post('/api/logs/write', async (req: HTTPRequest) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : {};
      pushWebhookLog(body.type || 'speaker', body.action || '', body.detail || null, body.result || null);
    } catch {}
    return jsonResponse({ success: true });
  });
}

// ================================================================
// 辅助函数：Webhook 执行逻辑
// ================================================================

/** MIoT API 基础路径（用于 push） */
const MIOT_API_BASE = '/api/v1/jsplugin/miot';

/** 构建 miot-plus 内部 HTTP 完整 URL（含协议前缀，避免 Go fetch 报错 "unsupported protocol scheme"） */
async function miotUrl(path: string): Promise<string> {
  const hostUrl = await songloft.plugin.getHostUrl();
  if (!hostUrl) {
    throw new Error('Host URL not available from songloft.plugin.getHostUrl()');
  }
  return hostUrl + MIOT_API_BASE + path;
}

/** 导出给前端调用的日志查询函数（通过 HTTP 路由调用，非直接导出） */
export function getWebhookLogs(): Array<{ time: number; type: string; action: string; detail: string; result: string | null }> {
  return [...webhooks];
}

/** 从 webhook payload 中提取用户说的话 */
function extractQuestion(messages: Array<Record<string, unknown>>, directMsg?: string): string | null {
  // 优先直接消息（前端手动提交）
  if (directMsg && typeof directMsg === 'string') return directMsg.trim();

  if (!Array.isArray(messages) || messages.length === 0) return null;

  // miot-plus webhook payload 格式：
  // { account_id, device_id, device_name, messages: [ { account_id, device_id, device_name, message: AskMessage } ] }
  // AskMessage 结构：{ timestamp_ms, response: { answer: [ { question, content, intention?: { query } } ] } }
  for (const msg of messages) {
    // 扁平结构
    const q1 = msg.question as string | undefined;
    if (q1) return q1.trim();

    // intention.query
    const intent = msg.intention as Record<string, unknown>;
    const iq = intent?.query as string | undefined;
    if (iq) return iq.trim();

    // 嵌套在 message 字段中的 AskMessage
    const innerMsg = msg.message as Record<string, unknown> | undefined;
    if ((innerMsg?.response as Record<string, unknown>)?.answer) {
      const answerList = (innerMsg.response as Record<string, unknown>).answer as Array<Record<string, unknown>>;
      if (answerList.length > 0) {
        const ans = answerList[0];
        const q2 = ans.question as string | undefined;
        if (q2) return q2.trim();
        // intention.query 在答案内
        const ansIntent = ans.intention as Record<string, unknown>;
        const iq2 = ansIntent?.query as string | undefined;
        if (iq2) return iq2.trim();
      }
    }
  }

  return null;
}

/** 生成 Webhook URL */
function generateWebhookUrl(): string {
  return '/app/audiobook/api/webhook/said';
}

/** 获取插件认证 Token */
async function getAuthToken(): Promise<string> {
  try {
    return await songloft.plugin.getToken();
  } catch {
    return '';
  }
}

/**
 * 通过 HTTP POST 调用 miot-plus 的 /mina/play-url
 */
async function pushChapterToMiot(
  bm: BookManager,
  accountId: string,
  deviceId: string,
  book: ReturnType<BookManager['getBookById']>,
  chapter: import('../types').Chapter,
  seekSeconds: number,
): Promise<boolean> {
    try {
    // 获取认证 token（提前到 URL 构造前）
    const token = await getAuthToken();

    // 从 settings 读取服务器地址（用户通过 Webhook 启用时保存的公网/局域网地址）
    const serverHost = bm.getSettings().serverHost || '';
    if (!serverHost) {
      songloft.log.warn('[webhook] ❌ serverHost 未设置，语音口令推送音响将无法工作，请在音响插件中配置正确的局域网地址');
      pushWebhookLog('error', '推送准备', 'serverHost 未设置', '❌');
      return false;
    }

    // 构建完整音频 URL（含 access_token，与手动推送保持一致）
    const audioPath = `/api/v1/jsplugin/audiobook/api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapter.id)}/audio`;
    const params: string[] = [];
    if (token) params.push(`access_token=${encodeURIComponent(token)}`);
    if (seekSeconds > 0) params.push(`seek=${seekSeconds}`);
    const audioUrl = params.length > 0 ? `${serverHost}${audioPath}?${params.join('&')}` : `${serverHost}${audioPath}`;

    songloft.log.info(`[webhook] 🔊 pushChapterToMiot start book="${book.title}" ch="${chapter.title}" seek=${seekSeconds} aid=${accountId} did=${deviceId}`);

    // 确保文件可播放（可能触发转码）
    const playablePath = await ensurePlayablePath(chapter.fileRelPath);
    songloft.log.info(`[webhook] ▶ file ready: ${playablePath}`);

    // 构造请求体
    const body = JSON.stringify({
      account_id: accountId,
      device_id: deviceId,
      url: audioUrl,
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // 构建完整 URL（含协议前缀，避免 Go fetch 报错 "unsupported protocol scheme"）
    const fullUrl = await miotUrl('/mina/play-url');
    songloft.log.info(`[webhook] 📡 POST ${fullUrl}`);
    pushWebhookLog('voice', '口令推送音响', `url="${audioUrl}"`, null);

    const resp = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body,
    });

    songloft.log.info(`[webhook] 📨 status=${resp.status}`);
    const text = await resp.text();
    songloft.log.info(`[webhook] 📦 response(${text.length}): ${text.substring(0, 200)}`);

    let ok = false;
    if (resp.ok) {
      try {
        const json = JSON.parse(text);
        ok = !!json.success;
      } catch {
        ok = text.includes('success');
      }
    }

    songloft.log.info(`[webhook] ✅ pushed to miot: ${ok ? 'OK' : 'FAILED'} book="${book.title}" ch="${chapter.title}"`);

    if (ok) {
      bm.setProgress(book.id, chapter.id, seekSeconds, chapter.duration).catch(() => {});
    }

    return ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushWebhookLog('error', '推送音响失败', `book="${book?.title || '?'}" ch="${chapter?.title || '?'}" err=${msg}`, '❌');
    songloft.log.error(`[webhook] ❌ push failed: book="${book?.title || '?'}" ch="${chapter?.title || '?'}" err=${msg}`);
    return false;
  }
}

/** 解析目标设备（必须来自 webhook payload） */
async function resolveDeviceTarget(body: Record<string, unknown>): Promise<{ accountId: string; deviceId: string } | { reason: string }> {
  const accountId = body.account_id as string | undefined;
  const deviceId = body.device_id as string | undefined;
  if (!accountId || !deviceId) {
    return { reason: '请求体缺少 account_id / device_id，请由 miot-plus 自动传递（勿手动构造空 payload）' };
  }
  songloft.log.info(`[webhook] 🎯 target from payload: aid=${accountId} did=${deviceId}`);
  return { accountId, deviceId };
}

/** 执行有声书操作 */
async function executeAudiobookAction(
  bm: BookManager,
  intent: import('../services/intentParser').ParseResult,
  accountId: string,
  deviceId: string,
): Promise<boolean> {
  const bookTitle = intent.bookTitle;

  // ========== 必填字段校验 ==========
  if (!bookTitle) {
    pushWebhookLog('error', '参数缺失', `intent=${intent.intent} bookTitle 为空`, '❌');
    return false;
  }

  const book = findBookByTitle(bm, bookTitle);
  if (!book) {
    pushWebhookLog('error', '书籍不存在', `book="${bookTitle}"`, '❌');
    return false;
  }

  switch (intent.intent) {
    case 'PLAY_EPISODE': {
      // 精确指定章节：按书名 + 章节号匹配
      const chapterIndex = intent.chapterIndex!; // 1-based
      const chapters = bm.getBookById(book.id)?.chapters ?? [];
      if (chapters.length === 0) {
        pushWebhookLog('error', '执行失败', `"${book.title}" 无章节`, '❌');
        return false;
      }

      if (!chapterIndex || chapterIndex < 1) {
        pushWebhookLog('error', '章节号无效', `book="${bookTitle}" chapterIndex=${chapterIndex}`, '❌');
        return false;
      }

      const clampedIndex = Math.max(1, Math.min(chapterIndex, chapters.length));
      const chapter = chapters.find(c => c.index === clampedIndex);
      if (!chapter) {
        pushWebhookLog('error', '章节不存在', `book="${bookTitle}" chapterIndex=${chapterIndex}`, '❌');
        return false;
      }

      songloft.log.info(`[webhook] 🎵 PLAY_EPISODE "${book.title}" #${chapter.index} "${chapter.title}"`);
      return await pushChapterToMiot(bm, accountId, deviceId, book, chapter, 0);
    }

    case 'PLAY_BOOK': {
      // 播放书籍：从上次断点继续
      // 获取上次播放进度
      const recent = bm.getRecentlyPlayed();
      const lastRecent = recent.find(r => r.bookId === book.id);
      let seek = 0;

      if (lastRecent) {
        const progress = bm.getProgress(book.id, lastRecent.chapterId);
        seek = progress.position > 10 ? progress.position : 0; // 跳过已完成章节
        songloft.log.info(`[webhook] 📖 PLAY_BOOK "${book.title}" resume at ${seek}s from ch=${lastRecent.chapterId}`);
      } else {
        const detail = bm.getBookById(book.id);
        songloft.log.info(`[webhook] 📖 PLAY_BOOK "${book.title}" first time, ${detail?.chapters?.length || 0} chapters`);
        seek = 0;
      }

      // 从断点位置继续（或从头开始）
      if (lastRecent) {
        const targetChapter = bm.getChapter(book.id, lastRecent.chapterId);
        if (!targetChapter) {
          pushWebhookLog('error', '章节缺失', `book="${bookTitle}" chapterId=${lastRecent.chapterId}`, '❌');
          return false;
        }
        return await pushChapterToMiot(bm, accountId, deviceId, book, targetChapter, seek);
      } else {
        // 无历史，推第一章节
        const detail = bm.getBookById(book.id);
        const firstCh = detail?.chapters?.[0];
        if (!firstCh) {
          pushWebhookLog('error', '无可用章节', `book="${bookTitle}" 暂无章节`, '❌');
          return false;
        }
        return await pushChapterToMiot(bm, accountId, deviceId, book, firstCh, 0);
      }
    }

    case 'NEXT_EPISODE': {
      // 下一集：从最近播放继续推下一章节
      const recent = bm.getRecentlyPlayed();
      const lastRecent = recent[0];
      if (!lastRecent) {
        pushWebhookLog('error', '无播放历史', `无法继续（最近未播放）`, '❌');
        return false;
      }

      const detail = bm.getBookById(lastRecent.bookId);
      if (!detail) {
        pushWebhookLog('error', '书籍不存在', `recent bookId=${lastRecent.bookId}`, '❌');
        return false;
      }

      const currentChapter = detail.chapters.find(c => c.id === lastRecent.chapterId);
      if (!currentChapter) {
        pushWebhookLog('error', '当前章节缺失', `recent chapterId=${lastRecent.chapterId}`, '❌');
        return false;
      }

      const nextChapter = detail.chapters.find(c => c.index === currentChapter.index + 1);
      if (!nextChapter) {
        songloft.log.info(`[webhook] NEXT_EPISODE: already at end`);
        return false;
      }

      songloft.log.info(`[webhook] ➡️ NEXT_EPISODE "${detail.title}" #${currentChapter.index} → #${nextChapter.index}`);
      return await pushChapterToMiot(bm, accountId, deviceId, detail, nextChapter, 0);
    }

    case 'PREV_EPISODE': {
      // 上一集：回退到前一章节开头
      const recent = bm.getRecentlyPlayed();
      const lastRecent = recent[0];
      if (!lastRecent) {
        pushWebhookLog('error', '无播放历史', `无法回退（最近未播放）`, '❌');
        return false;
      }

      const detail = bm.getBookById(lastRecent.bookId);
      if (!detail) {
        pushWebhookLog('error', '书籍不存在', `recent bookId=${lastRecent.bookId}`, '❌');
        return false;
      }

      const currentChapter = detail.chapters.find(c => c.id === lastRecent.chapterId);
      if (!currentChapter) {
        pushWebhookLog('error', '当前章节缺失', `recent chapterId=${lastRecent.chapterId}`, '❌');
        return false;
      }

      const prevChapter = detail.chapters.find(c => c.index === currentChapter.index - 1);
      if (!prevChapter) {
        songloft.log.info(`[webhook] PREV_EPISODE: already at start`);
        return false;
      }

      songloft.log.info(`[webhook] ⬅️ PREV_EPISODE "${detail.title}" #${currentChapter.index} → #${prevChapter.index}`);
      return await pushChapterToMiot(bm, accountId, deviceId, detail, prevChapter, 0);
    }

    default:
      pushWebhookLog('error', '未知意图', `intent=${intent.intent}`, '❌');
      return false;
  }
}

/** 在 BookManager 缓存中通过标题子串匹配查找书籍 */
function findBookByTitle(bm: BookManager, title: string): ReturnType<BookManager['getBookById']> | null {
  const books = bm.list({ pageSize: 100 }).books;
  const lower = title.toLowerCase();

  // 精确匹配优先
  const exact = books.find(b => b.title.toLowerCase() === lower);
  if (exact) return bm.getBookById(exact.id);

  // 子串匹配（最长）
  let bestMatch: ReturnType<BookManager['getBookById']> | null = null;
  let bestLen = 0;
  for (const b of books) {
    if (b.title.toLowerCase().includes(lower)) {
      if (b.title.length > bestLen) {
        bestMatch = bm.getBookById(b.id);
        bestLen = b.title.length;
      }
    }
  }
  return bestMatch;
}
