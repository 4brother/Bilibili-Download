# B站视频下载助手（Chrome / Edge 扩展）

一个基于 **Manifest V3** 的浏览器扩展，用于下载哔哩哔哩（bilibili.com）的视频，支持：

- 🎧 **仅音频**：下载音频流（`.m4a`），可直接用播放器播放
- 🎬 **音频+视频**：
  - **MP4 一体格式**：单文件即下即播（最高 1080P），无需合并
  - **DASH 分离格式**：音视频分别下载，可选最高画质（1080P 高码率 / 4K / 8K / 杜比视界 / HDR / Hi-Res），下载后用 ffmpeg 一键无损合并

同时兼容 **Chrome** 和 **Edge**（均为 Chromium 内核，安装方式相同），自动携带浏览器已登录的B站账号 Cookie，登录用户可直接下载 1080P 等更高清晰度。

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| 仅音频下载 | 从 DASH 流中提取音频（64k / 132k / 192k，大会员可见杜比全景声 / Hi-Res） |
| 音频+视频（MP4 一体） | 走 HTML5 平台接口，得到单个 MP4 文件，下载完直接播放，适合大多数场景 |
| 音频+视频（DASH 分离） | 分别下载视频流与音频流（最高可选 4K/8K），附赠一键复制的 ffmpeg 无损合并命令 |
| 自动携带登录态 | 复用浏览器B站 Cookie（SESSDATA），登录用户可下载 1080P，大会员可下载 4K/8K/Hi-Res |
| Wbi 签名 | 内置 B 站 Wbi 接口签名算法（md5 + 混淆表），接口调用更稳定 |
| 多P / 番剧支持 | 支持普通视频多分P选择、番剧/影视（ep/ss 链接）整季选集 |
| 实时进度 | 弹窗内实时展示每个文件的下载进度（字节级）；下载在后台执行，关闭弹窗不影响 |
| 记住偏好 | 自动记住上次选择的下载模式 / 格式 / 编码 |

> 技术要点：B 站 CDN 会校验 Referer，扩展通过 `declarativeNetRequest` 会话规则为下载请求自动附加 `Referer: https://www.bilibili.com/`，保证直链可下载。

---

## 📦 安装（开发者模式加载）

### Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
2. 打开右上角的 **「开发者模式」** 开关
3. 点击左上角 **「加载已解压的扩展程序」**
4. 选择本项目文件夹 `Bilibili-Download`（即包含 `manifest.json` 的目录）
5. 工具栏出现「B站视频下载助手」图标即安装成功（可点击拼图图标将其固定到工具栏）

### Edge

1. 打开 Edge，地址栏输入 `edge://extensions/` 回车
2. 打开左侧（或右下角设置中）的 **「开发人员模式」** 开关
3. 点击 **「加载解压缩的扩展」**
4. 选择本项目文件夹 `Bilibili-Download`
5. 安装成功后，点击工具栏拼图图标，将「B站视频下载助手」固定即可

> 修改代码后，需在扩展管理页点击该扩展卡片上的 **刷新（↻）** 按钮重新加载。

---

## 📦 打包 / 分发

项目内置一键打包脚本（Windows，无需安装任何依赖）：

### 方式一：双击打包（推荐）

双击项目根目录的 **`build.bat`** 即可。

### 方式二：命令行打包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
```

### 打包产物（输出到 `dist/` 目录）

| 产物 | 用途 |
| --- | --- |
| `dist/unpacked/` | 干净的「加载已解压的扩展程序」目录（只含运行所需文件），发给别人后按上文开发者模式步骤加载 |
| `dist/bilibili-downloader_v1.0.0.zip` | 商店上传包（zip 根目录即 `manifest.json`），可直接用于 **Chrome Web Store** / **Edge Add-ons** 上传审核，或作为归档分发 |

### 打包前自动检查

脚本每次运行会依次执行并拦截问题：

1. `manifest.json` JSON 合法性与版本号格式校验
2. manifest 引用的资源（图标 / popup / service worker / offscreen）存在性检查
3. 全部 JS 文件语法检查（检测到 Node 时）
4. 按白名单组装 `dist/unpacked/`（自动排除 README、调试文档、开发残留）
5. 用 .NET ZipArchive 生成规范 zip（条目路径为正斜杠，兼容商店上传器）

> 发版提示：每次上传商店新版本前，记得把 `manifest.json` 的 `version` 加一位（如 `1.0.0` → `1.0.1`），zip 文件名会自动带上版本号。

---

## 🚀 使用方法

### 第一步：打开B站视频页

在浏览器中打开任意B站页面，支持的地址形式：

- 普通视频：`https://www.bilibili.com/video/BVxxxxxxxx`（支持多分P，`?p=2` 会自动定位）
- av 号链接：`https://www.bilibili.com/video/av170001`
- 番剧 / 影视：`https://www.bilibili.com/bangumi/play/epxxxxx` 或 `ssxxxxx`

