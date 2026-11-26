import { TextSearchIndex } from "./vendor/text-search.js";

// Search metadata only: reading the catalog must never retain a conversation,
// load message history, or change the workspace's archived-session state.
export function sessionSearchRows(sessions, workspaces, { current, history = [] } = {}) {
  if (sessions?.phase !== "ready" || workspaces?.phase !== "ready") return [];
  const excluded = new Set(workspaces.archivedSessionIds || []);
  for (const projection of Object.values(sessions.projectionsBySession || {})) {
    for (const child of projection?.values?.subagentCatalog || []) excluded.add(child.id);
  }
  const basename = path => typeof path === "string" ? path.trim().split(/[\\/]+/).filter(Boolean).at(-1) || path.trim() : "";
  const membership = new Map();
  for (const workspace of workspaces.items || []) {
    const name = workspace.title?.trim() || basename(workspace.path);
    for (const id of workspace.sessionIds || []) if (!membership.has(id)) membership.set(id, name);
  }
  const recent = new Map(history.map((id, index) => [id, index]));
  return (sessions.ids || []).flatMap(id => {
    const session = sessions.byId[id];
    if (!session || excluded.has(id) || session.origin === "subagent" || (session.blank && id !== current)) return [];
    const title = session.displayTitle?.trim() || session.title?.trim() || "新会话";
    const workspace = membership.get(id) || basename(session.cwd) || "未分组";
    return [{ id, title, workspace, updatedAt: Number(session.updatedAt) || 0,
      recent: recent.has(id), current: id === current }];
  }).sort((a, b) => (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity)
    || b.updatedAt - a.updatedAt);
}

export function indexSessionRows(rows) {
  const catalog = new TextSearchIndex(rows, row => ({ fuzzy: [row.title, row.workspace] }));
  const titles = new TextSearchIndex(rows, row => ({ fuzzy: [row.title] }));
  return query => {
    if (!query.trim()) return rows;
    const titleHits = new Set(titles.search(query));
    return catalog.search(query).map(row => ({ ...row, workspaceMatch: !titleHits.has(row) }));
  };
}
