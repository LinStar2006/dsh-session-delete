/**
 * dsh-session-delete 的 Host 半。
 *
 * DSH 目前只提供「归档」：归档只是把会话 id 放进 registry 的 archivedSessionIds，
 * 会话的日志、工作区归属、投影缓存全都留着，没有真正删除的入口。
 *
 * 本插件在 Host 侧暴露一个很小的 JSON 路由 `POST /session-delete/delete`，
 * 由客户端半的「删除对话」菜单项调用，按下面的顺序把一个会话彻底清掉：
 *
 * 1. 若会话还有活动（运行中的回合 / 子代理 / 任务 / 提醒），先请各提供方停止，
 *    并短暂等待活动收敛，避免删除正在写入的日志。
 * 2. 从每个 Workspace 的 sessionIds 里移除该会话（WorkspaceEntity.detachSession，
 *    这是宿主真实写路径，走 storage domain 表更新，会顺带把变更推给客户端）。
 * 3. 从 registry 的 archivedSessionIds / pinnedSessionIds 里移除（归档/置顶集合
 *    只存 id，unarchive/unpin 对已不存在的会话也是幂等的）。
 * 4. 若调用方要求（`deleteFolder`），顺带删除「对话独立文件夹」插件
 *    （dsh-conversation-folders）为这个会话建的工作目录，并从它的索引里移除记录。
 * 5. 删除磁盘上的会话日志目录（`<root>/<projectKey(cwd)>/<sessionId>`）与
 *    会话投影缓存文件。
 * 6. 广播 `api-session/removed`，让客户端立刻把这一行从会话列表里移除
 *    （宿主销毁 Session 时用的是同一个事件；否则侧栏会残留一条已不存在的数据）。
 *
 * 删除是幂等的：会话已经被删过（日志与缓存都不在了）时仍然执行上面的清理步骤，
 * 并照常广播移除事件，用来修复客户端列表里的残留行。
 *
 * 另有一个只读路由 `POST /session-delete/inspect`，用来告诉客户端某个会话
 * 有没有可顺带删除的独立工作文件夹（供确认框显示勾选项）。
 *
 * 所有写操作都走宿主自己的 API，不直接改 storage 文件，因此内存与磁盘保持一致。
 */

import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const name = "session-delete";

/** 依赖 Host 服务：路由、工作区注册表、会话持久化。 */
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

/** 路由前缀。 */
const ROUTE_PREFIX = "/session-delete";

/** 等待会话活动收敛的上限（毫秒）。 */
const ACTIVITY_SETTLE_TIMEOUT_MS = 8000;
const ACTIVITY_POLL_INTERVAL_MS = 120;

/** 简单的延时。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node 的 IncomingMessage → JSON。请求体上限很小，这里只接受一个 sessionId。
 * @param {import("node:http").IncomingMessage} req 请求。
 * @returns {Promise<any>} 解析后的 JSON（空体视为 {}）。
 */
async function readJsonBody(req) {
  const limit = 64 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 写回一个 JSON 响应。
 * @param {import("node:http").ServerResponse} res 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} value JSON 值。
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * 与 dsh-session-persistence-jsonl 一致的工程目录名编码：分隔符/盘符折叠成 `-`，
 * 不安全字符转 `~XXXX`，整体加 `--` 前后缀。仅在无法扫描目录时作为兜底使用。
 * @param {string} cwd 会话的工作目录。
 * @returns {string} 目录名。
 */
function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 会话日志的根目录。 */
function sessionRoot(ctx) {
  const root = ctx.sessionPersistence?.root;
  if (typeof root === "string" && root.length > 0) return root;
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** DSH 的用户数据目录。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 定位一个会话的日志目录：先按 cwd 推导的工程目录试，再退回遍历根目录下的一级子目录。
 * @param {string} root 会话日志根目录。
 * @param {string} sessionId 会话 id。
 * @param {string | undefined} cwd 会话 header 里的工作目录。
 * @returns {Promise<string | undefined>} 存在的会话目录，找不到时 undefined。
 */
async function findSessionDir(root, sessionId, cwd) {
  const candidates = [];
  if (typeof cwd === "string" && cwd.length > 0) candidates.push(join(root, projectKey(cwd), sessionId));
  candidates.push(join(root, "_no-cwd", sessionId));
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, sessionId);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* 不是这个工程目录 */
    }
  }
  return undefined;
}

