# B站视频下载扩展 · 开发踩坑实录

> 记录本项目（MV3 浏览器扩展下载 B 站视频）从「用不了」到「E2E 全链路通过」、再到「一键打包分发」过程中踩过的所有坑。
> 每个坑按 **现象 → 排查 → 根因 → 修复 → 教训** 组织，供后来者避雷。
>
> 环境：Chrome/Edge（Manifest V3）· Windows · 2026-08

---

## 坑 1：Wbi 签名正则写反，触发 -352 风控

### 现象
弹窗显示「请求错误」。B 站接口返回 `{"code":-352,"message":"请求错误"}`（风控拦截）。

### 排查
1. 先怀疑 DNR 规则非法导致 Service Worker 启动崩溃（上一轮的修复方向，**误判**）；
2. 写 Node 脚本用 `vm` 模块直接模拟运行 service-worker.js，把消息处理链路在本地跑起来，稳定复现出「请求错误」；
3. 单独用 Node 直连 B 站接口做对照实验：
   - `nav` 接口带浏览器 UA → `code=0` 正常；
   - `view` 接口**不带 wbi 签名** → `code=0` 正常！
   - 说明问题不在网络、不在登录态，而在**我方生成的签名本身**。

### 根因
Wbi 签名要求对参数值剔除 `!'()*` 四个字符，官方算法：

```js
value.replace(/[!'()*]/g, '')   // 正确：删除这4个字符
```

我写成了：

```js
String(p[k]).replace(/[^!'()*]/g, '')  // 错误：^ 取反，删除"除这4个字符以外"的一切
```

**一个 `^` 之差**：所有参数值（bvid、cid…）被清成空串，`w_rid` 全错。B 站对「带 w_rid 但校验不过」的请求直接 -352 风控，且错误信息只有一句「请求错误」，极具迷惑性。

### 修复
改正正则为 `[!'()*]`，并用独立脚本验证签名后的请求 `code=0`。

### 教训
- 正则字符类取反 `[^...]` 是高危笔误点，写完应立刻用实际值跑一遍单测；
- B 站「-352 请求错误」= wbi 签名错误/风控，可优先核对签名算法，不要先怀疑网络与登录态。

---

## 坑 2：BV 号被 toUpperCase() 毁掉，接口 -404

### 现象
修复坑 1 后，弹窗显示「啥都木有」。接口返回 `{"code":-404,"message":"啥都木有"}`。

### 排查
1. E2E 脚本（Playwright 加载扩展）里抓包，直接看到了凶手：

```
[REQ] https://api.bilibili.com/x/web-interface/view?bvid=BV1WNSVZ9EHB&...
                                              ^^^^^^^^^^^ 全大写（错误）
原始 URL：                        BV1WNsVz9EhB  混合大小写（正确）
```

### 根因
`parsePageUrl` 解析出 BV 号后画蛇添足地执行了 `m[1].toUpperCase()`。**BV 号是 Base58 编码、大小写敏感**，`BV1WNsVz9EhB ≠ BV1WNSVZ9EHB`，大写化后 B 站查无此稿。

之所以会写这行，是参照了 av 号/ep 号「数字统一」的习惯，但 BV 是字符串 ID，不能做任何大小写归一。

### 修复
```js
// 错误
return { kind: 'ugc', bvid: m[1].toUpperCase(), ... };
// 正确：BV 号原样保留，绝不 toUpperCase
return { kind: 'ugc', bvid: m[1], ... };
```

### 教训
- 字符串型 ID（BV 号、抖音 awid、YouTube 11 位 videoId 等）一律**原样透传**，禁止大小写转换；
- `-404 啥都木有` 在 B 站语境下优先怀疑「ID 被程序改写」，抓包看实际出站参数 10 秒定位。

---

## 坑 3：manifest 缺 CDN 域名权限，PCDN 节点下载失败

### 现象
音频流下载一直卡在「进行中 0/0」，视频流报 `SERVER_FORBIDDEN`。`downloads.search` 显示音频卡在：

```
https://xy113x207x85x219xy.mcdn.bilivideo.cn:8082/v1/resource/...
```

