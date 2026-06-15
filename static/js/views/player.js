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

    // 播放超 60s 后提前转码下一集
    if (el.currentTime >= 60 && !el._preloadTriggered) {
      el._preloadTriggered = true;
      preloadNextChapter();
    }
  });

  el.addEventListener('play', () => updatePlayState(true));
  el.addEventListener('pause', () => {
    updatePlayState(false);
    // 暂停时立即保存进度
    if (state.currentBookForPlayer && state.currentChapter && isFinite(el.currentTime)) {
      saveProgress(state.currentBookForPlayer.id, state.currentChapter.id, el.currentTime, el.duration || 0);
    }
  });
  el.addEventListener('ended', () => {
    if (!state.currentBookForPlayer || !state.currentChapter) return;

    if (state.sleepTimer && state.sleepTimer.mode === 'chapters') {
      state.sleepTimer.chaptersRemaining--;
      updateSleepTimerUI();
      if (state.sleepTimer.chaptersRemaining <= 0) {
        cancelSleepTimer();
        el.pause();
        showToast('定时关闭：已播放完设定集数');
        return;
      }
    }

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
  // 本地播放时退出遥控模式
  exitMiotRemote();

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
  audio._preloadTriggered = false; // 新章节重置预加载标记
  updatePlayState(true);

  let token = '';
  try {
    const auth = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    token = auth.accessToken || '';
  } catch (e) {}
  const withToken = (url) => token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;

  // 检测转码状态，首次转码可能耗时
  const withTokenUrl = (path) => withToken(`./api/books/${book.id}${path}`);
  try {
    let checkResp = await fetch(withTokenUrl(`/chapters/${chapter.id}/preload?check=1`));
    let checkData = await checkResp.json();
    if (checkData.data && !checkData.data.ready) {
      showToast('音频转码中，请稍候...');
      updatePlayState(false);
      // 触发当前集转码（后台）+ 提前转码下一集
      fetch(withTokenUrl(`/chapters/${chapter.id}/preload`));
      preloadNextChapter();
      // 轮询等待就绪（最多 2 分钟）
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        checkResp = await fetch(withTokenUrl(`/chapters/${chapter.id}/preload?check=1`));
        checkData = await checkResp.json();
        if (checkData.data && checkData.data.ready) break;
      }
      if (!checkData.data || !checkData.data.ready) {
        showToast('转码超时，请稍后重试');
        return;
      }
    }
  } catch (e) {
    // 检测失败仍尝试播放
  }

  const url = withToken(`./api/books/${book.id}/chapters/${chapter.id}/audio`);
  console.log('播放地址：', url);
  audio.src = url;
  audio.playbackRate = state.speed;
  audio.play().catch((e) => {
    showToast('播放失败：' + e.message);
    updatePlayState(false);
  });
}

/** 预转码下一集（播放 60s 后自动触发） */
async function preloadNextChapter() {
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx < 0 || idx >= chapters.length - 1) return; // 最后一集，无需预加载
  const next = chapters[idx + 1];
  let token = '';
  try {
    const auth = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    token = auth.accessToken || '';
  } catch (e) {}
  const withToken = (url) => token ? `${url}?access_token=${encodeURIComponent(token)}` : url;
  fetch(withToken(`./api/books/${state.currentBookForPlayer.id}/chapters/${next.id}/preload`));
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
  if (state.miotRemote) { miotPrevChapter(); return; }
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx > 0) {
    playChapter(state.currentBookForPlayer, chapters[idx - 1], false);
  }
}

