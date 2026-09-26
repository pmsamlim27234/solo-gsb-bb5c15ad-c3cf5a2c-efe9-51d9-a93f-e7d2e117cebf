'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const {
  ASSET_DIR,
  MAX_ASSET_SIZE,
  AUDIO_TYPES,
  sniffAudioExt,
  sha256,
  saveAssetFile,
  removeAssetFile,
} = require('./assets');
const { relocalize, buildAnchor } = require('./reanchor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ----------------------------- 工具函数 ----------------------------- */

function validateType(type) {
  if (!['light', 'sound'].includes(type)) {
    const e = new Error('提示类型必须为 light（灯光）或 sound（音效）');
    e.status = 400;
    throw e;
  }
}

function getScriptOr404(scriptId) {
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
  if (!script) {
    const e = new Error('剧本不存在');
    e.status = 404;
    throw e;
  }
  return script;
}

/**
 * 待确认提示的候选行存于 issue_detail（格式 __CANDIDATES__{json}），
 * 解析出展示文案与候选行列表。
 * 行内的 asset_filename / asset_size 来自 listCues 对 sound_assets 的 LEFT JOIN，
 * 这里组装成 asset 对象（未关联素材时为 null）。
 */
function parseCue(c) {
  let candidates = [];
  let detail = c.issue_detail || '';
  if (detail.startsWith('__CANDIDATES__')) {
    try {
      const parsed = JSON.parse(detail.replace('__CANDIDATES__', ''));
      detail = parsed.detail;
      candidates = parsed.candidates;
    } catch {
      detail = '';
    }
  }
  const { asset_filename, asset_size, ...rest } = c;
  return {
    ...rest,
    // 关联的音效素材（仅音效提示可能有）；素材被引用时无法删除，故 JOIN 必然命中
    asset: c.asset_id ? { id: c.asset_id, filename: asset_filename, size: asset_size } : null,
    context_before: c.context_before ? JSON.parse(c.context_before) : [],
    context_after: c.context_after ? JSON.parse(c.context_after) : [],
    issue:
      c.anchor_status === 'pending'
        ? { type: c.issue_type, detail, candidates }
        : null,
  };
}

function listCues(scriptId) {
  return db
    .prepare(
      `SELECT c.*, a.filename AS asset_filename, a.size AS asset_size
       FROM cues c
       LEFT JOIN sound_assets a ON a.id = c.asset_id
       WHERE c.script_id = ?
       ORDER BY c.id`
    )
    .all(scriptId)
    .map(parseCue);
}

/**
 * 解析提示关联的素材 ID（创建/编辑提示共用）：
 * - 灯光提示一律不关联素材（返回 null）；
 * - 音效提示未提供 assetId 字段（undefined）时保持原值 keepValue；传 null 解除关联；
 * - 传了具体 ID 则必须存在于素材库，否则 400（可能已被删除）。
 */
function resolveCueAssetId(type, input, keepValue) {
  if (type !== 'sound') return null;
  if (input === undefined) return keepValue;
  if (input === null) return null;
  const id = Number(input);
  const asset =
    Number.isInteger(id) && id > 0
      ? db.prepare('SELECT id FROM sound_assets WHERE id = ?').get(id)
      : null;
  if (!asset) {
    const e = new Error('所选音效素材不存在，可能已被删除，请刷新素材库后重试');
    e.status = 400;
    throw e;
  }
  return id;
}

/* ----------------------------- 剧本接口 ----------------------------- */

// 剧本列表（不含正文）
app.get('/api/scripts', (req, res) => {
  const scripts = db
    .prepare(
      `SELECT s.id, s.title, s.current_version, s.created_at, s.updated_at,
              COUNT(c.id) AS cue_count,
              SUM(CASE WHEN c.anchor_status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM scripts s
       LEFT JOIN cues c ON c.script_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC`
    )
    .all();
  res.json(scripts);
});

// 剧本详情（含全部提示）
app.get('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  res.json({ ...script, cues: listCues(script.id) });
});

// 新建剧本
app.post('/api/scripts', (req, res) => {
  const title = (req.body.title || '').trim();
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });

  const result = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO scripts (title, content) VALUES (?, ?)')
      .run(title, content);
    db.prepare(
      'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, 1, ?, ?)'
    ).run(info.lastInsertRowid, title, content);
    return info.lastInsertRowid;
  })();

  res.status(201).json({ id: result });
});

// 修改标题
app.patch('/api/scripts/:id', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: '剧本标题不能为空' });
  db.prepare("UPDATE scripts SET title = ?, updated_at = datetime('now') WHERE id = ?").run(
    title,
    script.id
  );
  res.json({ ok: true });
});

/**
 * 事务内公共操作：把 content 保存为 scriptId 的递增新版本（正文快照写入 script_versions），
 * 并按现有重定位规则（reanchor）在同一事务内更新全部提示——
 * 自动绑定 / 待确认（缺失或重复台词无法唯一定位，保留候选行）。
 * 手工「保存新版」与「恢复历史版本」共用同一实现，保证行为一致、快照均不可变。
 * 须在事务内调用（或被 db.transaction 包裹）；返回新版本号与重定位统计。
 */
function persistVersionAndRelocalize(scriptId, content) {
  const cur = db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
  const newVersion = cur.current_version + 1;
  db.prepare(
    `UPDATE scripts SET content = ?, current_version = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(content, newVersion, scriptId);
  db.prepare(
    'INSERT INTO script_versions (script_id, version, title, content) VALUES (?, ?, ?, ?)'
  ).run(scriptId, newVersion, cur.title, content);

  const cues = db.prepare('SELECT * FROM cues WHERE script_id = ?').all(scriptId);
  const { results, stats } = relocalize(cues, content);

  const boundStmt = db.prepare(
    `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_status = 'bound',
                     issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
     WHERE id = ?`
  );
  const pendingStmt = db.prepare(
    `UPDATE cues SET version = ?, line_no = NULL, line_text = NULL, anchor_status = 'pending',
                     issue_type = ?, issue_detail = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  for (const r of results) {
    if (r.status === 'bound') {
      boundStmt.run(newVersion, r.lineNo, r.lineText, r.cueId);
    } else {
      const payload =
        '__CANDIDATES__' +
        JSON.stringify({ detail: r.issueDetail, candidates: r.candidates || [] });
      pendingStmt.run(newVersion, r.issueType, payload, r.cueId);
    }
  }
  return { version: newVersion, stats };
}

// 保存新版正文 -> 全部提示重新定位
app.put('/api/scripts/:id/content', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const content = typeof req.body.content === 'string' ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: '缺少 content 字段' });

  const outcome = db.transaction(() => persistVersionAndRelocalize(script.id, content))();

  res.json({ ok: true, ...outcome });
});

/* ----------------------------- 剧本版本回溯 ----------------------------- */

/** 取某剧本的指定历史版本快照，不存在（或不属于该剧本）抛 404 */
function getVersionOr404(scriptId, version) {
  const row = db
    .prepare(
      'SELECT id, script_id, version, title, content, created_at FROM script_versions WHERE script_id = ? AND version = ?'
    )
    .get(scriptId, version);
  if (!row) {
    const e = new Error('该剧本不存在此版本');
    e.status = 404;
    throw e;
  }
  return row;
}