### 根因
manifest 的 `host_permissions` 只声明了 `bilivideo.com`，而 B 站近年大量把未登录流量调度到 `*.mcdn.bilivideo.cn`（PCDN 节点，带 `:8082` 端口）。无 host 权限的域，扩展发起的请求受限。

### 修复
```json
"host_permissions": [
  "*://*.bilibili.com/*",
  "*://*.bilivideo.com/*",
  "*://*.bilivideo.net/*",
  "*://*.bilivideo.cn/*",
  "*://*.akamaized.net/*",
  "*://*.hdslb.com/*",
  "*://*.acgvideo.com/*"
]
```

### 教训
- B 站 CDN 域名是一整个家族（`.com/.net/.cn` + `akamaized` + `hdslb`），host_permissions 要按**域名族**声明；
- 排查下载类问题务必用 `chrome.downloads.search({id})` 拿 `error` 字段和真实 `url`，比猜快得多。

---

## 坑 4（核心大坑）：chrome.downloads 的请求无法携带 Referer，DNR 救不了

### 现象
API 链路全部正常，但把 CDN 直链交给 `chrome.downloads.download` 后必 403 `SERVER_FORBIDDEN`。

### 排查过程（连环试错，全部失败）

先做对照实验确认 CDN 的校验规则（Node 直连，Range 拉 1KB）：

| 请求头 | 结果 |
| --- | --- |
| 带 `Referer: https://www.bilibili.com/` | HTTP 206 ✅ |
| 带 Referer + Origin | HTTP 206 ✅ |
| 不带 Referer | HTTP 403 ❌ |

结论：**CDN 只认 Referer**。于是开始想方设法给下载请求加 Referer：

| 尝试 | 结果 |
| --- | --- |
| ① DNR `requestDomains` + `modifyHeaders` | ❌ 无效（音频"成功"是假象——PCDN 节点 mcdn.bilivideo.cn 不校验 Referer，主 CDN bilivideo.com 照样 403） |
| ② DNR 去掉 `resourceTypes` 限制 | ❌ 无效 |
| ③ DNR `urlFilter: '||bilivideo.com'`（每域名一条规则） | ❌ 无效 |
| ④ `chrome.downloads.download({ headers: [{name:'Referer',...}] })` | ❌ 直接抛 `Error: Unsafe request header name` |

决定性实验（区分「DNR 对 fetch 生效」vs「对 downloads 不生效」）：

```
扩展页面内 fetch(直链)          → 200 ✅（DNR 给 fetch 加上了 Referer）
扩展调用 chrome.downloads(直链) → 403 ❌（同一 URL、同一 DNR 规则）
```

### 根因（两条 Chrome 平台限制叠加）

1. **`chrome.downloads` 发起的下载请求不经过 DNR modifyHeaders 规则**（实测 requestDomains / urlFilter / 不限 resourceTypes 三种写法均不命中）；
2. **`chrome.downloads.download` 的 `headers` 参数禁设 Referer/Origin** 等 forbidden header，写入即抛 `Unsafe request header name`。

也就是说：MV3 下没有任何官方途径让「浏览器下载管理器发起的请求」携带自定义 Referer。这是 B 站（以及众多校验 Referer 的 CDN）类下载扩展的共同死穴。

### 修复：流式下载中转架构

```
Service Worker fetch(特权上下文，可带 Referer)   ← CDN 放行 ✅
   │ 流式写入 OPFS 临时文件（逐块广播进度）
   ▼
BroadcastChannel 把 File 发给 Offscreen Document
   │ URL.createObjectURL(file)
   ▼
blob URL 传回 Service Worker
   │ chrome.downloads.download({url: blobUrl, filename})
   ▼
浏览器下载管理器保存到用户下载目录 → 自动清理 OPFS 临时文件
```

关键认知：
- **SW 的 fetch 可以带 Referer**（扩展有 host 权限的域不受 forbidden header 限制）；
- **SW 没有 `URL.createObjectURL`**，所以必须借助 Offscreen Document（`chrome.offscreen`，reasons: `BLOBS`）；
- blob URL 下载完后要在 offscreen 里 `revokeObjectURL`，OPFS 临时文件要在 SW 里 `removeEntry`，两处都要清理。

