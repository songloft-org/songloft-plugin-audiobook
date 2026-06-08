// 首页：书籍网格、最近播放、分类、搜索
import { api } from '../api.js';
import { formatFileSize, escapeHtml, showToast } from '../utils.js';
import { state, switchView } from '../state.js';
import { loadBookDetail } from './detail.js';
import { playChapter } from './player.js';

export async function loadSnapshot() {
  try {
    const data = await api('/api/snapshot');
    if (!data.totalBooks) {
      const grid = document.getElementById('bookGrid');
      const empty = document.getElementById('emptyState');
      if (grid) grid.innerHTML = '';
      if (empty) empty.hidden = false;
      const summary = document.getElementById('resultSummary');
      if (summary) summary.textContent = '';
      const title = document.getElementById('booksSectionTitle');
      if (title) title.textContent = '全部书籍';
      return;
    }
    const empty = document.getElementById('emptyState');
    if (empty) empty.hidden = true;
    await loadBooks();
  } catch (e) {
    const empty = document.getElementById('emptyState');
    if (empty) empty.hidden = false;
    console.error(e);
  }
}

export async function loadBooks() {
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

    const title = document.getElementById('booksSectionTitle');
    if (title) title.textContent = state.keyword ? `搜索: "${state.keyword}"` : '全部书籍';
    const empty = document.getElementById('emptyState');
    if (empty) empty.hidden = state.total > 0;
  } catch (e) {
    console.error(e);
    showToast('加载失败：' + e.message);
  }
}

export function renderBookGrid() {
  const grid = document.getElementById('bookGrid');
  if (!grid) return;
  if (!state.books.length) { grid.innerHTML = ''; return; }

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
      } catch (err) { showToast(err.message); }
    });
  });
  grid.querySelectorAll('[data-play]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      playBookFromCard(btn.getAttribute('data-play'));
    });
  });
}

async function playBookFromCard(bookId) {
  try {
    const book = await api(`/api/books/${bookId}`);
    state.currentBook = book;
    if (book.chapters.length) {
      playChapter(book, book.chapters[0], /* switchToPlayer */ false);
    }
  } catch (e) { showToast('播放失败：' + e.message); }
}

export function renderPagination() {
  const el = document.getElementById('pagination');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.total <= state.pageSize) {
    el.hidden = true;
    const summary = document.getElementById('resultSummary');
    if (summary) summary.textContent = `共 ${state.total} 本`;
    return;
  }
  el.hidden = false;
  const info = document.getElementById('pageInfo');
  if (info) info.textContent = `第 ${state.page} / ${totalPages} 页`;
  const summary = document.getElementById('resultSummary');
  if (summary) summary.textContent = `共 ${state.total} 本`;
  document.getElementById('prevPage').disabled = state.page <= 1;
  document.getElementById('nextPage').disabled = state.page >= totalPages;
}

export async function loadRecentlyPlayed() {
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
  } catch (e) { console.error(e); }
}

export async function triggerRescan() {
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
