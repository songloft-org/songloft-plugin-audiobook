// 播放器：核心播放、FAB 悬浮按钮、全屏播放页
import { api } from '../api.js';
import { formatDuration, formatFileSize, escapeHtml, showToast } from '../utils.js';
import { state, switchView } from '../state.js';

// ==================== 音频核心 ====================

export function ensureAudio() {
  if (state.audioEl) return state.audioEl;
  const a = document.getElementById('audio');
  const el = a || (() => {
    const e = document.createElement('audio');
    e.id = 'audio';
    e.preload = 'auto';
    document.body.appendChild(e);
    return e;
  })();
  state.audioEl = el;

  el.addEventListener('timeupdate', () => {
    if (!state.currentChapter || !state.currentBookForPlayer) return;
    const now = Date.now();
    if (!el._lastSave || now - el._lastSave > 5000) {
      el._lastSave = now;
      saveProgress(
        state.currentBookForPlayer.id,
        state.currentChapter.id,
        el.currentTime,
        el.duration || 0
      );
    }
    updatePlayerUI();
  });

  el.addEventListener('play', () => updatePlayState(true));
  el.addEventListener('pause', () => updatePlayState(false));
  el.addEventListener('ended', () => {
    if (!state.currentBookForPlayer || !state.currentChapter) return;
    const chapters = state.currentBookForPlayer.chapters;
    const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
    if (idx >= 0 && idx < chapters.length - 1) {
      playChapter(state.currentBookForPlayer, chapters[idx + 1], false);
    }
  });
  el.addEventListener('loadedmetadata', () => {
    if (state.currentChapter && state.currentChapter.progress && state.currentChapter.progress.position > 0) {
      try { el.currentTime = state.currentChapter.progress.position; } catch (e) {}
    }
  });
  return el;
}

export async function playChapter(book, chapter, switchToPlayer) {
  state.currentBookForPlayer = book;
  state.currentChapter = chapter;

  updateFab();
  if (document.getElementById('playerView').classList.contains('active')) {
    updatePlayerInfo();
  }
  if (switchToPlayer) {
    updatePlayerInfo();
    switchView('playerView');
  }

  const audio = ensureAudio();
  updatePlayState(true);

  try {
    const data = await api(`/api/books/${book.id}/chapters/${chapter.id}/audio`);
    if (!data || !data.audio) throw new Error('服务端返回数据异常');

    const trimmed = data.audio.trim();
    if (trimmed.startsWith('<') || trimmed.startsWith('<!')) {
      throw new Error('音频加载失败：API 路径错误');
    }

    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: data.mime || 'audio/mpeg' });
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(blob);
    audio.src = state.objectUrl;
    audio.playbackRate = state.speed;
    audio.play().catch((e) => {
      const isWma = (data.mime || '').includes('wma');
      showToast(isWma ? '浏览器不支持 WMA 格式' : '播放失败：' + e.message);
      updatePlayState(false);
    });
  } catch (e) {
    showToast('音频加载失败：' + e.message);
    updatePlayState(false);
  }
}

