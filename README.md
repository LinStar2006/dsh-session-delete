# dsh-session-delete

为 DeepSeek Harness（DSH）增加「删除对话」能力的插件：在会话菜单里补上一个真正可用的删除动作。

DSH 内置的会话菜单只有「归档」——归档只是从列表里隐藏，会话日志与工作区记录仍然保留。本插件提供不可撤销的永久删除，并补齐宿主没有提供的删除链路。

---

## 功能

- 在会话行的「⋯」菜单末尾新增 **删除对话**（垃圾桶图标，位于「复制 Session ID」之后）。
- 点击后弹出确认框；确认即永久删除，不可撤销。
- 删除内容：
  1. 停止该会话仍在进行的活动（turn / 子代理 / 后台任务），最多等待 8 秒；
  2. 从所属工作区的会话列表中移除（`detachSession`）；
  3. 从归档列表（`archivedSessionIds`）与置顶列表（`pinnedSessionIds`）中清除；
  4. 可选：删除 [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders)（对话独立文件夹）为该会话建立的工作目录，并从其索引中移除记录；
  5. 删除磁盘上的会话日志目录 `<DSH_HOME>/sessions/<project>/<sessionId>/`；
  6. 删除投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`；
  7. 广播 `api-session/removed` 事件，让客户端立即把这一行从会话列表中移除。

### 与「归档」的区别

| | 归档 | 删除对话 |
| --- | --- | --- |
| 会话日志 | 保留 | 删除 |
| 工作区归属 | 保留（槽位不删） | 移除 |
| 可否恢复 | 可取消归档 | 不可恢复 |
| 适用场景 | 暂时收起不用的对话 | 确认不再需要、需要清理磁盘 |

### 幂等与残留行

删除是幂等的：如果会话已经被删除过一次（磁盘日志与投影缓存都不存在），再次执行删除不会报错，而是照常完成清理并广播移除事件，用于修复客户端列表中可能残留的行。

执行结果中的 `alreadyDeleted` 字段表示该次调用是否属于「已删除后的重复清理」。

### 顺带删除独立工作文件夹

安装 [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders)（对话独立文件夹）后，每个对话会在 `<workspace>/conversations/<folder>` 下拥有自己的工作目录。打开删除确认框时，本插件先通过 `POST /session-delete/inspect` 探测该目录：

- 探测到：确认框中出现默认勾选的「同时删除该对话的独立工作文件夹」，并显示目录路径；
- 探测不到：不显示该选项，行为与未安装该插件时一致。

安全性：只会删除索引中登记、且确实位于索引目录内部的子目录。即使索引文件被篡改，也无法越界删除其他位置的文件。

---

## 安装

### 方式一：在 DSH 插件页安装（推荐）

1. 打开 DSH 的「插件」设置页；
2. 点右上角 **添加插件**，在输入框里粘贴本仓库地址：

   ```text
   https://github.com/LinStar2006/dsh-session-delete
   ```

   同一个输入框也接受本地目录路径（例如 `D:\plugins\dsh-session-delete`）和包名；
3. 点 **安装**，等安装完成；重载页面（必要时重启 DSH），会话菜单里即出现「删除对话」。

> 安装器在后台使用 pnpm，等价于 `pnpm add github:LinStar2006/dsh-session-delete`。如果所在网络无法直接访问 GitHub，可以先 `git clone` 到本地固定目录，再把该目录路径粘进同一个输入框。

### 方式二：命令行 / 让 Agent 安装

与方式一等价，直接执行（`target` 同时接受 GitHub 仓库和本地目录）：

```text
plugin_manager action=install_bundle target=github:LinStar2006/dsh-session-delete
```

```text
plugin_manager action=install_bundle target=file:<插件绝对路径>
```

### 方式三：手动安装

1. 将插件目录放入任意固定路径（不要放在会话工作目录里——会话重命名会导致路径变化）；
2. 在 profile 的 `package.json` 中添加依赖与 bundle 条目：

   ```jsonc
   {
     "dependencies": {
       "dsh-session-delete": "file:<插件绝对路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-session-delete"
         ]
       }
     }
   }
   ```

3. 把插件目录复制到 `<profile>/node_modules/dsh-session-delete`；
4. 重启 DSH。

profile 目录形如 `<DSH_HOME>/profiles/<profile-name>/`。

### 卸载

从 profile 的 `package.json` 中移除依赖与 `bundles` 条目，删除 `<profile>/node_modules/dsh-session-delete`，重启 DSH。

---

## 使用

1. 在左侧会话列表中找到目标对话；
2. 打开「⋯」菜单，选择 **删除对话**；
3. 确认框会显示对话标题与将永久删除的内容；如安装了 [dsh-conversation-folders](https://github.com/LinStar2006/dsh-conversation-folders)，还会显示可选的「同时删除该对话的独立工作文件夹」；
4. 点击 **永久删除**。

删除完成后该行会立即从列表中消失，无需刷新页面。

---

## 删除流程

宿主没有公开的「删除会话」API，因此删除由以下步骤组合完成：

1. **`sessionPersistence.stat(sessionId)`** —— 读取会话头部，取得其工作目录（`cwd`），用于定位日志目录；
2. **停止活动** —— 通过 `workspace/session-activity` 瀑布查询是否有正在进行的活动；有则触发 `workspace/session-stop` 并行钩子，并轮询等待活动结束（上限 8 秒）；
3. **摘除工作区归属** —— 遍历 `workspaceRegistry.list()`，对包含该会话的工作区调用 `detachSession(sessionId)`；
4. **清理归档 / 置顶** —— 调用 `unarchiveSession`、`unpinSession`（两者对不存在的条目幂等）；
5. **可选清理独立文件夹** —— 见上文；
6. **删除日志目录** —— 按 DSH 的 `<DSH_HOME>/sessions/<project>/<sessionId>/` 布局定位后递归删除；
7. **删除投影缓存** —— 遍历 `<DSH_HOME>/storages/` 下与投影相关的存储目录，删除对应文件；
8. **广播移除事件** —— `ctx.emit("api-session/removed", sessionId)`。

任一步骤失败都会记录日志，其余步骤继续执行；HTTP 响应中通过 `removedPaths` 返回实际删除的路径。

---

## HTTP API

插件在 Host 侧注册了 `/session-delete` 前缀下的两个端点，供客户端半调用（也可用于脚本或其他插件）：

### `POST /session-delete/inspect`

探测会话是否有可一并删除的独立工作文件夹。

```jsonc
// 请求
{ "sessionId": "session-xxxxxxxx" }

