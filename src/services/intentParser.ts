// 有声书插件 — 语音意图解析器
// 解析用户口语为结构化的有声书操作指令（PLAY_BOOK / PLAY_EPISODE / NEXT_EPISODE / PREV_EPISODE）

import type { Book } from '../types';

// ===== 关键词配置 =====

const PLAY_BOOK_KEYWORDS = ['播放有声书', '有声书'];
const EPISODE_PATTERN = /(?:第|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341百千万]+)(?:集|章|节|回)[^\d]*/;
const EPISODE_NUM_PATTERN = /第?(\d+)(?:集|章|节|回)/;
const CN_TO_ARABIC: Record<string, number> = {
 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
 十: 10, 百: 100, 千: 1000, 万: 10000,
};

const NEXT_EPISODE_KEYWORDS = ['下一集', '下一章', '下一段', '下一回', '换一节'];
const PREV_EPISODE_KEYWORDS = ['上一集', '上一章', '上一段', '上一回', '回上一集', '回上一章'];

// ===== 类型定义 =====

export interface ParseResult {
  /** 意图类型 */
  intent: string;
  /** 书籍标题（空串表示未知或后续章节操作） */
  bookTitle: string;
  /** 章节索引（从 1 开始）；relative > 0 表示当前章节偏移量 */
  chapterIndex: number | null;
  /** 相对偏移（next=1, prev=-1） */
  relativeOffset: number | null;
  /** 用于匹配的原始 query */
  rawQuery: string;
}

// ===== 工具函数 =====

/** 中文数字 → 阿拉伯数字 */
function chineseToNumber(chinese: string): number {
  if (/^\d+$/.test(chinese)) return parseInt(chinese, 10);
  let result = 0;
  let sum = 0;
  for (const ch of chinese) {
    const val = CN_TO_ARABIC[ch];
    if (val === undefined) break;
    if (val >= 10) {
      sum = result > 0 ? (sum || result) * val : val;
      result += sum;
      sum = 0;
    } else {
      sum = result > 0 ? result * val + sum : sum + val;
    }
  }
  return result + sum;
}

/** 从 argument 中提取「书名」——即去掉所有章节标识子串后的剩余部分 */
function extractBookTitle(argument: string): string {
  // 多次替换直到没有章节模式
  return argument.replace(/(?:^|\s*)(?:第?[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341百千万\d]+(?:集|章|节|回)\s*)+/g, '').trim()
    || argument.trim();
}

/** 从 argument 中解析具体章节号，返回从 1 开始的索引 */
function parseEpisodeIndex(argument: string): number | null {
  // 1) 精确匹配「第N集/章」
  const m = EPISODE_NUM_PATTERN.exec(argument);
  if (m) return chineseToNumber(m[1]);

  // 2) 匹配「第 + 中文数字 + 集/章」
  const mm = EPISODE_PATTERN.exec(argument);
  if (mm) {
    const inner = mm[0].replace(/^第/, '').replace(/(?:集|章|节|回)$/, '');
    const num = chineseToNumber(inner);
    if (num > 0 && num < 10000) return num;
  }

  return null;
}

/** 通过最长前缀包含匹配查询与命令列表 */
function matchKeyword(query: string, keywords: string[]): [string, string] | null {
  const lower = query.toLowerCase();
  let best: [string, string] | null = null;
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      if (!best || kw.length > best[1].length) {
        best = [kw, kw];
      }
    }
  }
  return best;
}

// ===== 主入口 =====

/**
 * 解析用户语音命令
 * @param query - 用户说的话（来自 ConversationMessage.response.answer[].question）
 * @returns 解析结果；如果未匹配到有声书意图则返回 null
 */
export function parseIntent(query: string): ParseResult | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Step 1: 判断是否为前后章节操作（相对操作不需要书名）
  for (const kw of NEXT_EPISODE_KEYWORDS) {
    if (trimmed.includes(kw)) {
      return { intent: 'NEXT_EPISODE', bookTitle: '', chapterIndex: null, relativeOffset: 1, rawQuery: trimmed };
    }
  }
  for (const kw of PREV_EPISODE_KEYWORDS) {
    if (trimmed.includes(kw)) {
      return { intent: 'PREV_EPISODE', bookTitle: '', chapterIndex: null, relativeOffset: -1, rawQuery: trimmed };
    }
  }

  // Step 2: 查找播放类关键词及其参数
  const bookMatch = matchKeyword(trimmed, PLAY_BOOK_KEYWORDS);
  if (!bookMatch) return null;

  const kw = bookMatch[0];
  const idx = trimmed.indexOf(kw) + kw.length;
  const argument = trimmed.slice(idx).trim();

  // Step 3: 尝试提取章节号
  const episodeIndex = parseEpisodeIndex(argument);

  // Step 4: 提取书名（去掉章节号后的剩余文本）
  const bookTitle = extractBookTitle(argument);

  // 如果没有书名也没有章节号，不算有效匹配
  if (!bookTitle && episodeIndex === null) return null;

  return {
    intent: episodeIndex ? 'PLAY_EPISODE' : 'PLAY_BOOK',
    bookTitle,
    chapterIndex: episodeIndex,
    relativeOffset: null,
    rawQuery: trimmed,
  };
}
