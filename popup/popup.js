/**
 * B站视频下载助手 —— Popup 交互逻辑
 */

/* ================= 工具 ================= */

const $ = (sel) => document.querySelector(sel);

function send(msg) {
  return chrome.runtime
    .sendMessage(msg)
    .then((res) => res || { ok: false, error: '后台无响应，请重试' })
    .catch((e) => ({ ok: false, error: String(e) }));
}

function fmtBytes(n) {
  if (!n || n <= 0) return '';
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

/* ================= 状态 ================= */

const state = {
  parse: null, // URL 解析结果 {kind, bvid/epId, ...}
  info: null,  // 视频元信息 {kind, title, subtitle, items[], currentIdx}
  play: {},    // 播放信息缓存  key = `${key}:${cid}:${fmt}`
  tasks: [],
  prefs: { mode: 'video', fmt: 'mp4', codec: 7 },
};

const FMT_HINT = {
  mp4: '单文件「即下即播」，无需合并，最高 1080P。适合大多数场景。',
  dash: '音视频分离为两个文件，可选最高画质（1080P高码率/4K/8K/杜比/Hi-Res），下载后用 ffmpeg 一键合并。',
};

/* ================= 初始化 ================= */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();

  const saved = await chrome.storage.local.get('prefs');
  if (saved && saved.prefs) state.prefs = { ...state.prefs, ...saved.prefs };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  setStatus('loading', '正在识别当前页面…');
  const res = await send({ type: 'PARSE_PAGE', url });
  if (!res.ok) {
    setStatus('error', res.error);
    return;
  }

  state.parse = res.parse;
  state.info = res.info;
  setStatus('ok');

  renderInfo(res.loggedIn);
  renderModeSeg();

  // 预取两种格式的播放信息（并发）
  setStatus('loading', '正在获取清晰度列表…');
  await Promise.all([loadPlay('dash'), loadPlay('mp4')]);
  setStatus('ok');
  renderFmtSeg();
  renderAll();

  // 恢复后台任务进度
  const tasksRes = await send({ type: 'GET_TASKS' });
  if (tasksRes.ok && tasksRes.tasks.length) {
    state.tasks = tasksRes.tasks;
    renderTasks();
  }
}

function setStatus(kind, text) {
  const box = $('#statusBox');
  const txt = $('#statusText');
  const content = $('#content');
  if (kind === 'ok') {
    box.hidden = true;
    content.hidden = false;
  } else {
    box.hidden = false;
    content.hidden = true;
    box.innerHTML = '';
    if (kind === 'loading') {
      const sp = document.createElement('div');
      sp.className = 'spinner';
      box.appendChild(sp);
    }
    const div = document.createElement('div');
    div.className = 'status-text';
    div.textContent = text || (kind === 'error' ? '出错了' : '');
    box.appendChild(div);
  }
}

/* ================= 数据加载 ================= */

function currentCid() {
  const idx = Math.max(0, parseInt($('#partSel').value || '0', 10));
  return state.info.items[idx]?.cid;
}

function currentItem() {
  const idx = Math.max(0, parseInt($('#partSel').value || '0', 10));
  return state.info.items[idx];
}

function playKey(fmt) {
  const item = currentItem();
  return `${state.info.key}:${item?.cid}:${fmt}`;
}

async function loadPlay(fmt) {
  const item = currentItem();
  if (!item) return;
  const key = playKey(fmt);
  if (state.play[key]) return state.play[key];

  const params = {
    type: 'GET_PLAY',
    kind: state.info.kind,
    bvid: state.info.kind === 'ugc' ? state.info.bvid : undefined,
    epId: item.epId,
    cid: item.cid,
    fmt,
  };
  const res = await send(params);
  state.play[key] = res.ok ? res.data : { error: res.error };
  return state.play[key];
}

/* ================= 渲染 ================= */

function renderInfo(loggedIn) {
  $('#vTitle').textContent = state.info.title;
  $('#vSub').textContent = state.info.subtitle;
  $('#vKind').textContent = state.info.kind === 'ugc' ? '普通视频' : '番剧 / 影视';
  $('#loginTip').hidden = !!loggedIn;

  const items = state.info.items || [];
  const partRow = $('#partRow');
  const sel = $('#partSel');
  sel.innerHTML = '';
  if (items.length > 1) {
    partRow.hidden = false;
    items.forEach((it, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = it.label || `第 ${i + 1} 项`;
      sel.appendChild(opt);
    });
    sel.value = String(Math.min(state.info.currentIdx, items.length - 1));
  } else {
    partRow.hidden = true;
  }
}

