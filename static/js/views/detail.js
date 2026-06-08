// 书籍详情页：章节列表、收藏切换
import { api } from '../api.js';
import { formatDuration, formatFileSize, escapeHtml, showToast } from '../utils.js';
import { state, switchView } from '../state.js';
import { playChapter } from './player.js';

export async function loadBookDetail(bookId, autoPlay, chapterId) {
  try {
    state.currentBookId = bookId;
    const book = await api(`/api/books/${bookId}`);
    state.currentBook = book;
    renderBookDetail(book);
    switchView('bookView');
    if (autoPlay) {
      const ch = chapterId ? book.chapters.find((c) => c.id === chapterId) : book.chapters[0];
      if (ch) playChapter(book, ch, /* switchToPlayer */ false);
    }
  } catch (e) {
    showToast('加载书籍失败：' + e.message);
  }
}

export function renderBookDetail(book) {
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
    if (state.currentBook && state.currentBook.chapters.length) {
      playChapter(state.currentBook, state.currentBook.chapters[0], false);
    }
  });
  document.getElementById('btnToggleFav').addEventListener('click', async () => {
    try {
      const data = await api(`/api/books/${book.id}/favorite`, { method: 'POST' });
      state.currentBook.isFavorite = data.isFavorite;
      const idx = state.books.findIndex((b) => b.id === book.id);
      if (idx >= 0) state.books[idx].isFavorite = data.isFavorite;
      renderBookDetail(state.currentBook);
    } catch (err) { showToast(err.message); }
  });
  el.querySelectorAll('.chapter-row').forEach((row) => {
    row.addEventListener('click', () => {
      const chId = row.getAttribute('data-chapter');
      const ch = state.currentBook.chapters.find((c) => c.id === chId);
      if (ch) playChapter(state.currentBook, ch, false);
    });
  });
}