/**
 * 删除会话的投影缓存文件。缓存按 session id 命名，清掉可以避免 id 复用时读到旧投影。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string[]>} 被删掉的文件。
 */
async function removeProjectionCache(sessionId) {
  const removed = [];
  const base = join(dshHome(), "storages");
  let stores;
  try {
    stores = await readdir(base, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const store of stores) {
    if (!store.isDirectory() || !store.name.toLowerCase().includes("proj")) continue;
    const storeDir = join(base, store.name);
    let entries;
    try {
      entries = await readdir(storeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const targets = entry.isDirectory() ? [join(storeDir, entry.name, `${sessionId}.json`)] : [];
      if (!entry.isDirectory() && entry.name.includes(sessionId)) targets.push(join(storeDir, entry.name));
      for (const target of targets) {
        try {
          await rm(target, { force: true });
          removed.push(target);
        } catch {
          /* 缓存删除失败不影响整体删除 */
        }
      }
    }
  }
  return removed;
}

/**
 * 「对话独立文件夹」插件（dsh-conversation-folders）的默认目录名与索引文件名。
 * 这两项都能被那个插件的配置改掉，所以它们只是首选的猜测，找不到时再扫描一级子目录。
 */
const CONVERSATION_FOLDER_DIR = "conversations";
const CONVERSATION_FOLDER_INDEX = ".dsh-conversation-folders.json";

/**
 * 判断一个路径是否是已存在的目录。
 * @param {string} target 路径。
 * @returns {Promise<boolean>} 是否存在且为目录。
 */
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读一个 JSON 文件，任何读取或解析错误都当作「没有」。
 * @param {string} file 文件路径。
 * @returns {Promise<any | undefined>} 解析结果。
 */
async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 找工作区根目录下「对话独立文件夹」的索引文件。
 * @param {string} root 工作区根目录。
 * @returns {Promise<string | undefined>} 索引文件的绝对路径。
 */
async function findFolderIndexFile(root) {
  const candidates = [join(root, CONVERSATION_FOLDER_DIR, CONVERSATION_FOLDER_INDEX)];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(root, entry.name, CONVERSATION_FOLDER_INDEX));
    }
  } catch {
    /* 根目录不可读时只用默认候选 */
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return undefined;
}

/**
 * 找出会话在「对话独立文件夹」插件里的工作目录。
 * 索引结构：`{ folders: { [sessionId]: { folder: string } } }`，目录位于索引文件所在目录之下。
 * @param {string} sessionId 会话 id（完整 id，与该插件的索引键一致）。
 * @param {string | undefined} cwd 会话 header 里的工作目录，也是该插件建目录时的根。
 * @returns {Promise<{ indexFile: string, folderPath: string } | undefined>} 目录信息，找不到时为 undefined。
 */
async function resolveConversationFolder(sessionId, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return undefined;
  const indexFile = await findFolderIndexFile(cwd);
  if (indexFile === undefined) return undefined;
  const index = await readJsonFile(indexFile);
  const record = index?.folders?.[sessionId];
  if (record === undefined || record === null || typeof record.folder !== "string") return undefined;
  const folder = record.folder.trim();
  if (folder === "" || folder === "." || folder === "..") return undefined;
  const folderDir = dirname(indexFile);
  const folderPath = resolve(folderDir, folder);
  const sub = relative(folderDir, folderPath);
  // 只删除索引目录内部的一层子目录，防止索引被改坏后越界删除别的东西。
  if (sub === "" || sub.startsWith("..") || isAbsolute(sub)) return undefined;
  if (!(await isDirectory(folderPath))) return undefined;
  return { indexFile, folderPath };
}