// 响应
{ "ok": true, "sessionId": "session-xxxxxxxx", "folderPath": "<workspace>/conversations/<folder>" }
```

`folderPath` 为 `null` 表示未探测到独立工作文件夹。

### `POST /session-delete/delete`

执行删除。

```jsonc
// 请求
{ "sessionId": "session-xxxxxxxx", "deleteFolder": true }

// 响应
{
  "ok": true,
  "sessionId": "session-xxxxxxxx",
  "removedPaths": ["..."],
  "folderRemoved": true,
  "alreadyDeleted": false
}
```

失败时返回 `{ "ok": false, "error": "<原因>" }`，HTTP 状态码为 400 / 405 / 404 / 500。

---

## 组成

```text
dsh-session-delete/
├── package.json          # 包元信息、DSH bundle / client 声明、exports
├── cordis.patch.yml      # Loader patch：把插件插入 profile
├── lib/
│   └── index.js          # Host 半：HTTP 路由与删除流程
├── client.js             # Client 半：会话菜单项与确认对话框
├── locale/
│   ├── zh.json           # 插件列表中显示的标题与简介（中文）
│   └── en.json           # 插件列表中显示的标题与简介（英文）
├── icon.svg              # 插件图标
└── README.md
```

- **Host 半**（`lib/index.js`）注册 `/session-delete/inspect`、`/session-delete/delete` 两条路由。
- **Client 半**（`client.js`）向 slot `sidebar.workspaces.session.menu.item` 注册菜单项，向 `shell.overlay` 注册确认对话框，并通过相对页面基址的 `fetch` 调用 Host 路由。
- **展示元信息**：`locale/<lang>.json` 中的 `meta.title` / `meta.description` 由 DSH 的插件元信息读取逻辑显示在「插件」设置页；图标由 `exports["./icon"]` 提供。

---

## 兼容性

- 面向 DSH `0.2.x`（已在 `0.2.1-rc.5` 上验证）。
- 插件使用 `webServer`、`workspaceRegistry`、`sessionPersistence` 三个 Host 服务，以及 `workspace/session-activity`、`workspace/session-stop` 两个事件钩子。
- 其中 `detachSession()` 与 `api-session/removed` 广播属于宿主内部能力，DSH 升级后若内部接口变动，插件可能需要相应调整。

## 已知限制

- 删除不可撤销，不会进入回收站。
- 删除当前正在打开、仍在内存中的会话后，宿主内存里的 Session 对象可能仍存在；若它后续继续写入，可能重新生成日志文件。建议先切换到其他会话再删除。
- 投影缓存目录按约定名称扫描，宿主若更改存储布局，需要更新 `removeProjectionCache` 的匹配逻辑。

## 开发

修改 Host 代码后需要重新加载插件（Host 半不参与 HMR）：

```text
plugin_manager action=remove_bundle target=dsh-session-delete
plugin_manager action=install_bundle target=file:<插件绝对路径>
```

或在开发时先把文件同步到 profile 的 `node_modules/dsh-session-delete` 后重启 DSH。

## License

MIT