// 版本列表：版本号、保存时间（不含正文），标注当前版本
app.get('/api/scripts/:id/versions', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const versions = db
    .prepare(
      `SELECT id, version, title, created_at,
              length(content) - length(replace(content, char(10), '')) + 1 AS line_count
       FROM script_versions WHERE script_id = ? ORDER BY version DESC`
    )
    .all(script.id)
    .map((v) => ({ ...v, is_current: v.version === script.current_version }));
  res.json({ script_id: script.id, current_version: script.current_version, versions });
});

// 单个版本正文（点开查看该版正文）
app.get('/api/scripts/:id/versions/:version', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) {
    return res.status(400).json({ error: '版本号非法' });
  }
  const row = getVersionOr404(script.id, version);
  res.json({ ...row, is_current: version === script.current_version });
});

/**
 * 版本回溯预览（只读，不改任何数据）：
 * 对「把当前全部提示迁移到目标版本正文」执行与保存新版完全相同的重定位演算，
 * 返回迁移后的已绑定/待确认数量，以及待确认提示的原因与候选行，供确认前人工评估。
 * 预览响应携带 current_version：恢复提交时必须原样带回，用于乐观锁校验。
 */
app.get('/api/scripts/:id/versions/:version/restore-preview', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) {
    return res.status(400).json({ error: '版本号非法' });
  }
  const target = getVersionOr404(script.id, version);
  if (version === script.current_version) {
    return res
      .status(400)
      .json({ error: `第 ${version} 版就是当前版本，无需恢复` });
  }

  const cues = db.prepare('SELECT * FROM cues WHERE script_id = ?').all(script.id);
  const { results, stats } = relocalize(cues, target.content);
  const cueById = new Map(cues.map((c) => [c.id, c]));
  const pending = [];
  for (const r of results) {
    if (r.status !== 'pending') continue;
    const c = cueById.get(r.cueId);
    pending.push({
      cue_id: r.cueId,
      type: c ? c.type : null,
      label: c ? c.label : '',
      note: c ? c.note : '',
      anchor_text: c ? c.anchor_text : null,
      issue_type: r.issueType,
      issue_detail: r.issueDetail,
      candidates: r.candidates || [],
    });
  }

  res.json({
    script_id: script.id,
    current_version: script.current_version,
    target_version: version,
    total: stats.total,
    bound: stats.bound,
    pending: stats.pending,
    pending_cues: pending,
  });
});

/**
 * 恢复历史版本：
 *  1. 请求必须携带预览时的当前版本号 expectedCurrentVersion；事务内重新读取当前版本，
 *     若另一窗口已改版（版本号不一致），返回 409 要求重新预览，绝不覆盖新内容；
 *  2. 目标历史快照原样保留、不被改动：其正文会另存为一个递增的新版本；
 *  3. 同一事务内按现有重定位规则把当前提示迁移到该正文——重复台词无法唯一定位时
 *     保持待确认并附候选行，绝不会静默挂到另一句相同台词上。
 */
app.post('/api/scripts/:id/versions/:version/restore', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) {
    return res.status(400).json({ error: '版本号非法' });
  }
  const expectedCurrent = Number(req.body.expectedCurrentVersion);
  if (!Number.isInteger(expectedCurrent) || expectedCurrent <= 0) {
    return res.status(400).json({ error: '缺少预览时的当前版本号 expectedCurrentVersion' });
  }

  const outcome = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM scripts WHERE id = ?').get(script.id);
    if (cur.current_version !== expectedCurrent) {
      throw conflict(
        `剧本已在其他窗口改版（预览时为第 ${expectedCurrent} 版，当前为第 ${cur.current_version} 版），请重新预览后再恢复`
      );
    }
    const target = getVersionOr404(script.id, version);
    // 历史快照不可变：恢复 = 以该版正文另存为递增的新版本，再迁移提示
    return persistVersionAndRelocalize(script.id, target.content);
  })();

  res.json({ ok: true, restored_from: version, ...outcome });
});

// 删除剧本
app.delete('/api/scripts/:id', (req, res) => {
  getScriptOr404(req.params.id);
  db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------- 提示接口 ----------------------------- */

// 在某行旁添加提示（同时生成锚点与上下文快照）；音效提示可同时关联素材库中的音频
app.post('/api/scripts/:id/cues', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const { type, label, note, lineNo } = req.body;
  validateType(type);
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: '提示内容不能为空' });
  }
  const lineIndex = Number(lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择提示所附着的台词行' });
  }
  // 仅音效提示可关联素材；灯光提示忽略该字段
  const assetId = resolveCueAssetId(type, req.body.assetId, null);

  const anchor = buildAnchor(script.content, lineIndex);
  const info = db
    .prepare(
      `INSERT INTO cues (script_id, type, label, note, asset_id, version, line_no, line_text,
                         anchor_index, anchor_text, context_before, context_after, anchor_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bound')`
    )
    .run(
      script.id,
      type,
      String(label).trim(),
      (note || '').trim(),
      assetId,
      script.current_version,
      lineIndex + 1,
      anchor.anchorText,
      lineIndex,
      anchor.anchorText,
      JSON.stringify(anchor.contextBefore),
      JSON.stringify(anchor.contextAfter)
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

// 编辑提示文案（不改动锚点）；音效提示可同时选择/替换/解除关联素材
app.patch('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });

  const type = req.body.type !== undefined ? req.body.type : cue.type;
  validateType(type);
  const label = req.body.label !== undefined ? String(req.body.label).trim() : cue.label;
  if (!label) return res.status(400).json({ error: '提示内容不能为空' });
  const note = req.body.note !== undefined ? String(req.body.note).trim() : cue.note;
  // 未提供 assetId 字段时保持原关联；传 null 解除关联；类型改为灯光时自动解除
  const assetId = resolveCueAssetId(type, req.body.assetId, cue.asset_id);

  db.prepare(
    `UPDATE cues SET type = ?, label = ?, note = ?, asset_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(type, label, note, assetId, cue.id);
  res.json({ ok: true });
});

// 人工重新绑定：把提示挂到当前版本指定行，并重做锚点快照
app.post('/api/cues/:cueId/rebind', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  const script = getScriptOr404(cue.script_id);

  const lineIndex = Number(req.body.lineNo) - 1;
  if (!Number.isInteger(lineIndex)) {
    return res.status(400).json({ error: '请选择要绑定的台词行' });
  }
  const anchor = buildAnchor(script.content, lineIndex);

  db.prepare(
    `UPDATE cues SET version = ?, line_no = ?, line_text = ?, anchor_index = ?, anchor_text = ?,
                     context_before = ?, context_after = ?, anchor_status = 'bound',
                     issue_type = NULL, issue_detail = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    script.current_version,
    lineIndex + 1,
    anchor.anchorText,
    lineIndex,
    anchor.anchorText,
    JSON.stringify(anchor.contextBefore),
    JSON.stringify(anchor.contextAfter),
    cue.id
  );
  res.json({ ok: true });
});

// 删除提示
app.delete('/api/cues/:cueId', (req, res) => {
  const cue = db.prepare('SELECT * FROM cues WHERE id = ?').get(req.params.cueId);
  if (!cue) return res.status(404).json({ error: '提示不存在' });
  db.prepare('DELETE FROM cues WHERE id = ?').run(cue.id);
  res.json({ ok: true });
});

/* ----------------------------- 音效素材库 ----------------------------- */

