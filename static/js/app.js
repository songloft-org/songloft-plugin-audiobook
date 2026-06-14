// 有声书插件 — 入口
import { state, switchView } from './state.js';
import { ensureAudio, updatePlayerInfo, updatePlayerUI, togglePlaylistModal, togglePlaylistSort, playerPrevChapter, playerNextChapter, playerSeek, playerTogglePlay, cycleSpeed, openSleepTimer, closeSleepTimer, startSleepTimer, cancelSleepTimer, openCustomPicker, closeCustomPicker, pushToXiaoAi, closeDevicePicker } from './views/player.js';
import { loadSnapshot, loadBooks, loadRecentlyPlayed, triggerRescan } from './views/home.js';

// ==================== 绑定事件 ====================

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

  // 小爱音箱推送
  document.getElementById('btnPushXiaoAi').addEventListener('click', pushToXiaoAi);
  document.getElementById('btnDevicePickerClose').addEventListener('click', closeDevicePicker);
  document.getElementById('devicePickerOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDevicePicker();
  });
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