### 教训
- 需要自定义请求头的下载，**放弃让下载管理器直接拉 URL**，改「扩展先拉、blob 转交」；
- DNR 只对页面/扩展自身发起的网络请求可靠生效，**不要指望它拦截/修改浏览器内部管线的请求**（downloads、以及部分 prefetch）。

---

## 坑 5：Offscreen Document 里没有 chrome.downloads

### 现象
第一版中转架构里，让 offscreen 收到 File 后直接调 `chrome.downloads.download`，报：

```
TypeError: Cannot read properties of undefined (reading 'download')
```

### 根因
Offscreen Document 是权限受限的托管页面，**不注入大部分 chrome.* 特权 API**（含 `chrome.downloads`）。它只该做 DOM 相关的事（本例：createObjectURL）。

### 修复
职责重新划分：offscreen 只负责 `createObjectURL` 并把 blob URL 通过 BroadcastChannel 传回；下载调用移回 SW。

### 教训
- Offscreen Document 的定位是「SW 干不了的 DOM 工具人」：createObjectURL、canvas、音视频解析可以；**特权 API 一律不要在 offscreen 里调**；
- BroadcastChannel 的消息是广播，记得用 `taskId` 过滤归属，避免多任务并发时串线。

---

## 坑 6：Offscreen 并发创建竞态

### 现象
DASH 模式同时下载「视频+音频」两个文件，第二个任务报：

```
Only a single offscreen document may be created.
```

### 根因
两个 `streamDownload` 并行执行 `ensureOffscreen()`：都查到「不存在」→ 都去 create → 后者撞上「只允许一个 offscreen document」限制。

### 修复
```js
try {
  await chrome.offscreen.createDocument({...});
} catch (e) {
  // 并发竞态：已被别的任务创建，忽略即可
  if (!/single offscreen/i.test(String(e))) throw e;
}
```

### 教训
「查一下再创建」在并发下不是原子操作，**必须捕获重复创建异常**做幂等兜底（类似数据库的 insert-or-ignore）。

---

## 坑 7：PowerShell 5.1 读 UTF-8 无 BOM 脚本，中文变乱码导致语法错误

### 现象
编写 `build.ps1`（含中文输出）后运行，直接解析失败：

```
The string is missing the terminator: ".
鍙戠粰浠栦汉锛氬鏂硅В鍘嬪悗鎸変笂闈㈡柟寮忓姞杞藉嵆鍙?   ← 明显的 GBK 乱码
```

### 根因
Windows PowerShell 5.1 对**无 BOM 的 UTF-8 脚本按 ANSI(GBK) 解码**，中文字符被拆坏，恰好"吃掉"了字符串的闭合引号，于是报「字符串缺少终止符」——报错位置与真正的编码问题相距甚远，极具迷惑性。

### 修复
给 `.ps1` 文件写入 **UTF-8 with BOM**（PowerShell 5.1 与 PowerShell 7 均能正确识别）：

```powershell
$p = 'build.ps1'
$c = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $c, [System.Text.UTF8Encoding]::new($true))
```

### 教训
- 在 Windows 上分发含中文的 PowerShell 脚本，**一律存 UTF-8 BOM**（编辑器右下角可直接切换编码）；
- PowerShell 报「字符串缺少终止符」但肉眼看引号成对，先怀疑编码，再怀疑语法。

---

## 坑 8：Compress-Archive 生成非规范 zip（反斜杠路径）

### 现象
用 `Compress-Archive` 打包扩展后检查 zip 条目，路径分隔符是反斜杠：

```
background\service-worker.js   ← ZIP 规范要求正斜杠
background/service-worker.js   ← 应该是这样
```