/**
 * 素材的引用计数：同时统计
 *  - cue_n：当前音效提示引用（cues.asset_id）；
 *  - frozen_n：场次冻结条目引用（session_items.asset_id，含补排场——补排场沿用来源快照）。
 * 任一方仍引用，素材即不允许删除。冻结条目随剧本删除（ON DELETE CASCADE）而清除。
 */
function assetRefCounts(assetId) {
  const cueN = db
    .prepare('SELECT COUNT(*) AS n FROM cues WHERE asset_id = ?')
    .get(assetId).n;
  const frozenN = db
    .prepare('SELECT COUNT(*) AS n FROM session_items WHERE asset_id = ?')
    .get(assetId).n;
  return { cue_n: cueN, frozen_n: frozenN, total: cueN + frozenN };
}

/**
 * 引用明细（删除冲突时返回，附可定位信息，上限 20 条）：
 *  - 当前提示：提示内容 + 所属剧本标题 + 行号；
 *  - 场次冻结条目：场次名 + 剧本标题 + 队列序号 + 行号（标注为「冻结快照」，
 *    提示当前是否仍关联该素材都不影响——解除当前提示不会释放冻结引用）。
 */
function assetReferences(assetId) {
  const cueRefs = db
    .prepare(
      `SELECT 'cue' AS ref_type, c.id AS ref_id, c.label, c.line_no,
              s.id AS script_id, s.title AS script_title, NULL AS session_id,
              NULL AS session_name, NULL AS item_seq
       FROM cues c JOIN scripts s ON s.id = c.script_id
       WHERE c.asset_id = ?
       ORDER BY c.id LIMIT 20`
    )
    .all(assetId);
  const frozenRefs = db
    .prepare(
      `SELECT 'session_item' AS ref_type, i.id AS ref_id, i.label, i.line_no,
              s.id AS script_id, s.title AS script_title, se.id AS session_id,
              se.name AS session_name, i.seq AS item_seq
       FROM session_items i
       JOIN sessions se ON se.id = i.session_id
       JOIN scripts s ON s.id = se.script_id
       WHERE i.asset_id = ?
       ORDER BY se.id, i.seq LIMIT 20`
    )
    .all(assetId);
  return [...cueRefs, ...frozenRefs].slice(0, 20);
}

/** 素材记录序列化：附带当前提示引用数、场次冻结引用数与合计引用数（不暴露磁盘文件名） */
function serializeAsset(a) {
  const refs = assetRefCounts(a.id);
  return {
    id: a.id,
    filename: a.filename,
    ext: a.ext,
    size: a.size,
    sha256: a.sha256,
    ref_count: refs.total,
    cue_ref_count: refs.cue_n,
    frozen_ref_count: refs.frozen_n,
    created_at: a.created_at,
  };
}

function getAssetOr404(assetId) {
  const asset = db
    .prepare('SELECT * FROM sound_assets WHERE id = ?')
    .get(Number(assetId));
  if (!asset) {
    const e = new Error('素材不存在');
    e.status = 404;
    throw e;
  }
  return asset;
}

// 素材列表（含引用计数，最新的在前）
app.get('/api/assets', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM sound_assets ORDER BY created_at DESC, id DESC')
    .all();
  res.json(rows.map(serializeAsset));
});

/**
 * 上传素材：请求体为音频原始字节，文件名经 query 参数 filename 传入。
 * - 仅接受 MP3 / WAV / OGG，且文件头魔数必须与扩展名一致；单个文件不超过 10 MB；
 * - 按内容 SHA-256 去重：同一内容重复上传直接复用原素材记录与文件（deduped=true），
 *   不产生新记录、不重复落盘；
 * - 先写临时文件再原子重命名，最后登记数据库；任一步失败都会清理现场，
 *   不留下可见记录或残缺文件（服务重启时另有一次孤儿文件兜底清理）。
 */
app.post(
  '/api/assets',
  express.raw({ type: () => true, limit: MAX_ASSET_SIZE }),
  (req, res) => {
    const filename = String(req.query.filename || '').trim();
    if (!filename) {
      return res.status(400).json({ error: '缺少文件名（query 参数 filename）' });
    }
    const ext = path.extname(filename).toLowerCase();
    if (!AUDIO_TYPES[ext]) {
      return res.status(400).json({ error: '仅支持 MP3 / WAV / OGG 格式的音频文件' });
    }
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: '上传内容为空' });
    }
    if (buf.length > MAX_ASSET_SIZE) {
      return res.status(413).json({ error: '文件超过 10 MB 大小限制' });
    }
    // 魔数校验：扩展名必须与真实音频格式一致，拒绝伪装文件
    if (sniffAudioExt(buf) !== ext) {
      return res
        .status(400)
        .json({ error: '文件内容与扩展名不符，仅支持真实的 MP3 / WAV / OGG 音频' });
    }

    const hash = sha256(buf);
    const existing = db
      .prepare('SELECT * FROM sound_assets WHERE sha256 = ?')
      .get(hash);
    if (existing) {
      // 同一内容重复上传：复用原素材记录与文件
      return res.json({ asset: serializeAsset(existing), deduped: true });
    }

    // 先落盘（临时文件 + 原子重命名），再登记记录
    saveAssetFile(buf, hash, ext);
    const storedName = `${hash}${ext}`;
    try {
      const info = db
        .prepare(
          'INSERT INTO sound_assets (sha256, filename, ext, size, stored_name) VALUES (?, ?, ?, ?, ?)'
        )
        .run(hash, filename, ext, buf.length, storedName);
      const asset = db
        .prepare('SELECT * FROM sound_assets WHERE id = ?')
        .get(info.lastInsertRowid);
      res.status(201).json({ asset: serializeAsset(asset), deduped: false });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        // 并发上传同一内容：另一请求已登记，复用其记录（文件内容相同，无需清理）
        const dup = db
          .prepare('SELECT * FROM sound_assets WHERE sha256 = ?')
          .get(hash);
        if (dup) return res.json({ asset: serializeAsset(dup), deduped: true });
      }
      // 登记失败：删除刚落盘的文件，不留下残缺文件
      removeAssetFile(storedName);
      throw err;
    }
  }
);

// 素材音频文件（供页面试听；支持 Range 拖动）
app.get('/api/assets/:id/file', (req, res) => {
  const asset = getAssetOr404(req.params.id);
  const file = path.join(ASSET_DIR, asset.stored_name);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: '素材文件缺失（记录存在但文件不在磁盘中）' });
  }
  res.setHeader('Content-Type', AUDIO_TYPES[asset.ext] || 'application/octet-stream');
  res.sendFile(file);
});

/**
 * 删除素材：引用检查同时覆盖当前提示（cues）与场次冻结条目（session_items，含补排场）——
 * 任一方仍引用即返回 409 冲突（附两类引用数量与可定位明细：剧本/场次/序号/行号）。
 * 提示后来解除素材只会减少当前提示引用；冻结条目只能随剧本（级联）删除而清除。
 * 无任何引用时同一事务删除记录并清理文件。
 */
