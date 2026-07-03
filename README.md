# AI 用量监控（Claude / Codex）

Chrome 插件（Manifest V3）。`background.js`（service worker）直接调用 `claude.ai` 自己在渲染
Settings → Usage 页面时用的同一个 JSON 接口：

```
GET https://claude.ai/api/organizations/{orgId}/usage
```

`orgId` 从 `lastActiveOrg` 这个 cookie 里读（明文存着，不用另外发请求去查），请求本身用
`fetch(url, { credentials: "include" })`，靠浏览器里已有的 `claude.ai` 登录态 cookie 完成鉴权。
全程**不打开任何标签页或窗口**，只是一次后台 HTTP 请求，通常几十到几百毫秒就能拿到结果。

返回 JSON 里用了这几个字段（来自实际抓包确认）：

- `five_hour.utilization` / `five_hour.resets_at`：**Current Session**（5 小时滚动窗口）用量百分比和重置时间
- `seven_day.utilization` / `seven_day.resets_at`：**All Models**（7 天滚动窗口，所有模型合计）用量百分比
  和重置时间；部分账号/套餐可能没有这块数据（`seven_day` 为 `null`），此时弹窗里对应卡片会自动隐藏

`resets_at` 是 ISO 8601 字符串（如 `2026-07-03T03:00:00...+00:00`），展示时用 `Date` 自动转成本地
时区；如果重置日期和今天不是同一天（7 天限额几乎总是这样），会自动带上月-日，显示成
`MM-DD HH:MM`，避免误以为是当天。

弹窗（点击工具栏图标）是纯展示层，Current Session 和 All Models 各一张卡片，分别显示：

- 用量百分比（进度条 + 数字）
- 重置时间（HH:MM，跨天会带上 MM-DD）
- 剩余重置时长（H:MM，如 `3:13`，每 30 秒在本地重新计算一次，不需要重新请求接口）
- 最后更新时间（共用一个）

**工具栏图标角标**：无论是否打开弹窗，图标右下角都会常驻显示当前用量百分比数字，并按 20% 一档
变色提示（0-20% 绿 `#22C55E`、20-40% 蓝 `#0284C7`、40-60% 黄 `#FACC15`、60-80% 橙 `#F97316`、
80-90% 红 `#EF4444`、90%+ 深红 `#7F1D1D`），一眼就能看出是否快用完。

**刷新时机**：

1. 用户点击弹窗里的 ⟳ 按钮，立即刷新一次
2. 插件安装后自动开始，此后每 5 分钟在后台自动刷新一次（用 `chrome.alarms` 实现，弹窗关不关闭都会执行）

Codex 部分暂为占位（按钮已禁用），后续可以在 `popup.html` / `popup.js` / `background.js` 中按 Claude
的模式加一个 provider（找到 Codex 网页版对应的用量接口后，套用同样的 fetch 逻辑即可）。

## 安装（开发者模式加载）

1. Chrome 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录 `claude-usage-extension`
4. 确保当前浏览器里已经登录了 `claude.ai`
5. 点击工具栏里的插件图标，再点右上角 ⟳ 刷新

## 走过的弯路（供参考）

最早的两版实现都是在隐藏浏览器窗口/标签页里打开用量页面，靠正则从渲染出来的文字里抓百分比和
剩余时长，主要卡在两个问题上：

1. **做不到真正无感知**：`chrome.windows.create({ state: "minimized" })` 在部分 Windows 环境下仍会
   闪一下；把窗口建在屏幕坐标之外又被 Chrome 拒绝（`Bounds must be at least 50% within visible
   screen space`，较新版本强制要求窗口至少一半在可见屏幕内）；换成后台非激活标签页虽然不再有窗口
   动画，但标签栏还是会短暂多出一条。
2. **慢**：每次都要整页刷新走一遍 SPA 启动流程（下载 JS、鉴权、渲染），还要轮询等文字出现。

后来用户帮忙用浏览器 DevTools 抓到了页面实际调用的接口和返回的 JSON，才发现有现成的结构化数据可以
直接拿，于是彻底去掉了标签页/窗口这条路，改成后台直连 fetch——这是目前能做到的最快、最不打扰的方案。

## 权限说明

- `host_permissions: https://claude.ai/*`：用于跨域请求用量接口并带上登录 cookie
- `cookies`：读取 `lastActiveOrg` cookie 拿到当前组织 id，用来拼接接口地址
- `alarms`：用于每 5 分钟触发一次后台自动刷新
- `storage`：缓存最近一次查询结果，下次打开弹窗时先展示缓存，同时剩余时长会每 30 秒在本地重新计算显示

## 注意事项

这个接口没有公开文档，是内部接口，Anthropic 随时可能调整字段或加更严格的校验（比如要求额外的
请求头）。如果哪天刷新突然报"返回数据里没有找到 session 用量字段"，把弹窗调试信息面板里的原始 JSON
发给我，照着新格式改一下解析逻辑就行。