### 根因
Windows PowerShell 5.1 的 `Compress-Archive` 基于老版 .NET 实现，条目名沿用了 Windows 路径分隔符 `\`。ZIP 规范（PKWARE APPNOTE）规定条目名用 `/`。多数解压工具容错处理了，但**严格的工具链（如部分 CI、商店上传器）会把整个路径当成文件名**，导致 manifest.json 不在 zip 根目录而被拒。

### 修复
改用 .NET `ZipArchive` 手动写入条目，路径统一正斜杠：

```powershell
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs  = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$entry = $zip.CreateEntry(($relPath -replace '\\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
...
```

### 教训
- 需要分发给「严格消费者」的 zip，别用 PS5.1 的 `Compress-Archive`，用 .NET `ZipArchive` 自己控制条目名（PowerShell 7 已修复该问题）；
- 打包后永远用 `ZipFile::OpenRead` 列一遍条目，肉眼确认路径分隔符与目录层级（本扩展的商店包要求 zip 根直接是 `manifest.json`）。

---

## 附 A：这些坑背后的通用经验

1. **错误码是地图**：B 站 `-352` → 签名/风控；`-404` → 资源 ID 不对；CDN `403` → Referer/防盗链。先查表再动手。
2. **正则取反 `[^...]` 是高危区**：涉及「剔除字符」的算法，写完必须用真实数据单测（wbi 签名这个 bug 如果一开始就跑官方测试向量，30 秒就能发现）。
3. **字符串 ID 永远原样透传**：任何 normalize（大小写、trim、编码转换）都是破坏。
4. **平台 API 的"能设"与"不能设"要实测**：文档写着有 `headers` 参数，但 forbidden header 名单把它变成陷阱；DNR 文档没说"不覆盖 downloads"，实测才知道。
5. **对照实验是最高效的调试手段**：本次三次关键突破全部来自最小对照——「带/不带 Referer 的 CDN 响应」「fetch vs downloads 同 URL 对比」「签名前后的接口响应」。

## 附 B：调试工具链（可复用）

| 手段 | 做法 | 解决了什么 |
| --- | --- | --- |
| Node `vm` 沙箱模拟 SW | 把 service-worker.js 在 `vm.createContext` 里跑，mock 掉 `chrome.*` 与 `importScripts`，直接调用消息处理器 | 不开浏览器即可复现/定位 API 层 bug（坑 1、2） |
| 最小 API 探针脚本 | Node 直连 B 站接口，控制变量（UA / Referer / wbi）逐项对比 | 确认风控触发条件、验证签名算法 |
| Playwright 加载扩展 E2E | `launchPersistentContext` + `--load-extension`（Chromium 开源版；branded Chrome 已禁用此参数），打开 `chrome-extension://<id>/popup/popup.html` 直接 `page.evaluate` 调 `chrome.runtime.sendMessage` | 全链路真实环境验证；抓包看 SW 实际出站请求（坑 2 的凶手就是抓包看到的） |
| `chrome.downloads.search({id})` | 查 `error`/`url`/`state` 字段 | 下载失败的真实原因（SERVER_FORBIDDEN、卡死 URL） |

> 注意：用户日常 Chrome/Edge 里调试扩展，直接在 `chrome://extensions` 开发者模式加载即可；Playwright 的 `--load-extension` 仅适用于开源 Chromium，且 headed 模式。

## 附 C：最终架构一图流

```
┌─ popup ──────────────────────────────────────────────┐
│ 选模式/清晰度 → runtime.sendMessage → 显示任务进度    │
└──────────────┬────────────────────────▲──────────────┘
               │ PARSE_PAGE / GET_PLAY /│TASKS 广播
               │ DOWNLOAD               │
┌─ service worker ─────────────────────┴───────────────┐
│ 解析 URL（BV 号原样保留！）                           │
│ B站 API + Wbi 签名（md5 + 混淆表）                    │
│ fetch(带 Referer) ──流式──▶ OPFS 临时文件             │
│ BroadcastChannel ◀──File──▶ offscreen(createObjectURL)│
│ chrome.downloads(blobUrl) ──▶ 用户下载目录            │
│ onChanged 终态 ▶ 清理 OPFS + 通知 offscreen 释放 blob │
└───────────────────────────────────────────────────────┘
```
