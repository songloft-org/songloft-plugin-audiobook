/// <reference types="@songloft/plugin-sdk" />
import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { BookManager } from './services/bookManager';
import { registerHandlers } from './handlers/router';

const router = createRouter();
let bookManager: BookManager | null = null;

async function onInit(): Promise<void> {
  songloft.log.info('有声书插件：初始化中...');
  bookManager = new BookManager();
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
