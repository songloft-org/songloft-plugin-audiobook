# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

有声书插件（`songloft-plugin-audiobook`）——Songloft JS 插件，提供本地有声书资源管理、章节播放、播放进度与收藏功能。运行在 QuickJS 沙盒中，通过 `@songloft/plugin-sdk` 与宿主通信，前端为 Vanilla JS SPA（无框架）。

## 常用命令

```bash
npm install          # 安装依赖
npm run build        # 构建产物 dist/audiobook.jsplugin.zip（名称由 plugin.json entryPath 决定）
npm run validate     # 验证 plugin.json 中的 hash
```

构建使用 esbuild 打包 + zip 压缩，由 `@songloft/plugin-builder` CLI 完成。中间产物为 QuickJS 字节码（`.jsc`）。

## 架构

### 插件入口（src/main.ts）

注册 3 个全局函数：`onInit` / `onDeinit` / `onHTTPRequest`。宿主启动时调用 `onInit`（异步检查 ffmpeg 可用性，非阻塞）创建 `BookManager` 实例、注册所有路由；HTTP 请求到达时调用 `onHTTPRequest` 分配到 router。未初始化完成时返回 503。

### 模块职责

| 目录/文件 | 职责 |
|-----------|------|
| `src/services/bookManager.ts` | 核心管理器：内存索引 + `songloft.storage` 持久化，封装扫描、查询、收藏、播放进度、设置、元数据编辑、封面上传 |
| `src/services/scanner.ts` | 本地文件扫描器：扫描 `/app/audiobook/<书名>/` 目录结构，支持递归子目录（最深 6 层），构建索引，支持缓存 |
| `src/services/transcoder.ts` | 音频转码器：WMA→MP3（ffmpeg，128kbps），转码缓存到 `.cache/transcode/`，仅在需要时触发 |
| `src/handlers/router.ts` | HTTP 路由注册：使用 SDK 的 `createRouter()`，注册所有 `/api/*` 端点 |
| `src/types.ts` | 核心类型：Book、Chapter、BookDetail、ChapterProgress、BookMetadata、PluginSettings |
| `src/utils/helpers.ts` | 工具函数：query 解析、JSON 响应、自然排序、文件类型判断、时长估算、hash 等 |
| `static/` | 前端 SPA：`index.html` + 多模块 JS（`app.js` 入口/`api.js`/`state.js`/`utils.js`/`views/`）+ `css/style.css`，通过相对路径 `./api/*` 调用 API |

### 插件 API 端点

所有 API 响应格式：`{ success: boolean, data?: ..., error?: string }`。宿主自动拼接路由前缀 `/api/v1/jsplugin/audiobook/`。

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/books` | GET | 书籍列表（分页、搜索、分类、排序、收藏过滤） |
| `/api/categories` | GET | 分类与标签列表 |
| `/api/snapshot` | GET | 整体状态快照（含设置） |
| `/api/recently-played` | GET | 最近播放记录（最多 20 条，含书名/章节名） |
| `/api/rescan` | POST | 触发重新扫描 |
| `/api/books/:id` | GET | 书籍详情（含章节列表和各章节播放进度） |
| `/api/books/:id/favorite` | GET/POST | 收藏状态查询/切换 |
| `/api/books/:id/metadata` | GET/PUT | 书籍元数据查询/更新（描述、分类、标签、作者） |
| `/api/books/:id/cover` | POST | 上传封面图片（base64） |
| `/api/books/:id/chapters/:chapterId/progress` | GET/POST | 播放进度查询/保存（position/duration，秒） |
| `/api/books/:id/chapters/:chapterId/audio` | GET | 音频文件（通过 `serveFile` 由宿主 Go 层提供，支持 Range 请求；WMA 自动转码） |
| `/api/books/:id/chapters/:chapterId/preload` | GET | 预转码触发/状态检查 |

### 数据流

```
本地文件系统 (/app/audiobook/)
  → Scanner (songloft.fs.readdir + stat) 递归扫描目录结构（最深 6 层）
  → BookManager 内存索引 (books[] + chaptersByBookId)
  → Router 提供 HTTP API
  → 前端 Vanilla JS SPA fetch 调用 API
  → 音频通过 serveFile (Go 层 http.ServeFile) 直传，支持 Range 请求
```

### 持久化键

- `audiobook_library_v1`：扫描索引缓存（完整 ScannerState，定义在 scanner.ts）
- `audiobook_settings_v1`：插件设置（favorites、recentlyPlayed）
- `audiobook_progress_v1`：播放进度（`{ "<bookId>::<chapterId>": { position, duration, updatedAt } }`）

## 核心约束

1. **QuickJS 沙盒**：只能通过 `songloft.*` 全局 API（`songloft.fs.readdir/stat/readFile`、`songloft.storage.get/set`、`songloft.log.*`）访问宿主
2. **音频传输**：通过 `serveFile` 返回 `{ serveFile: { filePath } }`，由宿主 Go 层执行 `http.ServeFile`（支持 Range/206）；WMA 文件自动转码为 MP3 后再 serve
3. **目录约定**：有声书放在 `/app/audiobook/<书名>/<章节.mp3>`（`plugin.json` 中 `externalPaths: ["/app/audiobook"]`），支持递归子目录（最深 6 层），根目录散落音频归入"未分类"
4. **章节排序**：自然排序（natural compare），正确处理 "第2集" < "第10集"
5. **封面识别**：优先匹配 `cover.*` / `folder.*` / `封面.*`，未命中取第一个图片文件
6. **时长估算**：按 128kbps 码率（`bytes / 16000`），非精确时长
7. **章节 ID 规则**：`<bookSafeId>-ch<3位序号>`（如 `三体-ch001`），未分类用 `misc-audio-ch<3位序号>`
8. **TypeScript 配置**：`strict: false`，`noImplicitAny: false`，target ES2020，module ESNext + Bundler 解析
9. **类型声明**：`@songloft/plugin-sdk` 提供 `songloft` 全局类型（含 `HTTPRequest`/`HTTPResponse`），`songloft.fs` 需手动 declare

## 插件清单

`plugin.json` 关键字段：
- `entryPath: "audiobook"` — 决定宿主路由前缀 `/api/v1/jsplugin/audiobook/`
- `externalPaths: ["/app/audiobook"]` — 声明插件可访问的宿主文件系统路径
- `permissions: ["storage", "fs", "fs:music", "fs:external", "command"]` — 声明所需权限（fs 为宿主文件系统访问，command 用于 ffmpeg 转码）
- `main` / `entryHash` / `zipHash` — 由 `songloft-plugin build` 自动填充

## Git 提交约定

遵循 Conventional Commits 格式：`type(scope): description`。**禁止**添加 `Co-Authored-By` 尾部标记。
