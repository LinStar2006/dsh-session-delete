/**
 * dsh-session-delete 的浏览器半（Client bundle）。
 *
 * 提供两件事：
 * 1. 侧栏每个会话「...」菜单里的一行「删除对话」（slot
 *    `sidebar.workspaces.session.menu.item`，排在宿主自带条目之后）。
 * 2. 一个二次确认框（slot `shell.overlay`），确认后调用 Host 的
 *    `POST /session-delete/delete`，由 Host 真正删掉会话记录、工作区归属
 *    与本地日志。
 *
 * 删除成功后不需要手动刷新列表：Host 的 WorkspaceEntity.detachSession 走
 * storage domain 的写路径，客户端的工作区推送流会把该行移除。
 */

window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let React = require("react");

    /** locale 命名空间。 */
    const NS = "session-delete";

    const zh = {
      "menu.deleteSession": "删除对话",
      "dialog.title": "删除对话",
      "dialog.desc": "将永久删除「{title}」的聊天记录与本地日志，此操作无法撤销。",
      "dialog.cancel": "取消",
      "dialog.confirm": "永久删除",
      "dialog.pending": "正在删除…",
      "dialog.failed": "删除失败：{message}",
      "dialog.folderChecking": "正在检查该对话的独立工作文件夹…",
      "dialog.folderLabel": "同时删除该对话的独立工作文件夹",
      "dialog.folderPath": "文件夹：{path}",
      "error.generic": "删除失败，请查看日志后重试。",
    };

    const en = {
      "menu.deleteSession": "Delete conversation",
      "dialog.title": "Delete conversation",
      "dialog.desc": "This permanently deletes the chat history and local logs of “{title}”. This cannot be undone.",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Delete permanently",
      "dialog.pending": "Deleting…",
      "dialog.failed": "Delete failed: {message}",
      "dialog.folderChecking": "Checking this conversation's own working folder…",
      "dialog.folderLabel": "Also delete this conversation's own working folder",
      "dialog.folderPath": "Folder: {path}",
      "error.generic": "Delete failed; check the logs and retry.",
    };

    const CSS = `
.sd-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-danger,#e5484d);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1;text-align:left;cursor:pointer;}
.sd-menu-item:hover,.sd-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));outline:none;}
.sd-menu-item:disabled{opacity:.55;cursor:default;}
.sd-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);}
.sd-modal{box-sizing:border-box;width:min(420px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;padding:20px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-l1,#1c1c1f);color:var(--dsw-alias-text-primary,#e8e8ea);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.6;box-shadow:0 18px 48px rgba(0,0,0,.38);}
.sd-modal-title{font-size:15px;font-weight:600;}
.sd-modal-desc{color:var(--dsw-alias-text-secondary,#a0a0a6);}
.sd-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px;}
.sd-button{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.36));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-family:inherit;font-size:13px;cursor:pointer;}
.sd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));}
.sd-button:disabled{opacity:.55;cursor:default;}
.sd-button.danger{background:var(--dsw-alias-button-danger-bg,#d93636);border-color:transparent;color:#fff;}
.sd-button.danger:hover:not(:disabled){background:var(--dsw-alias-button-danger-bg-hover,#c02d2d);}
.sd-status{color:var(--dsw-alias-text-secondary,#a0a0a6);font-size:12px;}
.sd-status.error{color:var(--dsw-alias-text-error,#e5484d);}
.sd-check{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));border-radius:var(--dsw-radius-sm,6px);cursor:pointer;user-select:none;}
.sd-check:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));}
.sd-check input{margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-button-danger-bg,#d93636);}
.sd-check-text{display:flex;flex-direction:column;gap:2px;min-width:0;}
.sd-check-path{color:var(--dsw-alias-text-secondary,#a0a0a6);font-size:12px;word-break:break-all;}
`;

    /** 垃圾桶图标（自绘，避免依赖客户端包的图标与样式表）。 */
    function TrashIcon({ size = 14 }) {
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { display: "block", flex: "none" },
        },
        React.createElement("path", { d: "M2.75 4.25h10.5" }),
        React.createElement("path", { d: "M6.25 4.25V3.1c0-.47.38-.85.85-.85h1.8c.47 0 .85.38.85.85v1.15" }),
        React.createElement("path", { d: "M4.1 4.25l.62 8.05c.04.5.46.89.96.89h4.64c.5 0 .92-.39.96-.89l.62-8.05" }),
        React.createElement("path", { d: "M6.6 6.9v3.6M9.4 6.9v3.6" })
      );
    }

    /** 极简的可订阅状态盒（避免引入额外依赖）。 */
    function createStore() {
      let state = { request: null, running: false, error: null, folderPath: null, inspecting: false, deleteFolder: true };
      const listeners = new Set();
      const emit = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        open(request) {
          state = { request, running: false, error: null, folderPath: null, inspecting: true, deleteFolder: true };
          emit();
        },
        setFolder(folderPath) {
          if (state.request === null) return;
          const path = typeof folderPath === "string" && folderPath.length > 0 ? folderPath : null;
          state = { ...state, folderPath: path, inspecting: false, deleteFolder: path !== null };
          emit();
        },
        setDeleteFolder(deleteFolder) {
          if (state.request === null) return;
          state = { ...state, deleteFolder };
          emit();
        },
        setRunning(running) {
          state = { ...state, running, error: running ? null : state.error };
          emit();
        },
        fail(error) {
          state = { ...state, running: false, error };
          emit();
        },
        close() {
          state = { request: null, running: false, error: null, folderPath: null, inspecting: false, deleteFolder: true };
          emit();
        },
      };
    }

    const deleteStore = createStore();

    /**
     * 解析 Host 路由。相对页面基址解析，兼容反向代理前缀与桌面壳的自定义 scheme。
     * @param {string} path 去掉前导斜杠的路由。
     * @returns {string} 绝对地址。
     */
    function hostRouteUrl(path) {
      const base = (typeof document !== "undefined" && document.baseURI) || window.location.href;
      const url = new URL(base);
      url.search = "";
      url.hash = "";
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return new URL(path.replace(/^\/+/, ""), url.href).href;
    }

    /**
     * 向 Host 的路由发一个 JSON POST，非 ok 响应抛错。
     * @param {string} path 去掉前导斜杠的路由。
     * @param {Record<string, unknown>} body 请求体。
     * @returns {Promise<Record<string, unknown>>} Host 的响应体。
     */
    async function postJson(path, body) {
      const response = await fetch(hostRouteUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!response.ok || payload?.ok !== true) {
        const message = typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    }

    /**
     * 询问 Host：这个会话有没有「对话独立文件夹」插件建的工作目录。
     * @param {string} sessionId 会话 id。
     * @returns {Promise<string | null>} 目录绝对路径，没有时为 null。
     */
    async function requestInspect(sessionId) {
      const payload = await postJson("session-delete/inspect", { sessionId });
      const folderPath = payload?.folderPath;
      return typeof folderPath === "string" && folderPath.length > 0 ? folderPath : null;
    }

    /**
     * 请求 Host 删除一个会话。
     * @param {string} sessionId 会话 id。
     * @param {boolean} deleteFolder 是否顺带删除独立工作文件夹。
     * @returns {Promise<Record<string, unknown>>} Host 的响应体。
     */
    async function requestDelete(sessionId, deleteFolder) {
      return postJson("session-delete/delete", { sessionId, deleteFolder: deleteFolder === true });
    }

    /**
     * 菜单项：一行「删除对话」。
     * @param props slot props（owner share + menuOpenState hooks + locale 的 t）。
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const onClick = () => {
        setMenuOpen(false);
        deleteStore.open({ sessionId, displayTitle });
        requestInspect(sessionId)
          .then((folderPath) => deleteStore.setFolder(folderPath))
          .catch(() => deleteStore.setFolder(null));
      };
      return React.createElement(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "sd-menu-item",
          onClick,
        },
        React.createElement(TrashIcon, { size: 14 }),
        React.createElement("span", null, t("menu.deleteSession"))
      );
    }

    /**
     * 二次确认框。等待请求时保持打开，失败时把原因显示在框内。
     * @param props slot props（locale 的 t）。
     */
    function DeleteConfirmDialog(props) {
      const { t } = props;
      const [state, setState] = React.useState(() => deleteStore.getSnapshot());

      React.useEffect(() => deleteStore.subscribe(() => setState(deleteStore.getSnapshot())), []);

      if (state.request === null) return null;

      const { sessionId, displayTitle } = state.request;
      const close = () => {
        if (state.running) return;
        deleteStore.close();
      };
      const confirm = () => {
        if (state.running) return;
        deleteStore.setRunning(true);
        requestDelete(sessionId, state.deleteFolder)
          .then(() => {
            deleteStore.close();
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            deleteStore.fail(t("dialog.failed", { message }) || message);
          });
      };

      return React.createElement(
        "div",
        {
          className: "sd-backdrop",
          role: "presentation",
          onClick: (event) => {
            if (event.target === event.currentTarget) close();
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") close();
          },
        },
        React.createElement(
          "div",
          { className: "sd-modal", role: "dialog", "aria-modal": "true", "aria-label": t("dialog.title") },
          React.createElement("div", { className: "sd-modal-title" }, t("dialog.title")),
          React.createElement(
            "div",
            { className: "sd-modal-desc" },
            t("dialog.desc", { title: typeof displayTitle === "string" && displayTitle.length > 0 ? displayTitle : sessionId })
          ),
          state.inspecting
            ? React.createElement("div", { className: "sd-status", role: "status" }, t("dialog.folderChecking"))
            : state.folderPath !== null
              ? React.createElement(
                  "label",
                  { className: "sd-check" },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: state.deleteFolder,
                    disabled: state.running,
                    onChange: (event) => deleteStore.setDeleteFolder(event.target.checked),
                  }),
                  React.createElement(
                    "span",
                    { className: "sd-check-text" },
                    React.createElement("span", null, t("dialog.folderLabel")),
                    React.createElement("span", { className: "sd-check-path" }, t("dialog.folderPath", { path: state.folderPath }))
                  )
                )
              : null,
          state.error !== null
            ? React.createElement("div", { className: "sd-status error", role: "alert" }, state.error)
            : null,
          state.running ? React.createElement("div", { className: "sd-status", role: "status" }, t("dialog.pending")) : null,
          React.createElement(
            "div",
            { className: "sd-modal-actions" },
            React.createElement(
              "button",
              { type: "button", className: "sd-button", disabled: state.running, onClick: close },
              t("dialog.cancel")
            ),
            React.createElement(
              "button",
              { type: "button", className: "sd-button danger", disabled: state.running, onClick: confirm },
              t("dialog.confirm")
            )
          )
        )
      );
    }

    /**
     * 注册文案、样式与两个 slot。
     * @param {any} ctx Client 插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: locale");

      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-session-delete";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "session-delete: styles");

      ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
        ctx.slots.register(
          {
            name: "sidebar.workspaces.session.menu.item",
            id: "session-delete",
            order: 500,
            locale: NS,
          },
          DeleteSessionMenuItem
        )
      );

      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "session-delete-confirm",
            locale: NS,
          },
          DeleteConfirmDialog
        )
      );
    }

    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return module.exports;
  },
});
