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
}

/** 设置 */
export interface PluginSettings {
  libraryPath: string;
  favorites: string[];
  recentlyPlayed: { bookId: string; chapterId: string; at: number }[];
}