function renderModeSeg() {
  $('#modeSeg').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.v === state.prefs.mode);
  });
}

function renderFmtSeg() {
  $('#fmtSeg').querySelectorAll('button').forEach((btn) => {
    const data = state.play[playKey(btn.dataset.v)];
    const disabled = !!data?.error;
    btn.disabled = disabled;
    btn.title = disabled ? data.error : '';
    if (disabled && btn.classList.contains('active')) {
      // 当前格式不可用，自动切换到另一种
      const other = btn.dataset.v === 'mp4' ? 'dash' : 'mp4';
      if (!state.play[playKey(other)]?.error) state.prefs.fmt = other;
    }
    btn.classList.toggle('active', btn.dataset.v === state.prefs.fmt);
  });
  $('#fmtHint').textContent = FMT_HINT[state.prefs.fmt] || '';
}

function fillSelect(sel, options, value) {
  sel.innerHTML = '';
  options.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = String(o.value);
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
  if (value != null) sel.value = String(value);
}

function renderAll() {
  const mode = state.prefs.mode;
  const isVideo = mode === 'video';

  $('#audioSection').hidden = isVideo;
  $('#videoSection').hidden = !isVideo;

  if (!isVideo) {
    const dash = state.play[playKey('dash')];
    if (dash?.error) {
      toast(dash.error);
      return;
    }
    const audios = dash?.audios || [];
    fillSelect(
      $('#audioSel'),
      audios.map((a) => ({ value: a.id, label: a.desc })),
      audios[0]?.id
    );
    return;
  }

  renderFmtSeg();
  const fmt = state.prefs.fmt;
  const play = state.play[playKey(fmt)];

  if (play?.error) {
    toast(play.error);
    return;
  }

  // 清晰度
  const qualities = play?.qualities || [];
  fillSelect(
    $('#qualitySel'),
    qualities.map((q) => ({ value: q.qn, label: q.desc + (q.member ? '（大会员）' : '') })),
    qualities[0]?.qn
  );

  // DASH 附加项：编码 + 音质
  const isDash = fmt === 'dash';
  $('#codecRow').hidden = !isDash;
  $('#dashAudioRow').hidden = !isDash;
  if (isDash) {
    renderCodecSel();
    const audios = play?.audios || [];
    fillSelect(
      $('#dashAudioSel'),
      audios.map((a) => ({ value: a.id, label: a.desc })),
      audios[0]?.id
    );
  }
}

const CODEC_LABEL = { 7: 'H.264 / AVC（兼容最佳）', 12: 'H.265 / HEVC', 13: 'AV1' };

function renderCodecSel() {
  const play = state.play[playKey('dash')];
  const qn = parseInt($('#qualitySel').value || '0', 10);
  const q = (play?.qualities || []).find((x) => x.qn === qn);
  const codecs = q?.codecs || [7];
  let preferred = codecs.includes(state.prefs.codec) ? state.prefs.codec : codecs[0];
  fillSelect(
    $('#codecSel'),
    codecs.map((c) => ({ value: c, label: CODEC_LABEL[c] || `编码 ${c}` })),
    preferred
  );
}

/* ================= 任务渲染 ================= */