app.delete('/api/assets/:id', (req, res) => {
  const asset = getAssetOr404(req.params.id);

  const refs = assetRefCounts(asset.id);
  if (refs.total > 0) {
    return res.status(409).json({
      error:
        `该素材仍被引用（${refs.cue_n} 条当前音效提示、${refs.frozen_n} 条场次冻结条目），` +
        '请先解除当前提示关联并删除引用它的场次所属剧本后再删除',
      conflict: true,
      ref_count: refs.total,
      cue_ref_count: refs.cue_n,
      frozen_ref_count: refs.frozen_n,
      references: assetReferences(asset.id),
    });
  }

  db.prepare('DELETE FROM sound_assets WHERE id = ?').run(asset.id);
  try {
    removeAssetFile(asset.stored_name);
  } catch (err) {
    // 记录已删除；文件清理失败仅留不可见的孤儿文件（下次启动时兜底清理），不影响删除结果
    console.error(`素材文件清理失败（${asset.stored_name}）：`, err.message);
  }
  res.json({ ok: true });
});

/* ----------------------------- 排练场次接口 ----------------------------- */

/** 服务端当前时间（UTC epoch 秒，整数）：计时一律以服务端时间为准，跨刷新/跨浏览器一致 */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 某场次「当前有效排练秒数」（须在事务/读取后即时调用）：
 * idle（从未开始）为 null（页面显示「未计时」）；paused 取已落账秒数；
 * running 取已落账秒数 + 当前计时段经过的整数秒。
 */
function rehearsalSecondsAt(session, now) {
  if (session.timer_state === 'idle') return null;
  if (session.timer_state === 'paused') return session.timer_elapsed;
  return session.timer_elapsed + Math.max(0, now - (session.timer_started_at || now));
}

/** 409：请求基于过期的场次进度（重复提交/越序处理/撤回错对象） */
function conflict(message) {
  const e = new Error(message);
  e.status = 409;
  return e;
}

function getSessionOr404(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    const e = new Error('场次不存在');
    e.status = 404;
    throw e;
  }
  return session;
}

/**
 * 取当前版本已绑定、可执行的提示，按行号、提示 ID 排序。
 * 同时 LEFT JOIN sound_assets 取创建场次时要冻结的素材文件名
 * （素材被引用时无法删除，JOIN 命中即有效；未关联时 asset_* 为 NULL）。
 */
function executableCues(scriptId) {
  return db
    .prepare(
      `SELECT c.*, a.filename AS cue_asset_filename
       FROM cues c
       LEFT JOIN sound_assets a ON a.id = c.asset_id
       WHERE c.script_id = ? AND c.anchor_status = 'bound' AND c.line_no IS NOT NULL
       ORDER BY c.line_no ASC, c.id ASC`
    )
    .all(scriptId);
}

function countPendingCues(scriptId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM cues WHERE script_id = ? AND anchor_status = 'pending'")
    .get(scriptId).n;
}

/** 组装场次完整状态（含冻结条目快照、进度、处理记录与修订建议） */
function serializeSession(session) {
  const now = nowSec();
  const items = db
    .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY seq ASC')
    .all(session.id);
  const execs = db
    .prepare(
      `SELECT e.id, e.item_id, e.seq, e.kind, e.miss_reason, e.rehearsal_seconds, e.executed_at,
              i.line_no, i.type, i.label, i.line_text, i.asset_id, i.asset_filename
       FROM session_executions e
       JOIN session_items i ON i.id = e.item_id
       WHERE e.session_id = ?
       ORDER BY e.seq ASC`
    )
    .all(session.id);
  const suggestions = db
    .prepare(
      `SELECT g.*, i.seq AS item_seq, i.line_no AS item_line_no,
              i.label AS item_label, i.note AS item_note
       FROM session_item_suggestions g
       JOIN session_items i ON i.id = g.item_id
       WHERE g.session_id = ?
       ORDER BY g.id ASC`
    )
    .all(session.id);
  // 补排场：逐条冻结的来源信息（来源场次、原条目、漏执行原因）
  const makeupRows =
    session.kind === 'makeup'
      ? db
          .prepare('SELECT * FROM session_makeup_sources WHERE session_id = ?')
          .all(session.id)
      : [];
  const makeupByItem = new Map(makeupRows.map((m) => [m.item_id, m]));
  const execByItem = new Map(execs.map((x) => [x.item_id, x]));
  const sugByItem = new Map();
  for (const g of suggestions) {
    if (!sugByItem.has(g.item_id)) sugByItem.set(g.item_id, []);
    sugByItem.get(g.item_id).push(g);
  }
  const doneCount = execs.filter((x) => x.kind === 'done').length;

  // 补排场的来源场次（仅用于展示来源名称；来源场次删除后返回 null，冻结数据不受影响）
  let sourceSession = null;
  if (session.kind === 'makeup' && session.source_session_id != null) {
    sourceSession = db
      .prepare('SELECT id, name, script_version, created_at FROM sessions WHERE id = ?')
      .get(session.source_session_id) || null;
  }

  return {
    ...session,
    progress: execs.length, // 已处理条数 = 已执行 + 漏执行（共用同一进度）
    done_count: doneCount,
    missed_count: execs.length - doneCount,
    is_complete: execs.length >= session.total,
    // 有效排练计时：timer_state/elapsed/started_at/version 为持久化状态；
    // rehearsal_seconds 为服务端按当前时间算出的有效秒数（null=从未计时，显示「未计时」），
    // server_now 供跨浏览器的页面本地跳动对表（与 timer_started_at 同属服务端时钟）
    rehearsal_seconds: rehearsalSecondsAt(session, now),
    server_now: now,
    source_session: sourceSession,
    items: items.map((it) => {
      const rec = execByItem.get(it.id);
      const m = makeupByItem.get(it.id);
      const { asset_id, asset_filename, ...itemRest } = it;
      return {
        ...itemRest,
        // 创建时刻冻结的素材快照：提示后来改绑/解除/删除素材均不影响本场试听；
        // 无快照（创建时未关联，或旧场次自动补列后仍为 NULL）时 asset 为 null，页面显示「未关联素材」
        asset: asset_id ? { id: asset_id, filename: asset_filename } : null,
        status: rec ? rec.kind : 'pending', // 'done' | 'missed' | 'pending'
        miss_reason: rec ? rec.miss_reason : null,
        processed_at: rec ? rec.executed_at : null,
        rehearsal_seconds: rec ? rec.rehearsal_seconds : null,
        suggestions: sugByItem.get(it.id) || [],
        // 补排条目带来源追溯：原条目、原处理顺序、原漏执行原因（创建时冻结，不随后续撤回变化）
        makeup_source: m
          ? {
              source_session_id: m.source_session_id,
              source_item_id: m.source_item_id,
              source_execution_id: m.source_execution_id,
              source_seq: m.source_seq,
              miss_reason: m.miss_reason,
            }
          : null,
      };
    }),
    executions: execs.map(({ asset_id, asset_filename, ...e }) => ({
      ...e,
      asset: asset_id ? { id: asset_id, filename: asset_filename } : null,
    })),
    suggestions,
    makeup_sources: makeupRows,
  };
}

// 创建前预览：当前版本、可冻结提示数、被排除的待确认提示数
app.get('/api/scripts/:id/sessions/preview', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const cues = executableCues(script.id);
  res.json({
    script_id: script.id,
    title: script.title,
    version: script.current_version,
    total: cues.length,
    excluded_pending: countPendingCues(script.id),
    cues: cues.map((c) => ({
      id: c.id,
      line_no: c.line_no,
      type: c.type,
      label: c.label,
      note: c.note,
      line_text: c.line_text,
    })),
  });
});

