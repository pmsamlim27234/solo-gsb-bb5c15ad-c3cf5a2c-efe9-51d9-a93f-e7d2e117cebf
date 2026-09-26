'use strict';

/* =============================== 状态 =============================== */

const state = {
  view: 'list', // 'list' | 'detail'
  tab: 'cue', // 'cue' | 'run'
  mode: 'view', // 'view' | 'edit'
  script: null, // 当前剧本详情 { id, title, content, current_version, cues }
  cueModal: null, // { mode:'add', lineNo } | { mode:'edit', cue }
  suggestModal: null, // { mode:'add', item } | { mode:'edit', suggestion }
  missModal: null, // { item } 待登记漏执行的队首条目
  rebindCue: null, // 正在重绑的提示
  rebindTarget: null, // 重绑弹窗中暂选行号
  flashLineNo: null, // 渲染后需要高亮的行
  run: {
    preview: null, // 创建前预览 { version, total, excluded_pending, cues }
    sessions: [], // 历次场次摘要
    activeSession: null, // 当前打开的场次完整状态
    makeupPreview: null, // 当前场次的漏项补排预览（可补排的漏执行记录）
    cmp: { baseId: null, compareId: null, result: null, expanded: new Set() }, // 场次对照
  },
  versions: {
    list: [], // 历史版本摘要（不含正文）
    selected: null, // 当前查看的版本（含正文）
    preview: null, // 该版本的恢复预览（已绑定/待确认数量与待确认明细）
    busy: false,
  },
  assets: {
    list: [], // 音效素材库（本机全剧目共用）
    loaded: false, // 是否已拉取；提示增删改后失效需重新拉取（引用计数会变化）
  },
};

const $ = (id) => document.getElementById(id);

/* =============================== 工具 =============================== */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const typeName = { light: '灯光', sound: '音效' };

/** 文件大小格式化（B / KB / MB） */
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* =============================== 素材试听 =============================== */

// 全局单实例播放器：同时只播放一个素材，再次点击同一素材即停止
let audioEl = null;
let playingAssetId = null;

function updatePlayButtons() {
  document.querySelectorAll('[data-action="play-asset"]').forEach((b) => {
    b.textContent = Number(b.dataset.asset) === playingAssetId ? '⏸ 停止' : '▶ 试听';
  });
  // 提示弹窗中的试听按钮（跟随下拉框选中的素材）
  const modalBtn = $('cueAssetPlayBtn');
  if (modalBtn) {
    const selected = Number($('cueAssetSelect').value) || null;
    modalBtn.textContent =
      selected && selected === playingAssetId ? '⏸ 停止' : '▶ 试听';
  }
}

function stopAssetPlayback() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = '';
    audioEl = null;
  }
  playingAssetId = null;
  updatePlayButtons();
}

function toggleAssetPlayback(id) {
  if (!id) return;
  if (playingAssetId === id) {
    stopAssetPlayback();
    return;
  }
  stopAssetPlayback();
  audioEl = new Audio(`/api/assets/${id}/file`);
  audioEl.addEventListener('ended', stopAssetPlayback);
  audioEl.addEventListener('error', () => {
    toast('音频加载失败，素材文件可能已缺失', true);
    stopAssetPlayback();
  });
  playingAssetId = id;
  audioEl.play().catch(() => {
    toast('无法播放该音频', true);
    stopAssetPlayback();
  });
  updatePlayButtons();
}

/* =============================== 有效排练计时 =============================== */

// 服务端时钟与本地时钟的差值（秒）：场次数据里带 server_now，用于跨刷新/跨浏览器对表。
// 有效时长始终由服务端的 timer_elapsed + timer_started_at 计算，本地时钟只负责秒针跳动。
let serverClockOffset = 0;

function syncServerClock(serverNow) {
  if (Number.isFinite(Number(serverNow))) {
    serverClockOffset = Math.floor(Number(serverNow)) - Math.floor(Date.now() / 1000);
  }
}

function serverNowSec() {
  return Math.floor(Date.now() / 1000) + serverClockOffset;
}

/** 秒数格式化为 H:MM:SS / MM:SS；null（从未计时）显示「未计时」 */
function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '未计时';
  const total = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 当前场次的实时有效排练秒数：
 * running = 已落账秒数 + 本段经过秒数（按服务端时钟），paused = 已落账秒数，idle = null。
 */
function liveRehearsalSeconds(s) {
  if (!s) return null;
  if (s.timer_state === 'running') {
    return (s.timer_elapsed || 0) + Math.max(0, serverNowSec() - (s.timer_started_at || serverNowSec()));
  }
  if (s.timer_state === 'paused') return s.timer_elapsed || 0;
  return null;
}

/* =============================== 视图切换 =============================== */

function showView(view) {
  state.view = view;
  $('listView').classList.toggle('hidden', view !== 'list');
  $('detailView').classList.toggle('hidden', view !== 'detail');
  window.scrollTo(0, 0);
}

function setMode(mode) {
  state.mode = mode;
  const editing = mode === 'edit';
  $('scriptViewer').classList.toggle('hidden', editing);
  $('scriptEditor').classList.toggle('hidden', !editing);
  $('editBtn').classList.toggle('hidden', editing);
  $('saveVersionBtn').classList.toggle('hidden', !editing);
  $('cancelEditBtn').classList.toggle('hidden', !editing);
  $('scriptModeHint').textContent = editing
    ? '修改后点击「保存新版」，系统会重新定位所有提示；无法唯一确认的将标记待确认。'
    : '点击任意台词行，可在旁边添加提示';
}

/* =============================== 剧本列表 =============================== */

async function loadScripts() {
  const scripts = await api('GET', '/api/scripts');
  const box = $('scriptList');
  if (scripts.length === 0) {
    box.innerHTML = '<div class="empty">还没有剧本，先在上方创建一个吧。</div>';
    return;
  }
  box.innerHTML = scripts
    .map((s) => {
      const pending = s.pending_count || 0;
      return `
      <div class="script-item" data-id="${s.id}">
        <div>
          <div class="script-item-title">${escapeHtml(s.title)}</div>
          <div class="script-item-meta">
            v${s.current_version}
            <span class="sep">·</span>${s.cue_count} 条提示
            ${pending > 0 ? `<span class="sep">·</span><span style="color:var(--danger)">${pending} 条待确认</span>` : ''}
            <span class="sep">·</span>更新于 ${escapeHtml(s.updated_at)}
          </div>
        </div>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${s.id}">删除</button>
      </div>`;
    })
    .join('');
}

$('scriptList').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-action="delete"]');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.id;
    if (!confirm('确定删除该剧本及其全部提示？此操作不可恢复。')) return;
    await api('DELETE', `/api/scripts/${id}`);
    toast('剧本已删除');
    loadScripts();
    return;
  }
  const item = e.target.closest('.script-item');
  if (item) openScript(item.dataset.id);
});

$('createBtn').addEventListener('click', async () => {
  const title = $('newTitle').value.trim();
  const content = $('newContent').value;
  if (!title) return toast('请填写剧本标题', true);
  const r = await api('POST', '/api/scripts', { title, content });
  $('newTitle').value = '';
  $('newContent').value = '';
  toast('剧本已创建');
  openScript(r.id);
});

/* =============================== 剧本详情 =============================== */

async function openScript(id) {
  stopAssetPlayback();
  state.script = await api('GET', `/api/scripts/${id}`);
  state.run = {
    preview: null,
    sessions: [],
    activeSession: null,
    makeupPreview: null,
    cmp: { baseId: null, compareId: null, result: null, expanded: new Set() },
  };
  state.versions = { list: [], selected: null, preview: null, busy: false };
  state.assets.loaded = false; // 提示可能已变化，素材引用计数需重新拉取
  $('detailTitle').textContent = state.script.title;
  $('topbarSub').textContent = state.script.title;
  $('scriptEditor').value = state.script.content;
  setMode('view');
  switchTab('cue');
  renderDetail();
  showView('detail');
}

function cuesByLine() {
  const map = new Map();
  for (const c of state.script.cues) {
    if (c.anchor_status === 'bound' && c.line_no != null) {
      if (!map.has(c.line_no)) map.set(c.line_no, []);
      map.get(c.line_no).push(c);
    }
  }
  return map;
}

function renderDetail() {
  const s = state.script;
  $('versionBadge').textContent = `第 ${s.current_version} 版`;

  renderViewer($('scriptViewer'), s.content, { clickable: true });
  renderCues();
}

/** 通用剧本行渲染（浏览区 & 重绑弹窗） */
function renderViewer(container, content, opts = {}) {
  const lineMap = opts.clickable ? cuesByLine() : null;
  const lines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');

  if (lines.length === 0) {
    container.innerHTML = '<div class="empty">剧本内容为空，请先编辑粘贴文本。</div>';
    return;
  }

  container.innerHTML = lines
    .map((text, i) => {
      const lineNo = i + 1;
      const isEmpty = text.trim() === '';
      if (isEmpty && !opts.showEmpty) {
        return `<div class="script-line empty-line"><span class="line-no">${lineNo}</span><span class="line-text">&nbsp;</span></div>`;
      }
      const cues = lineMap ? lineMap.get(lineNo) || [] : [];
      const classes = ['script-line'];
      if (!isEmpty) classes.push('selectable');
      if (cues.length) classes.push('has-cue');
      if (opts.pendingLineNos && opts.pendingLineNos.includes(lineNo)) classes.push('pending-target');
      if (state.flashLineNo === lineNo) classes.push('flash');

      const chips = cues
        .map(
          (c) =>
            `<span class="chip ${c.type === 'light' ? 'chip-light' : 'chip-sound'}">${
              c.type === 'light' ? '💡' : '🔊'
            } ${escapeHtml(c.label)}</span>`
        )
        .join('');

      return `
        <div class="${classes.join(' ')}" data-line="${lineNo}">
          <span class="line-no">${lineNo}</span>
          <span class="line-text">${escapeHtml(text) || '&nbsp;'}</span>
          ${chips ? `<span class="line-chips">${chips}</span>` : ''}
        </div>`;
    })
    .join('');

  state.flashLineNo = null;
}

