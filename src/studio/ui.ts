/** The studio page: one HTML file, a stylesheet and a script, served by `server.ts`. No external assets. */

export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hana-orm studio</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header>
  <strong>hana-orm studio</strong>
  <span id="label"></span>
  <span id="ro" class="badge" hidden>read-only</span>
</header>
<div id="layout">
  <nav>
    <input id="model-search" type="search" placeholder="Models" aria-label="Find a model">
    <ul id="models"></ul>
  </nav>
  <main>
    <div id="empty" class="hint">Pick a model on the left.</div>
    <section id="view" hidden>
      <div class="toolbar">
        <h1 id="title"></h1>
        <span id="count" class="muted"></span>
        <span class="spacer"></span>
        <button id="add-filter" type="button">+ Filter</button>
        <button id="refresh" type="button">Refresh</button>
        <button id="add-row" type="button" class="primary">Add row</button>
      </div>
      <div id="filters"></div>
      <div id="error" class="error" role="alert" hidden></div>
      <div class="table-wrap"><table id="grid"><thead></thead><tbody></tbody></table></div>
      <div class="pager">
        <button id="prev" type="button">&larr;</button>
        <span id="range" class="muted"></span>
        <button id="next" type="button">&rarr;</button>
        <label>Rows <select id="take"><option>25</option><option selected>50</option><option>100</option><option>250</option><option>500</option></select></label>
      </div>
    </section>
  </main>
</div>
<dialog id="row-dialog">
  <form method="dialog" id="row-form">
    <h2 id="row-title">Add row</h2>
    <div id="row-fields"></div>
    <div class="error" id="row-error" hidden></div>
    <menu><button value="cancel" formnovalidate>Cancel</button><button id="row-save" value="save" class="primary">Save</button></menu>
  </form>
</dialog>
</body>
</html>
`;

export const STUDIO_CSS = `:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --soft: #f6f8fa;
  --accent: #0969da; --accent-fg: #ffffff; --danger: #cf222e; --null: #8c959f; --sel: #ddf4ff;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --soft: #161b22;
    --accent: #2f81f7; --danger: #f85149; --null: #6e7681; --sel: #1f2d3d; }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