// 从剧本当前版本创建场次（冻结行号/类型/内容/备注；无可执行提示不创建空场次）
app.post('/api/scripts/:id/sessions', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const name =
    req.body.name && String(req.body.name).trim()
      ? String(req.body.name).trim()
      : `${script.title} · 第${script.current_version}版排练`;

  const sessionId = db.transaction(() => {
    const cues = executableCues(script.id);
    if (cues.length === 0) {
      // 空场次没有任何意义：待确认提示无法执行，直接拒绝
      throw conflict('当前版本没有可执行的已绑定提示，无法创建场次');
    }
    const pending = countPendingCues(script.id);

    const info = db
      .prepare(
        `INSERT INTO sessions (script_id, name, script_version, total, excluded_pending)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(script.id, name, script.current_version, cues.length, pending);
    const sid = info.lastInsertRowid;

    const itemStmt = db.prepare(
      `INSERT INTO session_items (session_id, seq, cue_id, line_no, type, label, note, line_text,
                                  asset_id, asset_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    cues.forEach((c, i) => {
      // 素材快照取自创建时刻提示的关联（asset_id）与素材当前文件名；
      // 素材被引用时无法删除，故关联存在时 JOIN 必然命中；灯光/未关联音效两列均写 NULL
      itemStmt.run(
        sid,
        i + 1,
        c.id,
        c.line_no,
        c.type,
        c.label,
        c.note,
        c.line_text || '',
        c.asset_id ?? null,
        c.asset_id ? c.cue_asset_filename : null
      );
    });
    return sid;
  })();

  res.status(201).json({ id: sessionId });
});

// 场次列表（进度摘要：已执行/漏执行分开计数 + 修订建议状态计数）
app.get('/api/scripts/:id/sessions', (req, res) => {
  getScriptOr404(req.params.id);
  const now = nowSec();
  const sessions = db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM session_executions e WHERE e.session_id = s.id) AS progress,
              (SELECT COUNT(*) FROM session_executions e
                WHERE e.session_id = s.id AND e.kind = 'done') AS done_count,
              (SELECT COUNT(*) FROM session_executions e
                WHERE e.session_id = s.id AND e.kind = 'missed') AS missed_count,
              (SELECT COUNT(*) FROM session_item_suggestions g
                WHERE g.session_id = s.id AND g.status = 'pending') AS pending_suggestions,
              (SELECT COUNT(*) FROM session_item_suggestions g
                WHERE g.session_id = s.id AND g.status = 'conflict') AS conflict_suggestions
       FROM sessions s
       WHERE s.script_id = ?
       ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(req.params.id)
    .map((s) => ({
      ...s,
      is_complete: s.progress >= s.total,
      rehearsal_seconds: rehearsalSecondsAt(s, now),
    }));
  res.json(sessions);
});

// 场次详情（快照与执行记录）
app.get('/api/sessions/:sessionId', (req, res) => {
  res.json(serializeSession(getSessionOr404(req.params.sessionId)));
});

/* ----------------------------- 有效排练计时 ----------------------------- */

/**
 * 开始 / 暂停 / 继续有效排练计时（单一接口按 action 切换）：
 *   - 全部状态在服务端持久化：timer_state（idle/running/paused）、timer_elapsed（已落账秒数）、
 *     timer_started_at（当前计时段开始的服务端 epoch 秒）、timer_version（状态版本）；
 *   - 有效时长一律按服务端时钟结算，跨刷新、跨浏览器、服务重启后都一致；
 *   - 请求必须带 expectedVersion：重复提交、基于旧版本（另一浏览器已切换）一律 409，
 *     每段经过时间只在 running→paused（或完成自动停表）时结算一次，不能重复累计；
 *   - 已完成的场次不能再切换计时。
 */
app.post('/api/sessions/:sessionId/timer', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const action = String(req.body.action || '');
  const expectedVersion = Number(req.body.expectedVersion);
  if (!['start', 'pause', 'resume'].includes(action)) {
    return res.status(400).json({ error: "action 必须为 start / pause / resume 之一" });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return res.status(400).json({ error: '缺少预期计时状态版本 expectedVersion' });
  }

  const timer = db.transaction(() => {
    // 事务内重新读取，避免并发下基于过期状态切换
    const cur = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
    if (cur.timer_version !== expectedVersion) {
      throw conflict('计时状态已变化（可能在其他页面切换过），请刷新后重试');
    }
    const done = db
      .prepare('SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ?')
      .get(cur.id).n;
    if (done >= cur.total) {
      throw conflict('本场次已全部处理完毕，不能再切换计时');
    }

    const now = nowSec();
    let state = cur.timer_state;
    let elapsed = cur.timer_elapsed;
    let startedAt = cur.timer_started_at;

    if (action === 'start') {
      if (state !== 'idle') throw conflict('计时已经开始，请勿重复开始');
      state = 'running';
      startedAt = now;
    } else if (action === 'pause') {
      if (state !== 'running') throw conflict('计时当前不在进行中，不能暂停');
      // 本段有效秒数在此唯一结算点落账：重复/过期请求已被版本校验挡住，不会重复累计
      elapsed += Math.max(0, now - (startedAt || now));
      state = 'paused';
      startedAt = null;
    } else {
      if (state !== 'paused') throw conflict('计时当前未暂停，不能继续');
      state = 'running';
      startedAt = now;
    }

    db.prepare(
      `UPDATE sessions
       SET timer_state = ?, timer_elapsed = ?, timer_started_at = ?, timer_version = timer_version + 1
       WHERE id = ?`
    ).run(state, elapsed, startedAt, cur.id);

    return {
      timer_state: state,
      timer_elapsed: elapsed,
      timer_started_at: startedAt,
      timer_version: cur.timer_version + 1,
      rehearsal_seconds:
        state === 'running' ? elapsed + Math.max(0, now - startedAt) : elapsed,
      server_now: now,
    };
  })();

  res.json({ ok: true, ...timer });
});

/* ----------------------------- 漏项补排 ----------------------------- */

/**
 * 取某场次「当前尚未补排」的漏执行记录（须在事务内复核状态时与创建接口共用同一查询）。
 * 条件：① 处理记录为漏执行（kind='missed'）；② 未被任何补排场引用
 * （session_makeup_sources UNIQUE(source_execution_id) 同时兜底）。
 * 按来源队列顺序（原处理 seq 升序）返回，行号/类型/文案/备注均取自来源冻结条目。
 */
function makeupCandidates(sessionId) {
  return db
    .prepare(
      `SELECT e.id AS execution_id, e.seq AS execution_seq, e.miss_reason,
              i.id AS item_id, i.seq AS item_seq, i.cue_id,
              i.line_no, i.type, i.label, i.note, i.line_text,
              i.asset_id, i.asset_filename
       FROM session_executions e
       JOIN session_items i ON i.id = e.item_id
       WHERE e.session_id = ? AND e.kind = 'missed'
         AND NOT EXISTS (
           SELECT 1 FROM session_makeup_sources m WHERE m.source_execution_id = e.id
         )
       ORDER BY e.seq ASC`
    )
    .all(sessionId);
}

function countMissed(sessionId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ? AND kind = 'missed'"
    )
    .get(sessionId).n;
}

