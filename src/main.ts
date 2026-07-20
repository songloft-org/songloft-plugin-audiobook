/// <reference types="@songloft/plugin-sdk" />
import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { BookManager } from './services/bookManager';
import { registerHandlers } from './handlers/router';
import { isFFmpegAvailable } from './services/transcoder';
import { PLUGIN_VERSION } from './generated/version';

const router = createRouter();
let bookManager: BookManager | null = null;

async function onInit(): Promise<void> {
  songloft.log.info('有声书插件：初始化中...');

  // 检测 ffmpeg 可用性（异步，不阻塞初始化）
  isFFmpegAvailable().then((ok) => {
    if (ok) {
      songloft.log.info('有声书插件：ffmpeg 可用，支持 WMA 转码');
    } else {
      songloft.log.warn('有声书插件：ffmpeg 不可用，WMA 格式将无法播放');
    }
  }).catch(() => {});

  bookManager = new BookManager(PLUGIN_VERSION);
  await bookManager.init();
  registerHandlers(router, bookManager);
  songloft.log.info('有声书插件：初始化完成');
}

async function onDeinit(): Promise<void> {
  songloft.log.info('有声书插件：已停止');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  if (!bookManager) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ success: false, error: '插件尚未初始化完成' }),
    };
  }
  try {
    const resp = await router.handle(req);
    if (!resp || typeof resp !== 'object') {
      songloft.log.error(`onHTTPRequest: handler 返回非对象: ${typeof resp}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ success: false, error: 'handler 返回无效响应' }),
      };
    }
    return resp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    songloft.log.error(`onHTTPRequest: ${msg}${stack ? '\n' + stack : ''}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ success: false, error: msg }),
    };
  }
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
