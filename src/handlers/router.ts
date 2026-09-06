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
    case 'STOP': return 'voice';
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
      pushWebhookLog('config', '------------------------------------', null, null);
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

      pushWebhookLog('voice',
        intent.intent === 'PLAY_EPISODE' ? '播放章节' :
        (intent.intent === 'PLAY_BOOK' ? '播放书籍' :
        (intent.intent === 'NEXT_EPISODE' ? '下一集' :
        (intent.intent === 'PREV_EPISODE' ? '上一集' :
        (intent.intent === 'STOP' ? '停止播放' : '未知')))), `msg="${query}"`, '✅');
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

  // POST /api/session/update —— 前端手动推送成功后更新设备会话
  router.post('/api/session/update', async (req: HTTPRequest) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : {};
      const accountId = body.accountId as string;
      if (!accountId) {
        return jsonResponse({ success: false, error: 'missing accountId' }, 400);
      }
      updateDeviceSession(
        accountId,
        body.deviceId as string || '',
        body.bookId as string || '',
        body.chapterId as string || '',
        Number(body.chapterIndex) || 0,
        body.bookTitle as string || '',
      );
      return jsonResponse({ success: true });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message || String(e) });
    }
  });
}

// ================================================================
// 辅助函数：Webhook 执行逻辑
// ================================================================

/** 设备会话缓存（按 device_id 分组，支持同一账号多设备独立播放） */
const deviceSessions: Record<string, import('../types').DeviceSession> = {};

/** ========== 自动下一集配置 ========== */
const AUTO_NEXT_POS_END_THRESHOLD = 0;   // 位置判定：position >= totalDur - N 秒视为结束（与前端一致）
const AUTO_NEXT_TIME_TOLERANCE = 1;     // 时间兜底：elapsed >= dur + N 秒触发切换
/** ================================ */

/** 自动下一集轮询定时器（按 deviceId 隔离） */
const autoNextTimers: Record<string, ReturnType<typeof setInterval>> = {};
const autoNextState: Record<string, { accountId: string; bookId: string; chapterId: string; chapterIndex: number; bookTitle: string }> = {};
/** 每集推送的时间戳（按 bookId+deviceId 隔离，用于时间兜底判定） */
const autoNextPushedAt: Record<string, number> = {};