// 补排前预览：来源场次的漏执行总数、已补排数、当前可补排条目（冻结字段 + 原漏执行原因）
app.get('/api/sessions/:sessionId/makeup-preview', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const candidates = makeupCandidates(session.id);
  res.json({
    session_id: session.id,
    name: session.name,
    script_id: session.script_id,
    script_version: session.script_version,
    kind: session.kind,
    missed_total: countMissed(session.id),
    made_up: countMissed(session.id) - candidates.length,
    available: candidates.length,
    items: candidates,
  });
});

/**
 * 一键生成漏项补排场：
 *   - 按原队列顺序冻结每条漏执行条目的行号、类型、文案、备注及漏执行原因，
 *     并通过 session_makeup_sources 记下来源场次 / 原条目 / 原处理记录；
 *   - 创建时在同一事务内重新查询来源记录仍为漏执行、且尚未进入任何补排场；
 *   - 请求可带 sourceExecutionIds 指定子集；提交的记录若已被撤回 / 已补排 / 不属于该场，
 *     一律 409（不静默忽略，避免基于过期页面生成错误的场次）；
 *   - UNIQUE(source_execution_id) 保证同一条漏执行记录只能进入一个补排场；
 *   - 没有可冻结条目时 409，绝不生成空场次。
 * 原场次与其提示、冻结条目、执行记录均不改动。
 */
app.post('/api/sessions/:sessionId/makeup', (req, res) => {
  const source = getSessionOr404(req.params.sessionId);
  let requested = null;
  if (req.body.sourceExecutionIds !== undefined) {
    if (!Array.isArray(req.body.sourceExecutionIds)) {
      return res.status(400).json({ error: 'sourceExecutionIds 必须为数组' });
    }
    requested = [];
    for (const x of req.body.sourceExecutionIds) {
      const n = Number(x);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: 'sourceExecutionIds 中的记录 ID 非法' });
      }
      if (!requested.includes(n)) requested.push(n);
    }
  }
  const defaultName =
    source.kind === 'makeup' ? `${source.name} · 再次补排` : `${source.name} · 漏项补排`;
  const name =
    req.body.name && String(req.body.name).trim() ? String(req.body.name).trim() : defaultName;

  const outcome = db.transaction(() => {
    // 事务内复核：重新读取来源场次当前全部「仍漏执行且未补排」记录
    const candidates = makeupCandidates(source.id);
    if (candidates.length === 0) {
      throw conflict('来源场次当前没有尚未补排的漏执行记录，无法生成补排场次');
    }
    let chosen = candidates;
    if (requested) {
      if (requested.length === 0) {
        throw conflict('未选择任何漏执行记录，不能生成空补排场次');
      }
      const byId = new Map(candidates.map((c) => [c.execution_id, c]));
      chosen = [];
      for (const id of requested) {
        const c = byId.get(id);
        if (!c) {
          // 记录不属于此场、已不是漏执行（被撤回后整行删除）、或已进入其他补排场。
          // 撤回的语义无法从已删除的行区分「从未存在」，统一以过期/无效请求 409 告知并要求刷新。
          throw conflict('存在已被撤回、已补排或不属于该场次的来源记录，该补排请求已过期（冲突），请刷新后重试');
        }
        chosen.push(c);
      }
      // makeupCandidates 已按原 seq 升序，chosen 保持请求顺序可能乱序，这里恢复原队列顺序
      chosen.sort((a, b) => a.execution_seq - b.execution_seq);
    }

    const info = db
      .prepare(
        `INSERT INTO sessions (script_id, name, script_version, total, excluded_pending,
                               kind, source_session_id)
         VALUES (?, ?, ?, ?, 0, 'makeup', ?)`
      )
      .run(source.script_id, name, source.script_version, chosen.length, source.id);
    const sid = info.lastInsertRowid;

    const itemStmt = db.prepare(
      `INSERT INTO session_items (session_id, seq, cue_id, line_no, type, label, note, line_text,
                                  asset_id, asset_filename)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const srcStmt = db.prepare(
      `INSERT INTO session_makeup_sources
         (session_id, item_id, source_session_id, source_item_id, source_execution_id,
          source_seq, original_line_no, original_type, original_label, original_note,
          original_line_text, miss_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    chosen.forEach((c, i) => {
      // 按原队列顺序重新编号 seq；冻结字段全部取自来源条目快照与漏执行处理记录。
      // 素材快照同样沿用来源条目的冻结值（c.asset_id / c.asset_filename），
      // 不再回查 cues 当前关联——提示后来改绑/解除/删除素材不影响补排场试听。
      const r = itemStmt.run(
        sid,
        i + 1,
        c.cue_id,
        c.line_no,
        c.type,
        c.label,
        c.note,
        c.line_text || '',
        c.asset_id ?? null,
        c.asset_id ? c.asset_filename : null
      );
      try {
        srcStmt.run(
          sid,
          r.lastInsertRowid,
          source.id,
          c.item_id,
          c.execution_id,
          c.execution_seq,
          c.line_no,
          c.type,
          c.label,
          c.note,
          c.line_text || '',
          c.miss_reason
        );
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          // 并发下另一个请求已把同一漏执行记录补排：整笔事务回滚，冲突告知
          throw conflict('部分漏执行记录已进入其他补排场次，请刷新后重试');
        }
        throw err;
      }
    });

    return { id: sid, count: chosen.length };
  })();

  res.status(201).json({ id: outcome.id, total: outcome.count });
});

/* ----------------------------- 场次对照 ----------------------------- */

/** 取场次冻结条目并合并执行状态（done / missed / pending），按队列序号排序 */
function sessionItemsWithStatus(sessionId) {
  const items = db
    .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId);
  const execs = db
    .prepare('SELECT item_id, kind, miss_reason, executed_at FROM session_executions WHERE session_id = ?')
    .all(sessionId);
  const byItem = new Map(execs.map((e) => [e.item_id, e]));
  return items.map((it) => {
    const rec = byItem.get(it.id);
    return {
      cue_id: it.cue_id,
      seq: it.seq,
      line_no: it.line_no,
      type: it.type,
      label: it.label,
      note: it.note,
      line_text: it.line_text,
      status: rec ? rec.kind : 'pending',
      miss_reason: rec ? rec.miss_reason : null,
      processed_at: rec ? rec.executed_at : null,
    };
  });
}

function compareSessionSummary(s) {
  return {
    id: s.id,
    name: s.name,
    script_version: s.script_version,
    total: s.total,
    done_count: s.done_count,
    missed_count: s.missed_count,
    created_at: s.created_at,
  };
}

/**
 * 同一剧本两场场次的对照（只读，不改写任何场次或提示数据）。
 * 配对规则：以冻结条目记录的来源提示 ID（session_items.cue_id）对齐——
 * 同一场次内 cue_id 唯一，因此基准场与对照场中 cue_id 相同的条目互为同一条提示；
 * 绝不按队列序号或台词文本配对。cue_id 为空（历史数据）的条目无法配对，按各自场次独有处理。
 * 展示顺序：共同提示与基准场独有提示按基准场队列顺序排列；对照场独有（新增）提示
 * 接在末尾，并保持其在对照场中的队列顺序。
 */