function renderCues() {
  const cues = state.script.cues;
  const pending = cues.filter((c) => c.anchor_status === 'pending');
  const bound = cues
    .filter((c) => c.anchor_status === 'bound')
    .sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

  // 音效提示关联素材的展示行（含试听按钮）
  const assetRow = (c) =>
    c.asset
      ? `<div class="cue-asset">🎵 ${escapeHtml(c.asset.filename)}
          <button class="btn btn-sm" data-action="play-asset" data-asset="${c.asset.id}">▶ 试听</button>
        </div>`
      : '';

  $('cueStats').innerHTML = `
    <span>共 ${cues.length} 条</span>
    <span style="color:var(--ok)">已绑定 ${bound.length}</span>
    <span style="color:${pending.length ? 'var(--danger)' : 'var(--text-dim)'}">待确认 ${pending.length}</span>`;

  // 待确认面板
  const pp = $('pendingPanel');
  if (pending.length === 0) {
    pp.classList.add('hidden');
    pp.innerHTML = '';
  } else {
    pp.classList.remove('hidden');
    pp.innerHTML =
      `<h4>⚠ ${pending.length} 条提示无法唯一定位，需要人工确认</h4>
       <p class="hint" style="margin:0">系统不会把它们自动挂到其他台词上。可使用候选行一键绑定，或打开剧本点选正确行。</p>` +
      pending
        .map((c) => {
          const cands = (c.issue && c.issue.candidates) || [];
          return `
          <div class="pending-item" data-cue="${c.id}">
            <div class="pending-item-top">
              <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
                ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
              </span>
              <strong>${escapeHtml(c.label)}</strong>
              <span class="badge badge-pending">待确认</span>
            </div>
            <div class="cue-line">原锚点台词：${escapeHtml(c.anchor_text || '（无）')}</div>
            ${assetRow(c)}
            <div class="pending-reason">${escapeHtml((c.issue && c.issue.detail) || '无法定位')}</div>
            ${
              cands.length
                ? `<div class="hint" style="margin:6px 0 2px">候选位置（第 ${cands
                    .map((x) => x.lineNo)
                    .join('、')} 行）：</div>` +
                  cands
                    .map(
                      (x) => `
                    <div class="candidate-row">
                      <button class="btn btn-sm btn-primary" data-action="bind-candidate"
                              data-cue="${c.id}" data-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
                      <span class="candidate-line">${escapeHtml(x.lineText)}</span>
                    </div>`
                    )
                    .join('')
                : ''
            }
            <div class="cue-actions">
              <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">点选台词重绑…</button>
              <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑内容</button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
            </div>
          </div>`;
        })
        .join('');
  }

  // 已绑定提示列表
  const list = $('cueList');
  if (bound.length === 0) {
    list.innerHTML = pending.length
      ? ''
      : '<div class="empty">暂无提示。在左侧剧本中点击一句台词即可添加。</div>';
  } else {
    list.innerHTML = bound
      .map(
        (c) => `
      <div class="cue-item">
        <div class="cue-item-top">
          <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
            ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
          </span>
          <span class="cue-label">${escapeHtml(c.label)}</span>
          <span class="badge badge-ok">第 ${c.line_no} 行 · v${c.version}</span>
        </div>
        <button class="line-link" data-action="goto" data-line="${c.line_no}">📖 ${escapeHtml(
          c.line_text || ''
        )}</button>
        ${c.note ? `<div class="cue-note">📝 ${escapeHtml(c.note)}</div>` : ''}
        ${assetRow(c)}
        <div class="cue-actions">
          <button class="btn btn-sm" data-action="add-here" data-line="${c.line_no}">同行再加提示</button>
          <button class="btn btn-sm" data-action="rebind" data-cue="${c.id}">重新绑定…</button>
          <button class="btn btn-sm" data-action="edit" data-cue="${c.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-cue="${c.id}">删除</button>
        </div>
      </div>`
      )
      .join('');
  }
  updatePlayButtons();
}

/* 剧本区点击行 -> 添加提示 */
$('scriptViewer').addEventListener('click', async (e) => {
  if (state.mode !== 'view') return;
  const line = e.target.closest('.script-line.selectable');
  if (!line) return;
  await openCueModal({ mode: 'add', lineNo: Number(line.dataset.line) });
});