#label { color: var(--muted); }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); }
#layout { flex: 1; display: flex; min-height: 0; }
nav { width: 220px; border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
nav input { margin: 10px; padding: 6px 8px; }
nav ul { list-style: none; margin: 0; padding: 0 0 10px; overflow: auto; }
nav li button { width: 100%; text-align: left; border: 0; background: none; padding: 6px 16px; border-radius: 0; color: inherit; }
nav li button:hover { background: var(--soft); }
nav li button[aria-current="true"] { background: var(--sel); font-weight: 600; }
nav li .kind { color: var(--muted); font-size: 12px; margin-left: 6px; }
main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 12px 16px; }
#view { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.hint { color: var(--muted); padding: 40px 0; text-align: center; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.toolbar h1 { font-size: 18px; margin: 0; }
.spacer { flex: 1; }
.muted { color: var(--muted); }
button, select, input, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; }
button { cursor: pointer; }
button:hover { background: var(--soft); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.danger { color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
#filters { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
#filters .filter { display: flex; gap: 6px; align-items: center; }
.error { color: var(--danger); margin: 6px 0; white-space: pre-wrap; }
.table-wrap { flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
table { border-collapse: collapse; min-width: 100%; }
th, td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 4px 8px; text-align: left; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
th { position: sticky; top: 0; background: var(--soft); cursor: pointer; user-select: none; font-weight: 600; }
th .type { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 4px; }
td.null { color: var(--null); font-style: italic; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.editable { cursor: text; }
td.editing { padding: 0; }
td.editing input, td.editing select, td.editing textarea { width: 100%; min-width: 160px; border-radius: 0; border: 2px solid var(--accent); }
td a { color: var(--accent); cursor: pointer; text-decoration: underline; }
td.actions { width: 1%; }
td.actions button { padding: 0 6px; border: 0; }
.pager { display: flex; gap: 8px; align-items: center; padding-top: 8px; }
dialog { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); min-width: 420px; max-width: 90vw; }
dialog::backdrop { background: rgba(0,0,0,.35); }
#row-fields { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; max-height: 60vh; overflow: auto; }
#row-fields .opt { color: var(--muted); font-size: 12px; }
#row-fields textarea { min-height: 60px; }
menu { display: flex; justify-content: flex-end; gap: 8px; padding: 0; margin: 16px 0 0; }
`;

export const STUDIO_JS = `"use strict";
(() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  // keep the token out of the address bar history and of anything copied from it
  history.replaceState(null, "", location.pathname + location.hash);
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...children) => {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
  };

  let meta = { models: [], readOnly: false };
  const state = { model: null, skip: 0, take: 50, sort: null, dir: "asc", filters: [], rows: [], total: 0 };

  async function call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "x-studio-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const showError = (msg) => { const e = $("error"); e.textContent = msg || ""; e.hidden = !msg; };
  const columns = (m) => m.fields.filter((f) => f.kind !== "relation");
  const model = () => meta.models.find((m) => m.name === state.model);
  const editable = (m) => !meta.readOnly && m.kind === "model" && !!m.key;
  const isNumeric = (f) => ["Int", "BigInt", "Float", "Decimal"].includes(f.type);

  // ---- display ----
  function display(f, v) {
    if (v === null || v === undefined) return "null";
    if (f.type === "Json") return JSON.stringify(v);
    if (f.type === "Bytes") return "<" + Math.floor((String(v).length * 3) / 4) + " bytes>";
    return String(v);
  }

  // foreign keys: the relation a column belongs to (single-column relations only)
  function linkOf(m, f) {
    for (const r of m.fields) {
      if (r.kind === "relation" && r.relation.owner && r.relation.localFields.length === 1 && r.relation.localFields[0] === f.name) return r.relation;
    }
    return null;
  }

  // ---- models list ----
  function renderModels() {
    const q = $("model-search").value.trim().toLowerCase();
    const ul = $("models");
    ul.replaceChildren();
    for (const m of meta.models) {
      if (q && !m.name.toLowerCase().includes(q)) continue;
      ul.append(el("li", null, el("button", { type: "button", "aria-current": m.name === state.model ? "true" : "false", onclick: () => open(m.name, []) },
        m.name, m.kind === "view" ? el("span", { class: "kind", text: "view" }) : null)));
    }
  }

  function open(name, filters) {
    state.model = name; state.skip = 0; state.sort = null; state.dir = "asc"; state.filters = filters;
    renderModels(); renderFilters(); load();
  }

  // ---- filters ----
  const OPS = [["equals", "="], ["not", "≠"], ["contains", "contains"], ["startsWith", "starts with"], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["isNull", "is null"], ["notNull", "is not null"]];
  function renderFilters() {
    const m = model();
    const box = $("filters");
    box.replaceChildren();
    state.filters.forEach((flt, i) => {
      const field = el("select", { "aria-label": "Column" }, ...columns(m).map((f) => el("option", { value: f.name, text: f.name, selected: f.name === flt.field })));
      const op = el("select", { "aria-label": "Operator" }, ...OPS.map(([v, t]) => el("option", { value: v, text: t, selected: v === flt.op })));
      const value = el("input", { "aria-label": "Value", value: flt.value ?? "", placeholder: "value" });
      const sync = () => { flt.field = field.value; flt.op = op.value; flt.value = value.value; value.hidden = flt.op === "isNull" || flt.op === "notNull"; };
      field.onchange = sync; op.onchange = sync; value.oninput = sync;
      value.onkeydown = (e) => { if (e.key === "Enter") { state.skip = 0; load(); } };
      sync();
      box.append(el("div", { class: "filter" }, field, op, value,
        el("button", { type: "button", text: "Apply", onclick: () => { state.skip = 0; load(); } }),
        el("button", { type: "button", text: "Remove", onclick: () => { state.filters.splice(i, 1); renderFilters(); state.skip = 0; load(); } })));
    });
  }

  // ---- table ----
  async function load() {
    const m = model();
    if (!m) return;
    $("empty").hidden = true; $("view").hidden = false;
    $("title").textContent = m.name;
    $("add-row").hidden = !editable(m);
    showError("");
    const p = new URLSearchParams({ model: m.name, skip: String(state.skip), take: String(state.take),
      filters: JSON.stringify(state.filters.map((f) => ({ field: f.field, op: f.op, value: f.op === "isNull" || f.op === "notNull" ? undefined : f.value }))) });
    if (state.sort) { p.set("sort", state.sort); p.set("dir", state.dir); }
    try {
      const data = await call("GET", "/api/rows?" + p);
      state.rows = data.rows; state.total = data.total;
    } catch (e) {
      state.rows = []; state.total = 0; showError(e.message);
    }
    renderTable();
  }

  function renderTable() {
    const m = model();
    const cols = columns(m);
    const head = el("tr", null, ...cols.map((f) => el("th", { title: "Sort by " + f.name, onclick: () => {
      if (state.sort === f.name) state.dir = state.dir === "asc" ? "desc" : "asc"; else { state.sort = f.name; state.dir = "asc"; }
      state.skip = 0; load();
    } }, f.name + (state.sort === f.name ? (state.dir === "asc" ? " ▲" : " ▼") : ""), el("span", { class: "type", text: f.type + (f.optional ? "?" : "") }))));
    if (editable(m)) head.append(el("th", { "aria-label": "Actions" }));
    $("grid").tHead.replaceChildren(head);
    const body = $("grid").tBodies[0];
    body.replaceChildren(...state.rows.map((row) => {
      const tr = el("tr");
      for (const f of cols) {
        const v = row[f.name];
        const td = el("td", { class: [v === null || v === undefined ? "null" : "", isNumeric(f) ? "num" : "", editable(m) ? "editable" : ""].join(" ").trim(), title: display(f, v) });
        const link = v !== null && v !== undefined ? linkOf(m, f) : null;
        if (link) td.append(el("a", { text: display(f, v), title: "Open " + link.model, onclick: (e) => { e.stopPropagation(); open(link.model, [{ field: link.targetFields[0], op: "equals", value: String(v) }]); } }));
        else td.textContent = display(f, v);
        if (editable(m)) td.ondblclick = () => editCell(td, row, f);
        tr.append(td);
      }
      if (editable(m)) tr.append(el("td", { class: "actions" }, el("button", { type: "button", class: "danger", title: "Delete row", text: "Delete", onclick: () => removeRow(row) })));
      return tr;
    }));
    const from = state.total ? state.skip + 1 : 0;
    $("count").textContent = state.total + " row" + (state.total === 1 ? "" : "s");
    $("range").textContent = from + "–" + (state.skip + state.rows.length) + " of " + state.total;
    $("prev").disabled = state.skip === 0;
    $("next").disabled = state.skip + state.rows.length >= state.total;
  }

  const keyOf = (m, row) => Object.fromEntries(m.key.map((k) => [k, row[k]]));

  // ---- editors ----
  // An input for field f; read() returns the value to send, null when left empty.
  // blank: label of the empty choice ("null" for optional fields, "default" in the add dialog).
  function editor(f, v, blank) {
    const empty = blank ? [el("option", { value: "", text: blank, selected: v === null || v === undefined })] : [];
    if (f.kind === "enum") {
      const s = el("select", null, ...empty, ...f.enumValues.map((x) => el("option", { value: x, text: x, selected: x === v })));
      return { node: s, read: () => (s.value === "" ? null : s.value) };
    }
    if (f.type === "Boolean") {
      const s = el("select", null, ...empty, el("option", { value: "true", text: "true", selected: v === true }), el("option", { value: "false", text: "false", selected: v === false }));
      return { node: s, read: () => (s.value === "" ? null : s.value === "true") };
    }
    if (f.type === "Json") {
      const t = el("textarea", { rows: 3 });
      t.value = v === null || v === undefined ? "" : JSON.stringify(v, null, 2);
      return { node: t, read: () => { const s = t.value.trim(); if (!s) return null; try { return JSON.parse(s); } catch { throw new Error(f.name + ": not valid JSON"); } } };
    }
    const i = el("input", { placeholder: blank || (f.type === "DateTime" ? "2026-01-31T12:00:00Z" : f.type === "Bytes" ? "base64" : "") });
    i.value = v === null || v === undefined ? "" : String(v);
    return { node: i, read: () => (i.value === "" && (blank || f.type !== "String") ? null : i.value) };
  }

  function editCell(td, row, f) {
    if (td.classList.contains("editing")) return;
    const m = model();
    const ed = editor(f, row[f.name], f.optional ? "null" : null);
    td.classList.add("editing");
    td.replaceChildren(ed.node);
    ed.node.focus();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) {
        try {
          const value = ed.read();
          const res = await call("PATCH", "/api/rows", { model: m.name, key: keyOf(m, row), data: { [f.name]: value } });
          Object.assign(row, res.row);
          showError("");
        } catch (e) { showError(e.message); }
      }
      renderTable();
    };
    ed.node.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter" && !(f.type === "Json" && !e.ctrlKey && !e.metaKey)) { e.preventDefault(); finish(true); }
    });
    ed.node.addEventListener("blur", () => finish(false));
  }

  async function removeRow(row) {
    const m = model();
    const key = keyOf(m, row);
    if (!confirm("Delete " + m.name + " " + JSON.stringify(key) + "?")) return;
    try { await call("DELETE", "/api/rows", { model: m.name, key }); await load(); }
    catch (e) { showError(e.message); }
  }

  function addRow() {
    const m = model();
    const box = $("row-fields");
    box.replaceChildren();
    const eds = [];
    for (const f of columns(m)) {
      const ed = editor(f, null, f.generated ? "default" : f.optional ? "null" : null);
      eds.push([f, ed]);
      box.append(el("label", { text: f.name }), el("div", null, ed.node, f.generated || f.optional ? el("div", { class: "opt", text: f.generated ? "empty = database default" : "optional" }) : null));
    }
    $("row-error").hidden = true;
    $("row-title").textContent = "Add " + m.name;
    const dlg = $("row-dialog");
    $("row-save").onclick = async (e) => {
      e.preventDefault();
      try {
        const data = {};
        for (const [f, ed] of eds) {
          const v = ed.read();
          if (v === null && f.generated) continue;
          if (v === null && !f.optional) throw new Error(f.name + " is required");
          data[f.name] = v;
        }
        await call("POST", "/api/rows", { model: m.name, data });
        dlg.close();
        await load();
      } catch (err) { $("row-error").textContent = err.message; $("row-error").hidden = false; }
    };
    dlg.showModal();
  }

  // ---- wiring ----
  $("model-search").oninput = renderModels;
  $("refresh").onclick = load;
  $("add-row").onclick = addRow;
  $("add-filter").onclick = () => { const m = model(); if (!m) return; state.filters.push({ field: columns(m)[0].name, op: "equals", value: "" }); renderFilters(); };
  $("prev").onclick = () => { state.skip = Math.max(0, state.skip - state.take); load(); };
  $("next").onclick = () => { state.skip += state.take; load(); };
  $("take").onchange = (e) => { state.take = Number(e.target.value); state.skip = 0; load(); };

  call("GET", "/api/meta").then((m) => {
    meta = m;
    $("label").textContent = m.label || "";
    $("ro").hidden = !m.readOnly;
    renderModels();
    if (m.models.length) open(m.models[0].name, []);
  }).catch((e) => { $("empty").textContent = e.message; });
})();
`;