app.get('/api/scripts/:id/sessions/compare', (req, res) => {
  const script = getScriptOr404(req.params.id);
  const baseId = Number(req.query.base);
  const compareId = Number(req.query.compare);
  if (!Number.isInteger(baseId) || !Number.isInteger(compareId)) {
    return res.status(400).json({ error: '请通过 base 与 compare 参数指定要对照的两个场次' });
  }
  if (baseId === compareId) {
    return res.status(400).json({ error: '基准场与对照场不能是同一场次' });
  }
  const base = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND script_id = ?')
    .get(baseId, script.id);
  if (!base) return res.status(404).json({ error: '基准场次不存在或不属于该剧本' });
  const compare = db
    .prepare('SELECT * FROM sessions WHERE id = ? AND script_id = ?')
    .get(compareId, script.id);
  if (!compare) return res.status(404).json({ error: '对照场次不存在或不属于该剧本' });

  const baseItems = sessionItemsWithStatus(base.id);
  const compareItems = sessionItemsWithStatus(compare.id);
  const compareByCue = new Map();
  for (const it of compareItems) {
    if (it.cue_id != null) compareByCue.set(it.cue_id, it);
  }

  const rows = [];
  const matchedCompareCueIds = new Set();
  let commonCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  // 按基准场顺序：共同提示（含变化检测）与基准场独有提示
  for (const b of baseItems) {
    const c = b.cue_id != null ? compareByCue.get(b.cue_id) : undefined;
    if (!c) {
      rows.push({ kind: 'only-base', cue_id: b.cue_id, base: b });
      continue;
    }
    matchedCompareCueIds.add(c.cue_id);
    const changes = {
      line_no: b.line_no !== c.line_no,
      type: b.type !== c.type,
      label: b.label !== c.label,
      note: b.note !== c.note,
      status: b.status !== c.status,
    };
    const changed = Object.values(changes).some(Boolean);
    commonCount += 1;
    if (changed) changedCount += 1;
    else unchangedCount += 1;
    rows.push({ kind: 'common', cue_id: b.cue_id, base: b, compare: c, changes, changed });
  }

  // 对照场独有（新增）提示：接在末尾，保持对照场顺序
  let onlyCompareCount = 0;
  for (const c of compareItems) {
    if (c.cue_id != null && matchedCompareCueIds.has(c.cue_id)) continue;
    onlyCompareCount += 1;
    rows.push({ kind: 'only-compare', cue_id: c.cue_id, compare: c });
  }

  res.json({
    script_id: script.id,
    base: compareSessionSummary(base),
    compare: compareSessionSummary(compare),
    stats: {
      common: commonCount,
      changed: changedCount,
      unchanged: unchangedCount,
      only_base: baseItems.length - commonCount,
      only_compare: onlyCompareCount,
    },
    rows,
  });
});

/**
 * 正常执行与漏执行共用的队首推进校验（须在事务内调用）：
 * 预期进度必须等于服务端当前已处理条数，且目标条目必须是队首；
 * 过期/重复/越序一律 409。返回队首条目与当前已处理数。
 */
function checkHeadAdvance(session, itemId, expectedProgress) {
  const done = db
    .prepare('SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ?')
    .get(session.id).n;

  // 过期请求：客户端看到的进度已经不是服务端当前进度
  if (done !== expectedProgress) {
    throw conflict('场次进度已变化，请刷新后重试（你的请求已过期）');
  }
  if (done >= session.total) {
    throw conflict('本场次已全部处理完毕，不能推进下一条');
  }

  // 一次只能处理队首
  const head = db
    .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY seq ASC LIMIT 1 OFFSET ?')
    .get(session.id, done);
  if (!head) throw conflict('找不到下一条可处理条目');
  if (head.id !== itemId) {
    throw conflict('只能处理队首条目，不能跳过或乱序');
  }
  return { head, done };
}

/**
 * 追加一条处理记录；UNIQUE 冲突 = 该条目已处理（重复请求）。
 * rehearsalSeconds 为该处理时刻的有效排练秒数（同一事务内快照，null=从未计时）。
 */
function insertExecution(sessionId, itemId, seq, kind, missReason, rehearsalSeconds) {
  try {
    db.prepare(
      `INSERT INTO session_executions
         (session_id, item_id, seq, kind, miss_reason, rehearsal_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, itemId, seq, kind, missReason, rehearsalSeconds);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw conflict('该条目已处理，请勿重复提交');
    }
    throw err;
  }
}

/**
 * 处理后场次即全部完成时，同一事务内自动停表：running 才结算最后一段，
 * paused/idle 不动累计值；timer_version +1（结束态，之后不允许再切换）。
 * 返回完成后场次的有效排练秒数（idle 仍为 null）。
 */
function settleTimerOnComplete(session, newDone, now) {
  if (newDone < session.total) return;
  const cur = db
    .prepare('SELECT timer_state, timer_elapsed, timer_started_at, timer_version FROM sessions WHERE id = ?')
    .get(session.id);
  if (cur.timer_state === 'running') {
    const elapsed = cur.timer_elapsed + Math.max(0, now - (cur.timer_started_at || now));
    db.prepare(
      `UPDATE sessions
       SET timer_state = 'paused', timer_elapsed = ?, timer_started_at = NULL,
           timer_version = timer_version + 1
       WHERE id = ?`
    ).run(elapsed, session.id);
  } else if (cur.timer_state === 'paused') {
    // 已暂停即为最终值，仅推进版本号以标记停表时刻（不重复加时间）
    db.prepare('UPDATE sessions SET timer_version = timer_version + 1 WHERE id = ?').run(session.id);
  }
}

/** 事务内：取队首推进 + 当前有效排练秒数快照（用于写入该条处理的时间点） */
function currentRehearsalSeconds(sessionId, now) {
  const t = db
    .prepare('SELECT timer_state, timer_elapsed, timer_started_at FROM sessions WHERE id = ?')
    .get(sessionId);
  return rehearsalSecondsAt(t, now);
}

// 执行队首条目：提交目标条目与预期进度做乐观锁校验
app.post('/api/sessions/:sessionId/execute', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const itemId = Number(req.body.itemId);
  const expectedProgress = Number(req.body.expectedProgress);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: '缺少要执行的目标条目' });
  }
  if (!Number.isInteger(expectedProgress) || expectedProgress < 0) {
    return res.status(400).json({ error: '缺少预期进度 expectedProgress' });
  }

  const result = db.transaction(() => {
    const { head, done } = checkHeadAdvance(session, itemId, expectedProgress);
    const now = nowSec();
    // 同事务记录该处理时刻对应的有效排练秒数（从未计时则为 NULL → 显示「未计时」）
    insertExecution(
      session.id,
      head.id,
      done + 1,
      'done',
      null,
      currentRehearsalSeconds(session.id, now)
    );
    // 全部处理完：同事务自动停表落账，最后一段也只结算一次
    settleTimerOnComplete(session, done + 1, now);
    return done + 1;
  })();

  res.json({ ok: true, progress: result });
});

// 漏执行登记：队首无法按计划执行时，填写原因并标记为漏执行，随后继续处理下一条。
// 与正常执行共用场次进度与预期进度校验（重复提交/越序/过期同样返回 409）。
app.post('/api/sessions/:sessionId/miss', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const itemId = Number(req.body.itemId);
  const expectedProgress = Number(req.body.expectedProgress);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: '缺少要登记的目标条目' });
  }
  if (!Number.isInteger(expectedProgress) || expectedProgress < 0) {
    return res.status(400).json({ error: '缺少预期进度 expectedProgress' });
  }
  if (!reason) {
    return res.status(400).json({ error: '请填写漏执行原因' });
  }

  const result = db.transaction(() => {
    const { head, done } = checkHeadAdvance(session, itemId, expectedProgress);
    const now = nowSec();
    insertExecution(
      session.id,
      head.id,
      done + 1,
      'missed',
      reason,
      currentRehearsalSeconds(session.id, now)
    );
    settleTimerOnComplete(session, done + 1, now);
    return done + 1;
  })();

  res.json({ ok: true, progress: result });
});

// 撤回最后处理的一条（正常执行或漏执行），该条回到待处理（同样带乐观锁）
app.post('/api/sessions/:sessionId/undo', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const expectedProgress = Number(req.body.expectedProgress);
  if (!Number.isInteger(expectedProgress) || expectedProgress < 0) {
    return res.status(400).json({ error: '缺少预期进度 expectedProgress' });
  }

  const result = db.transaction(() => {
    const last = db
      .prepare(
        `SELECT * FROM session_executions WHERE session_id = ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(session.id);
    if (!last) throw conflict('没有可撤回的处理记录');

    const done = db
      .prepare('SELECT COUNT(*) AS n FROM session_executions WHERE session_id = ?')
      .get(session.id).n;
    if (done !== expectedProgress) {
      throw conflict('场次进度已变化，请刷新后重试（你的撤回请求已过期）');
    }

    // 删除该条处理记录即同时移除其有效排练秒数时间点；冻结条目（队列顺序）保持不变。
    // 计时状态不回滚：若撤回前已完成并自动停表，撤回后场次回到未完成、计时保持暂停，可再点「继续」。
    db.prepare('DELETE FROM session_executions WHERE id = ?').run(last.id);
    return done - 1;
  })();

  res.json({ ok: true, progress: result });
});

