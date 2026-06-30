// 音频转码服务：将浏览器不支持的格式（如 WMA）转为 MP3
// 与交付方式解耦 — 只负责确保磁盘上有浏览器可播放的版本

import { safeId, getExt } from '../utils/helpers';

/** 浏览器 <audio> 标签不支持的格式 */
const INCOMPATIBLE_EXTS = new Set(['.wma']);

/** 缓存目录（相对于插件工作目录） */
export const CACHE_DIR = '.cache/transcode';

/** ffmpeg 可用性缓存 */
let _ffmpegOk: boolean | null = null;

// ==================== 公开 API ====================

/** 检查是否需要转码 */
export function needsTranscode(filePath: string): boolean {
  return INCOMPATIBLE_EXTS.has(getExt(filePath));
}

/**
 * 确保给定路径上的文件是浏览器可直接播放的格式。
 * - 已是兼容格式 → 原样返回
 * - 不兼容 → 转码为 MP3 并缓存，返回缓存路径
 * - ffmpeg 不可用 → 抛错
 */
export async function ensurePlayablePath(inputPath: string): Promise<string> {
  if (!needsTranscode(inputPath)) return inputPath;

  const cachePath = cacheKey(inputPath);
  const cached = await songloft.fs.exists(cachePath).catch(() => false);
  if (cached) return cachePath;

  await ensureFFmpeg();
  await songloft.fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});

  songloft.log.info(`[转码] ${inputPath} → ${cachePath}`);
  const r = await songloft.command.exec('ffmpeg', [
    '-y', '-i', inputPath,
    '-b:a', '128k',
    '-map', '0:a:0',
    '-f', 'mp3',
    cachePath,
  ], { timeout: 300000 });

  if (r.exitCode !== 0) {
    songloft.log.error(`[转码失败] ${inputPath}\n${r.stderr}`);
    // 清理可能的半成品
    await songloft.fs.unlink(cachePath).catch(() => {});
    throw new Error('音频转码失败');
  }

  songloft.log.info(`[转码完成] ${cachePath}`);
  return cachePath;
}

/** 检查路径是否已转码就绪（兼容格式或缓存已存在） */
export async function isCacheReady(inputPath: string): Promise<boolean> {
  if (!needsTranscode(inputPath)) return true;
  const cp = cacheKey(inputPath);
  return await songloft.fs.exists(cp).catch(() => false);
}

/** 获取缓存目录信息 */
export async function getCacheInfo(): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;
  try {
    const entries = (await songloft.fs.readdir(CACHE_DIR)) || [];
    for (const e of entries) {
      if (!e.isDir) {
        const st = await songloft.fs.stat(`${CACHE_DIR}/${e.name}`).catch(() => null);
        if (st) {
          fileCount++;
          totalSize += Number(st.size || 0);
        }
      }
    }
  } catch {
    // 目录不存在或无权限访问
  }
  return { fileCount, totalSize };
}

/** 清理缓存目录 */
export async function clearCache(): Promise<{ deletedCount: number }> {
  let deletedCount = 0;
  try {
    const entries = (await songloft.fs.readdir(CACHE_DIR)) || [];
    for (const e of entries) {
      if (!e.isDir) {
        await songloft.fs.unlink(`${CACHE_DIR}/${e.name}`).catch(() => {});
        deletedCount++;
      }
    }
  } catch {
    // ignore
  }
  return { deletedCount };
}

/** 用 ffprobe 获取音频精确时长（秒），不写文件缓存，结果由调用方持久化 */
export async function probeDuration(filePath: string): Promise<number> {
  await ensureFFmpeg();

  const r = await songloft.command.exec('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ], { timeout: 30000 });

  if (r.exitCode !== 0) {
    songloft.log.warn(`[probe失败] ${filePath}: ${r.stderr}`);
    return 0;
  }

  const duration = parseFloat((r.stdout || '').trim());
  if (!isFinite(duration) || duration <= 0) return 0;

  return Math.floor(duration);
}

/** 检测 ffmpeg 是否可用（结果缓存） */
export async function isFFmpegAvailable(): Promise<boolean> {
  await ensureFFmpeg();
  return _ffmpegOk === true;
}

// ==================== 内部 ====================

async function ensureFFmpeg(): Promise<void> {
  if (_ffmpegOk !== null) {
    if (!_ffmpegOk) throw new Error('ffmpeg 不可用，无法转码 WMA 文件。请安装 ffmpeg。');
    return;
  }
  try {
    const r = await songloft.command.exec('ffmpeg', ['-version'], { timeout: 10000 });
    _ffmpegOk = r.exitCode === 0 && r.stdout.includes('ffmpeg');
  } catch {
    _ffmpegOk = false;
  }
  if (!_ffmpegOk) {
    throw new Error('ffmpeg 不可用，无法转码 WMA 文件。请安装 ffmpeg。');
  }
}

/** 根据输入路径生成缓存文件名 */
function cacheKey(inputPath: string): string {
  // 去掉原扩展名，拼上 .mp3，放入缓存目录
  const base = inputPath.replace(/\.wma$/i, '');
  return `${CACHE_DIR}/${safeId(base)}.mp3`;
}
