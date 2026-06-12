# Songloft 有声书插件

本插件为 Songloft 提供了本地有声书资源管理与播放能力，支持扫描本地有声书目录，提供分类展示、搜索、章节播放、播放进度记忆与收藏功能。

## 核心特性

- **本地目录扫描**：自动扫描 `/app/audiobook/<书名>/` 目录结构，构建书籍与章节索引，支持递归子目录（最深 6 层）与索引缓存加速启动。
- **章节播放**：支持章节切歌与断点续播，自动记忆每个章节的播放进度。
- **音频传输**：通过宿主 Go 层 `http.ServeFile` 直传音频文件，支持 Range/206 流式播放，无文件大小限制。
- **WMA 自动转码**：WMA 文件通过 ffmpeg 自动转码为 MP3（128kbps），转码结果缓存到 `.cache/transcode/`。
- **收藏管理**：支持收藏书籍，可在列表页快速筛选已收藏内容。
- **最近播放**：自动记录最近播放的书籍与章节（最多 30 条），方便快速续听。
- **书籍信息编辑**：支持编辑书籍描述、分类、标签、作者信息，以及上传自定义封面。
- **睡眠定时器**：支持按时间或按章节数两种模式自动停止播放。
- **播放速度控制**：支持 0.75x 到 2.0x 倍速播放。
- **前端界面**：内置 Material 3 风格 SPA 界面，支持搜索、分类筛选与排序。

## 开发与构建

基于 `songloft-plugin-sdk` 和 TypeScript 构建，运行在 QuickJS 沙盒中。

```bash
# 安装依赖
npm install

# 构建生产环境插件包 (产物位于 dist/audiobook.jsplugin.zip)
npm run build

# 验证插件包完整性
npm run validate
```

构建流程：esbuild 打包 TypeScript → QuickJS 字节码（`.jsc`）+ 静态资源 → zip 压缩为 `.jsplugin.zip`。

## 目录结构

```
<libraryPath>/
  <书名>/
    <章节>.mp3          # 音频文件（支持 mp3/flac/m4a/ogg/wma/wav）
    cover.jpg           # 封面图片（可选，支持 cover.*/folder.*/封面.*）
    metadata.json       # 元数据（可选，含 author/category/tags/description）
    <章节>.mp3          # 更多章节...
  <另一本书>/
    ...
```

- 根目录散落的音频文件会自动归入"未分类"分类
- 封面识别优先级：`cover.*` > `folder.*` > `封面.*` > 目录内任意图片

## API 端点

所有 API 响应格式：`{ success: boolean, data?: ..., error?: string }`。宿主自动拼接路由前缀 `/api/v1/jsplugin/audiobook/`。

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/books` | GET | 书籍列表（分页、搜索、分类、排序、收藏过滤） |
| `/api/books/:id` | GET | 书籍详情（含章节列表和各章节播放进度） |
| `/api/books/:id/favorite` | GET/POST | 收藏状态查询/切换 |
| `/api/books/:id/metadata` | GET/PUT | 书籍元数据查询/更新 |
| `/api/books/:id/cover` | POST | 上传封面图片（base64） |
| `/api/books/:id/chapters/:chapterId/progress` | GET/POST | 播放进度查询/保存 |
| `/api/books/:id/chapters/:chapterId/audio` | GET | 音频文件（支持 Range 请求，WMA 自动转码） |
| `/api/books/:id/chapters/:chapterId/preload` | GET | 预转码触发/状态检查 |
| `/api/categories` | GET | 分类与标签列表 |
| `/api/snapshot` | GET | 整体状态快照（含设置） |
| `/api/recently-played` | GET | 最近播放记录（最多 20 条） |
| `/api/rescan` | POST | 触发重新扫描 |

## 持久化键

通过 `songloft.storage` 持久化：

- `audiobook_library_v1`：扫描索引缓存（ScannerState，定义在 scanner.ts）
- `audiobook_settings_v1`：插件设置（收藏列表、最近播放记录）
- `audiobook_progress_v1`：播放进度（`<bookId>::<chapterId>` → `{ position, duration, updatedAt }`）

## 限制说明

- **时长估算**：章节时长按 128kbps 码率从文件大小估算（`bytes / 16000`），非精确值。
- **WMA 转码依赖 ffmpeg**：需宿主环境安装 ffmpeg，否则 WMA 文件无法播放。
- **沙盒限制**：运行在 QuickJS 沙盒中，只能通过 `songloft.*` API 访问宿主能力。

## License

Apache-2.0