### 第二步：点击扩展图标

点击工具栏中的扩展图标打开弹窗，扩展会自动识别当前页面并显示：

- 视频标题、UP主（或番剧类型）
- 多P视频 / 多集番剧的 **选P / 选集** 下拉框

### 第三步：选择下载内容

**🎧 仅音频**

1. 切换到「仅音频」
2. 在「音质」下拉框中选择码率（64kbps / 132kbps / 192kbps，大会员账号可见杜比全景声、Hi-Res 无损）
3. 点击「开始下载」，得到一个 `.m4a` 文件，可直接播放（或用 ffmpeg 转成 mp3）

**🎬 音频+视频（方式一：MP4 一体，推荐新手）**

1. 切换到「音频+视频」，格式选择「MP4 一体」
2. 选择清晰度（最高 1080P）
3. 点击「开始下载」，得到一个完整的 `.mp4` 文件，下载完直接观看

**🎬 音频+视频（方式二：DASH 分离，追求最高画质）**

1. 格式选择「DASH 分离」
2. 选择清晰度（登录后可到 1080P；大会员可选 1080P 高码率 / 4K / 8K / 杜比视界 / HDR）
3. 按需选择视频编码（默认 H.264/AVC，兼容性最好；HEVC/AV1 体积更小）
4. 选择伴生音质（建议默认最高）
5. 点击「开始下载」，会**同时下载两个文件**：「…[1080P 高清·视频].mp4」和「…[音频·192kbps].m4a」
6. 下载完成后按弹窗提示合并（见下节）

### 第四步：查看进度

- 弹窗内会实时显示每个文件的下载进度条
- 下载任务由浏览器下载管理器接管，**关闭弹窗、切换标签页都不影响下载**
- 所有文件统一保存在下载目录的 `Bilibili/` 子文件夹内，文件名形如：`视频标题 - P1 xxx [1080P 高清·视频].mp4`

---

## 📼 DASH 音视频合并（ffmpeg）

B 站的 DASH 格式把视频和音频拆成两个流。下载完成后，用 ffmpeg 可以**无损、秒级**合并（不重新编码，画质无损）。

### 1. 安装 ffmpeg