function saveProgress(bookId, chapterId, position, duration) {
  api(`/api/books/${bookId}/chapters/${chapterId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position, duration }),
  }).catch(() => {});
}

// ==================== FAB 悬浮按钮 ====================

export function updateFab() {
  const fab = document.getElementById('playerFab');
  const book = state.currentBookForPlayer;
  if (!fab || !book) return;

  const img = document.getElementById('playerFabCover');
  const pl = document.getElementById('playerFabPlaceholder');
  if (book.coverUrl) {
    img.src = book.coverUrl;
    img.style.display = '';
    if (pl) pl.style.display = 'none';
  } else {
    img.style.display = 'none';
    if (pl) pl.style.display = '';
  }
  fab.hidden = false;
}

export function updatePlayState(playing) {
  const fab = document.getElementById('playerFab');
  if (fab) fab.classList.toggle('playing', playing);
  const disc = document.getElementById('playerDisc');
  if (disc) disc.classList.toggle('playing', playing);
  const btn = document.getElementById('btnPlayFull');
  if (btn) btn.textContent = playing ? '⏸️' : '▶️';
}

// ==================== 全屏播放器页 ====================

export function updatePlayerInfo() {
  const book = state.currentBookForPlayer;
  const ch = state.currentChapter;
  document.getElementById('playerFullBook').textContent = book ? book.title : '';
  document.getElementById('playerFullChapter').textContent = ch ? ch.title : '';

  const discImg = document.getElementById('playerDiscCover');
  const discPl = document.getElementById('playerDiscPlaceholder');
  if (book && book.coverUrl) {
    discImg.src = book.coverUrl;
    discImg.style.display = '';
    if (discPl) discPl.style.display = 'none';
  } else {
    discImg.style.display = 'none';
    if (discPl) discPl.style.display = '';
  }
}

export function updatePlayerUI() {
  const audio = state.audioEl;
  if (!audio) return;
  const seek = document.getElementById('playerFullSeek');
  const cur = document.getElementById('playerFullCur');
  const dur = document.getElementById('playerFullDur');
  if (audio.duration && isFinite(audio.duration)) {
    if (seek) seek.value = String((audio.currentTime / audio.duration) * 100);
    if (cur) cur.textContent = formatDuration(audio.currentTime);
    if (dur) dur.textContent = formatDuration(audio.duration);
  }
}

export function renderPlaylistModal() {
  const book = state.currentBookForPlayer;
  const body = document.getElementById('playlistSheetBody');
  if (!book || !body) return;

  const sorted = [...book.chapters].sort((a, b) =>
    state.playlistSortAsc ? a.index - b.index : b.index - a.index
  );

  body.innerHTML = sorted.map((ch) => {
    const isActive = state.currentChapter && ch.id === state.currentChapter.id;
    return `
      <div class="chapter-row ${isActive ? 'active' : ''}" data-chapter="${ch.id}">
        <div class="chapter-row-left">
          <div class="chapter-index">${String(ch.index).padStart(3, '0')}</div>
          <div class="chapter-text">
            <div class="chapter-title">${escapeHtml(ch.title)}</div>
            <div class="chapter-sub">${formatDuration(ch.duration)} · ${formatFileSize(ch.fileSize)}</div>
          </div>
        </div>
        <div class="chapter-row-right">
          <div class="chapter-time">${formatDuration(ch.duration)}</div>
        </div>
      </div>
    `;
  }).join('');

  const sortBtn = document.getElementById('btnPlaylistSort');
  if (sortBtn) sortBtn.textContent = state.playlistSortAsc ? '↑ 正序' : '↓ 倒序';

  body.querySelectorAll('.chapter-row').forEach((row) => {
    row.addEventListener('click', () => {
      const chId = row.getAttribute('data-chapter');
      const ch = book.chapters.find((c) => c.id === chId);
      if (ch) {
        playChapter(book, ch, false);
        closePlaylistModal();
      }
    });
  });
}

export function togglePlaylistModal() {
  const overlay = document.getElementById('playlistOverlay');
  if (!overlay) return;
  if (overlay.hidden) {
    renderPlaylistModal();
    overlay.hidden = false;
  } else {
    overlay.hidden = true;
  }
}

function closePlaylistModal() {
  const overlay = document.getElementById('playlistOverlay');
  if (overlay) overlay.hidden = true;
}

export function togglePlaylistSort() {
  state.playlistSortAsc = !state.playlistSortAsc;
  const btn = document.getElementById('btnPlaylistSort');
  if (btn) btn.textContent = state.playlistSortAsc ? '↑ 正序' : '↓ 倒序';
  renderPlaylistModal();
}

// ==================== 播放控制 ====================

export function playerPrevChapter() {
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx > 0) {
    playChapter(state.currentBookForPlayer, chapters[idx - 1], false);
  }
}

export function playerNextChapter() {
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx >= 0 && idx < chapters.length - 1) {
    playChapter(state.currentBookForPlayer, chapters[idx + 1], false);
  }
}

export function playerSeek(seconds) {
  const audio = state.audioEl || ensureAudio();
  if (audio && isFinite(audio.duration)) {
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  }
}

export function playerTogglePlay() {
  const audio = ensureAudio();
  if (!audio.src) {
    if (state.currentBookForPlayer && state.currentChapter) {
      playChapter(state.currentBookForPlayer, state.currentChapter, false);
    }
    return;
  }
  if (audio.paused) audio.play(); else audio.pause();
}

export function cycleSpeed() {
  const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const curIdx = speeds.indexOf(state.speed);
  state.speed = speeds[(curIdx + 1) % speeds.length];
  const btn = document.getElementById('btnSpeedFull');
  if (btn) btn.textContent = state.speed + 'x';
  const audio = state.audioEl || ensureAudio();
  if (audio) audio.playbackRate = state.speed;
}
