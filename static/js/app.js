// 有声书插件 — 入口
import { state, switchView } from './state.js';
import { ensureAudio, updatePlayerInfo, updatePlayerUI, togglePlaylistModal, togglePlaylistSort, playerPrevChapter, playerNextChapter, playerSeek, playerTogglePlay, cycleSpeed, openSleepTimer, closeSleepTimer, startSleepTimer, cancelSleepTimer, openCustomPicker, closeCustomPicker, pushToMiot, closeDevicePicker, exitMiotRemote } from './views/player.js';
import { loadSnapshot, loadBooks, loadRecentlyPlayed, triggerRescan } from './views/home.js';
import { openSettings, closeSettings, cleanCache, toggleWebhook, copyWebhookUrl, copyWebhookToken, resetWebhookToken } from './views/settings.js';
import { escapeHtml, showToast } from './utils.js';

// ============================================================
// 日志面板（调试用）
// ============================================================

let logEntries = [];
let _logPollTimer = null;

function toggleLogPanel() {
  const panel = document.getElementById('logPanel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (!isOpen) {
    panel.classList.add('open');
    fetchLogs();
    // 每 5s 轮询刷新
    _logPollTimer = setInterval(fetchLogs, 5000);
  } else {
    panel.classList.remove('open');
    if (_logPollTimer) { clearInterval(_logPollTimer); _logPollTimer = null; }
  }
}

async function fetchLogs() {
  try {
    const init = {};
    try {
      const authData = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
      if (authData.accessToken) {
        init.headers = { 'Authorization': 'Bearer ' + authData.accessToken };
      }
    } catch (e) {}
    const res = await fetch('./api/logs', init);
    if (!res.ok) return;
    const json = await res.json();
    if (json?.success && Array.isArray(json.data)) {
      // 直接覆盖上次快照，避免增量追加产生重复
      logEntries = json.data.slice();
      renderLogs();
    }
  } catch { /* ignore */ }
}

function renderLogs() {
  const body = document.getElementById('logPanelBody');
  const countEl = document.getElementById('logCount');
  if (!body || !countEl) return;

  if (logEntries.length === 0) {
    body.innerHTML = '<div class="log-empty">暂无日志</div>';
    countEl.textContent = '共 0 条';
    return;
  }

  let html = '';
  for (let i = 0; i < logEntries.length; i++) {
    const e = logEntries[i];
    const d = new Date(e.time);
    const ts = d.getHours().toString().padStart(2, '0') + ':' +
               d.getMinutes().toString().padStart(2, '0') + ':' +
               d.getSeconds().toString().padStart(2, '0');
    const iconMap = { voice: '🎤', error: '❌', speaker: '📌', sys: 'ℹ️' };
    const icon = iconMap[e.type] || '📌';
    const rCls = e.result === '✅' ? 'le-ok' : (e.result === '❌' ? 'le-fail' : '');
    const rText = e.result || '';

    html += '<div class="log-entry type-' + (e.type || 'speaker') + '">' +
            '<span class="le-time">' + ts + '</span>' +
            '<span class="le-icon">' + icon + '</span>' +
            escapeHtml(String(e.action || '')) + ' ' +
            escapeHtml(String(e.detail || '')) +
            '<span class="le-result ' + rCls + '">' + rText + '</span>' +
            '</div>';
  }
  body.innerHTML = html;
  // 滚动到底部（仅最后一条变化时自动滚）
  const prevScroll = body.scrollHeight - body.scrollTop;
  body.scrollTop = body.scrollHeight;

  countEl.textContent = '共 ' + logEntries.length + ' 条';
}

function clearLogs() {
  const authData = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
  const opts = { method: 'POST' };
  if (authData.accessToken) {
    opts.headers = { 'Authorization': 'Bearer ' + authData.accessToken };
  }
  fetch('./api/logs', opts).catch(() => {});

  logEntries = [];
  renderLogs();
}

function copyLogs() {
  if (logEntries.length === 0) return;
  const text = logEntries.map(function(e) {
    const d = new Date(e.time);
    const ts = d.toTimeString().slice(0, 8);
    return '[' + ts + '] ' + (e.action || '') + ' ' + (e.detail || '');
  }).join('\n');

  navigator.clipboard.writeText(text).then(function() {
    showToast('日志已复制到剪贴板');
  }).catch(function() {
    showToast('复制失败');
  });
}

// ============================================================
// 绑定事件
// ============================================================

