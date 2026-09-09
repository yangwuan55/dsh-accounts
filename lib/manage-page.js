/**
 * lib/manage-page.js — 管理页单文件 HTML（无外链、无构建链、无框架）。
 *
 * 交付约束：
 * - 暗色主题（与 DSH GUI 谐调）、卡片圆角、等宽字体显示 id / env 键；
 * - 眼睛图标用内联 SVG；全部中文文案；
 * - label/id/domains 渲染一律过 esc()（HTML 转义防 XSS，虽然值来自用户自己的凭据文件）；
 * - capabilities.canWrite=false → 表单与删除按钮禁用 + 顶部只读横幅；
 * - 保存 = PUT（覆盖语义），成功 toast、失败显示 API 错误 JSON 的 error 字段。
 */
export const MANAGE_PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-accounts 管理页</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1d212b;
    --border: #2a2f3a;
    --text: #d7dce4;
    --text-dim: #8a93a5;
    --accent: #4f8cff;
    --accent-soft: rgba(79, 140, 255, 0.14);
    --ok: #34c07c;
    --warn: #e5a640;
    --danger: #e05656;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 80px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0; }
  header .sub { color: var(--text-dim); font-size: 12px; }
  .banner {
    display: none; margin: 14px 0 0; padding: 10px 14px; border-radius: 10px;
    background: rgba(229, 166, 64, 0.12); border: 1px solid rgba(229, 166, 64, 0.4);
    color: var(--warn); font-size: 13px;
  }
  .banner.show { display: block; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin: 18px 0 14px; }
  button {
    font: inherit; color: var(--text); background: var(--panel-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px;
  }
  .card.invalid { border-color: rgba(224, 86, 86, 0.5); }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .card-head .id { font-family: var(--mono); font-size: 15px; font-weight: 600; }
  .badge {
    font-size: 11px; padding: 1px 8px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent); border: 1px solid rgba(79, 140, 255, 0.35);
  }
  .badge.totp { background: rgba(52, 192, 124, 0.12); color: var(--ok); border-color: rgba(52, 192, 124, 0.35); }
  .card .label { color: var(--text-dim); font-size: 13px; }
  .card .domains { font-family: var(--mono); font-size: 12px; color: var(--text-dim); margin-top: 4px; word-break: break-all; }
  .card .err { color: var(--danger); font-size: 13px; margin-top: 6px; word-break: break-all; }
  .card-actions { margin-left: auto; display: flex; gap: 8px; }
  .card-actions button { padding: 4px 12px; font-size: 13px; }
  /* 表单 */
  dialog {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 14px; padding: 0; width: min(640px, calc(100vw - 32px));
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
  .dlg-body { padding: 20px 22px; max-height: 82vh; overflow: auto; }
  .dlg-body h2 { margin: 0 0 14px; font-size: 17px; }
  .field { margin-bottom: 12px; }
  .field > label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
  .field input[type="text"], .field input[type="password"], .field input[type="url"] {
    width: 100%; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .field .hint { font-size: 11px; color: var(--text-dim); margin-top: 3px; }
  .field input[type="text"].mono, .mono { font-family: var(--mono); }
  .radios { display: flex; gap: 14px; flex-wrap: wrap; }
  .radios label { display: flex; gap: 5px; align-items: center; cursor: pointer; font-size: 13px; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .row input { flex: 1; min-width: 0; }
  .kv-inputs input { font-family: var(--mono); font-size: 13px; }
  .row button { padding: 4px 10px; font-size: 13px; flex: none; }
  .secret-wrap { position: relative; }
  .secret-wrap input { padding-right: 38px; }
  .eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; padding: 4px; cursor: pointer; color: var(--text-dim);
    display: flex; align-items: center; justify-content: center;
  }
  .eye:hover { color: var(--accent); }
  .eye svg { width: 16px; height: 16px; }
  .dlg-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  .edit-note { display: none; color: var(--warn); font-size: 12px; margin: -6px 0 12px; }
  .edit-note.show { display: block; }
  .form-error { display: none; color: var(--danger); font-size: 13px; margin: 0 0 12px; white-space: pre-wrap; word-break: break-all; }
  .form-error.show { display: block; }
  /* toast */
  #toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(20px);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 18px; font-size: 13px; opacity: 0; pointer-events: none;
    transition: opacity 0.2s, transform 0.2s; max-width: 80vw; word-break: break-all; z-index: 50;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.ok { border-color: rgba(52, 192, 124, 0.5); color: var(--ok); }
  #toast.bad { border-color: rgba(224, 86, 86, 0.5); color: var(--danger); }
  .empty { color: var(--text-dim); padding: 30px 0; text-align: center; }
  .loading { color: var(--text-dim); padding: 30px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>dsh-accounts 管理页</h1>
    <span class="sub">账号值存于本机 ~/.dsh/.credentials.yaml（0600），仅本机浏览器可达</span>
  </header>
  <div id="ro-banner" class="banner">当前凭据存储为只读（headless 或未开启写能力），新建/编辑/删除已禁用。</div>
  <div class="toolbar">
    <button id="btn-new" class="primary">＋ 新建账号</button>
    <button id="btn-reload">刷新列表</button>
    <span class="sub" id="count"></span>
  </div>
  <div id="list" class="loading">加载中…</div>
</div>

<dialog id="dlg">
  <form id="form" method="dialog">
    <div class="dlg-body">
      <h2 id="dlg-title">新建账号</h2>
      <div id="edit-note" class="edit-note">⚠ 该账号已存在，保存将<strong>覆盖现有值</strong>。</div>
      <div id="form-error" class="form-error"></div>
      <div class="field">
        <label for="f-id">账号 id（小写字母开头，仅小写字母/数字/连字符）</label>
        <input type="text" id="f-id" class="mono" autocomplete="off" spellcheck="false" placeholder="github-main">
        <div class="hint">将作为凭据键 dsh-accounts/&lt;id&gt；编辑时不可修改。</div>
      </div>
      <div class="field">
        <label>类型 kind</label>
        <div class="radios">
          <label><input type="radio" name="kind" value="account" checked> account（登录表单字段）</label>
          <label><input type="radio" name="kind" value="env"> env（环境变量注入）</label>
          <label><input type="radio" name="kind" value="secret"> secret（单值令牌）</label>
        </div>
      </div>
      <div class="field">
        <label for="f-label">label（可选，模型可见的描述）</label>
        <input type="text" id="f-label" placeholder="GitHub 主账号">
      </div>
      <div class="field">
        <label for="f-domains">domains（可选，域名白名单，逗号分隔；account_fill 用）</label>
        <input type="text" id="f-domains" class="mono" placeholder="github.com, api.github.com">
      </div>
      <div class="field" id="sec-fields">
        <label>fields（登录字段，值非空；建议含 username / password，可加 totpSecret 或自定义键）</label>
        <div id="fields-rows" class="kv-inputs"></div>
        <button type="button" id="add-field">＋ 加字段</button>
      </div>
      <div class="field" id="sec-env">
        <label>env（环境变量键值对，键为 [A-Za-z_][A-Za-z0-9_]*）</label>
        <div id="env-rows" class="kv-inputs"></div>
        <button type="button" id="add-env">＋ 加变量</button>
      </div>
      <div class="field" id="sec-value">
        <label for="f-value">value（secret 的值）</label>
        <div class="secret-wrap">
          <input type="password" id="f-value" class="mono" autocomplete="off" spellcheck="false">
          <button type="button" class="eye" data-eye="f-value" aria-label="显示/隐藏值" title="显示/隐藏值">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>
      <div class="dlg-actions">
        <button type="button" id="btn-cancel">取消</button>
        <button type="submit" id="btn-save" class="primary">保存</button>
      </div>
    </div>
  </form>
</dialog>

<div id="toast"></div>

<script>
'use strict';
var API = '/dsh-accounts/api';
var canWrite = false;
var editingId = null; // null = 新建模式

function $(id) { return document.getElementById(id); }

// HTML 转义：页面渲染 id/label/domains 一律过它
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var toastTimer = null;
function toast(msg, ok) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + (ok ? 'ok' : 'bad');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = ''; }, 3600);
}