/** 更新设备会话 */
function updateDeviceSession(
  accountId: string,
  deviceId: string,
  bookId: string,
  chapterId: string,
  chapterIndex: number,
  bookTitle: string,
) {
  deviceSessions[deviceId] = {
    deviceId,
    bookId,
    chapterId,
    chapterIndex,
    bookTitle,
    updatedAt: Date.now(),
  };
  songloft.log.info(`[webhook] 📱 session updated: did=${deviceId} book="${bookTitle}" ch#${chapterIndex}`);
}

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

    // 校验文件确实存在且非空
    const stat = await songloft.fs.stat(playablePath).catch(() => null);
    if (!stat || !Number(stat.size) || Number(stat.size) < 100) {
      pushWebhookLog('error', '推送准备', `文件不可用: ${playablePath} (size=${stat?.size ?? 'N/A'})`, '❌');
      songloft.log.error(`[webhook] ❌ playable file missing or empty: ${playablePath}`);
      return false;
    }

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
      // 获取真实时长：优先已有的进度 duration，否则 probe
      let realDur = chapter.duration ?? 0;
      try {
        const playablePath = await ensurePlayablePath(chapter.fileRelPath);
        realDur = await probeDuration(playablePath);
        if (realDur > 0) {
          songloft.log.info(`[push] probed dur=${realDur}s for "${book.title}" #${chapter.index}`);
        } else {
          songloft.log.warn(`[push] probe returned 0, using cached: ${realDur}s`);
          realDur = chapter.duration ?? 0;
        }
      } catch (e) {
        songloft.log.warn(`[push] probe failed: ${String(e)}, using cached`);
        realDur = chapter.duration ?? 0;
      }
      bm.setProgress(book.id, chapter.id, seekSeconds, realDur).catch(() => {});

      // 记录设备会话，供 NEXT/PREV 口令使用
      const chapterIdx = typeof chapter.index === 'number' ? chapter.index : 0;
      updateDeviceSession(accountId, deviceId, book.id, chapter.id, chapterIdx, book.title);

      // 记录推送时间戳（用于计时判定自动下一集）
      autoNextPushedAt[book.id + '_' + deviceId] = Date.now();

      // 更新最近播放列表（供下次未指定集数时断点续播使用）
      await bm.addRecentlyPlayed(book.id, chapter.id).catch(() => {});

      // 启动自动下一集（不阻塞返回）
      getAuthToken()
        .then(token => startAutoNext(bm, accountId, deviceId, book, chapter, token))
        .catch(() => {});
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

  // ========== 必填字段校验（仅 PLAY/PLAY_BOOK 需要 bookTitle） ==========
  if (!bookTitle && intent.intent !== 'NEXT_EPISODE' && intent.intent !== 'PREV_EPISODE' && intent.intent !== 'STOP') {
    pushWebhookLog('error', '参数缺失', `intent=${intent.intent} bookTitle 为空`, '❌');
    return false;
  }

  let book: ReturnType<BookManager['getBookById']> | null = null;
  if (bookTitle) {
    book = findBookByTitle(bm, bookTitle);
    if (!book) {
      pushWebhookLog('error', '书籍不存在', `book="${bookTitle}"`, '❌');
      return false;
    }
  }

  switch (intent.intent) {
    case 'STOP': {
      // 停止播放：取消自动下一集轮询 + 保存当前进度 + 记录最近播放
      songloft.log.info(`[webhook] STOP playback on device ${deviceId}`);

      // 获取当前播放上下文（设备会话或自动轮询状态）
      const session = deviceSessions[deviceId];
      if (session) {
        const book = bm.getBookById(session.bookId);
        if (book) {
          // 查询 miMusic 获取当前进度
          let currentPosition = 0;
          try {
            const url = await miotUrl(`/mina/status?account_id=${accountId}&device_id=${deviceId}`);
            const resp = await fetch(url, {
              headers: { 'Content-Type': 'application/json' }
            });
            if (resp.ok) {
              const json = await resp.json();
              if (json.success && json.data) {
                currentPosition = json.data.position ?? 0;
              }
            }
          } catch { /* ignore */ }

          // 保存章节进度（position 用于断点续播）
          const chapter = book.chapters.find(c => c.id === session.chapterId);
          if (chapter) {
            bm.setProgress(book.id, session.chapterId, currentPosition, chapter.duration).catch(() => {});
            songloft.log.info(`[webhook] STOP saved progress: "${book.title}" #${session.chapterIndex} "${chapter.title}" pos=${currentPosition}s`);
            pushWebhookLog('voice', `停止播放并保存进度`, `${book.title} #${session.chapterIndex} pos=${currentPosition.toFixed(0)}s/${chapter.duration}s`, null);
          }

          // 更新最近播放列表（供下次未指定集数时断点续播使用）
          await bm.addRecentlyPlayed(book.id, session.chapterId);
          songloft.log.info(`[webhook] stopped book "${book.title}" #${session.chapterIndex}, updated recentlyPlayed`);
        }
      } else {
        pushWebhookLog('voice', '停止播放', `msg="${intent.rawQuery}"`, null);
      }

      stopAutoNext(deviceId);
      return true;
    }

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
      // 下一集：从设备会话缓存中获取当前播放的书籍和章节
      const session = deviceSessions[deviceId];
      if (!session) {
        pushWebhookLog('error', '无会话', '尚未推送过有声书，请先播放某本书', '❌');
        return false;
      }
      const detail = bm.getBookById(session.bookId);
      if (!detail) {
        pushWebhookLog('error', '书籍不存在', `bookId=${session.bookId}`, '❌');
        return false;
      }
      const currentChapter = detail.chapters.find(c => c.id === session.chapterId);
      if (!currentChapter) {
        pushWebhookLog('error', '当前章节缺失', `chapterId=${session.chapterId}`, '❌');
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
      // 上一集：从设备会话缓存中获取当前播放的书籍和章节，回退到前一章开头
      const session = deviceSessions[deviceId];
      if (!session) {
        pushWebhookLog('error', '无会话', '尚未推送过有声书，请先播放某本书', '❌');
        return false;
      }
      const detail = bm.getBookById(session.bookId);
      if (!detail) {
        pushWebhookLog('error', '书籍不存在', `bookId=${session.bookId}`, '❌');
        return false;
      }
      const currentChapter = detail.chapters.find(c => c.id === session.chapterId);
      if (!currentChapter) {
        pushWebhookLog('error', '当前章节缺失', `chapterId=${session.chapterId}`, '❌');
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

/** 停止指定设备的自动下一集轮询 */
function stopAutoNext(deviceId: string): void {
  if (autoNextTimers[deviceId]) {
    clearInterval(autoNextTimers[deviceId]);
    delete autoNextTimers[deviceId];
  }
  delete autoNextState[deviceId];
  delete autoNextPushedAt[deviceId];
}

/** 启动自动下一集轮询 */
async function startAutoNext(
  bm: BookManager,
  accountId: string,
  deviceId: string,
  book: ReturnType<BookManager['getBookById']>,
  chapter: import('../types').Chapter,
  token: string,
): Promise<void> {
  // 清除旧的轮询
  stopAutoNext(deviceId);

  const chapterIdx = typeof chapter.index === 'number' ? chapter.index : 0;
  autoNextState[deviceId] = { accountId, bookId: book.id, chapterId: chapter.id, chapterIndex: chapterIdx, bookTitle: book.title };

  // ========== 获取真实时长：先用已有的，没有则 ffprobe 精确探测 ==========
  let totalDur = (bm.getProgress(book.id, chapter.id)?.duration) ?? 0;
  if (!totalDur || totalDur <= 0) {
    try {
      const playablePath = await ensurePlayablePath(chapter.fileRelPath);
      totalDur = await probeDuration(playablePath);
      if (totalDur > 0) {
        bm.setProgress(book.id, chapter.id, 0, totalDur).catch(() => {});
        songloft.log.info(`[auto-next] probed duration ${totalDur}s for "${book.title}" #${chapterIdx}`);
        pushWebhookLog('speaker', '自动下一集已开启', `${book.title} ${chapter.title} dur=${totalDur}s → 等待播放结束`, null);
      } else {
        songloft.log.warn(`[auto-next] probe failed (${playablePath}), using cached duration`);
        totalDur = chapter.duration ?? 0;
        pushWebhookLog('speaker', '自动下一集已开启', `${book.title} ${chapter.title} (dur未知) → 等待播放结束`, null);
      }
    } catch (e) {
      songloft.log.warn(`[auto-next] probe error: ${String(e)}, using cached duration`);
      totalDur = chapter.duration ?? 0;
      pushWebhookLog('speaker', '自动下一集已开启', `${book.title} ${chapter.title} (dur未知) → 等待播放结束`, null);
    }
  } else {
    pushWebhookLog('speaker', '自动下一集已开启', `${book.title} ${chapter.title} dur=${totalDur}s → 等待播放结束`, null);
  }

  if (!totalDur || totalDur <= 0) {
    songloft.log.error(`[auto-next] no duration available for "${book.title}" #${chapterIdx}, aborting auto-next`);
    return;
  }

  // 短等待给底层缓存刷新时间（3秒即可）
  await new Promise((resolve) => setTimeout(resolve, 3000));
  // 检查是否已被取消（会话已变更）
  if (!autoNextState[deviceId]) return;

  // 记录本集推送时间戳（用于计时判定兜底）
  autoNextPushedAt[book.id + '_' + deviceId] = Date.now();

  pushWebhookLog('speaker', '自动下一集轮询已启动', `${book.title} ${chapter.title}`, null);

  const poll = setInterval(async () => {
    if (!autoNextState[deviceId]) {
      clearInterval(poll);
      delete autoNextTimers[deviceId];
      return;
    }

    const state = autoNextState[deviceId];

    try {
      // 获取章节总时长（优先 probe 真值，其次缓存）
      let totalDur = (bm.getProgress(state.bookId, state.chapterId)?.duration) ?? 0;

      // 如果缓存时长为 0 或明显不合理（比如小于 15s），尝试实时 probe 修正
      if ((!totalDur || totalDur <= 0)) {
        const detail = bm.getBookById(state.bookId);
        const ch = detail?.chapters.find(c => c.id === state.chapterId);
        if (ch) {
          try {
            const playablePath = await ensurePlayablePath(ch.fileRelPath);
            totalDur = await probeDuration(playablePath);
            if (totalDur > 0) {
              bm.setProgress(state.bookId, state.chapterId, 0, totalDur).catch(() => {});
              songloft.log.info(`[auto-next] late-probed dur=${totalDur}s for "${state.bookTitle}" #${state.chapterIndex}`);
            }
          } catch { /* ignore */ }
        }
        if (!totalDur || totalDur <= 0) return;
      }

      // ---------- /mina/status 获取当前播放进度 position → 判定是否播完 ----------
      let timedOut = false;
      try {
        const url = await miotUrl(`/mina/status?account_id=${state.accountId}&device_id=${deviceId}`);
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        headers['Content-Type'] = 'application/json';
        const resp = await fetch(url, { headers });
        if (!resp.ok) return;

        const json = await resp.json();
        if (!json.success || !json.data) return;

        const data = json.data;
        const position = data.position ?? 0;       // 当前播放到的秒数
        const isPlaying = data.is_playing ?? (data.state === 'playing');

        // ========== 判1：/mina/status 返回的位置状态（优先） ==========
        // 未播放中 + 位置接近结尾，或设备进入 idle 态
        let posEnded = !isPlaying && (position >= totalDur - AUTO_NEXT_POS_END_THRESHOLD || data.state === 'idle');
        if (posEnded) {
          songloft.log.info(`[auto-next] pos-based: pos=${position}/${totalDur}s played=${isPlaying} idle=${data.state === 'idle'} -> advance`);
          pushWebhookLog('speaker', `检测到章节结束 (pos=${position.toFixed(0)}s/${totalDur}s)，推送下一章`, `${state.bookTitle} #${state.chapterIndex}`, null);
          // 位置判定已触发，不再进入时间兜底
          // fall through to execute
        } else {
          console.log(`[auto-next] status: pos=${position}/${totalDur}s played=${isPlaying} idle=${data.state === 'idle'}`);

          // ========== 判2：时间兜底（防止 miMusic 一直返回 playing 不更新状态） ==========
          const pushedAt = autoNextPushedAt[state.bookId + '_' + deviceId];
          if (pushedAt) {
            const elapsedSec = (Date.now() - pushedAt) / 1000;
            const threshold = totalDur + AUTO_NEXT_TIME_TOLERANCE; // 总时长 + 缓冲秒数
            if (elapsedSec >= threshold) {
              timedOut = true;
              songloft.log.info(`[auto-next] timer-based: elapsed=${elapsedSec.toFixed(0)}s dur=${totalDur}s -> advance`);
              pushWebhookLog('speaker', `计时判定章节结束 (${elapsedSec.toFixed(0)}s/${threshold.toFixed(0)}s)，推送下一章`, `${state.bookTitle} #${state.chapterIndex}`, null);
            }
          }
        }

        // 任一判定触发 → 切换下一章
        if (!posEnded && !timedOut) return; // 还未到切换时机

        if (posEnded) {
          songloft.log.info(`[auto-next] pos-triggered -> next chapter`);
        } else {
          songloft.log.info(`[auto-next] timer-triggered -> next chapter`);
        }

        const detail = bm.getBookById(state.bookId);
        if (detail) {
          const curCh = detail.chapters.find(c => c.id === state.chapterId);
          if (curCh) {
            const nextIdx = curCh.index + 1;
            if (nextIdx < detail.chapters.length) {
              const nextCh = detail.chapters.find(c => c.index === nextIdx);
              if (nextCh) {
                songloft.log.info(`[auto-next] -> "${detail.title}" #${curCh.index} -> #${nextIdx}`);
                const pushOk = await pushChapterToMiot(bm, accountId, deviceId, detail, nextCh, 0);
                updateDeviceSession(accountId, deviceId, detail.id, nextCh.id, nextIdx, detail.title);
                autoNextState[deviceId] = { accountId, bookId: detail.id, chapterId: nextCh.id, chapterIndex: nextIdx, bookTitle: detail.title };
                if (pushOk) {
                  pushWebhookLog('speaker', '自动下一章推送成功', `${detail.title} ${nextCh.title}`, '✅');
                }
              }
            } else {
              pushWebhookLog('speaker', '自动下一集已结束', `${detail.title} 已达最后一集`, null);
              songloft.log.info('[auto-next] reached last chapter');
              stopAutoNext(deviceId);
            }
          }
        }
      } catch { /* ignore */ }
    } catch {
      // 网络错误静默忽略
    }
  }, 3000);

  autoNextTimers[deviceId] = poll as any;
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
