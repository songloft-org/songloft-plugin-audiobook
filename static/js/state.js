// 全局状态 + 视图切换
export const state = {
  books: [],
  total: 0,
  page: 1,
  pageSize: 24,
  keyword: '',
  currentBookId: null,
  currentBook: null,
  currentChapter: null,
  currentBookForPlayer: null,
  audioEl: null,
  speed: 1.0,
  previousView: 'homeView',
  chapterSortOrder: 'asc',
  playlistSortAsc: true,
  sleepTimer: null,
  miotRemote: null, // { accountId, deviceId, token, pollTimer, isPlaying }
  realDurations: {}, // chapterId → 真实时长（浏览器 audio.duration，秒）
};

/** 获取章节最佳时长：优先用浏览器解析的真实时长，其次用服务端估算值 */
export function getChapterDuration(ch) {
  if (!ch) return 0;
  return (state.realDurations && state.realDurations[ch.id]) || ch.duration || 0;
}

export function switchView(id) {
  // Record current active view before switching
  const cur = document.querySelector('.view.active');
  if (cur && cur.id !== id) {
    state.previousView = cur.id;
  }

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');

  // FAB 只在首页/详情页显示，播放器页隐藏
  const fab = document.getElementById('playerFab');
  if (fab) {
    const hide = id === 'playerView';
    fab.style.display = hide ? 'none' : '';
  }

  // 顶部栏、标签、排序栏只在首页显示，且仅在有数据时显示排序栏
  const isHome = id === 'homeView';
  const header = document.querySelector('.app-header');
  const tabs = document.getElementById('tabs');
  const sortBar = document.querySelector('.sort-bar');
  if (header) header.style.display = isHome ? '' : 'none';
  if (tabs) tabs.style.display = isHome ? '' : 'none';
  if (sortBar) sortBar.style.display = (isHome && state.total > 0) ? '' : 'none';
}