function api(path, opts) {
  opts = opts || {};
  return fetch(API + path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) {
        var err = new Error(data && data.error ? data.error : ('请求失败（HTTP ' + res.status + '）'));
        err.status = res.status;
        throw err;
      }
      return data;
    });
  });
}

function splitIdFromPath(pathname, prefix) {
  var id = decodeURIComponent(pathname.slice(prefix.length));
  return id.replace(/\/+$/, '');
}

// ---- 列表渲染 ----
function renderList(data) {
  var list = $('list');
  var accounts = data.accounts || [];
  var invalid = data.invalid || [];
  $('count').textContent = '共 ' + (accounts.length + invalid.length) + ' 条记录';
  if (!accounts.length && !invalid.length) {
    list.className = 'empty';
    list.innerHTML = '暂无账号。点击「新建账号」添加，或直接编辑 ~/.dsh/.credentials.yaml。';
    return;
  }
  list.className = 'cards';
  var html = '';
  accounts.forEach(function (a) {
    var badges = '<span class="badge">' + esc(a.kind) + '</span>' +
      (a.hasTotp ? '<span class="badge totp">TOTP</span>' : '');
    var meta = [];
    if (a.label) meta.push('<span class="label">' + esc(a.label) + '</span>');
    if (a.domains && a.domains.length) meta.push('<span class="domains">域名: ' + esc(a.domains.join(', ')) + '</span>');
    html += '<div class="card">' +
      '<div class="card-head"><span class="id">' + esc(a.id) + '</span>' + badges +
      '<span class="card-actions">' +
      '<button data-edit="' + esc(a.id) + '"' + (canWrite ? '' : ' disabled') + '>编辑</button>' +
      '<button data-del="' + esc(a.id) + '" class="danger"' + (canWrite ? '' : ' disabled') + '>删除</button>' +
      '</span></div>' + meta.join('') + '</div>';
  });
  invalid.forEach(function (v) {
    html += '<div class="card invalid"><div class="card-head"><span class="id">' + esc(v.id) + '</span>' +
      '<span class="badge" style="color:var(--danger);border-color:rgba(224,86,86,.4);background:rgba(224,86,86,.1)">invalid</span>' +
      '</div><div class="err">' + esc(v.error) + '</div></div>';
  });
  list.innerHTML = html;
}

