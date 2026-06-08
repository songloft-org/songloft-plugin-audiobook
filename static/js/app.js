// 有声书插件 — 入口
import { state, switchView } from './state.js';
import { ensureAudio, updatePlayerInfo, updatePlayerUI, togglePlaylistModal, playerPrevChapter, playerNextChapter, playerSeek, playerTogglePlay, cycleSpeed } from './views/player.js';
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