function renderTasks() {
  const box = $('#tasks');
  const list = $('#taskList');
  if (!state.tasks.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  list.innerHTML = '';

  state.tasks.forEach((t) => {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'task-head';

    const label = document.createElement('span');
    label.className = 'task-label';
    label.textContent = t.label;
    label.title = t.filename;

    const st = document.createElement('span');
    st.className = 'task-state';
    if (t.state === '已完成') st.classList.add('done');
    if (t.state === '已中断' || t.state.startsWith('失败')) st.classList.add('err');
    st.textContent = t.state;

    head.appendChild(label);
    head.appendChild(st);

    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const inner = document.createElement('div');
    inner.className = 'progress-inner';
    const pct = t.total > 0 ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : 0;
    if (t.state === '已完成' || t.state === '保存中') {
      inner.style.width = '100%';
    } else if (t.total > 0) {
      inner.style.width = pct + '%';
    } else {
      inner.classList.add('indeterminate');
    }
    bar.appendChild(inner);

    li.appendChild(head);
    li.appendChild(bar);

    if (t.state !== '已完成') {
      const size = document.createElement('div');
      size.className = 'task-size';
      size.textContent = t.total > 0
        ? `${fmtBytes(t.bytes)} / ${fmtBytes(t.total)}（${pct}%）`
        : t.state === '转存中' || t.state === '保存中'
          ? '即将在浏览器下载管理器中出现…'
          : `已下载 ${fmtBytes(t.bytes)}`;
      li.appendChild(size);
    }

    list.appendChild(li);
  });
}

/* ================= 事件 ================= */

function bindEvents() {
  // 模式切换
  $('#modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.prefs.mode = btn.dataset.v;
    renderModeSeg();
    renderAll();
    savePrefs();
  });

  // 格式切换
  $('#fmtSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    state.prefs.fmt = btn.dataset.v;
    renderAll();
    savePrefs();
  });

  // 分P / 剧集切换
  $('#partSel').addEventListener('change', async () => {
    setStatus('loading', '正在获取清晰度列表…');
    await Promise.all([loadPlay('dash'), loadPlay('mp4')]);
    setStatus('ok');
    renderAll();
  });

  // 清晰度切换（DASH 下需联动编码列表）
  $('#qualitySel').addEventListener('change', () => {
    if (state.prefs.fmt === 'dash') renderCodecSel();
  });

  $('#codecSel').addEventListener('change', (e) => {
    state.prefs.codec = parseInt(e.target.value, 10) || 7;
    savePrefs();
  });

  // 下载
  $('#downloadBtn').addEventListener('click', download);

  // 复制 ffmpeg 命令
  $('#copyCmd').addEventListener('click', async (e) => {
    const cmd = $('#ffmpegCmd').textContent;
    try {
      await navigator.clipboard.writeText(cmd);
      e.target.textContent = '✓ 已复制';
    } catch {
      // 降级：选中文本
      const range = document.createRange();
      range.selectNodeContents($('#ffmpegCmd'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      e.target.textContent = '已选中，按 Ctrl+C 复制';
    }
    setTimeout(() => (e.target.textContent = '复制命令'), 1800);
  });

  // 后台进度推送
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'TASKS') {
      state.tasks = msg.tasks;
      renderTasks();
    }
  });
}

function savePrefs() {
  chrome.storage.local.set({ prefs: state.prefs }).catch(() => {});
}

/* ================= 下载 ================= */

async function download() {
  if (!state.info) return;
  const item = currentItem();
  if (!item) return;

  // 下拉列表为空（接口数据未就绪或不可用）时阻止无效请求
  if (state.prefs.mode === 'audio' && !$('#audioSel').value) {
    toast('音频列表为空，请稍后重试或刷新B站页面');
    return;
  }
  if (state.prefs.mode === 'video' && !$('#qualitySel').value) {
    toast('清晰度列表为空，请稍后重试或刷新B站页面');
    return;
  }

  const base = {
    kind: state.info.kind,
    bvid: state.info.kind === 'ugc' ? state.info.bvid : undefined,
    epId: item.epId,
    cid: item.cid,
    title: state.info.title,
    partLabel: (state.info.items || []).length > 1 ? item.label : '',
  };

  let payload;
  if (state.prefs.mode === 'audio') {
    payload = { ...base, mode: 'audio', audioId: parseInt($('#audioSel').value, 10) };
  } else if (state.prefs.fmt === 'mp4') {
    payload = { ...base, mode: 'mp4', qn: parseInt($('#qualitySel').value, 10) };
  } else {
    payload = {
      ...base,
      mode: 'dash',
      qn: parseInt($('#qualitySel').value, 10),
      codecid: parseInt($('#codecSel').value, 10) || 7,
      audioId: parseInt($('#dashAudioSel').value, 10),
    };
  }

  const btn = $('#downloadBtn');
  btn.disabled = true;
  btn.textContent = '正在获取下载地址…';
  const res = await send({ type: 'DOWNLOAD', payload });
  btn.disabled = false;
  btn.textContent = '⬇ 开始下载';

  if (!res.ok) {
    toast('下载失败：' + res.error);
    return;
  }

  if (res.ffmpeg) {
    $('#ffmpegCmd').textContent = res.ffmpeg;
    $('#ffmpegTip').hidden = false;
  } else {
    $('#ffmpegTip').hidden = true;
  }
  toast('已开始下载，可在浏览器下载管理器中查看');
}
