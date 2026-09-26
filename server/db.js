const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cues.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS scripts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS script_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 音效素材库：本机全剧目共用的音频素材记录；按文件内容 SHA-256 去重，
-- 同一内容重复上传复用原记录与文件。文件本体存放在 ASSET_DIR（默认 <数据目录>/assets），
-- stored_name 为 <sha256><扩展名>。删除前必须确认没有任何提示引用（应用层返回 409，外键兜底）。
CREATE TABLE IF NOT EXISTS sound_assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256      TEXT    NOT NULL UNIQUE,  -- 文件内容摘要，去重键
  filename    TEXT    NOT NULL,         -- 首次上传时的原始文件名（展示用）
  ext         TEXT    NOT NULL CHECK (ext IN ('.mp3', '.wav', '.ogg')),
  size        INTEGER NOT NULL,         -- 字节数
  stored_name TEXT    NOT NULL UNIQUE,  -- 磁盘文件名（<sha256><扩展名>）
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id      INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('light', 'sound')),
  label          TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  asset_id       INTEGER REFERENCES sound_assets(id),  -- 音效提示关联的素材（可空；灯光提示恒为 NULL）
  version        INTEGER NOT NULL DEFAULT 1,
  line_no        INTEGER,
  line_text      TEXT,
  anchor_index   INTEGER,
  anchor_text    TEXT,
  context_before TEXT    NOT NULL DEFAULT '',
  context_after  TEXT    NOT NULL DEFAULT '',
  anchor_status  TEXT    NOT NULL DEFAULT 'bound' CHECK (anchor_status IN ('bound', 'pending')),
  issue_type     TEXT,
  issue_detail   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cues_script ON cues(script_id);
CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id);

-- 排练场次：从剧本当前版本创建，创建时刻冻结条目快照；
-- kind='makeup' 为「漏项补排场」，由来源场次的漏执行记录一键冻结生成（source_session_id 记来源场次）
CREATE TABLE IF NOT EXISTS sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id         INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  name              TEXT    NOT NULL,
  script_version    INTEGER NOT NULL,            -- 创建时剧本当前版本（冻结）
  total             INTEGER NOT NULL DEFAULT 0,  -- 冻结的可执行条目数
  excluded_pending  INTEGER NOT NULL DEFAULT 0,  -- 创建时被排除的待确认提示数
  kind              TEXT    NOT NULL DEFAULT 'normal'
                    CHECK (kind IN ('normal', 'makeup')),
  source_session_id INTEGER,                     -- 补排场次的来源场次 ID；普通场次为 NULL
  -- 有效排练计时：状态机 idle（从未开始）→ running ⇄ paused；
  -- timer_elapsed 为已落账的累计有效秒数（暂停瞬间结算），running 时另加「当前段经过秒数」；
  -- timer_started_at 记当前计时段开始的服务端 epoch 秒（仅 running 非空）；
  -- timer_version 为状态版本，每次开始/暂停/继续（及完成自动停表）+1，用作乐观锁
  timer_state       TEXT    NOT NULL DEFAULT 'idle'
                    CHECK (timer_state IN ('idle', 'running', 'paused')),
  timer_elapsed     INTEGER NOT NULL DEFAULT 0,
  timer_started_at  INTEGER,
  timer_version     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 场次条目：冻结提示的行号/类型/内容/备注（及锚点台词文本，便于执行时对照）
-- cue_id 仅作来源追溯，不与 cues 建外键：提示日后被编辑/删除不影响既有场次
-- asset_id / asset_filename 为创建时刻该音效提示关联的素材快照：
-- 不与 sound_assets 建外键（素材删除冲突在应用层同时检查 cues 与本表引用，
-- 任一方仍引用即拒绝删除，因此快照存在时素材文件不会丢失）；
-- 提示后来改绑/解除/删除素材，旧场次仍按快照播放原素材。NULL 表示创建时未关联（或旧场次无快照）。
CREATE TABLE IF NOT EXISTS session_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,   -- 队列序号，从 1 开始（按行号、提示 ID 排序）
  cue_id         INTEGER,
  line_no        INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  label          TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  line_text      TEXT    NOT NULL DEFAULT '',
  asset_id       INTEGER,            -- 冻结的素材 ID（音效提示；未关联/灯光为 NULL）
  asset_filename TEXT,               -- 冻结的素材原始文件名（展示用；未关联为 NULL）
  UNIQUE (session_id, seq)
);

-- 处理记录：正常执行（done）与漏执行（missed）共用同一进度序列，只能按队首顺序追加；
-- 撤回即删除最后一条（不论哪种类型）；漏执行必须填写原因（miss_reason）
CREATE TABLE IF NOT EXISTS session_executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES session_items(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'done' CHECK (kind IN ('done', 'missed')),
  miss_reason TEXT,
  -- 该条处理（执行/漏执行）时刻对应的有效排练秒数：同事务内按服务端计时状态快照；
  -- NULL 表示处理时该场次从未开始计时（页面显示「未计时」）；撤回删除本行时时间点一并移除
  rehearsal_seconds INTEGER,
  executed_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, item_id)
);