/* ----------------------------- 场次条目修订建议 ----------------------------- */

function getSuggestionOr404(suggestionId) {
  const sug = db
    .prepare('SELECT * FROM session_item_suggestions WHERE id = ?')
    .get(suggestionId);
  if (!sug) {
    const e = new Error('建议不存在');
    e.status = 404;
    throw e;
  }
  return sug;
}

// 为冻结条目提交修订建议（新的提示内容 + 备注），保存在场次下
app.post('/api/sessions/:sessionId/items/:itemId/suggestions', (req, res) => {
  const session = getSessionOr404(req.params.sessionId);
  const item = db
    .prepare('SELECT * FROM session_items WHERE id = ? AND session_id = ?')
    .get(Number(req.params.itemId), session.id);
  if (!item) return res.status(404).json({ error: '场次条目不存在' });

  const label = String(req.body.label || '').trim();
  const note = String(req.body.note || '').trim();
  if (!label) return res.status(400).json({ error: '请填写建议的提示内容' });

  const info = db
    .prepare(
      `INSERT INTO session_item_suggestions (session_id, item_id, label, note)
       VALUES (?, ?, ?, ?)`
    )
    .run(session.id, item.id, label, note);
  res.status(201).json({ id: info.lastInsertRowid });
});

// 修改建议：仅未采纳的建议可改；修改后回到待处理状态，可再次尝试采纳
app.patch('/api/suggestions/:suggestionId', (req, res) => {
  const sug = getSuggestionOr404(req.params.suggestionId);
  if (sug.status === 'adopted') {
    return res.status(409).json({ error: '该建议已被采纳，作为历史记录保留，不能再修改' });
  }

  const label = req.body.label !== undefined ? String(req.body.label).trim() : sug.label;
  if (!label) return res.status(400).json({ error: '请填写建议的提示内容' });
  const note = req.body.note !== undefined ? String(req.body.note).trim() : sug.note;

  db.prepare(
    `UPDATE session_item_suggestions
     SET label = ?, note = ?, status = 'pending', conflict_reason = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(label, note, sug.id);
  res.json({ ok: true });
});

// 删除（撤回）建议：已采纳的作为历史保留，不可删除
app.delete('/api/suggestions/:suggestionId', (req, res) => {
  const sug = getSuggestionOr404(req.params.suggestionId);
  if (sug.status === 'adopted') {
    return res.status(409).json({ error: '该建议已被采纳，作为历史记录保留，不能删除' });
  }
  db.prepare('DELETE FROM session_item_suggestions WHERE id = ?').run(sug.id);
  res.json({ ok: true });
});

/**
 * 采纳建议：同一事务内核对——
 *   1. 来源提示仍存在；
 *   2. 剧本当前版本与场次冻结版本一致，且提示仍绑定在快照行；
 *   3. 提示的类型、内容、备注与条目快照一致（即排练后无人改过）。
 * 任一不符：标记建议为冲突并保留（提交该标记），返回 409，绝不覆盖排练后的编辑；
 * 全部通过：把建议的内容/备注写回当前提示，并标记建议已采纳。
 * 场次冻结条目与执行记录始终不被改动。
 */
app.post('/api/suggestions/:suggestionId/adopt', (req, res) => {
  const sug = getSuggestionOr404(req.params.suggestionId);

  const outcome = db.transaction(() => {
    if (sug.status === 'adopted') {
      throw conflict('该建议已被采纳，不能重复采纳');
    }
    const item = db.prepare('SELECT * FROM session_items WHERE id = ?').get(sug.item_id);
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sug.session_id);
    if (!item || !session) throw conflict('场次或条目已不存在');

    let failReason = null;
    const cue =
      item.cue_id == null
        ? null
        : db.prepare('SELECT * FROM cues WHERE id = ?').get(item.cue_id);

    if (!cue) {
      failReason = '来源提示已被删除，无法回写';
    } else {
      const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(session.script_id);
      if (!script || script.current_version !== session.script_version) {
        failReason = `剧本已改版（当前第 ${script ? script.current_version : '?'} 版，场次冻结自第 ${session.script_version} 版）`;
      } else if (cue.anchor_status !== 'bound' || cue.line_no !== item.line_no) {
        failReason = '来源提示的绑定行已变化（可能被重新绑定或待确认）';
      } else if (cue.type !== item.type || cue.label !== item.label || cue.note !== item.note) {
        failReason = '来源提示的类型/内容/备注已与场次快照不一致（排练后被编辑过）';
      }
    }

    if (failReason) {
      // 保留建议，仅把冲突状态与原因落库，随后以 409 告知调用方
      db.prepare(
        `UPDATE session_item_suggestions
         SET status = 'conflict', conflict_reason = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(failReason, sug.id);
      return { ok: false, reason: failReason };
    }

    db.prepare(
      `UPDATE cues SET label = ?, note = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(sug.label, sug.note, cue.id);
    db.prepare(
      `UPDATE session_item_suggestions
       SET status = 'adopted', conflict_reason = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(sug.id);
    return { ok: true };
  })();

  if (!outcome.ok) {
    return res.status(409).json({ error: `采纳失败：${outcome.reason}`, conflict: true });
  }
  res.json({ ok: true });
});

/* ----------------------------- 错误处理 ----------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // body-parser 体积超限：素材上传走 10 MB 限制，其余 JSON 请求走 5 MB 限制
  if (err.type === 'entity.too.large') {
    const limitMsg = req.path.startsWith('/api/assets')
      ? '文件超过 10 MB 大小限制，未保存任何内容'
      : '请求体超过大小限制';
    return res.status(413).json({ error: limitMsg });
  }
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`台词提示单已启动: http://localhost:${PORT}`);
});
