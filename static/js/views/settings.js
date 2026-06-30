import { api } from '../api.js';
import { state, switchView } from '../state.js';
import { formatFileSize, showToast } from '../utils.js';

export function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  loadCacheInfo();
}

export function closeSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.hidden = true;
}

async function loadCacheInfo() {
  const el = document.getElementById('settingsCacheInfo');
  if (!el) return;
  el.textContent = '加载中...';
  try {
    const data = await api('/api/cache/info');
    if (data.fileCount > 0) {
      el.textContent = `${data.fileCount} 个文件 · ${formatFileSize(data.totalSize)}`;
    } else {
      el.textContent = '无缓存数据';
    }
  } catch (e) {
    el.textContent = '加载失败: ' + e.message;
  }
}

export async function cleanCache() {
  const btn = document.getElementById('btnCleanCache');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '清理中...';
  try {
    const result = await api('/api/cache/clean', { method: 'POST' });
    showToast(`已清理 ${result.deletedCount} 个缓存文件`);
    loadCacheInfo();
  } catch (e) {
    showToast('清理失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🗑️ 清理缓存';
  }
}