/**
 * 从索引里移除会话记录（原子写：先写临时文件再改名）。
 * 失败不影响会话删除，调用方只记日志。
 * @param {string} indexFile 索引文件。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<boolean>} 是否真的改写了索引。
 */
async function forgetFolderRecord(indexFile, sessionId) {
  const index = await readJsonFile(indexFile);
  if (index === undefined || index === null || typeof index !== "object") return false;
  const folders = index.folders;
  if (folders === undefined || folders === null || typeof folders !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(folders, sessionId)) return false;
  delete folders[sessionId];
  index.updatedAt = new Date().toISOString();
  const temp = `${indexFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(index, null, 2), "utf8");
  await rename(temp, indexFile);
  return true;
}

/**
 * 取会话的工作目录：优先落盘日志的 header，落盘不可读时退回活会话。
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<string | undefined>} 工作目录。
 */
async function resolveSessionCwd(ctx, sessionId) {
  try {
    const snapshot = await ctx.sessionPersistence.stat(sessionId);
    const cwd = snapshot?.header?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  } catch {
    /* 落盘日志不可读时退回活会话 */
  }
  const live = ctx.get("sessions")?.get?.(sessionId);
  const cwd = live?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/**
 * 读取当前活动，用于判断会话是否还有工作在跑。
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<any[]>} 活动条目。
 */
async function readActivity(ctx, sessionId) {
  try {
    const activity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
    return Array.isArray(activity) ? activity : [];
  } catch (error) {
    ctx.logger.warn(`session-delete: 读取会话活动失败：${String(error)}`);
    return [];
  }
}

/**
 * 停止会话的活动并等待其收敛。停止失败不阻断删除，但会记录日志。
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 */
async function stopActivity(ctx, sessionId) {
  const activity = await readActivity(ctx, sessionId);
  if (activity.length === 0) return;
  ctx.logger.info(`session-delete: 会话 ${sessionId} 仍有活动，先请求停止`);
  try {
    await ctx.parallel("workspace/session-stop", { sessionId });
  } catch (error) {
    ctx.logger.warn(`session-delete: 停止会话活动失败：${String(error)}`);
  }
  const deadline = Date.now() + ACTIVITY_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(ACTIVITY_POLL_INTERVAL_MS);
    if ((await readActivity(ctx, sessionId)).length === 0) return;
  }
  ctx.logger.warn(`session-delete: 等待会话 ${sessionId} 静止超时，继续删除`);
}

/**
 * 彻底删除一个会话。
 * @param {any} ctx 插件上下文。
 * @param {string} sessionId 会话 id。
 * @param {{ deleteFolder?: boolean }} [options] 附加选项：是否同时删除独立工作文件夹。
 * @returns {Promise<{ sessionId: string, removedPaths: string[], folderRemoved: boolean, alreadyDeleted: boolean }>} 删除结果。
 */
async function deleteSession(ctx, sessionId, options = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("缺少 sessionId");
  const deleteFolder = options.deleteFolder === true;

  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;

  // 0. 读取会话元数据。会话可能已经被删过一次（日志与缓存都没了），此时剩下的
  //    只是客户端列表里的残留行；不要报错，继续做一遍幂等清理，并让客户端移除该行。
  let snapshot;
  try {
    snapshot = await persistence.stat(sessionId);
  } catch {
    snapshot = undefined;
  }
  const live = ctx.get("sessions")?.get?.(sessionId);
  const alreadyDeleted = snapshot === undefined && live === undefined;
  const cwd = snapshot?.header?.cwd ?? live?.header?.cwd;

  // 1. 停止仍在运行的工作，避免删除正在写入的日志。
  await stopActivity(ctx, sessionId);

  // 2. 解除每个工作区的归属（宿主真实写路径，客户端会收到变更推送）。
  for (const workspace of registry.list()) {
    let sessionIds;
    try {
      sessionIds = workspace.sessionIds;
    } catch {
      sessionIds = undefined;
    }
    if (!Array.isArray(sessionIds) || !sessionIds.includes(sessionId)) continue;
    await workspace.detachSession(sessionId);
  }

  // 3. 归档 / 置顶集合只存 id，对已不存在的会话同样幂等。
  try {
    await registry.unarchiveSession(sessionId);
  } catch (error) {
    ctx.logger.warn(`session-delete: 取消归档失败：${String(error)}`);
  }
  try {
    await registry.unpinSession(sessionId);
  } catch (error) {
    ctx.logger.warn(`session-delete: 取消置顶失败：${String(error)}`);
  }

  // 4. 可选：顺带删除「对话独立文件夹」插件为这个会话建的工作目录。
  const removedPaths = [];
  let folderRemoved = false;
  if (deleteFolder) {
    try {
      const folder = await resolveConversationFolder(sessionId, cwd);
      if (folder === undefined) {
        ctx.logger.info(`session-delete: 会话 ${sessionId} 没有独立工作文件夹，跳过`);
      } else {
        await rm(folder.folderPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
        removedPaths.push(folder.folderPath);
        folderRemoved = true;
        await forgetFolderRecord(folder.indexFile, sessionId);
      }
    } catch (error) {
      ctx.logger.warn(`session-delete: 删除对话工作文件夹失败：${String(error)}`);
    }
  }

  // 5. 删除磁盘产物。
  const root = sessionRoot(ctx);
  const dir = await findSessionDir(root, sessionId, cwd);
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    removedPaths.push(dir);
  } else {
    ctx.logger.warn(`session-delete: 未在 ${root} 下找到会话 ${sessionId} 的日志目录`);
  }
  try {
    removedPaths.push(...(await removeProjectionCache(sessionId)));
  } catch (error) {
    ctx.logger.warn(`session-delete: 清理投影缓存失败：${String(error)}`);
  }

  // 6. 通知客户端把这一行从会话列表里移除。宿主在 Session 被销毁时也是广播同一个事件
  //    （dsh-api-session-controller 的 `session/disposed` → `api-session/removed`），
  //    否则侧栏会一直留着一条已经不存在的数据，再点删除还会失败。
  try {
    ctx.emit("api-session/removed", sessionId);
  } catch (error) {
    ctx.logger.warn(`session-delete: 通知客户端移除会话失败：${String(error)}`);
  }

  ctx.logger.info(`session-delete: 已删除会话 ${sessionId}`);
  return { sessionId, removedPaths, folderRemoved, alreadyDeleted };
}

/**
 * 插件入口。
 * @param {any} ctx 插件上下文。
 */
export function apply(ctx) {
  const logger = ctx.logger;

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
            const isDelete = pathname === `${ROUTE_PREFIX}/delete`;
            const isInspect = pathname === `${ROUTE_PREFIX}/inspect`;
            if (!isDelete && !isInspect) {
              sendJson(res, 404, { ok: false, error: "未找到该接口" });
              return;
            }
            if (req.method !== "POST") {
              sendJson(res, 405, { ok: false, error: "仅支持 POST" });
              return;
            }
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
            if (sessionId === undefined) {
              sendJson(res, 400, { ok: false, error: "缺少 sessionId" });
              return;
            }
            if (isInspect) {
              // 只读探测：告诉客户端这个会话有没有「对话独立文件夹」目录可供顺带删除。
              const cwd = await resolveSessionCwd(ctx, sessionId);
              const folder = await resolveConversationFolder(sessionId, cwd);
              sendJson(res, 200, { ok: true, sessionId, folderPath: folder?.folderPath ?? null });
              return;
            }
            const result = await deleteSession(ctx, sessionId, { deleteFolder: body?.deleteFolder === true });
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            logger.warn(`session-delete: 删除会话失败：${String(error)}`);
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    "session-delete: route",
  );
}
