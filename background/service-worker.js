/**
 * B站视频下载助手 —— Background Service Worker (Manifest V3)
 *
 * 职责：
 *  1. 解析 popup 传来的页面 URL，识别视频（普通视频 UGC / 番剧影视 PGC）
 *  2. 调用 B 站接口（自动携带浏览器登录态 Cookie + Wbi 签名）
 *  3. 解析 DASH / MP4 播放地址，构造下载任务（仅音频 / 音频+视频）
 *  4. 通过 chrome.downloads 下发下载，并广播实时进度
 *  5. 维护 declarativeNetRequest 会话规则，为 CDN 请求附加 Referer/Origin
 */

importScripts('lib/md5.js');

/* ==================== 常量 ==================== */

const API = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  view: 'https://api.bilibili.com/x/web-interface/view',
  playurl: 'https://api.bilibili.com/x/player/playurl',
  season: 'https://api.bilibili.com/pgc/view/web/season',
  pgcPlayurl: 'https://api.bilibili.com/pgc/player/web/playurl',
};

/** 清晰度 id -> 描述 */
const QN_DESC = {
  127: '8K 超高清', 126: '杜比视界', 125: 'HDR 真彩', 120: '4K 超清',
  116: '1080P 60帧', 112: '1080P 高码率', 100: '智能修复', 80: '1080P 高清',
  74: '720P 60帧', 64: '720P 高清', 32: '480P 清晰', 16: '360P 流畅',
};
/** 需要大会员的清晰度 */
const MEMBER_QN = new Set([100, 112, 116, 120, 125, 126, 127]);
/** 音频 id -> 描述 */
const AUDIO_DESC = {
  30280: '192kbps', 30232: '132kbps', 30216: '64kbps',
  30250: '杜比全景声', 30251: 'Hi-Res 无损',
};
/** 视频编码 codecid -> 描述 */
const CODEC_DESC = { 7: 'H.264 / AVC', 12: 'H.265 / HEVC', 13: 'AV1' };

/** B 站视频 CDN 域名（用于 DNR 规则覆盖） */
const CDN_DOMAINS = [
  'bilivideo.com', 'bilivideo.net', 'bilivideo.cn', 'akamaized.net',
  'hdslb.com', 'acgvideo.com', 'mcdn.bilivideo.cn',
];

/* ==================== declarativeNetRequest ==================== */
/**
 * B 站 CDN 校验 Referer，浏览器下载请求默认无 Referer 会被拒绝。
 * 通过会话规则为所有指向 CDN 的请求附加 Referer/Origin。
 * Service Worker 每次被唤醒都会重新执行（幂等）。
 *
 * 每个 CDN 域名一条规则，condition 用 urlFilter（|| 锚定域名）：
 * downloads API 发起的请求在部分 Chromium 版本中不匹配 requestDomains，
 * 但 urlFilter 对浏览器下载请求稳定生效。
 */
async function ensureDnrRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: CDN_DOMAINS.map((_, i) => i + 1),
      addRules: CDN_DOMAINS.map((domain, i) => ({
        id: i + 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
          ],
        },
        condition: { urlFilter: `||${domain}` },
      })),
    });
  } catch (err) {
    // 不阻断扩展核心功能：若 DNR 不可用，CDN 下载仍可能在部分场景成功
    console.warn('[DNW] DNR 会话规则注册失败（CDN 可能 403）：', err);
  }
}
ensureDnrRules();

/* ==================== 登录态与 Wbi 签名 ==================== */

let wbiCache = null; // { keys: {imgKey, subKey}, loggedIn, ts }

/** 获取 nav 接口数据：Wbi 密钥 + 登录态（缓存 30 分钟） */
async function fetchNav() {
  if (wbiCache && Date.now() - wbiCache.ts < 30 * 60 * 1000) return wbiCache;
  const resp = await fetch(API.nav, { credentials: 'include' });
  const json = await resp.json();
  const imgUrl = json?.data?.wbi_img?.img_url;
  const subUrl = json?.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) throw new Error('无法获取 Wbi 密钥（接口异常）');
  wbiCache = {
    keys: {
      imgKey: imgUrl.split('/').pop().split('.')[0],
      subKey: subUrl.split('/').pop().split('.')[0],
    },
    loggedIn: json.code === 0,
    ts: Date.now(),
  };
  return wbiCache;
}

