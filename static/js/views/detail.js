// 书籍详情页：章节列表、收藏切换、元数据编辑
import { api } from '../api.js';
import { formatDuration, formatFileSize, escapeHtml, showToast } from '../utils.js';
import { state, switchView, getChapterDuration } from '../state.js';
import { playChapter } from './player.js';

let editingBookId = null;

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
  const ratioStyle = book.coverRatio ? ` style="aspect-ratio:${book.coverRatio.replace(':', '/')}"` : '';

  const chapters = [...book.chapters].sort((a, b) =>
    state.chapterSortOrder === 'asc' ? a.index - b.index : b.index - a.index
  );

  el.innerHTML = `
    <div class="book-hero">
      ${hasCover
        ? `<img class="book-hero-cover"${ratioStyle} src="${book.coverUrl}" alt="${escapeHtml(book.title)}">`
        : `<div class="book-hero-cover"${ratioStyle} style="display:grid;place-items:center;background:var(--surface-2);font-size:64px;${book.coverRatio ? 'aspect-ratio:' + book.coverRatio.replace(':', '/') + ';' : ''}">🎧</div>`}
      <button class="edit-btn" id="editBookBtn" title="编辑书籍信息">✏️</button>
      <div class="book-hero-info">
        <h2 class="book-hero-title">${escapeHtml(book.title)}</h2>
        <div class="book-hero-meta">${book.author !== '未知' ? escapeHtml(book.author) + ' · ' : ''}${book.chapterCount} 章 · ${formatFileSize(book.totalSize)}${book.category ? ' · ' + escapeHtml(book.category) : ''}</div>
        <div class="book-hero-desc">${escapeHtml(book.description || '')}</div>
        ${book.tags && book.tags.length ? `<div class="book-hero-tags">${book.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="book-hero-actions">
          <button class="btn btn-primary" id="btnPlayFirst">▶ 从第一集播放</button>
          <button class="btn btn-ghost" id="btnToggleFav">${book.isFavorite ? '★ 已收藏' : '☆ 收藏'}</button>
          <button class="btn btn-ghost" id="btnRefreshBook">🔄 刷新</button>
        </div>
      </div>
    </div>
    <div class="chapter-list">
      <div class="chapter-list-header">
        章节列表（${book.chapters.length}）
        <button class="btn btn-ghost chapter-sort-btn" id="chapterSortToggle">${state.chapterSortOrder === 'asc' ? '↑ 正序' : '↓ 倒序'}</button>
      </div>
      <div class="chapter-list-body">
        ${chapters.map((ch) => `
          <div class="chapter-row" data-chapter="${ch.id}">
            <div class="chapter-row-left">
              <div class="chapter-index">${String(ch.index).padStart(3, '0')}</div>
              <div class="chapter-text">
                <div class="chapter-title">${escapeHtml(ch.title)}</div>
                <div class="chapter-sub">${formatDuration(getChapterDuration(ch))} · ${formatFileSize(ch.fileSize)}${ch.progress && ch.progress.position ? ` · 听到 ${formatDuration(ch.progress.position)}` : ''}</div>
                ${ch.progress && ch.progress.duration && ch.progress.position
                  ? `<div class="chapter-progress"><div class="chapter-progress-bar" style="width:${Math.min(100, (ch.progress.position / ch.progress.duration) * 100)}%"></div></div>`
                  : ''}
              </div>
            </div>
            <div class="chapter-row-right">
              <div class="chapter-time">${formatDuration(getChapterDuration(ch))}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  document.getElementById('chapterSortToggle').addEventListener('click', () => {
    state.chapterSortOrder = state.chapterSortOrder === 'asc' ? 'desc' : 'asc';
    renderBookDetail(book);
  });

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
  document.getElementById('btnRefreshBook').addEventListener('click', () => {
    loadBookDetail(book.id);
  });
  el.querySelectorAll('.chapter-row').forEach((row) => {
    row.addEventListener('click', () => {
      const chId = row.getAttribute('data-chapter');
      const ch = state.currentBook.chapters.find((c) => c.id === chId);
      if (ch) playChapter(state.currentBook, ch, false);
    });
  });

  document.getElementById('editBookBtn').addEventListener('click', () => openEditModal(book));
}

export function openEditModal(book) {
  editingBookId = book.id;
  document.getElementById('editDescription').value = book.description || '';
  document.getElementById('editCategory').value = book.category || '';
  document.getElementById('editTags').value = (book.tags || []).join(', ');
  document.getElementById('editAuthor').value = book.author || '';
  document.getElementById('editCoverRatio').value = book.coverRatio || '';
  document.getElementById('editCoverPreview').src = book.coverUrl || '';
  document.getElementById('editCoverUrl').value = '';
  document.getElementById('editCoverFile').value = '';
  document.getElementById('editOverlay').hidden = false;
}

function closeEditModal() {
  document.getElementById('editOverlay').hidden = true;
  editingBookId = null;
}

// 封面文件选择预览
document.getElementById('editCoverFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    document.getElementById('editCoverPreview').src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

// 弹窗关闭
document.getElementById('editOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeEditModal();
});
document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);

// 保存
document.getElementById('editSaveBtn').addEventListener('click', async () => {
  const btn = document.getElementById('editSaveBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const bookId = editingBookId;
    if (!bookId) return;

    const description = document.getElementById('editDescription').value.trim();
    const category = document.getElementById('editCategory').value.trim();
    const tagsRaw = document.getElementById('editTags').value.trim();
    const author = document.getElementById('editAuthor').value.trim();
    const coverRatio = document.getElementById('editCoverRatio').value;
    const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    await api(`/api/books/${bookId}/metadata`, {
      method: 'PUT',
      body: JSON.stringify({ description, category, tags, author, coverRatio }),
      headers: { 'Content-Type': 'application/json' },
    });

    // 封面：优先文件上传，其次 URL 下载
    const coverFile = document.getElementById('editCoverFile').files[0];
    const coverUrlInput = document.getElementById('editCoverUrl').value.trim();
    if (coverFile) {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(coverFile);
      });
      await api(`/api/books/${bookId}/cover`, {
        method: 'POST',
        body: JSON.stringify({ base64 }),
        headers: { 'Content-Type': 'application/json' },
      });
    } else if (coverUrlInput) {
      const resp = await fetch(coverUrlInput);
      if (!resp.ok) throw new Error('无法下载封面图片，请检查 URL');
      const blob = await resp.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.onerror = () => reject(new Error('转换图片失败'));
        reader.readAsDataURL(blob);
      });
      await api(`/api/books/${bookId}/cover`, {
        method: 'POST',
        body: JSON.stringify({ base64 }),
        headers: { 'Content-Type': 'application/json' },
      });
    }

    closeEditModal();
    await loadBookDetail(bookId);
  } catch (e) {
    showToast('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
});