function loadList() {
  $('list').className = 'loading';
  $('list').textContent = '加载中…';
  return api('/accounts').then(function (data) {
    // 兼容两种 API 形态：invalid 独立数组，或与 valid 合并在 accounts 里以 valid:false 标记
    var all = data.accounts || [];
    var valid = all.filter(function (a) { return a.valid !== false; });
    var invalid = data.invalid || all.filter(function (a) { return a.valid === false; });
    renderList({ accounts: valid, invalid: invalid });
  }).catch(function (err) {
    $('list').className = 'empty';
    $('list').textContent = '加载失败：' + err.message;
  });
}

// ---- 表单 ----
function kindNow() {
  var r = document.querySelector('input[name="kind"]:checked');
  return r ? r.value : 'account';
}

function showSection(k) {
  $('sec-fields').style.display = k === 'account' ? '' : 'none';
  $('sec-env').style.display = k === 'env' ? '' : 'none';
  $('sec-value').style.display = k === 'secret' ? '' : 'none';
}

function addKvRow(container, key, val, keyPlaceholder, valSecret) {
  var row = document.createElement('div');
  row.className = 'row';
  var k = document.createElement('input');
  k.type = 'text';
  k.className = 'mono';
  k.placeholder = keyPlaceholder || '键';
  k.autocomplete = 'off';
  k.spellcheck = false;
  k.value = key || '';
  var wrap = document.createElement('div');
  wrap.className = 'secret-wrap';
  wrap.style.flex = '1';
  wrap.style.minWidth = '0';
  var v = document.createElement('input');
  v.type = valSecret ? 'password' : 'text';
  v.className = 'mono';
  v.placeholder = valSecret ? '值（已打码）' : '值';
  v.autocomplete = 'off';
  v.spellcheck = false;
  v.value = val || '';
  wrap.appendChild(v);
  if (valSecret) {
    var eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eye';
    eye.setAttribute('aria-label', '显示/隐藏值');
    eye.title = '显示/隐藏值';
    eye.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    eye.addEventListener('click', function () {
      v.type = v.type === 'password' ? 'text' : 'password';
    });
    wrap.appendChild(eye);
  }
  var del = document.createElement('button');
  del.type = 'button';
  del.textContent = '删';
  del.className = 'danger';
  del.addEventListener('click', function () { row.remove(); });
  row.appendChild(k);
  row.appendChild(wrap);
  row.appendChild(del);
  container.appendChild(row);
}

function readKvRows(container) {
  var out = {};
  var has = false;
  container.querySelectorAll('.row').forEach(function (row) {
    var inputs = row.querySelectorAll('input');
    var k = inputs[0].value.trim();
    var v = inputs[1].value;
    if (k && v) { out[k] = v; has = true; }
  });
  return has ? out : undefined;
}

function openForm(id, payload) {
  editingId = id || null;
  $('dlg-title').textContent = id ? '编辑账号 ' + id : '新建账号';
  $('edit-note').classList.toggle('show', !!id);
  $('form-error').className = 'form-error';
  $('form-error').textContent = '';
  $('f-id').value = id || '';
  $('f-id').disabled = !!id;
  $('f-label').value = (payload && payload.label) || '';
  $('f-domains').value = payload && payload.domains ? payload.domains.join(', ') : '';
  var kind = (payload && payload.kind) || 'account';
  document.querySelectorAll('input[name="kind"]').forEach(function (r) {
    r.checked = r.value === kind;
  });
  // fields 行
  var fr = $('fields-rows');
  fr.innerHTML = '';
  var fields = (payload && payload.fields) || {};
  var fk = Object.keys(fields);
  if (!fk.length) {
    addKvRow(fr, 'username', '', '字段名（如 username）', true);
    addKvRow(fr, 'password', '', '字段名（如 username）', true);
  } else {
    fk.forEach(function (k) { addKvRow(fr, k, fields[k], '字段名（如 username）', true); });
  }
  // env 行
  var er = $('env-rows');
  er.innerHTML = '';
  var env = (payload && payload.env) || {};
  var ek = Object.keys(env);
  if (!ek.length) addKvRow(er, '', '', '环境变量名（如 GITHUB_TOKEN）', true);
  else ek.forEach(function (k) { addKvRow(er, k, env[k], '环境变量名（如 GITHUB_TOKEN）', true); });
  $('f-value').value = (payload && payload.value) || '';
  showSection(kind);
  $('dlg').showModal();
}