-- 场次条目修订建议：排练时对冻结条目提出的新提示内容/备注，保存在场次下。
-- 采纳时事务内核对来源提示与条目快照一致才回写 cues；核对失败标记 conflict 并保留建议。
-- 已采纳的建议作为历史保留，不可再修改或删除。
CREATE TABLE IF NOT EXISTS session_item_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id         INTEGER NOT NULL REFERENCES session_items(id) ON DELETE CASCADE,
  label           TEXT    NOT NULL,              -- 建议的新提示内容
  note            TEXT    NOT NULL DEFAULT '',   -- 建议的新备注
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'adopted', 'conflict')),
  conflict_reason TEXT,                          -- 采纳核对失败的原因（建议本身保留）
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_script ON sessions(script_id);
CREATE INDEX IF NOT EXISTS idx_session_items_session ON session_items(session_id);
CREATE INDEX IF NOT EXISTS idx_session_exec_session ON session_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_session ON session_item_suggestions(session_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_item ON session_item_suggestions(item_id);

-- 补排来源：每条漏执行记录（session_executions.kind='missed'）至多对应一行，
-- UNIQUE(source_execution_id) 从数据库层保证「同一条漏执行记录只能进入一个补排场次」。
-- 同样不与来源场次/条目建外键：来源场次日后被撤回（删除执行记录）或场次删除后，
-- 补排场冻结数据仍完整，来源信息仅用于追溯展示。
CREATE TABLE IF NOT EXISTS session_makeup_sources (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id              INTEGER NOT NULL REFERENCES session_items(id) ON DELETE CASCADE,
  source_session_id    INTEGER NOT NULL,          -- 来源场次
  source_item_id       INTEGER NOT NULL,          -- 来源场次的冻结条目
  source_execution_id  INTEGER NOT NULL,          -- 来源场次的漏执行处理记录
  source_seq           INTEGER NOT NULL,          -- 来源场次处理顺序号
  original_line_no     INTEGER NOT NULL,          -- 冻结的来源提示行号
  original_type        TEXT    NOT NULL,          -- 冻结的来源类型
  original_label       TEXT    NOT NULL,          -- 冻结的来源提示内容
  original_note        TEXT    NOT NULL DEFAULT '', -- 冻结的来源备注
  original_line_text   TEXT    NOT NULL DEFAULT '', -- 冻结的来源锚点台词
  miss_reason          TEXT    NOT NULL,          -- 冻结的漏执行原因
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, item_id),
  UNIQUE (source_execution_id)
);

CREATE INDEX IF NOT EXISTS idx_makeup_sources_session ON session_makeup_sources(session_id);
CREATE INDEX IF NOT EXISTS idx_makeup_sources_source ON session_makeup_sources(source_session_id);
`);

// 兼容旧库：早期版本的 session_executions 没有 kind / miss_reason 列。
// CREATE TABLE IF NOT EXISTS 不会改动已存在的表，这里启动时检测并补齐，
// 已有执行记录默认记为正常执行（kind='done'），无需手工迁移。
const execCols = db
  .prepare('PRAGMA table_info(session_executions)')
  .all()
  .map((c) => c.name);
if (!execCols.includes('kind')) {
  db.exec("ALTER TABLE session_executions ADD COLUMN kind TEXT NOT NULL DEFAULT 'done'");
}
if (!execCols.includes('miss_reason')) {
  db.exec('ALTER TABLE session_executions ADD COLUMN miss_reason TEXT');
}

// 兼容旧库：sessions 增加 kind / source_session_id 列（普通场次默认 kind='normal'）
const sessionCols = db
  .prepare('PRAGMA table_info(sessions)')
  .all()
  .map((c) => c.name);
if (!sessionCols.includes('kind')) {
  db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
}
if (!sessionCols.includes('source_session_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN source_session_id INTEGER');
}

// 兼容旧库：sessions 增加有效排练计时四列（新场次默认从未计时）
if (!sessionCols.includes('timer_state')) {
  db.exec("ALTER TABLE sessions ADD COLUMN timer_state TEXT NOT NULL DEFAULT 'idle'");
}
if (!sessionCols.includes('timer_elapsed')) {
  db.exec('ALTER TABLE sessions ADD COLUMN timer_elapsed INTEGER NOT NULL DEFAULT 0');
}
if (!sessionCols.includes('timer_started_at')) {
  db.exec('ALTER TABLE sessions ADD COLUMN timer_started_at INTEGER');
}
if (!sessionCols.includes('timer_version')) {
  db.exec('ALTER TABLE sessions ADD COLUMN timer_version INTEGER NOT NULL DEFAULT 0');
}

// 兼容旧库：处理记录增加「有效排练秒数」时间点（旧记录无计时，保持 NULL → 页面显示「未计时」）
if (!execCols.includes('rehearsal_seconds')) {
  db.exec('ALTER TABLE session_executions ADD COLUMN rehearsal_seconds INTEGER');
}

// 兼容旧库：cues 增加 asset_id 列（音效提示关联的素材，可为空；既有提示均为 NULL 即未关联）
const cueCols = db
  .prepare('PRAGMA table_info(cues)')
  .all()
  .map((c) => c.name);
if (!cueCols.includes('asset_id')) {
  db.exec('ALTER TABLE cues ADD COLUMN asset_id INTEGER REFERENCES sound_assets(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_cues_asset ON cues(asset_id)');

// 兼容旧库：场次冻结条目增加素材快照两列（asset_id / asset_filename）。
// 旧场次没有素材快照，两列均为 NULL，页面音效条目显示「未关联素材」。
// 注：不回填历史快照——旧条目创建时关联的素材已无从按「当时状态」还原，
// 统一以未关联呈现，避免误把提示当前（可能已改绑的）素材当成冻结素材。
const itemCols = db
  .prepare('PRAGMA table_info(session_items)')
  .all()
  .map((c) => c.name);
if (!itemCols.includes('asset_id')) {
  db.exec('ALTER TABLE session_items ADD COLUMN asset_id INTEGER');
}
if (!itemCols.includes('asset_filename')) {
  db.exec('ALTER TABLE session_items ADD COLUMN asset_filename TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_session_items_asset ON session_items(asset_id)');

module.exports = db;
module.exports.DB_PATH = DB_PATH;