/** 通用 GET（自动携带 Cookie） */
async function fetchJson(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`网络请求失败（HTTP ${resp.status}）`);
  const json = await resp.json();
  if (json.code !== 0) throw new Error(json.message || `接口返回错误码 ${json.code}`);
  return json.data;
}

/** Wbi 混淆表（见 bilibili-API-collect 文档） */
const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 对请求参数做 Wbi 签名，返回完整 querystring */
function buildWbiQuery(params, imgKey, subKey) {
  const mixinKey = WBI_TAB.map((i) => (imgKey + subKey)[i]).join('').slice(0, 32);
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const qs = Object.keys(p)
    .sort()
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`
    )
    .join('&');
  return `${qs}&w_rid=${md5(qs + mixinKey)}`;
}

/** 带 Wbi 签名的 GET */
async function wbiGet(base, params) {
  const { keys } = await fetchNav();
  return fetchJson(`${base}?${buildWbiQuery(params, keys.imgKey, keys.subKey)}`);
}

/* ==================== 页面解析 ==================== */

/** 解析 B 站页面 URL，识别视频类型与编号 */
function parsePageUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/^([a-z0-9]+\.)?bilibili\.com$/i.test(u.hostname)) return null;
  let m;
  if ((m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/i))) {
    // 注意：BV 号为 Base58 编码且大小写敏感，必须原样保留，不能 toUpperCase
    return { kind: 'ugc', bvid: m[1], page: parseInt(u.searchParams.get('p') || '1', 10) || 1 };
  }
  if ((m = u.pathname.match(/^\/video\/av(\d+)/i))) {
    return { kind: 'ugc', aid: +m[1], page: parseInt(u.searchParams.get('p') || '1', 10) || 1 };
  }
  if ((m = u.pathname.match(/^\/bangumi\/play\/ep(\d+)/i))) {
    return { kind: 'pgc', epId: +m[1] };
  }
  if ((m = u.pathname.match(/^\/bangumi\/play\/ss(\d+)/i))) {
    return { kind: 'pgc', seasonId: +m[1] };
  }
  return null;
}

/** 获取视频元信息（标题、分P/剧集列表） */
async function fetchInfo(parse) {
  if (parse.kind === 'ugc') {
    const data = await wbiGet(API.view, parse.bvid ? { bvid: parse.bvid } : { aid: parse.aid });
    const pages = data.pages || [];
    return {
      kind: 'ugc',
      key: data.bvid,
      bvid: data.bvid,
      title: data.title,
      subtitle: `UP主：${data.owner?.name || '未知'}`,
      items: pages.map((p) => ({ cid: p.cid, label: `P${p.page} ${p.part || ''}`.trim() })),
      currentIdx: Math.min(Math.max((parse.page || 1) - 1, 0), Math.max(pages.length - 1, 0)),
    };
  }
  // 番剧 / 影视
  const data = await fetchJson(
    `${API.season}?${parse.epId ? 'ep_id=' + parse.epId : 'season_id=' + parse.seasonId}`
  );
  const eps = data.episodes || [];
  const idx = eps.findIndex((e) => e.id === parse.epId);
  return {
    kind: 'pgc',
    key: `ss${data.season_id}`,
    epId: parse.epId,
    title: data.title,
    subtitle: data.type_name || '番剧',
    items: eps.map((e) => ({
      cid: e.cid,
      epId: e.id,
      label: `${e.title || ''} ${e.long_title || ''}`.trim(),
    })),
    currentIdx: idx >= 0 ? idx : 0,
  };
}

/* ==================== 播放地址 ==================== */

/**
 * 请求播放地址
 * @param fmt 'dash' -> DASH 分离流（最高画质，含 4K/8K/Hi-Res）
 *            'mp4'  -> HTML5 平台 MP4 一体格式（即下即播，最高 1080P）
 */
async function fetchPlay(kind, { bvid, epId }, cid, fmt, qn) {
  const params = { cid };
  if (fmt === 'mp4') {
    Object.assign(params, { fnval: 1, platform: 'html5', high_quality: 1, qn: qn || 80 });
  } else {
    Object.assign(params, { fnval: 16, fourk: 1, qn: qn || 127 });
  }
  if (kind === 'ugc') params.bvid = bvid;
  else params.ep_id = epId;

  const base = kind === 'ugc' ? API.playurl : API.pgcPlayurl;
  return wbiGet(base, params);
}

/** 收集所有可用音频流（普通 AAC + 杜比 + Hi-Res），按码率降序 */
function collectAudios(dash) {
  const list = [];
  const push = (a, extraDesc) => {
    if (!a || !a.base_url) return;
    list.push({
      id: a.id,
      desc: AUDIO_DESC[a.id] || extraDesc || `${Math.round((a.bandwidth || 0) / 1000)}kbps`,
      bandwidth: a.bandwidth || 0,
      url: a.base_url || (a.backup_url && a.backup_url[0]),
    });
  };
  (dash.audio || []).forEach((a) => push(a));
  if (Array.isArray(dash.dolby?.audio)) dash.dolby.audio.forEach((a) => push(a, '杜比全景声'));
  if (dash.flac?.audio) push(dash.flac.audio, 'Hi-Res 无损');
  return list.sort((x, y) => y.bandwidth - x.bandwidth);
}

/** 把 playurl 响应规范成 popup 需要的列表结构（不含直链） */
function normalizePlay(data, fmt) {
  if (fmt === 'mp4') {
    const quality = data.quality;
    const qualities = (data.accept_quality || [quality]).map((qn, i) => ({
      qn,
      desc: (data.accept_description || [])[i] || QN_DESC[qn] || `Q${qn}`,
      member: MEMBER_QN.has(qn),
    }));
    return { fmt, qualities };
  }

  const dash = data.dash || {};
  const qMap = new Map();
  (dash.video || []).forEach((v) => {
    if (!v.base_url && !(v.backup_url && v.backup_url.length)) return;
    if (!qMap.has(v.id)) {
      qMap.set(v.id, { qn: v.id, desc: QN_DESC[v.id] || `Q${v.id}`, member: MEMBER_QN.has(v.id), codecs: new Set() });
    }
    qMap.get(v.id).codecs.add(v.codecid);
  });
  const qualities = [...qMap.values()]
    .sort((a, b) => b.qn - a.qn)
    .map((q) => ({
      qn: q.qn,
      desc: q.desc,
      member: q.member,
      codecs: [...q.codecs].sort((a, b) => (a === 7 ? -1 : b === 7 ? 1 : a - b)),
    }));
  const audios = collectAudios(dash).map((a) => ({ id: a.id, desc: a.desc, bandwidth: a.bandwidth }));
  return { fmt, qualities, audios };
}

/* ==================== 下载管理 ==================== */

const downloadTasks = new Map(); // downloadId -> task

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function serializeTasks() {
  return [...downloadTasks.values()].map((t) => ({
    id: t.id, label: t.label, filename: t.filename,
    bytes: t.bytes, total: t.total, state: t.state,
  }));
}

function broadcastTasks() {
  chrome.runtime.sendMessage({ type: 'TASKS', tasks: serializeTasks() }).catch(() => {});
}

/* ==================== 流式下载中转（核心） ====================
 * B 站 CDN 校验 Referer，而浏览器 downloads API 的请求既不匹配 DNR
 * modifyHeaders 规则、其 headers 参数也禁止设置 Referer。
 * 因此下载链路为：
 *   SW fetch(带 Referer) → 流式写入 OPFS → BroadcastChannel 传 File
 *   → offscreen document createObjectURL → chrome.downloads
 */

const XFER_CHANNEL = 'bilibili-dl-transfer';
let taskSeq = 0;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: '为流式下载完成的媒体文件创建 blob URL 以移交浏览器下载管理器',
    });
  } catch (e) {
    // 并发调用时可能已被其他任务创建，忽略"single offscreen"类错误
    if (!/single offscreen/i.test(String(e))) throw e;
  }
}

async function removeOpfsFile(name) {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch { /* 忽略清理失败 */ }
}

function notifyOffscreenRelease(taskId) {
  try {
    const ch = new BroadcastChannel(XFER_CHANNEL);
    ch.postMessage({ taskId, release: true });
    ch.close();
  } catch { /* offscreen 可能已关闭 */ }
}

async function streamDownload(task) {
  const { url, filename } = task;
  // OPFS 内使用扁平随机名（下载文件名含子目录 Bilibili/ 前缀，OPFS 无需对齐）
  const opfsName = `dnw-${Date.now()}-${taskSeq}-${sanitizeFilename(filename.split('/').pop())}`;

  try {
    await ensureOffscreen();

    const resp = await fetch(url, {
      credentials: 'omit',
      headers: {
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
      },
    });
    if (!resp.ok) throw new Error(`CDN 拒绝请求（HTTP ${resp.status}）`);
    task.total = task.total || +(resp.headers.get('content-length') || 0);

    // 流式写入 OPFS
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(opfsName, { create: true });
    const writer = await fh.createWritable();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      task.bytes += value.byteLength;
      broadcastTasks();
    }
    await writer.close();

    task.state = '转存中';
    broadcastTasks();

    // 请 offscreen 为 File 创建 blob URL
    const file = await fh.getFile();
    const blobUrl = await new Promise((resolve, reject) => {
      const xfer = new BroadcastChannel(XFER_CHANNEL);
      const timer = setTimeout(() => {
        xfer.close();
        reject(new Error('创建 blob URL 超时'));
      }, 30 * 1000);
      xfer.onmessage = (ev) => {
        const d = ev.data || {};
        if (d.taskId !== task.id) return;
        clearTimeout(timer);
        xfer.close();
        if (d.error) reject(new Error(d.error));
        else resolve(d.blobUrl);
      };
      xfer.postMessage({ taskId: task.id, file });
    });

    // 移交浏览器下载管理器（blob URL 同源可用）
    task.state = '保存中';
    broadcastTasks();
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    task.downloadId = downloadId;
    task.opfsName = opfsName;
    // 终态由 chrome.downloads.onChanged 统一处理（见下方监听器）
  } catch (err) {
    task.state = '失败：' + (err?.message || String(err));
    broadcastTasks();
    removeOpfsFile(opfsName);
  }
}

/** 下载终态处理（blob URL 下载完成/中断时） */
chrome.downloads.onChanged.addListener((delta) => {
  const s = delta.state && delta.state.current;
  if (s !== 'complete' && s !== 'interrupted') return;
  for (const task of downloadTasks.values()) {
    if (task.downloadId !== delta.id) continue;
    task.state = s === 'complete' ? '已完成' : '已中断';
    broadcastTasks();
    notifyOffscreenRelease(task.id); // 释放 blob URL
    removeOpfsFile(task.opfsName); // 清理 OPFS 临时文件
  }
});

async function startDownloadItems(items) {
  const ids = [];
  for (const item of items) {
    const id = 't' + ++taskSeq;
    downloadTasks.set(id, {
      id, label: item.label, filename: item.filename,
      url: item.url, bytes: 0, total: item.size || 0, state: '进行中',
    });
    ids.push(id);
    // 并行流式下载（不阻塞消息响应）
    streamDownload(downloadTasks.get(id));
  }
  broadcastTasks();
  return ids;
}

/** 生成 ffmpeg 无损合并命令（相对浏览器下载目录） */
function buildFfmpegCmd(videoItem, audioItem) {
  const out = videoItem.filename.replace(/\.mp4$/i, '') + '_合并成片.mp4';
  return `ffmpeg -i "${videoItem.filename}" -i "${audioItem.filename}" -c copy "${out}"`;
}

/**
 * 处理下载请求（此时实时请求最新直链，避免链接过期）
 * payload: { kind, bvid, epId, cid, title, partLabel, mode, qn, codecid, audioId }
 *   mode: 'audio' 仅音频 | 'mp4' MP4 一体 | 'dash' DASH 音视频分离
 */
async function handleDownload(p) {
  const fmt = p.mode === 'mp4' ? 'mp4' : 'dash';
  const data = await fetchPlay(p.kind, { bvid: p.bvid, epId: p.epId }, p.cid, fmt, p.mode === 'mp4' ? p.qn : 127);

  const safeTitle = sanitizeFilename(p.title || 'bilibili');
  const safePart = p.partLabel ? ' - ' + sanitizeFilename(p.partLabel) : '';
  const prefix = `Bilibili/${safeTitle}${safePart}`;
  const items = [];

  if (p.mode === 'mp4') {
    const seg = (data.durl || [])[0];
    if (!seg || !seg.url) throw new Error('未获取到 MP4 直链（该内容可能不支持 HTML5 格式，请改用 DASH 模式）');
    const desc = QN_DESC[data.quality] || `Q${data.quality}`;
    items.push({ url: seg.url, filename: `${prefix} [${desc}].mp4`, label: `MP4 一体（${desc}）`, size: seg.size });
  } else {
    const dash = data.dash || {};
    // 视频流（仅 dash 模式需要）
    if (p.mode === 'dash') {
      const videos = (dash.video || []).filter((v) => v.id === p.qn);
      if (!videos.length) throw new Error(`清晰度 ${QN_DESC[p.qn] || p.qn} 不可用，请重新选择`);
      const v = videos.find((x) => x.codecid === p.codecid) || videos.find((x) => x.codecid === 7) || videos[0];
      const desc = QN_DESC[v.id] || `Q${v.id}`;
      const url = v.base_url || (v.backup_url && v.backup_url[0]);
      if (!url) throw new Error('视频流直链获取失败');
      items.push({ url, filename: `${prefix} [${desc}·视频].mp4`, label: `视频 ${desc}（${CODEC_DESC[v.codecid] || v.codecs || ''}）` });
    }
    // 音频流（audio 与 dash 模式都需要）
    const audios = collectAudios(dash);
    if (!audios.length) throw new Error('未获取到可用音频流');
    const audio = audios.find((a) => a.id === p.audioId) || audios[0];
    items.push({ url: audio.url, filename: `${prefix} [音频·${audio.desc}].m4a`, label: `音频 ${audio.desc}` });
  }

  const ids = await startDownloadItems(items);
  const ffmpeg =
    p.mode === 'dash'
      ? buildFfmpegCmd(items.find((i) => i.label.startsWith('视频')), items.find((i) => i.label.startsWith('音频')))
      : null;
  return { ids, ffmpeg };
}

/* ==================== 消息路由 ==================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'PARSE_PAGE': {
          const parse = parsePageUrl(msg.url || '');
          if (!parse) {
            return sendResponse({
              ok: false,
              error:
                '当前页面不是可识别的B站视频页。请打开普通视频（/video/BV…）或番剧（/bangumi/play/…）页面后重试。',
            });
          }
          const nav = await fetchNav().catch(() => null);
          const info = await fetchInfo(parse);
          return sendResponse({ ok: true, parse, info, loggedIn: nav ? nav.loggedIn : true });
        }
        case 'GET_PLAY': {
          const data = await fetchPlay(msg.kind, { bvid: msg.bvid, epId: msg.epId }, msg.cid, msg.fmt, msg.qn);
          return sendResponse({ ok: true, data: normalizePlay(data, msg.fmt) });
        }
        case 'DOWNLOAD': {
          const result = await handleDownload(msg.payload);
          return sendResponse({ ok: true, ...result });
        }
        case 'GET_TASKS':
          return sendResponse({ ok: true, tasks: serializeTasks() });
        default:
          return sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
      }
    } catch (err) {
      console.warn('[DNW] 消息处理失败:', err);
      return sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // 异步 sendResponse
});

console.log('[DNW] B站视频下载助手 Service Worker 已启动');