function bindEvents() {
  // Search
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    let t;
    searchInput.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.keyword = searchInput.value.trim();
        state.page = 1;
        loadBooks();
      }, 300);
    });
  }

  // Rescan
  const btnRescan = document.getElementById('btnRescan');
  if (btnRescan) btnRescan.addEventListener('click', triggerRescan);

  // Pagination
  document.getElementById('prevPage').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadBooks(); }
  });
  document.getElementById('nextPage').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page < totalPages) { state.page++; loadBooks(); }
  });

  // Sort / filter
  document.getElementById('sortBy').addEventListener('change', () => { state.page = 1; loadBooks(); });
  document.getElementById('favoritesOnly').addEventListener('change', () => { state.page = 1; loadBooks(); });

  // Back buttons
  document.getElementById('backBtn').addEventListener('click', () => switchView('homeView'));
  document.getElementById('playerBackBtn').addEventListener('click', () => switchView(state.previousView));

  // FAB → open player
  document.getElementById('playerFab').addEventListener('click', () => {
    if (!state.currentBookForPlayer) return;
    updatePlayerInfo();
    switchView('playerView');
  });

  // Playlist modal
  document.getElementById('btnPlaylist').addEventListener('click', togglePlaylistModal);
  document.getElementById('btnPlaylistClose').addEventListener('click', togglePlaylistModal);
  document.getElementById('btnPlaylistSort').addEventListener('click', togglePlaylistSort);
  document.getElementById('playlistOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) togglePlaylistModal();
  });

  // Player controls
  document.getElementById('btnPlayFull').addEventListener('click', playerTogglePlay);
  document.getElementById('btnPrevFull').addEventListener('click', playerPrevChapter);
  document.getElementById('btnNextFull').addEventListener('click', playerNextChapter);
  document.getElementById('btnRewind').addEventListener('click', () => playerSeek(-15));
  document.getElementById('btnForward').addEventListener('click', () => playerSeek(15));
  document.getElementById('btnSpeedFull').addEventListener('click', cycleSpeed);

  // Seek bar
  const seek = document.getElementById('playerFullSeek');
  if (seek) seek.addEventListener('input', () => {
    const audio = state.audioEl || ensureAudio();
    if (audio && audio.duration) {
      audio.currentTime = (parseFloat(seek.value) / 100) * audio.duration;
      updatePlayerUI();
    }
  });

  // Directory structure info
  document.getElementById('dirInfoBtn').addEventListener('click', () => {
    document.getElementById('dirInfoOverlay').hidden = false;
  });
  document.getElementById('dirInfoClose').addEventListener('click', () => {
    document.getElementById('dirInfoOverlay').hidden = true;
  });
  document.getElementById('dirInfoOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  // Sleep timer
  document.getElementById('btnSleepTimer').addEventListener('click', openSleepTimer);
  document.getElementById('btnTimerClose').addEventListener('click', closeSleepTimer);
  document.getElementById('btnTimerCancel').addEventListener('click', () => { cancelSleepTimer(); closeSleepTimer(); });
  document.getElementById('timerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSleepTimer();
  });

  // Timer options
  document.querySelectorAll('.timer-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      const value = btn.getAttribute('data-value');
      if (value === 'custom') {
        openCustomPicker();
      } else {
        startSleepTimer(mode, parseInt(value, 10));
      }
    });
  });

  // Custom minutes picker
  const customValueEl = document.getElementById('timerCustomValue');
  document.getElementById('btnCustomPlus').addEventListener('click', () => {
    let v = parseInt(customValueEl.textContent, 10);
    if (v < 120) customValueEl.textContent = String(v + 5);
  });
  document.getElementById('btnCustomMinus').addEventListener('click', () => {
    let v = parseInt(customValueEl.textContent, 10);
    if (v > 5) customValueEl.textContent = String(v - 5);
  });
  document.getElementById('btnTimerCustomConfirm').addEventListener('click', () => {
    const v = parseInt(customValueEl.textContent, 10);
    startSleepTimer('time', v);
    closeCustomPicker();
  });
  document.getElementById('btnTimerCustomClose').addEventListener('click', closeCustomPicker);
  document.getElementById('timerCustomOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCustomPicker();
  });

  // 音响推送
  document.getElementById('btnPushMiot').addEventListener('click', pushToMiot);
  document.getElementById('btnDevicePickerClose').addEventListener('click', closeDevicePicker);
  document.getElementById('devicePickerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDevicePicker();
  });
  document.getElementById('btnExitRemote').addEventListener('click', exitMiotRemote);

  // 设置
  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('btnSettingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('btnCleanCache').addEventListener('click', cleanCache);
  document.getElementById('webhookToggle').addEventListener('change', toggleWebhook);
  document.getElementById('btnCopyWebhook').addEventListener('click', copyWebhookUrl);
  const btnToken = document.getElementById('btnCopyToken');
  if (btnToken) btnToken.addEventListener('click', copyWebhookToken);
  const btnReset = document.getElementById('btnResetToken');
  if (btnReset) btnReset.addEventListener('click', resetWebhookToken);

  // 日志面板
  document.getElementById('btnOpenLogPanel').addEventListener('click', toggleLogPanel);
  document.getElementById('btnCloseLogPanel').addEventListener('click', toggleLogPanel);
  document.getElementById('btnClearLogs').addEventListener('click', clearLogs);
  document.getElementById('btnCopyLogs').addEventListener('click', copyLogs);
}

// ==================== 启动 ====================

function boot() {
  ensureAudio();
  bindEvents();
  switchView('homeView');
  loadSnapshot();
  loadRecentlyPlayed();
}

document.addEventListener('DOMContentLoaded', boot);
window.app = { loadSnapshot, triggerRescan };