export function playerNextChapter() {
  if (state.miotRemote) { miotNextChapter(); return; }
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
  if (state.miotRemote) {
    miotTogglePlay();
    return;
  }
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

// ==================== 定时关闭 ====================

let sleepTimerInterval = null;

export function openSleepTimer() {
  const overlay = document.getElementById('timerOverlay');
  if (!overlay) return;
  overlay.hidden = false;
}

export function closeSleepTimer() {
  const overlay = document.getElementById('timerOverlay');
  if (overlay) overlay.hidden = true;
  const customOverlay = document.getElementById('timerCustomOverlay');
  if (customOverlay) customOverlay.hidden = true;
}

export function startSleepTimer(mode, value) {
  if (mode === 'time') {
    const minutes = value;
    state.sleepTimer = { mode: 'time', value: minutes, endAt: Date.now() + minutes * 60000, chaptersRemaining: null };
    if (sleepTimerInterval) clearInterval(sleepTimerInterval);
    sleepTimerInterval = setInterval(() => {
      const remaining = state.sleepTimer.endAt - Date.now();
      if (remaining <= 0) {
        const audio = state.audioEl;
        if (audio) audio.pause();
        cancelSleepTimer();
        showToast('定时关闭：时间到');
        return;
      }
      updateSleepTimerUI();
    }, 1000);
  } else {
    const chapters = value;
    state.sleepTimer = { mode: 'chapters', value: chapters, endAt: null, chaptersRemaining: chapters };
    if (sleepTimerInterval) clearInterval(sleepTimerInterval);
    sleepTimerInterval = setInterval(updateSleepTimerUI, 1000);
  }

  closeSleepTimer();
  updateSleepTimerUI();

  const btn = document.getElementById('btnSleepTimer');
  if (btn) btn.classList.add('timer-active');
}

export function cancelSleepTimer() {
  if (sleepTimerInterval) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }
  state.sleepTimer = null;
  const countdown = document.getElementById('playerTimerCountdown');
  if (countdown) countdown.hidden = true;
  const btn = document.getElementById('btnSleepTimer');
  if (btn) {
    btn.textContent = '⏱';
    btn.classList.remove('timer-active');
  }
}

