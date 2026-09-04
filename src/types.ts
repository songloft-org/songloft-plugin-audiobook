// 有声书插件 — 核心类型定义

/// <reference types="@songloft/plugin-sdk" />

/** 章节 */
export interface Chapter {
  id: string;
  index: number;
  title: string;
  duration: number;
  fileSize: number;
  fileRelPath: string;
  modTime: number;
}

/** 书籍 */
export interface Book {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  coverRatio: string;
  description: string;
  category: string;
  tags: string[];
  updatedAt: number;
  chapterCount: number;
  totalSize: number;
  folderRelPath: string;
}

/** 书籍详情（含章节列表） */
export interface BookDetail extends Book {
  chapters: Chapter[];
  isFavorite?: boolean;
}

/** 播放进度 */
export interface ChapterProgress {
  position: number;
  duration: number;
  updatedAt: number;
  completed?: boolean;
}

/** 书籍元数据（对应 metadata.json） */
export interface BookMetadata {
  description?: string;
  category?: string;
  tags?: string[];
  author?: string;
  coverRatio?: string;
}

/** 设置 */
export interface PluginSettings {
  favorites: string[];
  recentlyPlayed: { bookId: string; chapterId: string; at: number }[];
  /** Webhook 回调接收开关（来自 miot-plus 语音命令） */
  webhookEnabled?: boolean;
  /** Webhook 认证 token（自动生成的随机字符串） */
  webhookToken?: string;
  /** Webhook 服务器地址（推送音响时使用，如 http://192.168.x.x:58091） */
  serverHost?: string;
}

/** 设备会话（每设备独立，记录当前正在播放的有声书上下文） */
export interface DeviceSession {
  /** 设备 ID（miot-plus account_id） */
  deviceId: string;
  /** 当前播放的书籍 id */
  bookId: string;
  /** 当前播放的章节 id */
  chapterId: string;
  /** 章节号（1-based，用于日志展示） */
  chapterIndex: number;
  /** 书籍标题（用于日志展示） */
  bookTitle: string;
  /** 更新时间戳 */
  updatedAt: number;
}
