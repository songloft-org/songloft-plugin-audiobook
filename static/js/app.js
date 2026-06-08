// 有声书插件前端应用
// 使用 /api/* 端点与插件后端通信；音频通过 base64 -> Blob URL 播放

(function () {
  'use strict';

  const state = {
    books: [],
    total: 0,
    page: 1,
    pageSize: 24,
    keyword: '',
    currentBookId: null,
    currentBook: null,
    currentChapter: null,
    currentBookForPlayer: null,
    objectUrl: null,
    audioEl: null,
    speed: 1.0,
  };

  // ==================== 网络工具 ====================

  // 使用相对路径 ./ 让 <base> 标签正确解析。
  // 框架注入 <base href="/api/v1/jsplugin/audiobook/">，
  // ./api/books → /api/v1/jsplugin/audiobook/api/books
  const API_BASE = './';

  async function api(path, options) {
    const url = API_BASE + path.replace(/^\//, '');
    const init = options || {};
    init.headers = init.headers || {};
    try {
      const authData = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
      if (authData.accessToken) {
        init.headers['Authorization'] = 'Bearer ' + authData.accessToken;
      }
    } catch (e) {}
    const res = await fetch(url, init);
    if (res.status === 401) {
      throw new Error('认证过期，请刷新页面或重新登录');
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '请求失败');
    return json.data;
  }

  // ==================== 工具函数 ====================

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '00:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ==================== 视图切换 ====================

  function switchView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  }

  // ==================== 加载书籍列表 ====================

  async function loadSnapshot() {
    try {
      const data = await api('/api/snapshot');
      const grid = document.getElementById('bookGrid');
      const empty = document.getElementById('emptyState');
      const resultSummary = document.getElementById('resultSummary');
      const sectionTitle = document.getElementById('booksSectionTitle');

      if (!data.totalBooks) {
        if (grid) grid.innerHTML = '';
        if (empty) empty.hidden = false;
        if (resultSummary) resultSummary.textContent = '';
        if (sectionTitle) sectionTitle.textContent = '全部书籍';
        return;
      }
      if (empty) empty.hidden = true;
      // 有书，走完整列表渲染
      await loadBooks();
    } catch (e) {
      const empty = document.getElementById('emptyState');
      if (empty) empty.hidden = false;
      console.error(e);
    }
  }

  async function loadBooks() {
    try {
      const sortBy = (document.getElementById('sortBy') || {}).value || 'updatedAt';
      const favoritesOnly = (document.getElementById('favoritesOnly') || {}).checked || false;
      const data = await api(
        `/api/books?page=${state.page}&pageSize=${state.pageSize}`
        + `&keyword=${encodeURIComponent(state.keyword)}`
        + `&sortBy=${encodeURIComponent(sortBy)}`
        + (favoritesOnly ? '&favoritesOnly=true' : '')
      );
      state.books = data.books || [];
      state.total = data.total || 0;
      state.page = data.page || 1;
      state.pageSize = data.pageSize || 24;
      renderBookGrid();
      renderPagination();

      const sectionTitle = document.getElementById('booksSectionTitle');
      if (sectionTitle) {
        sectionTitle.textContent = state.keyword ? `搜索: "${state.keyword}"` : '全部书籍';
      }
      const empty = document.getElementById('emptyState');
      if (empty) empty.hidden = state.total > 0;
    } catch (e) {
      console.error(e);
      showToast('加载失败：' + e.message);
    }
  }

  function renderBookGrid() {
    const grid = document.getElementById('bookGrid');
    if (!grid) return;
    if (!state.books.length) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = state.books.map((book) => `
      <div class="book-card" data-id="${book.id}">
        <div class="book-card-cover">
          ${book.coverUrl
            ? `<img src="${book.coverUrl}" alt="${escapeHtml(book.title)}" loading="lazy" onerror="this.style.display='none'">`
            : `<div style="width:100%;height:100%;display:grid;place-items:center;font-size:48px;background:var(--surface-2);">🎧</div>`}
          <div class="book-card-overlay">
            <div class="book-card-title">${escapeHtml(book.title)}</div>
            <div class="book-card-meta">${book.chapterCount} 章 · ${formatFileSize(book.totalSize)}</div>
          </div>
          <button class="book-card-fav ${book.isFavorite ? 'on' : ''}" data-fav="${book.id}" title="收藏">★</button>
          <button class="book-card-play" data-play="${book.id}" title="播放">▶</button>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.book-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-fav]') || e.target.closest('[data-play]')) return;
        loadBookDetail(card.getAttribute('data-id'));
      });
    });
    grid.querySelectorAll('[data-fav]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-fav');
        try {
          const data = await api(`/api/books/${id}/favorite`, { method: 'POST' });
          const idx = state.books.findIndex((b) => b.id === id);
          if (idx >= 0) state.books[idx].isFavorite = data.isFavorite;
          if (state.currentBook && state.currentBook.id === id) state.currentBook.isFavorite = data.isFavorite;
          renderBookGrid();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
    grid.querySelectorAll('[data-play]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-play');
        loadBookDetail(id, /* autoPlay */ true);
      });
    });
  }

  function renderPagination() {
    const el = document.getElementById('pagination');
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const info = document.getElementById('pageInfo');
    const summary = document.getElementById('resultSummary');
    if (!el) return;
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.total <= state.pageSize) {
      el.hidden = true;
      if (summary) summary.textContent = `共 ${state.total} 本`;
      return;
    }
    el.hidden = false;
    if (info) info.textContent = `第 ${state.page} / ${totalPages} 页`;
    if (summary) summary.textContent = `共 ${state.total} 本`;
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= totalPages;
  }

  // ==================== 最近播放 ====================

  async function loadRecentlyPlayed() {
    try {
      const data = await api('/api/recently-played');
      const items = data.items || [];
      const section = document.getElementById('recentSection');
      const list = document.getElementById('recentList');
      if (!section || !list) return;
      if (!items.length) { section.hidden = true; return; }
      section.hidden = false;
      list.innerHTML = items.map((item) => `
        <div class="recent-card" data-book="${item.bookId}" data-chapter="${item.chapterId}">
          ${item.coverUrl
            ? `<img src="${item.coverUrl}" alt="">`
            : '<div style="width:48px;height:48px;background:var(--surface-2);border-radius:8px;display:grid;place-items:center;font-size:20px;">🎧</div>'}
          <div class="recent-card-info">
            <div class="recent-card-title">${escapeHtml(item.bookTitle)}</div>
            <div class="recent-card-sub">${escapeHtml(item.chapterTitle || '')}</div>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.recent-card').forEach((c) => {
        c.addEventListener('click', () => {
          loadBookDetail(c.getAttribute('data-book'), /* autoPlay */ true, c.getAttribute('data-chapter'));
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  // ==================== 书籍详情 ====================

  async function loadBookDetail(bookId, autoPlay, chapterId) {
    try {
      state.currentBookId = bookId;
      const book = await api(`/api/books/${bookId}`);
      state.currentBook = book;
      renderBookDetail(book);
      switchView('bookView');
      if (autoPlay) {
        const ch = chapterId ? book.chapters.find((c) => c.id === chapterId) : book.chapters[0];
        if (ch) playChapter(book, ch);
      }
    } catch (e) {
      showToast('加载书籍失败：' + e.message);
    }
  }

  function renderBookDetail(book) {
    const el = document.getElementById('bookDetail');
    if (!el) return;
    const hasCover = !!book.coverUrl;
    el.innerHTML = `
      <div class="book-hero">
        ${hasCover
          ? `<img class="book-hero-cover" src="${book.coverUrl}" alt="${escapeHtml(book.title)}">`
          : `<div class="book-hero-cover" style="display:grid;place-items:center;background:var(--surface-2);font-size:64px;">🎧</div>`}
        <div class="book-hero-info">
          <h2 class="book-hero-title">${escapeHtml(book.title)}</h2>
          <div class="book-hero-meta">${book.chapterCount} 章 · ${formatFileSize(book.totalSize)}${book.category ? ' · ' + escapeHtml(book.category) : ''}</div>
          <div class="book-hero-desc">${escapeHtml(book.description || '')}</div>
          <div class="book-hero-actions">
            <button class="btn btn-primary" id="btnPlayFirst">▶ 从第一集播放</button>
            <button class="btn btn-ghost" id="btnToggleFav">${book.isFavorite ? '★ 已收藏' : '☆ 收藏'}</button>
          </div>
        </div>
      </div>
      <div class="chapter-list">
        <div class="chapter-list-header">章节列表（${book.chapters.length}）</div>
        <div class="chapter-list-body">
          ${book.chapters.map((ch) => `
            <div class="chapter-row" data-chapter="${ch.id}">
              <div class="chapter-row-left">
                <div class="chapter-index">${String(ch.index).padStart(3, '0')}</div>
                <div class="chapter-text">
                  <div class="chapter-title">${escapeHtml(ch.title)}</div>
                  <div class="chapter-sub">${formatDuration(ch.duration)} · ${formatFileSize(ch.fileSize)}${ch.progress && ch.progress.position ? ` · 听到 ${formatDuration(ch.progress.position)}` : ''}</div>
                  ${ch.progress && ch.progress.duration && ch.progress.position
                    ? `<div class="chapter-progress"><div class="chapter-progress-bar" style="width:${Math.min(100, (ch.progress.position / ch.progress.duration) * 100)}%"></div></div>`
                    : ''}
                </div>
              </div>
              <div class="chapter-row-right">
                <div class="chapter-time">${formatDuration(ch.duration)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('btnPlayFirst').addEventListener('click', () => {
      if (state.currentBook && state.currentBook.chapters.length) playChapter(state.currentBook, state.currentBook.chapters[0]);
    });
    document.getElementById('btnToggleFav').addEventListener('click', async () => {
      try {
        const data = await api(`/api/books/${book.id}/favorite`, { method: 'POST' });
        state.currentBook.isFavorite = data.isFavorite;
        const idx = state.books.findIndex((b) => b.id === book.id);
        if (idx >= 0) state.books[idx].isFavorite = data.isFavorite;
        renderBookDetail(state.currentBook);
      } catch (err) {
        showToast(err.message);
      }
    });
    el.querySelectorAll('.chapter-row').forEach((row) => {
      row.addEventListener('click', () => {
        const chId = row.getAttribute('data-chapter');
        const ch = state.currentBook.chapters.find((c) => c.id === chId);
        if (ch) playChapter(state.currentBook, ch);
      });
    });
  }

  // ==================== 重新扫描 ====================

  async function triggerRescan() {
    const btn = document.getElementById('btnRescan');
    if (btn) { btn.disabled = true; btn.textContent = '扫描中...'; }
    try {
      const data = await api('/api/rescan', { method: 'POST' });
      state.page = 1;
      showToast(`扫描完成：${data.totalBooks} 本书，${data.totalChapters} 章节`);
      await loadBooks();
      await loadRecentlyPlayed();
    } catch (e) {
      showToast('扫描失败：' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄'; }
    }
  }

  // ==================== 播放器 ====================

  function ensureAudio() {
    if (state.audioEl) return state.audioEl;
    state.audioEl = document.getElementById('audio') || (() => {
      const a = document.createElement('audio');
      a.id = 'audio';
      a.preload = 'auto';
      document.body.appendChild(a);
      return a;
    })();

    state.audioEl.addEventListener('timeupdate', () => {
      if (!state.currentChapter || !state.currentBookForPlayer) return;
      const now = Date.now();
      if (!state.audioEl._lastSave || now - state.audioEl._lastSave > 5000) {
        state.audioEl._lastSave = now;
        saveProgress(
          state.currentBookForPlayer.id,
          state.currentChapter.id,
          state.audioEl.currentTime,
          state.audioEl.duration || 0
        );
      }
      updatePlayerUI();
    });

    state.audioEl.addEventListener('play', () => updatePlayIcon(true));
    state.audioEl.addEventListener('pause', () => updatePlayIcon(false));
    state.audioEl.addEventListener('ended', () => {
      if (!state.currentBookForPlayer || !state.currentChapter) return;
      const chapters = state.currentBookForPlayer.chapters;
      const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
      if (idx >= 0 && idx < chapters.length - 1) playChapter(state.currentBookForPlayer, chapters[idx + 1]);
    });
    state.audioEl.addEventListener('loadedmetadata', () => {
      // 如果有保存的进度，恢复
      if (state.currentChapter && state.currentChapter.progress && state.currentChapter.progress.position > 0) {
        try { state.audioEl.currentTime = state.currentChapter.progress.position; } catch (e) {}
      }
    });
    return state.audioEl;
  }

  async function playChapter(book, chapter) {
    state.currentBookForPlayer = book;
    state.currentChapter = chapter;

    const audio = ensureAudio();
    const bar = document.getElementById('playerBar');
    if (bar) bar.hidden = false;

    const bookEl = document.getElementById('playerBook');
    const chEl = document.getElementById('playerChapter');
    const coverEl = document.getElementById('playerCover');
    if (bookEl) bookEl.textContent = book.title;
    if (chEl) chEl.textContent = chapter.title;
    if (coverEl) {
      if (book.coverUrl) {
        coverEl.src = book.coverUrl;
        coverEl.style.display = '';
      } else {
        coverEl.style.display = 'none';
      }
    }

    updatePlayIcon(true);
    try {
      const data = await api(`/api/books/${book.id}/chapters/${chapter.id}/audio`);
      if (!data || !data.audio) throw new Error('服务端返回数据异常');

      // 检测是否返回了 HTML（API 路径错误时后端会返回 index.html）
      const trimmed = data.audio.trim();
      if (trimmed.startsWith('<') || trimmed.startsWith('<!')) {
        throw new Error('音频加载失败：API 路径错误，请尝试刷新页面');
      }

      const binary = atob(trimmed);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: data.mime || 'audio/mpeg' });
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = URL.createObjectURL(blob);
      audio.src = state.objectUrl;
      audio.playbackRate = state.speed;
      audio.oncanplay = () => {
        audio.oncanplay = null;
        showToast('已开始播放：' + chapter.title);
      };
      audio.onplay = null;
      audio.play().catch((e) => {
        console.error(e);
        // 浏览器不支持该格式时给出明确提示
        const isWma = (data.mime || '').includes('wma');
        showToast(isWma
          ? '浏览器不支持 WMA 格式，请将文件转换为 MP3 或使用 Edge 浏览器播放'
          : '播放失败：' + e.message);
        updatePlayIcon(false);
      });
    } catch (e) {
      showToast('音频加载失败：' + e.message);
      updatePlayIcon(false);
    }
  }

  function updatePlayIcon(playing) {
    const btn = document.getElementById('btnPlay');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  function updatePlayerUI() {
    const audio = state.audioEl;
    if (!audio) return;
    const seek = document.getElementById('playerSeek');
    const cur = document.getElementById('playerCurTime');
    const dur = document.getElementById('playerDurTime');
    if (audio.duration && isFinite(audio.duration)) {
      if (seek) seek.value = String((audio.currentTime / audio.duration) * 100);
      if (cur) cur.textContent = formatDuration(audio.currentTime);
      if (dur) dur.textContent = formatDuration(audio.duration);
    }
  }

  function saveProgress(bookId, chapterId, position, duration) {
    fetch(`/api/books/${bookId}/chapters/${chapterId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position, duration }),
    }).catch(() => {});
  }

  // ==================== 绑定事件 ====================

  function bindEvents() {
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

    const btnRescan = document.getElementById('btnRescan');
    if (btnRescan) btnRescan.addEventListener('click', triggerRescan);

    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    if (prevBtn) prevBtn.addEventListener('click', () => { if (state.page > 1) { state.page--; loadBooks(); } });
    if (nextBtn) nextBtn.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      if (state.page < totalPages) { state.page++; loadBooks(); }
    });

    const sortBy = document.getElementById('sortBy');
    if (sortBy) sortBy.addEventListener('change', () => { state.page = 1; loadBooks(); });

    const favoritesOnly = document.getElementById('favoritesOnly');
    if (favoritesOnly) favoritesOnly.addEventListener('change', () => { state.page = 1; loadBooks(); });

    const backBtn = document.getElementById('backBtn');
    if (backBtn) backBtn.addEventListener('click', () => switchView('homeView'));

    // 播放控制
    const playBtn = document.getElementById('btnPlay');
    if (playBtn) playBtn.addEventListener('click', () => {
      const audio = ensureAudio();
      if (!audio.src) {
        // 用户点了播放但还没加载过，尝试加载第一本书第一章
        if (state.currentBook) playChapter(state.currentBook, state.currentBook.chapters[0]);
        return;
      }
      if (audio.paused) audio.play(); else audio.pause();
    });
    const prevChapter = document.getElementById('btnPrev');
    if (prevChapter) prevChapter.addEventListener('click', () => {
      if (!state.currentBookForPlayer || !state.currentChapter) return;
      const idx = state.currentBookForPlayer.chapters.findIndex((c) => c.id === state.currentChapter.id);
      if (idx > 0) playChapter(state.currentBookForPlayer, state.currentBookForPlayer.chapters[idx - 1]);
    });
    const nextChapter = document.getElementById('btnNext');
    if (nextChapter) nextChapter.addEventListener('click', () => {
      if (!state.currentBookForPlayer || !state.currentChapter) return;
      const idx = state.currentBookForPlayer.chapters.findIndex((c) => c.id === state.currentChapter.id);
      if (idx >= 0 && idx < state.currentBookForPlayer.chapters.length - 1) {
        playChapter(state.currentBookForPlayer, state.currentBookForPlayer.chapters[idx + 1]);
      }
    });
    const speedBtn = document.getElementById('btnSpeed');
    if (speedBtn) {
      const speeds = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
      speedBtn.addEventListener('click', () => {
        const curIdx = speeds.indexOf(state.speed);
        const next = speeds[(curIdx + 1) % speeds.length];
        state.speed = next;
        speedBtn.textContent = next + 'x';
        const audio = ensureAudio();
        if (audio) audio.playbackRate = next;
      });
    }
    const seek = document.getElementById('playerSeek');
    if (seek) seek.addEventListener('change', () => {
      const audio = ensureAudio();
      if (audio && audio.duration) audio.currentTime = (parseFloat(seek.value) / 100) * audio.duration;
    });
    const coverBtn = document.getElementById('playerCoverBtn');
    if (coverBtn) coverBtn.addEventListener('click', () => {
      if (state.currentBookForPlayer) {
        state.currentBook = state.currentBookForPlayer;
        renderBookDetail(state.currentBook);
        switchView('bookView');
      }
    });
  }

  // ==================== 启动 ====================

  function boot() {
    bindEvents();
    switchView('homeView');
    loadSnapshot();
    loadRecentlyPlayed();
  }

  document.addEventListener('DOMContentLoaded', boot);

  // 暴露给 HTML (例如 onclick="app.loadSnapshot()")
  window.app = { loadSnapshot, triggerRescan };
})();