function closeForm() {
  $('dlg').close();
}

function collectPayload() {
  var kind = kindNow();
  var payload = { kind: kind };
  var label = $('f-label').value.trim();
  if (label) payload.label = label;
  var domainsRaw = $('f-domains').value.trim();
  if (domainsRaw) {
    payload.domains = domainsRaw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  if (kind === 'account') {
    var fields = readKvRows($('fields-rows'));
    if (!fields) return { error: 'kind=account 至少需要一个非空字段（如 username/password）' };
    payload.fields = fields;
  }
  if (kind === 'env') {
    var env = readKvRows($('env-rows'));
    if (!env) return { error: 'kind=env 至少需要一个非空环境变量键值对' };
    payload.env = env;
  }
  if (kind === 'secret') {
    var v = $('f-value').value;
    if (!v) return { error: 'kind=secret 必须提供非空 value' };
    payload.value = v;
  }
  return { payload: payload };
}

function saveForm() {
  var id = $('f-id').value.trim().toLowerCase();
  var errEl = $('form-error');
  errEl.className = 'form-error';
  errEl.textContent = '';
  if (!id) {
    errEl.className = 'form-error show';
    errEl.textContent = '账号 id 不能为空';
    return;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    errEl.className = 'form-error show';
    errEl.textContent = '账号 id 不合法：必须以小写字母开头，仅含小写字母/数字/连字符（^[a-z][a-z0-9-]*$）';
    return;
  }
  var collected = collectPayload();
  if (collected.error) {
    errEl.className = 'form-error show';
    errEl.textContent = collected.error;
    return;
  }
  api('/accounts/' + encodeURIComponent(id), { method: 'PUT', body: collected.payload })
    .then(function () {
      closeForm();
      toast('已保存 ' + id, true);
      loadList();
    })
    .catch(function (err) {
      errEl.className = 'form-error show';
      errEl.textContent = err.message;
    });
}

function deleteAccount(id) {
  if (!confirm('确定删除账号「' + id + '」？该操作立即生效且不可撤销。')) return;
  api('/accounts/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(function () {
      toast('已删除 ' + id, true);
      loadList();
    })
    .catch(function (err) { toast('删除失败：' + err.message, false); });
}

// ---- 事件绑定 ----
document.addEventListener('click', function (ev) {
  var t = ev.target;
  var eye = t.closest && t.closest('.eye');
  if (eye && eye.dataset.eye) {
    var input = $(eye.dataset.eye);
    input.type = input.type === 'password' ? 'text' : 'password';
    return;
  }
  var edit = t.closest && t.closest('[data-edit]');
  if (edit) {
    var id = edit.getAttribute('data-edit');
    api('/accounts/' + encodeURIComponent(id)).then(function (data) {
      openForm(id, data.payload);
    }).catch(function (err) { toast('读取失败：' + err.message, false); });
    return;
  }
  var del = t.closest && t.closest('[data-del]');
  if (del) deleteAccount(del.getAttribute('data-del'));
});

document.querySelectorAll('input[name="kind"]').forEach(function (r) {
  r.addEventListener('change', function () { showSection(kindNow()); });
});
$('f-id').addEventListener('input', function () {
  // 小写自动 + 非法字符提示（不阻断输入）
  var v = this.value;
  if (v !== v.toLowerCase()) this.value = v.toLowerCase();
});
$('add-field').addEventListener('click', function () { addKvRow($('fields-rows'), '', '', '字段名（如 username）', true); });
$('add-env').addEventListener('click', function () { addKvRow($('env-rows'), '', '', '环境变量名（如 GITHUB_TOKEN）', true); });
$('btn-new').addEventListener('click', function () {
  if (!canWrite) { toast('当前为只读模式，无法新建账号', false); return; }
  openForm(null, null);
});
$('btn-reload').addEventListener('click', loadList);
$('btn-cancel').addEventListener('click', closeForm);
$('form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  saveForm();
});

// ---- 启动 ----
api('/capabilities').then(function (cap) {
  canWrite = !!cap.canWrite;
  if (!canWrite) $('ro-banner').classList.add('show');
  $('btn-new').disabled = !canWrite;
  return loadList();
}).catch(function () {
  canWrite = false;
  $('ro-banner').classList.add('show');
  loadList();
});
</script>
</body>
</html>`