export function updateSleepTimerUI() {
  const countdown = document.getElementById('playerTimerCountdown');
  if (!countdown) return;

  if (!state.sleepTimer) {
    countdown.hidden = true;
    return;
  }

  const btn = document.getElementById('btnSleepTimer');
  if (!btn) return;

  if (state.sleepTimer.mode === 'time') {
    const remaining = Math.max(0, Math.ceil((state.sleepTimer.endAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    const text = `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    btn.textContent = text;
    countdown.textContent = `定时关闭剩余 ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    countdown.hidden = false;
  } else {
    const remaining = state.sleepTimer.chaptersRemaining;
    const label = remaining === 1 ? '本集' : `${remaining}集`;
    btn.textContent = `⏱ ${label}`;
    countdown.textContent = `定时关闭剩余 ${label}`;
    countdown.hidden = false;
  }
}

// ==================== 推送到音响 + 遥控模式 ====================

function getAuthToken() {
  try {
    const auth = JSON.parse(localStorage.getItem('songloft-auth') || '{}');
    return auth.accessToken || '';
  } catch (e) { return ''; }
}

function miotHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

async function miotPost(path, body, token) {
  const resp = await fetch('../miot' + path, {
    method: 'POST',
    headers: miotHeaders(token),
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function miotGet(path, token) {
  const resp = await fetch('../miot' + path, { headers: miotHeaders(token) });
  return resp.json();
}

// ---------- 遥控模式 ----------

function enterMiotRemote(accountId, deviceId, token) {
  // 先退出旧的遥控模式
  exitMiotRemote();

  state.miotRemote = { accountId, deviceId, token, pollTimer: null, isPlaying: true };

  // 暂停本地音频
  const audio = state.audioEl;
  if (audio && !audio.paused) audio.pause();

  // 更新 UI 为遥控模式
  updateRemoteUI(true);
  updatePlayState(true);

  // 启动心跳轮询
  pollMiotStatus();
  state.miotRemote.pollTimer = setInterval(pollMiotStatus, 5000);
}

export function exitMiotRemote() {
  if (!state.miotRemote) return;
  if (state.miotRemote.pollTimer) {
    clearInterval(state.miotRemote.pollTimer);
  }
  state.miotRemote = null;
  updateRemoteUI(false);
}

function updateRemoteUI(isRemote) {
  // 快进/后退/倍速按钮：遥控模式下隐藏
  const btnRewind = document.getElementById('btnRewind');
  const btnForward = document.getElementById('btnForward');
  const btnSpeed = document.getElementById('btnSpeedFull');
  if (btnRewind) btnRewind.style.display = isRemote ? 'none' : '';
  if (btnForward) btnForward.style.display = isRemote ? 'none' : '';
  if (btnSpeed) btnSpeed.style.display = isRemote ? 'none' : '';

  // 🔊音响 按钮：本地模式显示，遥控模式隐藏
  const btnPush = document.getElementById('btnPushMiot');
  if (btnPush) btnPush.style.display = isRemote ? 'none' : '';

  // ✕退出遥控 按钮：遥控模式显示，本地模式隐藏
  const btnExit = document.getElementById('btnExitRemote');
  if (btnExit) btnExit.style.display = isRemote ? '' : 'none';

  // 进度条：遥控模式下禁用拖动
  const seek = document.getElementById('playerFullSeek');
  if (seek) seek.disabled = isRemote;

  // 遥控模式标签
  const badge = document.getElementById('remoteBadge');
  if (badge) badge.hidden = !isRemote;
}

async function pollMiotStatus() {
  const r = state.miotRemote;
  if (!r) return;

  try {
    const data = await miotGet(`/player/status?account_id=${r.accountId}&device_id=${r.deviceId}`, r.token);
    if (!data.success || !data.data) return;

    const d = data.data;
    const position = d.position || 0;
    const duration = d.duration || 0;
    const isPlaying = d.state === 'playing';

    r.isPlaying = isPlaying;

    // 更新进度条
    const seek = document.getElementById('playerFullSeek');
    const cur = document.getElementById('playerFullCur');
    const dur = document.getElementById('playerFullDur');
    if (seek && duration > 0) seek.value = String((position / duration) * 100);
    if (cur) cur.textContent = formatDuration(position);
    if (dur) dur.textContent = formatDuration(duration);

    // 更新播放/暂停按钮 + 封面旋转
    updatePlayState(isPlaying);

    // 保存进度到本地
    if (state.currentBookForPlayer && state.currentChapter && duration > 0) {
      saveProgress(state.currentBookForPlayer.id, state.currentChapter.id, position, duration);
    }

    // 播放完毕 → 自动推下一章
    if (duration > 0 && position >= duration - 2) {
      pushNextChapterToMiot();
    }
  } catch (e) {
    // 轮询失败静默忽略
  }
}

async function pushNextChapterToMiot() {
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx < 0 || idx >= chapters.length - 1) {
    showToast('已是最后一章');
    exitMiotRemote();
    return;
  }
  const next = chapters[idx + 1];
  state.currentChapter = next;
  updatePlayerInfo();
  await pushChapterUrlToMiot(state.currentBookForPlayer, next);
}

async function pushChapterUrlToMiot(book, chapter) {
  const r = state.miotRemote;
  if (!r) return;

  const audio = state.audioEl || ensureAudio();
  if (!audio || !audio.src) {
    showToast('播放地址不可用');
    return;
  }

  // 从当前 audio.src 替换 chapterId 得到目标章节的完整 URL
  const chapterPattern = /\/chapters\/[^/]+\/audio/;
  const audioUrl = audio.src.replace(chapterPattern, `/chapters/${chapter.id}/audio`);

  try {
    const json = await miotPost('/mina/play-url', {
      account_id: r.accountId,
      device_id: r.deviceId,
      url: audioUrl,
    }, r.token);
    if (json.success) {
      showToast(`正在播放：${chapter.title}`);
    } else {
      showToast('推送失败：' + (json.error || '未知错误'));
    }
  } catch (e) {
    showToast('推送失败：' + e.message);
  }
}

// ---------- 遥控按钮 ----------

export async function miotTogglePlay() {
  const r = state.miotRemote;
  if (!r) return;
  try {
    if (r.isPlaying) {
      await miotPost('/mina/pause', { account_id: r.accountId, device_id: r.deviceId }, r.token);
      r.isPlaying = false;
      updatePlayState(false);
    } else {
      await miotPost('/mina/resume', { account_id: r.accountId, device_id: r.deviceId }, r.token);
      r.isPlaying = true;
      updatePlayState(true);
    }
  } catch (e) {
    showToast('操作失败：' + e.message);
  }
}

export async function miotPrevChapter() {
  if (!state.currentBookForPlayer || !state.currentChapter) return;
  const chapters = state.currentBookForPlayer.chapters;
  const idx = chapters.findIndex((c) => c.id === state.currentChapter.id);
  if (idx > 0) {
    const prev = chapters[idx - 1];
    state.currentChapter = prev;
    updatePlayerInfo();
    await pushChapterUrlToMiot(state.currentBookForPlayer, prev);
  }
}

export async function miotNextChapter() {
  await pushNextChapterToMiot();
}

// ---------- 设备选择 + 推送 ----------

export async function pushToMiot() {
  if (!state.currentBookForPlayer || !state.currentChapter) {
    showToast('请先播放有声书');
    return;
  }

  const token = getAuthToken();
  const headers = miotHeaders(token);

  // 校验 miot 插件是否已安装并启用
  try {
    const resp = await fetch('../../jsplugins', { headers });
    const json = await resp.json();
    const miotPlugin = (json.plugins || []).find(p => p.entry_path === 'miot' && p.status === 'active');
    if (!miotPlugin) {
      showToast('请先安装并启用"智能音箱"插件');
      return;
    }
  } catch (e) {
    showToast('无法获取插件列表');
    return;
  }

  const overlay = document.getElementById('devicePickerOverlay');
  const body = document.getElementById('devicePickerBody');
  if (!overlay || !body) return;

  body.innerHTML = '<div class="device-picker-loading">正在加载设备列表...</div>';
  overlay.hidden = false;

  let devicesData;
  try {
    const resp = await fetch('../miot/mina/devices', { headers });
    const json = await resp.json();
    if (!json.success) throw new Error(json.error || '获取设备列表失败');
    devicesData = json.data;
  } catch (e) {
    body.innerHTML = `<div class="device-picker-error">加载失败：${e.message}</div>`;
    return;
  }

  if (!devicesData || devicesData.length === 0) {
    body.innerHTML = '<div class="device-picker-empty">未找到账号，请先在小爱插件中登录</div>';
    return;
  }

  const allDevices = [];
  for (const account of devicesData) {
    const devices = (account.devices || []).filter(d => d.managed);
    for (const d of devices) {
      allDevices.push({
        account_id: account.account_id,
        device_id: d.deviceID,
        device_name: d.name || d.alias || '未命名设备',
        model: d.model || '',
        isLast: d.deviceID === account.last_selected_device_id,
      });
    }
  }

  if (allDevices.length === 0) {
    body.innerHTML = '<div class="device-picker-empty">没有已监听的设备，请先在小爱插件中勾选要监听的设备</div>';
    return;
  }

  allDevices.sort((a, b) => (b.isLast ? 1 : 0) - (a.isLast ? 1 : 0));

  let html = '';
  for (const acc of devicesData) {
    const accDevices = allDevices.filter(d => d.account_id === acc.account_id);
    if (accDevices.length === 0) continue;
    html += `<div class="device-picker-account">${acc.account_name || acc.account_id}</div>`;
    for (const d of accDevices) {
      html += `
        <div class="device-row" data-account="${d.account_id}" data-device="${d.device_id}">
          <div class="device-icon">☁️</div>
          <div class="device-info">
            <div class="device-name">${d.device_name}${d.isLast ? ' (上次使用)' : ''}</div>
            <div class="device-model">${d.model}</div>
          </div>
        </div>`;
    }
  }
  body.innerHTML = html;

  body.querySelectorAll('.device-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const accountId = row.getAttribute('data-account');
      const deviceId = row.getAttribute('data-device');
      overlay.hidden = true;
      await doPushToDevice(accountId, deviceId, token);
    });
  });
}

async function doPushToDevice(accountId, deviceId, token) {
  const book = state.currentBookForPlayer;
  const chapter = state.currentChapter;
  if (!book || !chapter) return;

  // 先检查转码状态
  const withToken = (url) => token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;
  try {
    let checkResp = await fetch(withToken(`./api/books/${book.id}/chapters/${chapter.id}/preload?check=1`));
    let checkData = await checkResp.json();
    if (checkData.data && !checkData.data.ready) {
      showToast('音频转码中，请稍候...');
      fetch(withToken(`./api/books/${book.id}/chapters/${chapter.id}/preload`));
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        checkResp = await fetch(withToken(`./api/books/${book.id}/chapters/${chapter.id}/preload?check=1`));
        checkData = await checkResp.json();
        if (checkData.data && checkData.data.ready) break;
      }
      if (!checkData.data || !checkData.data.ready) {
        showToast('转码超时，请稍后重试');
        return;
      }
    }
  } catch (e) {}

  // audio.src 已经是完整 URL，直接使用
  const audio = state.audioEl || ensureAudio();
  if (!audio || !audio.src) {
    showToast('当前没有播放内容');
    return;
  }
  const audioUrl = audio.src;

  showToast('正在推送到音响...');

  try {
    const json = await miotPost('/mina/play-url', {
      account_id: accountId,
      device_id: deviceId,
      url: audioUrl,
    }, token);
    if (json.success) {
      showToast('已推送到音响');
      enterMiotRemote(accountId, deviceId, token);
    } else {
      showToast('推送失败：' + (json.error || '未知错误'));
    }
  } catch (e) {
    showToast('推送失败：' + e.message);
  }
}

export function closeDevicePicker() {
  const overlay = document.getElementById('devicePickerOverlay');
  if (overlay) overlay.hidden = true;
}

export function openCustomPicker() {
  const overlay = document.getElementById('timerCustomOverlay');
  if (!overlay) return;
  document.getElementById('timerCustomValue').textContent = '15';
  overlay.hidden = false;
}

export function closeCustomPicker() {
  const overlay = document.getElementById('timerCustomOverlay');
  if (overlay) overlay.hidden = true;
}