/* 提示单 / 待确认面板按钮事件 */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const cueId = Number(btn.dataset.cue);

  if (action === 'goto') {
    const lineNo = Number(btn.dataset.line);
    const el = $('scriptViewer').querySelector(`[data-line="${lineNo}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.flashLineNo = lineNo;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1500);
    }
    return;
  }

  if (action === 'add-here') {
    openCueModal({ mode: 'add', lineNo: Number(btn.dataset.line) });
    return;
  }

  // 素材试听（提示单 / 素材库中的 ▶ 按钮）
  if (action === 'play-asset') {
    toggleAssetPlayback(Number(btn.dataset.asset));
    return;
  }

  // 删除素材：被引用时服务端返回 409 冲突，展示引用明细
  if (action === 'delete-asset') {
    await deleteAsset(btn);
    return;
  }

  // 排练执行台：修订建议相关操作
  if (['suggest', 'sug-edit', 'sug-adopt', 'sug-delete'].includes(action)) {
    await handleSuggestionAction(action, btn);
    return;
  }

  const cue = cueId ? state.script.cues.find((c) => c.id === cueId) : null;

  if (action === 'edit' && cue) {
    openCueModal({ mode: 'edit', cue });
  } else if (action === 'delete' && cue) {
    if (!confirm(`确定删除提示「${cue.label}」？`)) return;
    await api('DELETE', `/api/cues/${cue.id}`);
    toast('提示已删除');
    await openScript(state.script.id);
  } else if (action === 'rebind' && cue) {
    openRebindModal(cue);
  } else if (action === 'bind-candidate') {
    const targetLine = Number(btn.dataset.line);
    await rebindCue(Number(btn.dataset.cue), targetLine, true);
  }
});

/* =============================== 提示弹窗 =============================== */

function currentCueType() {
  const r = document.querySelector('input[name="cueType"]:checked');
  return r ? r.value : 'light';
}

/** 仅音效提示显示素材选择行 */
function toggleCueAssetRow() {
  $('cueAssetRow').classList.toggle('hidden', currentCueType() !== 'sound');
}

function updateCueAssetPlayBtn() {
  $('cueAssetPlayBtn').disabled = !$('cueAssetSelect').value;
}

/** 填充素材下拉框；编辑时选中当前关联素材（素材已不存在则回到「不关联」） */
function fillCueAssetSelect(selectedId) {
  const sel = $('cueAssetSelect');
  sel.innerHTML =
    '<option value="">（不关联素材）</option>' +
    state.assets.list
      .map(
        (a) =>
          `<option value="${a.id}">${escapeHtml(a.filename)}（${formatSize(a.size)}）</option>`
      )
      .join('');
  sel.value = selectedId ? String(selectedId) : '';
  if (selectedId && sel.value !== String(selectedId)) sel.value = '';
  updateCueAssetPlayBtn();
}

async function openCueModal(modalState) {
  state.cueModal = modalState;
  const isAdd = modalState.mode === 'add';
  $('cueModalTitle').textContent = isAdd ? '添加提示' : '编辑提示';

  const type = isAdd ? 'light' : modalState.cue.type;
  document.querySelectorAll('input[name="cueType"]').forEach((r) => {
    r.checked = r.value === type;
  });
  $('cueLabel').value = isAdd ? '' : modalState.cue.label;
  $('cueNote').value = isAdd ? '' : modalState.cue.note || '';

  // 加载素材库供音效提示选择；加载失败不阻塞弹窗（仍可不关联素材保存）
  try {
    await loadAssets();
  } catch {
    /* 素材列表不可用时仅无法选择素材 */
  }
  fillCueAssetSelect(isAdd ? null : modalState.cue.asset && modalState.cue.asset.id);
  toggleCueAssetRow();

  if (isAdd) {
    const lines = state.script.content.replace(/\r\n/g, '\n').split('\n');
    $('cueModalLine').textContent = `附着于第 ${modalState.lineNo} 行：${lines[modalState.lineNo - 1] || ''}`;
  } else {
    $('cueModalLine').textContent =
      modalState.cue.anchor_status === 'bound'
        ? `第 ${modalState.cue.line_no} 行：${modalState.cue.line_text || ''}`
        : `待确认 · 原锚点：${modalState.cue.anchor_text || '（无）'}`;
  }
  $('cueModal').classList.remove('hidden');
  $('cueLabel').focus();
}

function closeCueModal() {
  state.cueModal = null;
  $('cueModal').classList.add('hidden');
}

$('cueCancelBtn').addEventListener('click', closeCueModal);
$('cueModal').addEventListener('click', (e) => {
  if (e.target === $('cueModal')) closeCueModal();
});

// 类型切换：仅音效提示显示素材选择行
document.querySelectorAll('input[name="cueType"]').forEach((r) =>
  r.addEventListener('change', toggleCueAssetRow)
);
$('cueAssetSelect').addEventListener('change', () => {
  updateCueAssetPlayBtn();
  updatePlayButtons();
});
$('cueAssetPlayBtn').addEventListener('click', () => {
  toggleAssetPlayback(Number($('cueAssetSelect').value) || null);
});

$('cueSaveBtn').addEventListener('click', async () => {
  const m = state.cueModal;
  const body = {
    type: currentCueType(),
    label: $('cueLabel').value.trim(),
    note: $('cueNote').value.trim(),
  };
  if (!body.label) return toast('请填写提示内容', true);
  // 音效提示：携带素材选择（空串 = 解除关联）；灯光提示由服务端自动解除关联
  if (body.type === 'sound') {
    body.assetId = $('cueAssetSelect').value ? Number($('cueAssetSelect').value) : null;
  }

  try {
    if (m.mode === 'add') {
      await api('POST', `/api/scripts/${state.script.id}/cues`, { ...body, lineNo: m.lineNo });
      toast('提示已添加');
    } else {
      await api('PATCH', `/api/cues/${m.cue.id}`, body);
      toast('提示已保存');
    }
    closeCueModal();
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* =============================== 重新绑定弹窗 =============================== */

function openRebindModal(cue) {
  state.rebindCue = cue;
  state.rebindTarget = null;

  $('rebindCueInfo').innerHTML = `
    <span class="badge ${cue.type === 'light' ? 'badge-light' : 'badge-sound'}">
      ${cue.type === 'light' ? '💡 灯光' : '🔊 音效'}
    </span>
    <strong>${escapeHtml(cue.label)}</strong>`;
  $('rebindReason').textContent = cue.issue
    ? `无法自动定位原因：${cue.issue.detail}`
    : '为该提示选择正确的台词行：';

  const cands = (cue.issue && cue.issue.candidates) || [];
  $('rebindCandidates').innerHTML = cands.length
    ? cands
        .map(
          (x) => `
      <div class="candidate-row">
        <button class="btn btn-sm btn-primary" data-rebind-line="${x.lineNo}">绑到第 ${x.lineNo} 行</button>
        <span class="candidate-line">${escapeHtml(x.lineText)}</span>
      </div>`
        )
        .join('')
    : '';

  renderViewer($('rebindViewer'), state.script.content, {
    clickable: false,
    pendingLineNos: cands.map((x) => x.lineNo),
  });
  $('rebindViewer').querySelectorAll('.script-line.selectable').forEach((el) => {
    el.addEventListener('click', async () => {
      await rebindCue(cue.id, Number(el.dataset.line), true);
    });
  });

  $('rebindModal').classList.remove('hidden');
}

$('rebindCandidates').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-rebind-line]');
  if (!btn) return;
  await rebindCue(state.rebindCue.id, Number(btn.dataset.rebindLine), true);
});

async function rebindCue(cueId, lineNo, closeModal) {
  try {
    await api('POST', `/api/cues/${cueId}/rebind`, { lineNo });
    toast(`已绑定到第 ${lineNo} 行`);
    if (closeModal) $('rebindModal').classList.add('hidden');
    state.rebindCue = null;
    state.flashLineNo = lineNo;
    await openScript(state.script.id);
  } catch (err) {
    toast(err.message, true);
  }
}

$('rebindCancelBtn').addEventListener('click', () => {
  $('rebindModal').classList.add('hidden');
  state.rebindCue = null;
});
$('rebindModal').addEventListener('click', (e) => {
  if (e.target === $('rebindModal')) $('rebindModal').classList.add('hidden');
});

/* =============================== 修订建议 =============================== */

function openSuggestModal(modalState) {
  state.suggestModal = modalState;
  const isAdd = modalState.mode === 'add';
  const item = isAdd
    ? modalState.item
    : state.run.activeSession.items.find((it) => it.id === modalState.suggestion.item_id);
  if (!item) return toast('场次条目已不存在', true);

  $('suggestModalTitle').textContent = isAdd ? '为冻结条目提修订建议' : '修改修订建议';
  $('suggestItemInfo').textContent =
    `#${item.seq} · 第 ${item.line_no} 行：${item.line_text || ''}　｜　快照内容：${item.label}` +
    (item.note ? `（📝 ${item.note}）` : '');
  $('suggestLabel').value = isAdd ? item.label : modalState.suggestion.label;
  $('suggestNote').value = isAdd ? item.note || '' : modalState.suggestion.note || '';
  $('suggestModal').classList.remove('hidden');
  $('suggestLabel').focus();
}

function closeSuggestModal() {
  state.suggestModal = null;
  $('suggestModal').classList.add('hidden');
}

$('suggestCancelBtn').addEventListener('click', closeSuggestModal);
$('suggestModal').addEventListener('click', (e) => {
  if (e.target === $('suggestModal')) closeSuggestModal();
});

$('suggestSaveBtn').addEventListener('click', async () => {
  const m = state.suggestModal;
  if (!m) return;
  const body = { label: $('suggestLabel').value.trim(), note: $('suggestNote').value.trim() };
  if (!body.label) return toast('请填写建议的提示内容', true);

  const s = state.run.activeSession;
  try {
    if (m.mode === 'add') {
      await api('POST', `/api/sessions/${s.id}/items/${m.item.id}/suggestions`, body);
      toast('建议已保存，刷新后仍可查看与修改');
    } else {
      await api('PATCH', `/api/suggestions/${m.suggestion.id}`, body);
      toast('建议已更新，状态重置为待处理');
    }
    closeSuggestModal();
    await refreshActiveSession();
  } catch (err) {
    toast(err.message, true);
  }
});

/** 执行台中建议相关按钮：提建议 / 编辑 / 采纳 / 删除 */
async function handleSuggestionAction(action, btn) {
  const s = state.run.activeSession;
  if (!s) return;

  if (action === 'suggest') {
    const item = s.items.find((it) => it.id === Number(btn.dataset.item));
    if (item) openSuggestModal({ mode: 'add', item });
    return;
  }

  const sug = (s.suggestions || []).find((g) => g.id === Number(btn.dataset.sug));
  if (!sug) return toast('建议已不存在，请刷新', true);

  if (action === 'sug-edit') {
    openSuggestModal({ mode: 'edit', suggestion: sug });
    return;
  }

  if (action === 'sug-delete') {
    if (!confirm('确定删除该修订建议？')) return;
    try {
      await api('DELETE', `/api/suggestions/${sug.id}`);
      toast('建议已删除');
      await refreshActiveSession();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  if (action === 'sug-adopt') {
    try {
      await api('POST', `/api/suggestions/${sug.id}/adopt`);
      toast('建议已采纳，当前提示已更新（场次快照保持原样）');
      // 提示单数据已变化，静默刷新以便切回「剧本与提示单」时看到最新内容
      state.script = await api('GET', `/api/scripts/${state.script.id}`);
      await refreshActiveSession();
    } catch (err) {
      if (err.status === 409) {
        // 核对失败：建议被保留并标记冲突，刷新后展示冲突原因
        toast(`冲突：${err.message}`, true);
        await refreshActiveSession();
        refreshHistory();
      } else {
        toast(err.message, true);
      }
    }
  }
}

/* =============================== 漏执行登记 =============================== */

function openMissModal(item) {
  state.missModal = { item };
  $('missItemInfo').textContent =
    `#${item.seq} · 第 ${item.line_no} 行：${item.line_text || ''}　｜　` +
    `${item.type === 'light' ? '💡 灯光' : '🔊 音效'} ${item.label}`;
  $('missReason').value = '';
  $('missModal').classList.remove('hidden');
  $('missReason').focus();
}

function closeMissModal() {
  state.missModal = null;
  $('missModal').classList.add('hidden');
}

$('missCancelBtn').addEventListener('click', closeMissModal);
$('missModal').addEventListener('click', (e) => {
  if (e.target === $('missModal')) closeMissModal();
});

$('missSaveBtn').addEventListener('click', async () => {
  const m = state.missModal;
  const s = state.run.activeSession;
  if (!m || !s) return;
  const reason = $('missReason').value.trim();
  if (!reason) return toast('请填写漏执行原因', true);

  const btn = $('missSaveBtn');
  btn.disabled = true;
  try {
    // 与正常执行共用同一进度与乐观锁校验
    await api('POST', `/api/sessions/${s.id}/miss`, {
      itemId: m.item.id,
      expectedProgress: s.progress,
      reason,
    });
    closeMissModal();
    toast('已登记漏执行，继续处理下一条');
    await refreshActiveSession();
  } catch (err) {
    if (err.status === 409) {
      closeMissModal();
      handleRunConflict(err);
    } else {
      toast(err.message, true);
    }
  } finally {
    btn.disabled = false;
  }
});

/* =============================== 音效素材库 =============================== */

async function loadAssets(force) {
  if (state.assets.loaded && !force) return;
  state.assets.list = await api('GET', '/api/assets');
  state.assets.loaded = true;
}

async function loadAssetsTab() {
  try {
    await loadAssets(true);
    renderAssets();
  } catch (err) {
    $('assetList').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderAssets() {
  const box = $('assetList');
  const list = state.assets.list;
  if (!list.length) {
    box.innerHTML =
      '<div class="empty">素材库为空。上传 MP3 / WAV / OGG 文件后，即可在音效提示中关联并试听。</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (a) => `
    <div class="asset-item">
      <div class="asset-item-main">
        <div class="asset-name">🎵 ${escapeHtml(a.filename)}</div>
        <div class="asset-meta">
          ${formatSize(a.size)}<span class="sep">·</span>上传于 ${escapeHtml(a.created_at)}
          <span class="sep">·</span>${
            a.ref_count > 0
              ? `<span class="asset-ref">被 ${a.ref_count} 条提示引用</span>`
              : '未被引用'
          }
        </div>
      </div>
      <div class="asset-item-actions">
        <button class="btn btn-sm" data-action="play-asset" data-asset="${a.id}">▶ 试听</button>
        <button class="btn btn-sm btn-danger" data-action="delete-asset" data-asset="${a.id}"
                data-name="${escapeHtml(a.filename)}" data-refs="${a.ref_count}">删除</button>
      </div>
    </div>`
    )
    .join('');
  updatePlayButtons();
}

/* 上传：前端先做扩展名与大小校验，服务端还会做魔数与 SHA-256 去重 */
$('assetPickBtn').addEventListener('click', () => $('assetFileInput').click());

$('assetFileInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 允许再次选择同一文件
  if (!file) return;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!['.mp3', '.wav', '.ogg'].includes(ext)) {
    return toast('仅支持 MP3 / WAV / OGG 格式的音频文件', true);
  }
  if (file.size === 0) return toast('文件为空，未上传', true);
  if (file.size > 10 * 1024 * 1024) return toast('文件超过 10 MB 大小限制，未上传', true);

  const btn = $('assetPickBtn');
  btn.disabled = true;
  $('assetUploadHint').textContent = `正在上传「${file.name}」…`;
  try {
    const res = await fetch(`/api/assets?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `上传失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    toast(
      data.deduped
        ? '已存在相同内容的素材，已复用原记录与文件'
        : `素材「${data.asset.filename}」已上传`
    );
    await loadAssetsTab();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    $('assetUploadHint').textContent = '支持 MP3 / WAV / OGG，单个文件不超过 10 MB';
  }
});

/** 删除素材：被引用时服务端返回 409（附引用明细），解除全部引用后才能删除 */
async function deleteAsset(btn) {
  const id = Number(btn.dataset.asset);
  const refs = Number(btn.dataset.refs) || 0;
  if (refs === 0) {
    if (!confirm(`确定删除素材「${btn.dataset.name}」？文件与记录将一并删除，不可恢复。`)) return;
  }
  try {
    await api('DELETE', `/api/assets/${id}`);
    if (playingAssetId === id) stopAssetPlayback();
    toast('素材已删除');
    await loadAssetsTab();
  } catch (err) {
    if (err.status === 409) {
      const refs2 = (err.data && err.data.references) || [];
      const detail = refs2
        .slice(0, 3)
        .map((r) => `「${r.label}」@${r.script_title}`)
        .join('、');
      toast(detail ? `${err.message}：${detail}${refs2.length > 3 ? ' 等' : ''}` : err.message, true);
      loadAssetsTab(); // 引用计数可能已变化，静默刷新
    } else {
      toast(err.message, true);
    }
  }
}

/* =============================== 标签页切换 =============================== */

function switchTab(tab) {
  state.tab = tab;
  stopAssetPlayback(); // 切换标签时停止试听，避免后台继续播放
  $('cueTab').classList.toggle('hidden', tab !== 'cue');
  $('runTab').classList.toggle('hidden', tab !== 'run');
  $('versionsTab').classList.toggle('hidden', tab !== 'versions');
  $('assetsTab').classList.toggle('hidden', tab !== 'assets');
  $('tabCueBtn').classList.toggle('active', tab === 'cue');
  $('tabRunBtn').classList.toggle('active', tab === 'run');
  $('tabVersionsBtn').classList.toggle('active', tab === 'versions');
  $('tabAssetsBtn').classList.toggle('active', tab === 'assets');
  if (tab === 'run') loadRunTab();
  if (tab === 'versions') loadVersionsTab();
  if (tab === 'assets') loadAssetsTab();
}

$('tabCueBtn').addEventListener('click', () => switchTab('cue'));
$('tabRunBtn').addEventListener('click', () => switchTab('run'));
$('tabVersionsBtn').addEventListener('click', () => switchTab('versions'));
$('tabAssetsBtn').addEventListener('click', () => switchTab('assets'));

/* =============================== 排练执行台 =============================== */

async function loadRunTab() {
  const id = state.script.id;
  $('runPreview').textContent = '正在读取当前版本提示…';
  try {
    const [preview, sessions] = await Promise.all([
      api('GET', `/api/scripts/${id}/sessions/preview`),
      api('GET', `/api/scripts/${id}/sessions`),
    ]);
    state.run.preview = preview;
    state.run.sessions = sessions;
    renderCreateBox();
    renderSessionHistory();
    renderCmpSelects();

    // 默认打开最近一场（刷新页面后可在此恢复进度）
    const keep = state.run.activeSession;
    const target =
      keep && sessions.some((s) => s.id === keep.id)
        ? keep.id
        : sessions.length
          ? sessions[0].id
          : null;
    if (target) {
      await openRunSession(target);
    } else {
      state.run.activeSession = null;
      renderActiveSession();
    }
    // 场次够两场时自动按默认基准/对照场跑一次对照
    runCompare();
  } catch (err) {
    toast(err.message, true);
  }
}

/** 创建前的预览面板：显示将冻结条目数与待确认排除数 */
function renderCreateBox() {
  const p = state.run.preview;
  const box = $('runPreview');
  if (!p) {
    box.textContent = '暂无预览';
    return;
  }
  box.innerHTML = `
    <div class="run-preview-line">
      将基于剧本<strong>第 ${p.version} 版</strong>冻结当前已绑定提示，
      共 <strong>${p.total}</strong> 条可执行条目
      （按行号、提示 ID 排序）。
    </div>
    <div class="run-preview-line ${p.excluded_pending ? 'has-pending' : ''}">
      ${
        p.excluded_pending
          ? `⚠ 有 <strong>${p.excluded_pending}</strong> 条待确认提示未定位，将被排除在场次之外；请先在「剧本与提示单」中重新绑定。`
          : '没有待确认提示被排除。'
      }
    </div>`;
  $('runCreateBtn').disabled = p.total === 0;
  $('runCreateBtn').textContent =
    p.total === 0 ? '无可执行提示，不能创建场次' : '从当前版本创建场次';
}

$('runCreateBtn').addEventListener('click', async () => {
  const name = $('runName').value.trim();
  try {
    const r = await api('POST', `/api/scripts/${state.script.id}/sessions`, { name });
    $('runName').value = '';
    // 新建场次后重置对照默认选择（新场次成为最新场，自动作为基准场）
    state.run.cmp = { baseId: null, compareId: null, result: null, expanded: new Set() };
    toast('场次已创建，提示行号/类型/内容/备注已冻结');
    await loadRunTab();
    await openRunSession(r.id);
  } catch (err) {
    if (err.status === 409) {
      toast(err.message, true);
      loadRunTab(); // 进度/数据可能已变，静默刷新
    } else {
      toast(err.message, true);
    }
  }
});

async function openRunSession(sessionId) {
  try {
    const [session, makeup] = await Promise.all([
      api('GET', `/api/sessions/${sessionId}`),
      api('GET', `/api/sessions/${sessionId}/makeup-preview`),
    ]);
    syncServerClock(session.server_now);
    state.run.activeSession = session;
    state.run.makeupPreview = makeup;
    renderActiveSession();
    renderSessionHistory();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderActiveSession() {
  const box = $('activeSessionBox');
  const s = state.run.activeSession;
  if (!s) {
    box.innerHTML = '<div class="empty">还没有场次，从上方创建一场开始排练。</div>';
    return;
  }

  const head = s.items[s.progress] || null; // 队首（0-based 进度直接当下标）
  const headItem = head
    ? `
    <div class="run-head ${head.type === 'light' ? 'is-light' : 'is-sound'}">
      <div class="run-head-top">
        <span class="run-head-idx">下一条 · #${head.seq}</span>
        <span class="badge ${head.type === 'light' ? 'badge-light' : 'badge-sound'}">
          ${head.type === 'light' ? '💡 灯光' : '🔊 音效'}
        </span>
        <span class="run-head-label">${escapeHtml(head.label)}</span>
      </div>
      <div class="run-head-line">📖 第 ${head.line_no} 行：${escapeHtml(head.line_text)}</div>
      ${head.note ? `<div class="run-head-note">📝 ${escapeHtml(head.note)}</div>` : ''}
    </div>`
    : `<div class="run-head run-done">🎉 本场次 ${s.total} 条提示已全部处理完毕（已执行 ${s.done_count} · 漏执行 ${s.missed_count}）</div>`;

  const sugList = s.suggestions || [];
  const pendingSug = sugList.filter((g) => g.status === 'pending').length;
  const conflictSug = sugList.filter((g) => g.status === 'conflict').length;

  box.innerHTML = `
    <div class="run-session-head">
      <div class="run-session-title">
        ${s.kind === 'makeup' ? '<span class="badge badge-makeup">🔁 漏项补排场</span> ' : ''}${escapeHtml(s.name)}
      </div>
      <div class="run-session-meta">
        <span class="badge badge-version">v${s.script_version} 快照</span>
        <span>共 ${s.total} 条 · 已执行 ${s.done_count} 条 · 漏执行 ${s.missed_count} 条</span>
        <span class="timer-meta" title="当前有效排练时长（按服务端时间）">
          ⏱ 有效排练 <strong data-timer="now">${escapeHtml(formatDuration(liveRehearsalSeconds(s)))}</strong>
        </span>
        ${pendingSug ? `<span class="badge badge-sug-pending">💬 待处理建议 ${pendingSug}</span>` : ''}
        ${conflictSug ? `<span class="badge badge-pending">⚠ 冲突建议 ${conflictSug}</span>` : ''}
        ${s.is_complete ? '<span class="badge badge-ok">已完成</span>' : ''}
      </div>
    </div>
    ${s.kind === 'makeup' ? renderMakeupOrigin(s) : ''}
    ${renderMakeupBox(s)}
    ${renderTimerBox(s)}

    <div class="run-progress-bar">
      <div class="run-progress-fill" style="width:${s.total ? (s.progress / s.total) * 100 : 0}%"></div>
    </div>

    ${headItem}

    <div class="run-controls">
      <button class="btn btn-primary" id="executeBtn"
        ${!head || s.is_complete ? 'disabled' : ''}>
        ▶ 执行队首（#${head ? head.seq : '—'}）
      </button>
      <button class="btn btn-warn" id="missBtn" ${!head || s.is_complete ? 'disabled' : ''}>
        ⚠ 登记漏执行
      </button>
      <button class="btn" id="undoBtn" ${s.progress === 0 ? 'disabled' : ''}>
        ↩ 撤回最后一条
      </button>
      <span class="hint" id="runConflictHint"></span>
    </div>

    <h4 class="run-subhead">提示队列（创建时冻结）</h4>
    <div class="run-queue">
      ${s.items
        .map((it) => {
          const isHead = head && it.id === head.id;
          const cls =
            it.status === 'done'
              ? 'done'
              : it.status === 'missed'
                ? 'missed'
                : isHead
                  ? 'head'
                  : 'pending';
          const stateTag =
            it.status === 'done'
              ? '<span class="run-tag tag-done">已执行</span>'
              : it.status === 'missed'
                ? '<span class="run-tag tag-missed">漏执行</span>'
                : isHead
                  ? '<span class="run-tag tag-head">队首</span>'
                  : '<span class="run-tag tag-pending">待执行</span>';
          const sugs = it.suggestions || [];
          const sugBadges = renderSugMiniBadges(sugs);
          const msrc = it.makeup_source;
          return `
          <div class="run-item ${cls}">
            <span class="run-item-idx">#${it.seq}</span>
            ${stateTag}
            ${
              it.status !== 'pending'
                ? `<span class="run-tag tag-timepoint" title="该条处理时的有效排练秒数">⏱ ${escapeHtml(
                    formatDuration(it.rehearsal_seconds)
                  )}</span>`
                : ''
            }
            <span class="badge ${it.type === 'light' ? 'badge-light' : 'badge-sound'}">
              ${it.type === 'light' ? '💡' : '🔊'}
            </span>
            <span class="run-item-line">第 ${it.line_no} 行</span>
            <span class="run-item-label">${escapeHtml(it.label)}</span>
            ${msrc ? `<span class="run-tag tag-makeup">🔁 补排自原 #${msrc.source_seq}</span>` : ''}
            ${sugBadges}
            <span class="run-item-actions">
              <button class="btn btn-sm" data-action="suggest" data-item="${it.id}">✏️ 建议</button>
            </span>
            ${it.note ? `<span class="run-item-note">📝 ${escapeHtml(it.note)}</span>` : ''}
            ${msrc && msrc.miss_reason ? `<span class="run-item-note run-item-miss">⚠ 原漏执行原因：${escapeHtml(msrc.miss_reason)}</span>` : ''}
            ${it.status === 'missed' && it.miss_reason ? `<span class="run-item-note run-item-miss">⚠ 本场漏执行原因：${escapeHtml(it.miss_reason)}</span>` : ''}
          </div>`;
        })
        .join('')}
    </div>

    <h4 class="run-subhead">修订建议（保存在本场次下）</h4>
    <div class="sug-list">
      ${
        sugList.length === 0
          ? '<div class="empty" style="padding:12px 0">暂无修订建议。点击队列中条目的「✏️ 建议」即可提出。</div>'
          : sugList.map((g) => renderSuggestionCard(g)).join('')
      }
    </div>

    <h4 class="run-subhead">执行记录</h4>
    <div class="run-log">
      ${
        s.executions.length === 0
          ? '<div class="empty" style="padding:12px 0">尚无处理记录。</div>'
          : s.executions
              .slice()
              .reverse()
              .map(
                (e) => `
            <div class="run-log-row ${e.kind === 'missed' ? 'is-missed' : ''}">
              <span class="run-log-time">${escapeHtml(e.executed_at)}</span>
              <span class="run-log-idx">#${e.seq}</span>
              <span class="run-tag ${e.kind === 'missed' ? 'tag-missed' : 'tag-done'}">
                ${e.kind === 'missed' ? '漏执行' : '已执行'}
              </span>
              <span class="run-tag tag-timepoint" title="该条处理时的有效排练秒数">
                ⏱ ${escapeHtml(formatDuration(e.rehearsal_seconds))}
              </span>
              <span class="badge ${e.type === 'light' ? 'badge-light' : 'badge-sound'}">
                ${e.type === 'light' ? '💡' : '🔊'}
              </span>
              <span class="run-item-label">${escapeHtml(e.label)}</span>
              <span class="run-item-line">第 ${e.line_no} 行</span>
              ${e.kind === 'missed' && e.miss_reason ? `<span class="run-log-reason">⚠ ${escapeHtml(e.miss_reason)}</span>` : ''}
            </div>`
              )
              .join('')
      }
    </div>`;

  $('executeBtn').addEventListener('click', () => head && executeItem(head.id));
  $('missBtn').addEventListener('click', () => head && openMissModal(head));
  $('undoBtn').addEventListener('click', undoLast);
  const makeupBtn = $('makeupCreateBtn');
  if (makeupBtn) makeupBtn.addEventListener('click', createMakeupSession);
  const originBtn = $('makeupOriginBtn');
  if (originBtn) {
    originBtn.addEventListener('click', () => openRunSession(Number(originBtn.dataset.source)));
  }
}

/**
 * 有效排练计时面板：开始 / 暂停 / 继续全部由服务端持久化状态与状态版本控制，
 * 当前有效时长按服务端时间计算（页面仅每秒刷新数字），刷新或换浏览器后状态一致恢复；
 * 重复点击或基于旧版本的切换会被服务端以 409 拒绝，不会重复累计。
 * 从未开始计时的场次可照常执行，处理记录显示「未计时」。
 */
function renderTimerBox(s) {
  const st = s.timer_state || 'idle';
  const stTag =
    st === 'running'
      ? '<span class="run-tag tag-timer-running">⏱ 计时中</span>'
      : st === 'paused'
        ? '<span class="run-tag tag-timer-paused">⏸ 已暂停</span>'
        : '<span class="run-tag tag-timer-idle">未开始计时</span>';
  return `
  <div class="timer-box timer-${st}">
    <div class="timer-main">
      <span class="timer-label">有效排练时长</span>
      <span class="timer-value" data-timer="now">${escapeHtml(formatDuration(liveRehearsalSeconds(s)))}</span>
      ${stTag}
    </div>
    <div class="timer-controls">
      <button class="btn btn-sm btn-primary" data-action="timer-toggle" data-timer-action="start"
        ${st !== 'idle' || s.is_complete ? 'disabled' : ''}>▶ 开始计时</button>
      <button class="btn btn-sm btn-warn" data-action="timer-toggle" data-timer-action="pause"
        ${st !== 'running' || s.is_complete ? 'disabled' : ''}>⏸ 暂停</button>
      <button class="btn btn-sm" data-action="timer-toggle" data-timer-action="resume"
        ${st !== 'paused' || s.is_complete ? 'disabled' : ''}>▶ 继续</button>
    </div>
    <div class="timer-hint hint">
      状态由服务端持久化，有效时长按服务端时间计算，刷新或换浏览器均可恢复；
      每条执行/漏执行都会在同一事务记录其有效排练秒数。${s.is_complete ? '本场次已完成，计时已停止。' : ''}
    </div>
  </div>`;
}

/** 补排场头部：来源场次与原漏执行说明（冻结，仅追溯；点击可跳回来源场次） */
function renderMakeupOrigin(s) {
  const src = s.source_session;
  return `
  <div class="makeup-origin">
    <span class="badge badge-makeup">🔁 漏项补排</span>
    <span>本场次由来源场次
      ${
        src
          ? `<button class="line-link" id="makeupOriginBtn" data-source="${src.id}">「${escapeHtml(src.name)}」</button>`
          : '「（来源场次已删除）」'
      }
    的漏执行记录一键冻结生成，行号/类型/文案/备注与原漏执行原因均按原队列顺序冻结；原场次及当前提示保持原样。</span>
  </div>`;
}

/**
 * 漏项补排入口：列出当前场次「尚未补排」的漏执行记录，一键生成补排场。
 * 没有漏执行、或漏执行已全部补排时不展示生成按钮（不能生成空场次）。
 */
function renderMakeupBox(s) {
  const mp = state.run.makeupPreview;
  if (!mp) return '';
  const available = mp.items || [];
  const header = `
    <div class="makeup-box">
      <div class="makeup-box-head">
        <strong>🔁 漏项补排</strong>
        ${
          mp.missed_total > 0
            ? `<span class="hint">来源场共登记漏执行 ${mp.missed_total} 条 · 已补排 ${mp.made_up} 条 · 待补排 <strong class="makeup-count">${mp.available}</strong> 条</span>`
            : '<span class="hint">本场次还没有漏执行记录。</span>'
        }
      </div>`;
  if (mp.missed_total === 0) {
    return `${header}<div class="hint" style="margin:4px 0 0">队首无法执行时可点「⚠ 登记漏执行」，之后即可在此一键生成补排场次。</div></div>`;
  }
  if (available.length === 0) {
    return `${header}<div class="hint" style="margin:4px 0 0">全部漏执行记录均已生成补排场次；同一条漏执行记录只能进入一个补排场次。</div></div>`;
  }
  return `${header}
    <div class="makeup-list">
      ${available
        .map(
          (c) => `
        <div class="makeup-item">
          <span class="run-item-idx">原 #${c.item_seq}</span>
          <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
            ${c.type === 'light' ? '💡' : '🔊'}
          </span>
          <span class="run-item-line">第 ${c.line_no} 行</span>
          <span class="run-item-label">${escapeHtml(c.label)}</span>
          ${c.note ? `<span class="makeup-item-note">📝 ${escapeHtml(c.note)}</span>` : ''}
          <span class="makeup-item-note run-item-miss">⚠ 漏执行原因：${escapeHtml(c.miss_reason || '')}</span>
        </div>`
        )
        .join('')}
    </div>
    <p class="hint" style="margin:6px 0">
      将按原队列顺序冻结以上条目的行号、类型、文案、备注与漏执行原因；创建时服务端会在事务内再次复核来源记录仍为漏执行，
      若此时来源场次已撤回（请求过期）将返回冲突，且不会生成空场次。
    </p>
    <div class="run-create-form">
      <input id="makeupName" class="input" type="text" placeholder="补排场次名称（可选，默认「来源场次名 · 漏项补排」）" />
      <button class="btn btn-primary" id="makeupCreateBtn">🔁 一键生成补排场次（${available.length} 条）</button>
    </div>
  </div>`;
}

/** 一键生成漏项补排场；冲突（撤回/重复补排/空）由服务端 409 拒绝 */
async function createMakeupSession() {
  const s = state.run.activeSession;
  const mp = state.run.makeupPreview;
  if (!s || !mp || !mp.items.length) return;
  const count = mp.items.length;
  if (
    !confirm(
      `将把来源场次当前尚未补排的 ${count} 条漏执行记录按原队列顺序冻结，生成一个补排场次。是否继续？`
    )
  ) {
    return;
  }
  const btn = $('makeupCreateBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/sessions/${s.id}/makeup`, {
      name: $('makeupName').value.trim(),
      sourceExecutionIds: mp.items.map((c) => c.execution_id),
    });
    $('makeupName').value = '';
    state.run.cmp = { baseId: null, compareId: null, result: null, expanded: new Set() };
    toast(`补排场次已创建：${r.total} 条漏执行项已按原队列冻结`);
    await loadRunTab();
    await openRunSession(r.id);
  } catch (err) {
    if (err.status === 409) {
      toast(`冲突：${err.message}`, true);
      await loadRunTab();
    } else {
      toast(err.message, true);
    }
  } finally {
    if (document.body.contains(btn)) btn.disabled = false;
  }
}

/** 队列条目上的建议状态小标记 */
function renderSugMiniBadges(sugs) {
  const pending = sugs.filter((g) => g.status === 'pending').length;
  const conflict = sugs.filter((g) => g.status === 'conflict').length;
  const adopted = sugs.filter((g) => g.status === 'adopted').length;
  return (
    (pending ? `<span class="run-tag tag-sug-pending">💬 建议 ${pending}</span>` : '') +
    (conflict ? `<span class="run-tag tag-sug-conflict">⚠ 冲突 ${conflict}</span>` : '') +
    (adopted ? `<span class="run-tag tag-sug-adopted">✓ 已采纳 ${adopted}</span>` : '')
  );
}

const SUG_STATUS = {
  pending: { text: '待处理', cls: 'badge-sug-pending' },
  conflict: { text: '冲突', cls: 'badge-pending' },
  adopted: { text: '已采纳', cls: 'badge-ok' },
};

/** 单条修订建议卡片：展示快照原文 → 建议内容，以及待处理/冲突/已采纳状态 */
function renderSuggestionCard(g) {
  const st = SUG_STATUS[g.status] || SUG_STATUS.pending;
  const actionable = g.status !== 'adopted';
  return `
  <div class="sug-item ${g.status === 'conflict' ? 'is-conflict' : ''}">
    <div class="sug-item-top">
      <span class="run-item-idx">#${g.item_seq}</span>
      <span class="run-item-line">第 ${g.item_line_no} 行</span>
      <span class="badge ${st.cls}">${st.text}</span>
      <span class="sug-time">${escapeHtml(g.updated_at)}</span>
    </div>
    <div class="sug-diff">
      <div class="sug-diff-row">
        <span class="sug-diff-tag">快照</span>
        <span>${escapeHtml(g.item_label)}${g.item_note ? `（📝 ${escapeHtml(g.item_note)}）` : ''}</span>
      </div>
      <div class="sug-diff-row">
        <span class="sug-diff-tag sug-diff-new">建议</span>
        <span>${escapeHtml(g.label)}${g.note ? `（📝 ${escapeHtml(g.note)}）` : ''}</span>
      </div>
    </div>
    ${g.status === 'conflict' && g.conflict_reason
      ? `<div class="sug-conflict-reason">⚠ 采纳被驳回：${escapeHtml(g.conflict_reason)}。建议已保留，可修改后重试。</div>`
      : ''}
    ${
      actionable
        ? `<div class="sug-actions">
            <button class="btn btn-sm btn-primary" data-action="sug-adopt" data-sug="${g.id}">采纳（写回当前提示）</button>
            <button class="btn btn-sm" data-action="sug-edit" data-sug="${g.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-action="sug-delete" data-sug="${g.id}">删除</button>
          </div>`
        : '<div class="hint" style="margin:6px 0 0">已写回当前提示，建议作为历史保留。</div>'
    }
  </div>`;
}

async function executeItem(itemId) {
  const s = state.run.activeSession;
  const expectedProgress = s.progress;
  const btn = $('executeBtn');
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${s.id}/execute`, { itemId, expectedProgress });
    await refreshActiveSession();
  } catch (err) {
    handleRunConflict(err);
  } finally {
    if (document.body.contains(btn)) btn.disabled = false;
  }
}

/* ---------- 计时开始/暂停/继续（状态版本乐观锁） ---------- */

let timerBusy = false;

async function toggleTimer(action) {
  const s = state.run.activeSession;
  if (!s || timerBusy) return;
  const expectedVersion = s.timer_version;
  timerBusy = true;
  document
    .querySelectorAll('.timer-controls [data-action="timer-toggle"]')
    .forEach((b) => (b.disabled = true));
  try {
    const r = await api('POST', `/api/sessions/${s.id}/timer`, { action, expectedVersion });
    // 成功后直接用响应更新持久化状态（不再整页重渲染，避免打断秒针），并与服务端对表
    syncServerClock(r.server_now);
    s.timer_state = r.timer_state;
    s.timer_elapsed = r.timer_elapsed;
    s.timer_started_at = r.timer_started_at;
    s.timer_version = r.timer_version;
    renderActiveSession();
    // 完成自动停表不会由该接口触发；开始/暂停/继续本身不改进度，历史列表稍后刷新即可
    refreshHistory();
  } catch (err) {
    if (err.status === 409) {
      // 重复提交或另一浏览器已切换（旧版本）：以服务端状态为准恢复
      toast(`计时冲突：${err.message}`, true);
      await refreshActiveSession();
    } else {
      toast(err.message, true);
      renderActiveSession();
    }
  } finally {
    timerBusy = false;
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="timer-toggle"]');
  if (btn) toggleTimer(btn.dataset.timerAction);
});

/**
 * 全局秒针：每秒只更新当前场次计时面板的数字（running 时跳动），
 * 状态、累计秒数均来自服务端持久化数据，这里不累计、仅展示。
 */
setInterval(() => {
  const els = document.querySelectorAll('[data-timer="now"]');
  if (!els.length) return;
  const s = state.run.activeSession;
  if (!s) return;
  const text = formatDuration(liveRehearsalSeconds(s));
  els.forEach((el) => {
    if (document.body.contains(el)) el.textContent = text;
  });
}, 1000);

async function undoLast() {
  const s = state.run.activeSession;
  const expectedProgress = s.progress;
  const btn = $('undoBtn');
  btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${s.id}/undo`, { expectedProgress });
    await refreshActiveSession();
  } catch (err) {
    handleRunConflict(err);
  } finally {
    if (document.body.contains(btn)) btn.disabled = false;
  }
}

/** 冲突（过期/重复/越序）：刷新场次恢复真实进度，不推进下一条 */
function handleRunConflict(err) {
  if (err.status === 409) {
    toast(`冲突：${err.message}`, true);
    refreshActiveSession();
    refreshHistory();
  } else {
    toast(err.message, true);
  }
}

async function refreshActiveSession() {
  const s = state.run.activeSession;
  if (!s) return;
  const [session, makeup] = await Promise.all([
    api('GET', `/api/sessions/${s.id}`),
    api('GET', `/api/sessions/${s.id}/makeup-preview`),
  ]);
  syncServerClock(session.server_now);
  state.run.activeSession = session;
  state.run.makeupPreview = makeup;
  renderActiveSession();
  refreshHistory();
  // 对照结果若正展示且涉及当前场次，执行/漏执行/撤回后静默刷新状态
  if (state.run.cmp.result) runCompare();
}

async function refreshHistory() {
  state.run.sessions = await api('GET', `/api/scripts/${state.script.id}/sessions`);
  renderSessionHistory();
  renderCmpSelects();
}

function renderSessionHistory() {
  const box = $('sessionHistory');
  const list = state.run.sessions;
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无历史场次。</div>';
    return;
  }
  const activeId = state.run.activeSession ? state.run.activeSession.id : null;
  box.innerHTML = list
    .map((s) => {
      const pct = s.total ? Math.round((s.progress / s.total) * 100) : 0;
      return `
      <div class="session-item ${s.id === activeId ? 'active' : ''}" data-session="${s.id}">
        <div class="session-item-top">
          <span class="session-item-name">
            ${s.kind === 'makeup' ? '<span class="badge badge-makeup">🔁 补排</span> ' : ''}${escapeHtml(s.name)}
          </span>
          ${s.is_complete ? '<span class="badge badge-ok">已完成</span>' : ''}
        </div>
        <div class="session-item-meta">
          v${s.script_version} · ${s.total} 条 · 已执行 ${s.done_count} · 漏执行 ${s.missed_count}（${pct}%）
          · <span title="有效排练时长（按服务端时间）">⏱ ${escapeHtml(formatDuration(s.rehearsal_seconds))}</span>
          ${s.excluded_pending ? ` · 排除待确认 ${s.excluded_pending} 条` : ''}
          ${s.pending_suggestions ? ` · 💬 待处理建议 ${s.pending_suggestions} 条` : ''}
          ${s.conflict_suggestions ? ` · <span style="color:var(--danger)">⚠ 冲突建议 ${s.conflict_suggestions} 条</span>` : ''}
        </div>
        <div class="session-item-time">创建于 ${escapeHtml(s.created_at)}</div>
      </div>`;
    })
    .join('');
}

$('sessionHistory').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (item) openRunSession(Number(item.dataset.session));
});

/* =============================== 场次对照 =============================== */

const CMP_STATUS = {
  done: { text: '已执行', cls: 'tag-done' },
  missed: { text: '漏执行', cls: 'tag-missed' },
  pending: { text: '待处理', cls: 'tag-pending' },
};
const CMP_FIELD_NAMES = {
  line_no: '行号',
  type: '类型',
  label: '内容',
  note: '备注',
  status: '状态',
};

function cmpStatusTag(status) {
  const st = CMP_STATUS[status] || CMP_STATUS.pending;
  return `<span class="run-tag ${st.cls}">${st.text}</span>`;
}

/** 下拉框选项：与历次场次列表同序（最新在前） */
function cmpSessionOptions() {
  return state.run.sessions
    .map(
      (s) =>
        `<option value="${s.id}">#${s.id} ${escapeHtml(s.name)}（v${s.script_version} · ${s.total} 条）</option>`
    )
    .join('');
}

/** 刷新对照下拉框；未选择时默认基准场 = 最新一场、对照场 = 次新一场 */
function renderCmpSelects() {
  const cmp = state.run.cmp;
  const sessions = state.run.sessions;
  const valid = (id) => sessions.some((s) => s.id === id);
  if (!valid(cmp.baseId) || !valid(cmp.compareId)) {
    cmp.baseId = sessions.length ? sessions[0].id : null;
    cmp.compareId = sessions.length > 1 ? sessions[1].id : null;
    cmp.result = null;
    cmp.expanded = new Set();
  }
  const options = cmpSessionOptions();
  $('cmpBase').innerHTML = options;
  $('cmpCompare').innerHTML = options;
  if (cmp.baseId != null) $('cmpBase').value = String(cmp.baseId);
  if (cmp.compareId != null) $('cmpCompare').value = String(cmp.compareId);
  const enough = sessions.length >= 2;
  $('cmpBase').disabled = !enough;
  $('cmpCompare').disabled = !enough;
  $('cmpRunBtn').disabled = !enough;
  if (!enough) {
    $('cmpResult').innerHTML =
      '<div class="empty">至少需要两场历史场次才能对照。先在上方创建并执行不同的排练场次吧。</div>';
  }
}

async function runCompare() {
  const cmp = state.run.cmp;
  if (state.run.sessions.length < 2) return;
  const baseId = Number($('cmpBase').value);
  const compareId = Number($('cmpCompare').value);
  if (!baseId || !compareId) return;
  if (baseId === compareId) {
    cmp.result = null;
    $('cmpResult').innerHTML =
      '<div class="empty">基准场与对照场不能是同一场次，请重新选择。</div>';
    return;
  }
  // 同一对场次的重复对照保留手动展开状态；换了场次才重置
  if (cmp.baseId !== baseId || cmp.compareId !== compareId) {
    cmp.expanded = new Set();
  }
  cmp.baseId = baseId;
  cmp.compareId = compareId;
  $('cmpResult').innerHTML = '<div class="empty">正在对照两场场次…</div>';
  try {
    cmp.result = await api(
      'GET',
      `/api/scripts/${state.script.id}/sessions/compare?base=${baseId}&compare=${compareId}`
    );
  } catch (err) {
    cmp.result = null;
    $('cmpResult').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    return;
  }
  renderCompare();
}

function cmpSessionCard(title, s, cls) {
  return `
    <div class="cmp-session ${cls}">
      <div class="cmp-session-role">${title}</div>
      <div class="cmp-session-name">#${s.id} ${escapeHtml(s.name)}</div>
      <div class="cmp-session-meta">
        v${s.script_version} 快照 · 共 ${s.total} 条 · 已执行 ${s.done_count} · 漏执行 ${s.missed_count} · 创建于 ${escapeHtml(s.created_at)}
      </div>
    </div>`;
}

/** 单侧（基准场或对照场）条目内容；变化字段高亮 */
function cmpSide(item, side, changes) {
  if (!item) return '<div class="cmp-side cmp-side-empty">（本场次无此提示）</div>';
  const ch = changes || {};
  const hl = (key) => (ch[key] ? ' cmp-changed' : '');
  return `
    <div class="cmp-side">
      <div class="cmp-side-top">
        <span class="run-item-idx">#${item.seq}</span>
        <span class="cmp-fld${hl('line_no')}">第 ${item.line_no} 行</span>
        <span class="badge ${item.type === 'light' ? 'badge-light' : 'badge-sound'}${hl('type')}">
          ${item.type === 'light' ? '💡 灯光' : '🔊 音效'}
        </span>
        <span class="cmp-fld cmp-label${hl('label')}">${escapeHtml(item.label)}</span>
        <span class="cmp-status${hl('status')}">${cmpStatusTag(item.status)}</span>
      </div>
      ${item.note ? `<div class="cmp-note${hl('note')}">📝 ${escapeHtml(item.note)}</div>` : ''}
      ${
        item.status === 'missed' && item.miss_reason
          ? `<div class="cmp-note cmp-miss">⚠ 漏执行原因：${escapeHtml(item.miss_reason)}</div>`
          : ''
      }
      ${item.line_text ? `<div class="cmp-line-text">📖 ${escapeHtml(item.line_text)}</div>` : ''}
    </div>`;
}

function cmpRowTags(row) {
  if (row.kind === 'only-base') return '<span class="run-tag tag-only-base">仅基准场</span>';
  if (row.kind === 'only-compare') return '<span class="run-tag tag-only-compare">仅对照场（新增）</span>';
  return row.changed
    ? '<span class="run-tag tag-changed">有变化</span>'
    : '<span class="run-tag tag-unchanged">未变化</span>';
}

function cmpRow(row, idx, collapseUnchanged) {
  const tags = cmpRowTags(row);
  if (row.kind === 'common') {
    const changedFields = Object.keys(row.changes)
      .filter((k) => row.changes[k])
      .map((k) => CMP_FIELD_NAMES[k]);
    if (!row.changed) {
      const expanded = !collapseUnchanged || state.run.cmp.expanded.has(idx);
      if (!expanded) {
        return `
        <div class="cmp-row is-unchanged is-collapsed">
          <div class="cmp-row-head">
            ${tags}
            <span class="run-item-idx">#${row.base.seq}</span>
            <span class="badge ${row.base.type === 'light' ? 'badge-light' : 'badge-sound'}">
              ${row.base.type === 'light' ? '💡' : '🔊'}
            </span>
            <span class="cmp-collapsed-label">第 ${row.base.line_no} 行 · ${escapeHtml(row.base.label)}</span>
            <button class="btn btn-sm cmp-toggle-row" data-cmp-idx="${idx}">展开</button>
          </div>
        </div>`;
      }
      return `
      <div class="cmp-row is-unchanged">
        <div class="cmp-row-head">
          ${tags}
          <span class="hint cmp-same-hint">两侧一致</span>
          <button class="btn btn-sm cmp-toggle-row" data-cmp-idx="${idx}">收起</button>
        </div>
        <div class="cmp-sides">
          ${cmpSide(row.base, 'base')}
          ${cmpSide(row.compare, 'compare')}
        </div>
      </div>`;
    }
    return `
    <div class="cmp-row is-changed">
      <div class="cmp-row-head">
        ${tags}
        ${changedFields.map((f) => `<span class="cmp-field-chip">${f}</span>`).join('')}
      </div>
      <div class="cmp-sides">
        ${cmpSide(row.base, 'base', row.changes)}
        ${cmpSide(row.compare, 'compare', row.changes)}
      </div>
    </div>`;
  }
  if (row.kind === 'only-base') {
    return `
    <div class="cmp-row is-only-base">
      <div class="cmp-row-head">${tags}<span class="hint cmp-same-hint">对照场中不存在该来源提示</span></div>
      <div class="cmp-sides">
        ${cmpSide(row.base, 'base')}
        ${cmpSide(null, 'compare')}
      </div>
    </div>`;
  }
  return `
  <div class="cmp-row is-only-compare">
    <div class="cmp-row-head">${tags}<span class="hint cmp-same-hint">基准场之后新增的提示</span></div>
    <div class="cmp-sides">
      ${cmpSide(null, 'base')}
      ${cmpSide(row.compare, 'compare')}
    </div>
  </div>`;
}

function renderCompare() {
  const cmp = state.run.cmp;
  const box = $('cmpResult');
  const r = cmp.result;
  if (!r) return;
  const collapseUnchanged = !$('cmpExpand').checked;
  const commonRows = [];
  const onlyCompareRows = [];
  r.rows.forEach((row, idx) => {
    (row.kind === 'only-compare' ? onlyCompareRows : commonRows).push(cmpRow(row, idx, collapseUnchanged));
  });
  box.innerHTML = `
    <div class="cmp-summary">
      ${cmpSessionCard('基准场', r.base, 'cmp-base')}
      <div class="cmp-vs">⇄</div>
      ${cmpSessionCard('对照场', r.compare, 'cmp-compare')}
    </div>
    <div class="cmp-stats">
      共同提示 <strong>${r.stats.common}</strong> 条（有变化 <strong class="cmp-stat-changed">${r.stats.changed}</strong> ·
      未变化 <strong>${r.stats.unchanged}</strong>） ·
      仅基准场 <strong>${r.stats.only_base}</strong> 条 ·
      仅对照场（新增） <strong>${r.stats.only_compare}</strong> 条
    </div>
    <div class="cmp-cols-head">
      <span>基准场：${escapeHtml(r.base.name)}</span>
      <span>对照场：${escapeHtml(r.compare.name)}</span>
    </div>
    <div class="cmp-rows">${commonRows.join('')}</div>
    ${
      onlyCompareRows.length
        ? `<div class="cmp-section-head">仅对照场（基准场之后新增，保持对照场顺序）</div>
           <div class="cmp-rows">${onlyCompareRows.join('')}</div>`
        : ''
    }`;
}

$('cmpRunBtn').addEventListener('click', runCompare);
$('cmpBase').addEventListener('change', (e) => {
  state.run.cmp.baseId = Number(e.target.value);
});
$('cmpCompare').addEventListener('change', (e) => {
  state.run.cmp.compareId = Number(e.target.value);
});
$('cmpExpand').addEventListener('change', () => {
  if (state.run.cmp.result) renderCompare();
});
$('cmpResult').addEventListener('click', (e) => {
  const btn = e.target.closest('.cmp-toggle-row');
  if (!btn) return;
  const idx = Number(btn.dataset.cmpIdx);
  const expanded = state.run.cmp.expanded;
  if (expanded.has(idx)) expanded.delete(idx);
  else expanded.add(idx);
  renderCompare();
});

/* =============================== 剧本版本回溯 =============================== */

async function loadVersionsTab() {
  try {
    const data = await api('GET', `/api/scripts/${state.script.id}/versions`);
    state.versions.list = data.versions || [];
    renderVersionList();
    renderVersionSelection();
    renderRestorePanel();
  } catch (err) {
    $('versionList').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

function renderVersionList() {
  const box = $('versionList');
  const list = state.versions.list;
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有任何版本快照。</div>';
    return;
  }
  box.innerHTML = list
    .map((v) => {
      const active = state.versions.selected && state.versions.selected.version === v.version;
      return `
      <div class="version-item ${v.is_current ? 'is-current' : ''} ${active ? 'active' : ''}"
           data-version="${v.version}">
        <div class="version-item-top">
          <span class="version-item-name">第 ${v.version} 版</span>
          ${v.is_current ? '<span class="badge badge-ok">当前版本</span>' : ''}
          ${active && !v.is_current ? '<span class="badge badge-version">查看中</span>' : ''}
        </div>
        <div class="version-item-meta">保存于 ${escapeHtml(v.created_at)} · ${v.line_count} 行</div>
      </div>`;
    })
    .join('');
}

$('versionList').addEventListener('click', (e) => {
  const item = e.target.closest('.version-item');
  if (item) selectVersion(Number(item.dataset.version));
});

/** 点开某版本：拉取该版正文并清空之前的恢复预览（防止把旧预览误用到其他版本上） */
async function selectVersion(version) {
  try {
    const detail = await api(
      'GET',
      `/api/scripts/${state.script.id}/versions/${version}`
    );
    state.versions.selected = detail;
    state.versions.preview = null;
    renderVersionList();
    renderVersionSelection();
    renderRestorePanel();
  } catch (err) {
    toast(err.message, true);
  }
}

/** 右侧正文区渲染（只读；复用通用剧本行渲染，不可点击） */
function renderVersionSelection() {
  const v = state.versions.selected;
  if (!v) {
    $('versionViewerTitle').textContent = '版本正文';
    $('versionViewerMeta').textContent = '';
    $('versionContent').innerHTML =
      '<div class="empty">点击左侧任一历史版本查看该版正文。</div>';
    return;
  }
  $('versionViewerTitle').textContent = `第 ${v.version} 版正文`;
  $('versionViewerMeta').textContent = `保存于 ${v.created_at}${
    v.is_current ? ' · 当前版本' : ''
  }`;
  renderViewer($('versionContent'), v.content, { clickable: false });
  // 历史正文只读：去掉行 hover 指针感（无 selectable 类即不可点，点击区也不会触发添加提示）
}

function renderRestorePanel() {
  const box = $('restoreBox');
  const v = state.versions.selected;
  if (!v || v.is_current) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const p = state.versions.preview;

  if (!p) {
    box.innerHTML = `
      <div class="restore-head">
        <strong>🕘 恢复到第 ${v.version} 版</strong>
      </div>
      <p class="hint" style="margin:6px 0">
        恢复不会覆盖或删除任何历史快照：该版正文会被<strong>另存为递增的新版本</strong>，
        当前提示则在同一事务内按既有重定位规则迁移；无法唯一定位的台词仍会保持待确认并给出候选行。
        提交时会校验预览时的当前版本号，若另一窗口已改版将返回冲突、要求重新预览。
      </p>
      <div class="restore-actions">
        <button class="btn btn-primary" id="restorePreviewBtn">预览提示迁移结果</button>
      </div>`;
    return;
  }

  // 预览只在「基于同一当前版本、且针对同一目标版本」时有效
  const stale =
    p.current_version !== state.script.current_version || p.target_version !== v.version;
  const pendingList = (p.pending_cues || [])
    .map(
      (c) => `
    <div class="pending-item">
      <div class="pending-item-top">
        <span class="badge ${c.type === 'light' ? 'badge-light' : 'badge-sound'}">
          ${c.type === 'light' ? '💡 灯光' : '🔊 音效'}
        </span>
        <strong>${escapeHtml(c.label)}</strong>
        <span class="badge badge-pending">待确认</span>
      </div>
      <div class="cue-line">原锚点台词：${escapeHtml(c.anchor_text || '（无）')}</div>
      <div class="pending-reason">${escapeHtml(c.issue_detail || '无法定位')}</div>
      ${
        c.candidates && c.candidates.length
          ? `<div class="hint" style="margin:6px 0 2px">候选行：第 ${c.candidates
              .map((x) => x.lineNo)
              .join('、')} 行</div>` +
            c.candidates
              .map(
                (x) => `
            <div class="candidate-row">
              <span class="badge badge-pending">第 ${x.lineNo} 行</span>
              <span class="candidate-line">${escapeHtml(x.lineText)}</span>
            </div>`
              )
              .join('')
          : ''
      }
    </div>`
    )
    .join('');

  box.innerHTML = `
    <div class="restore-head">
      <strong>🕘 恢复到第 ${v.version} 版 · 迁移预览</strong>
      <span class="hint">基于当前第 ${p.current_version} 版的提示演算</span>
    </div>
    <div class="restore-stats">
      <span>提示总数 <strong>${p.total}</strong></span>
      <span style="color:var(--ok)">将自动绑定 <strong>${p.bound}</strong></span>
      <span style="color:${p.pending ? 'var(--danger)' : 'var(--text-dim)'}">
        待确认 <strong>${p.pending}</strong>
      </span>
    </div>
    ${
      p.pending > 0
        ? `<p class="hint" style="margin:6px 0">以下提示迁移后仍无法唯一定位，将保持待确认，恢复后可在提示单中人工重绑：</p>
           <div class="restore-pending-list">${pendingList}</div>`
        : '<p class="hint" style="margin:6px 0">全部提示都能在该版正文中唯一定位。</p>'
    }
    ${
      stale
        ? `<p class="restore-stale">⚠ 预览已过期（当前版本或目标版本已变化），请重新预览后再恢复。</p>`
        : ''
    }
    <div class="restore-actions">
      <button class="btn btn-primary" id="restoreConfirmBtn" ${stale ? 'disabled' : ''}>
        确认恢复（另存为新版本）
      </button>
      <button class="btn" id="restoreRepreviewBtn">重新预览</button>
    </div>`;
}

$('restoreBox').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const vs = state.versions;
  if (!vs.selected || vs.busy) return;

  if (btn.id === 'restorePreviewBtn' || btn.id === 'restoreRepreviewBtn') {
    vs.busy = true;
    btn.disabled = true;
    try {
      vs.preview = await api(
        'GET',
        `/api/scripts/${state.script.id}/versions/${vs.selected.version}/restore-preview`
      );
      renderRestorePanel();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    } finally {
      vs.busy = false;
    }
    return;
  }

  if (btn.id === 'restoreConfirmBtn') {
    const p = vs.preview;
    if (!p) return;
    if (p.target_version !== vs.selected.version) return;
    if (p.current_version !== state.script.current_version) {
      toast('预览已过期，请重新预览', true);
      renderRestorePanel();
      return;
    }
    if (
      !confirm(
        `将把第 ${vs.selected.version} 版正文另存为递增的新版本，当前第 ${p.current_version} 版及全部历史快照都会保留。\n\n` +
          `提示迁移预览：自动绑定 ${p.bound} 条，待确认 ${p.pending} 条（共 ${p.total} 条）。\n\n确认恢复？`
      )
    ) {
      return;
    }
    vs.busy = true;
    btn.disabled = true;
    try {
      const r = await api(
        'POST',
        `/api/scripts/${state.script.id}/versions/${vs.selected.version}/restore`,
        { expectedCurrentVersion: p.current_version }
      );
      // 恢复成功：重新拉取剧本（正文/版本号/提示均已变），切回版本回溯并选中新版本
      await openScript(state.script.id);
      switchTab('versions');
      await loadVersionsTab();
      await selectVersion(r.version);
      if (r.stats.pending > 0) {
        toast(
          `已恢复为第 ${r.version} 版：${r.stats.bound} 条自动绑定，${r.stats.pending} 条待确认`,
          true
        );
      } else {
        toast(`已恢复为第 ${r.version} 版，${r.stats.bound} 条提示全部重新定位成功`);
      }
    } catch (err) {
      vs.busy = false;
      if (err.status === 409) {
        // 另一窗口已改版：同步服务端当前状态，旧预览作废，必须重新预览后才能再次确认
        toast(`冲突：${err.message}`, true);
        state.script = await api('GET', `/api/scripts/${state.script.id}`);
        await loadVersionsTab();
      } else {
        toast(err.message, true);
        renderRestorePanel();
      }
    }
  }
});

/* =============================== 编辑剧本 =============================== */

$('editBtn').addEventListener('click', () => {
  $('scriptEditor').value = state.script.content;
  setMode('edit');
});

$('cancelEditBtn').addEventListener('click', () => setMode('view'));

$('saveVersionBtn').addEventListener('click', async () => {
  const content = $('scriptEditor').value;
  if (content === state.script.content) {
    toast('内容没有变化');
    setMode('view');
    return;
  }
  try {
    const r = await api('PUT', `/api/scripts/${state.script.id}/content`, { content });
    setMode('view');
    await openScript(state.script.id);
    if (r.stats.pending > 0) {
      toast(`已保存为第 ${r.version} 版：${r.stats.bound} 条自动重定位，${r.stats.pending} 条待确认`, true);
    } else {
      toast(`已保存为第 ${r.version} 版，${r.stats.bound} 条提示全部重新定位成功`);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

$('renameBtn').addEventListener('click', async () => {
  const title = prompt('修改剧本标题：', state.script.title);
  if (title == null) return;
  if (!title.trim()) return toast('标题不能为空', true);
  await api('PATCH', `/api/scripts/${state.script.id}`, { title: title.trim() });
  toast('标题已更新');
  openScript(state.script.id);
});

$('backBtn').addEventListener('click', goHome);
$('homeBtn').addEventListener('click', goHome);

async function goHome() {
  stopAssetPlayback();
  $('topbarSub').textContent = '灯光 / 音效提示管理';
  showView('list');
  await loadScripts();
}

/* =============================== 启动 =============================== */

loadScripts().catch((err) => toast(err.message, true));
