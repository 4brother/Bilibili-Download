/**
 * Offscreen Document：为 Service Worker 流式下载完成的 OPFS 文件创建
 * blob URL（Service Worker 环境没有 URL.createObjectURL）。
 *
 * 为什么需要它：
 *  - B 站 CDN 校验 Referer，浏览器 downloads API 的请求无法携带 Referer
 *    （DNR 对 downloads 请求不生效、headers 参数禁设 Referer）
 *  - Service Worker 中 fetch 可携带 Referer，但 SW 没有
 *    URL.createObjectURL，无法把文件交给下载管理器
 *  - 注意：offscreen document 中不可用 chrome.downloads API，
 *    下载动作由 SW 收到 blobUrl 后调用
 */

const XFER_CHANNEL = 'bilibili-dl-transfer';

const ch = new BroadcastChannel(XFER_CHANNEL);

/** taskId -> blobUrl（下载完成后释放） */
const blobUrls = new Map();

ch.onmessage = (ev) => {
  const { taskId, file, release } = ev.data || {};
  if (!taskId) return;

  if (release) {
    const url = blobUrls.get(taskId);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(taskId);
    }
    return;
  }

  if (!file) return;
  try {
    const blobUrl = URL.createObjectURL(file);
    blobUrls.set(taskId, blobUrl);
    ch.postMessage({ taskId, blobUrl });
  } catch (e) {
    ch.postMessage({ taskId, error: String(e) });
  }
};
