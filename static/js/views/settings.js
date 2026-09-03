import { api } from '../api.js';
import { state, switchView } from '../state.js';
import { formatFileSize, showToast } from '../utils.js';

export function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  loadCacheInfo();
  loadVersion();
  loadWebhookConfig();
}

async function loadVersion() {
  const el = document.getElementById('settingsVersion');
  if (!el) return;
  try {
    const data = await api('/api/snapshot');
    el.textContent = data.version || '-';
  } catch {
    el.textContent = '-';
  }
}

// ============================================================
// Webhook 设置
// ============================================================

let _webhookEnabled = false;
let _webhookToken = '';

/** 获取完整的 Webhook 外部地址（含 token） */
function getFullWebhookUrl() {
  const path = '/api/v1/jsplugin/audiobook/api/webhook/said';
  const token = _webhookToken ? '?token=' + encodeURIComponent(_webhookToken) : '';
  return `${window.location.origin}${path}${token}`;
}

async function loadWebhookConfig() {
  const statusEl = document.getElementById('webhookStatus');
  const toggleEl = document.getElementById('webhookToggle');
  const urlEl = document.getElementById('webhookUrl');
  const tokenEl = document.getElementById('webhookToken');
  if (!statusEl || !toggleEl) return;

  try {
    const data = await api('/api/webhook/config');
    _webhookEnabled = !!data.enabled;
    _webhookToken = data.token || '';
    toggleEl.checked = _webhookEnabled;
    statusEl.textContent = _webhookEnabled ? '已启用' : '已关闭';
    urlEl.textContent = getFullWebhookUrl();
    if (tokenEl) {
      tokenEl.textContent = _webhookToken;
    }
  } catch {
    statusEl.textContent = '加载失败';
  }
}

/** 切换 Webhook 开关 */
export async function toggleWebhook() {
  const toggleEl = document.getElementById('webhookToggle');
  const statusEl = document.getElementById('webhookStatus');
  if (!toggleEl || !statusEl) return;

  const newState = toggleEl.checked;
  try {
    await api('/api/webhook/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: newState }),
    });
    _webhookEnabled = newState;
    statusEl.textContent = newState ? '已启用' : '已关闭';
    showToast(newState ? 'Webhook 已启用' : 'Webhook 已关闭');
  } catch (e) {
    toggleEl.checked = !_webhookEnabled;
    showToast('切换失败: ' + e.message);
  }
}

export async function copyWebhookUrl() {
  const url = getFullWebhookUrl();
  try {
    await navigator.clipboard.writeText(url);
    showToast('Webhook 地址已复制到剪贴板');
  } catch {
    // fallback：选中文字方便手动复制
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('webhookUrl'));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    showToast('已选中地址，请手动复制');
  }
}

export async function copyWebhookToken() {
  const token = _webhookToken;
  if (!token) {
    showToast('Token 未生成');
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    showToast('Token 已复制到剪贴板');
  } catch {
    showToast('复制失败，请手动复制');
  }
}

export async function resetWebhookToken() {
  const btn = document.getElementById('btnResetToken');
  if (!btn) return;
  if (!confirm('确定重新生成 Token？旧 Token 将立即失效。')) return;

  btn.disabled = true;
  btn.textContent = '重置中...';
  try {
    await api('/api/webhook/regenerate-token', { method: 'POST' });
    _webhookToken = '';
    await loadWebhookConfig();
    showToast('Token 已重置');
  } catch (e) {
    showToast('重置失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 重置';
  }
}

// ============================================================
// 缓存与版本
// ============================================================

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