| 系统 | 方法 |
| --- | --- |
| Windows | 命令行执行 `winget install Gyan.FFmpeg`；或到 [ffmpeg 官网](https://ffmpeg.org/download.html) 下载 build 解压 |
| macOS | `brew install ffmpeg` |
| Linux | `sudo apt install ffmpeg`（Debian/Ubuntu）或对应包管理器 |

### 2. 执行合并命令

在下载弹窗中点击「DASH 分离」下载后，会自动生成合并命令，**点击「复制命令」**，然后：

1. 打开浏览器下载目录，进入 `Bilibili/` 文件夹
2. 在文件夹地址栏输入 `cmd` 回车（Windows）/ 在终端 `cd` 到该目录（macOS/Linux）
3. 粘贴命令并回车，例如：

```bash
ffmpeg -i "视频标题 - P1 xxx [1080P 高清·视频].mp4" -i "视频标题 - P1 xxx [音频·192kbps].m4a" -c copy "视频标题 - P1 xxx [1080P 高清·视频]_合并成片.mp4"
```

几秒后即可得到音画合一的完整 MP4。

> 说明：`-c copy` 表示直接复制流而不重新编码，因此速度极快且完全无损。
>
> 小技巧：其实「视频.mp4」与「音频.m4a」两个文件本身也能分别直接播放，只是视频文件没有声音。

---

## ℹ️ 清晰度与登录说明

| 账号状态 | 可下载的最高清晰度 |
| --- | --- |
| 未登录 | 360P / 480P（仅有低码率音频） |
| 普通登录（免费） | 1080P 高清、720P60 等 |
| 大会员 | 1080P 高码率、1080P60、4K、8K、杜比视界、HDR、杜比全景声、Hi-Res |

- 扩展自动使用浏览器中已登录的B站 Cookie，**无需额外配置**。若弹窗顶部出现「未检测到登录状态」的黄色提示，请先在浏览器登录 [bilibili.com](https://www.bilibili.com)，再重新打开扩展弹窗。
- 番剧的会员专享集、付费 charger 视频等，需要账号具备相应权限才能下载。

---

## ❓ 常见问题（FAQ）

**Q1：为什么没有 1080P 以上的选项？**
未登录只能拿到 480P；登录普通账号最高 1080P；1080P 高码率及以上需要大会员。请先登录B站后重开弹窗。

**Q2：下载一直 0% 或直接失败？**
多为下载直链过期（页面停留过久后签名失效），重新点击「开始下载」即可获取最新直链。若仍失败，请刷新B站页面后重试。

**Q2b：下载速度比较慢？**
未登录状态下B站常把流量调度到 PCDN 节点（速度有限）。登录B站账号后通常会分配到更快的 CDN 节点。

**Q2c：任务显示「失败：CDN 拒绝请求」？**
极少数 CDN 节点策略收紧导致。重新点击「开始下载」（会重新获取直链，通常自动换节点）即可。

**Q3：合并后的视频没声音 / 画面花屏？**
请确认使用 `-c copy` 无损合并命令且两个文件来自同一次下载（不同清晰度的时长可能不同）。若选择了 HEVC/AV1 编码，部分老旧播放器不支持，可改选 H.264/AVC 编码重新下载。

**Q4：MP4 一体格式只有 720P？**
MP4 一体走 HTML5 接口，上限为 1080P（且部分内容不提供）。追求更高画质请使用「DASH 分离」。

**Q5：港澳台番剧提示无法观看？**
区域限定内容受B站服务端限制，扩展无法绕过。

**Q6：支持收藏夹 / 动态 / 稍后再看批量下载吗？**
当前版本仅支持单个视频/番剧页面。批量下载在规划中。

---

## 📁 项目结构

```
Bilibili-Download/
├── manifest.json                 # 扩展清单（Manifest V3）
├── build.ps1                     # 一键打包脚本（产出 dist/unpacked + 商店 zip）
├── build.bat                     # 打包双击入口
├── background/
│   ├── service-worker.js         # 后台：B站API调用、Wbi签名、流式下载、进度管理
│   └── lib/
│       └── md5.js                # 精简 MD5 实现（Wbi 签名用）
├── offscreen/
│   ├── offscreen.html            # Offscreen 文档（为下载文件创建 blob URL）
│   └── offscreen.js
├── popup/
│   ├── popup.html                # 弹窗界面
│   ├── popup.css                 # 弹窗样式
│   └── popup.js                  # 弹窗交互逻辑
├── icons/
│   ├── icon16.png / icon48.png / icon128.png / icon512.png
└── README.md / DEBUG_NOTES.md / .gitignore
```

## 🔧 技术原理（简述）

1. **页面识别**：解析当前标签页 URL，区分普通视频（BV/av 号）与番剧（ep/ss 号）。
2. **获取元信息**：调用 `x/web-interface/view`（普通视频）或 `pgc/view/web/season`（番剧）得到标题与分P/剧集 cid 列表。
3. **获取播放地址**：
   - DASH：`x/player/playurl` / `pgc/player/web/playurl`（`fnval=16`），得到分离的 video/audio 流；
   - MP4 一体：同接口加 `platform=html5&high_quality=1&fnval=1`，得到单文件 MP4。
   - 所有请求带浏览器 Cookie（登录态）并做 **Wbi 签名**（`w_rid` = md5(参数 + 混淆密钥)，密钥来自 nav 接口）。
4. **流式下载中转**（绕过 CDN 的 Referer 校验）：
   - B 站 CDN 要求请求携带来自 bilibili.com 的 `Referer`；而浏览器下载请求（`chrome.downloads`）既不匹配 DNR 修改头规则、其 `headers` 参数也禁止设置 `Referer`；
   - 因此由 Service Worker `fetch`（特权上下文可携带 Referer）**流式**拉取媒体数据，逐块写入扩展的 **OPFS**（Origin Private File System）临时文件，实时向弹窗广播进度；
   - 下载完成后经 `BroadcastChannel` 将 File 交给 Offscreen Document 创建 **blob URL**，再由 `chrome.downloads` 移交浏览器下载管理器保存到用户下载目录，随后自动清理临时文件。
5. **进度推送**：弹窗实时显示每个任务的已下载字节数/总大小；下载在后台 Service Worker 中执行，关闭弹窗、切换标签页均不影响。

> 说明：由于 CDN 拉取由扩展完成（浏览器下载管理器只负责最后的本地保存），暂不支持浏览器原生的断点续传；若下载中断，重新点击「开始下载」即可重新获取直链下载。

---

## 📝 相关文档

- [DEBUG_NOTES.md](./DEBUG_NOTES.md) —— 开发踩坑实录：Wbi 签名正则、BV 号大小写、CDN Referer 校验、Offscreen 中转架构、PowerShell 打包编码与 zip 规范等 8 个坑的完整排查记录与调试方法论。

## ⚠️ 免责声明

本项目仅供个人学习与技术研究使用。下载的视频、音频版权归原作者及哔哩哔哩所有，请勿将下载内容用于任何商业用途或二次传播。使用本项目产生的一切后果由使用者自行承担。
