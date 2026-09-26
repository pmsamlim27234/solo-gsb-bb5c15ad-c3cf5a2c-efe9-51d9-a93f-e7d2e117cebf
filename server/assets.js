'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const { DB_PATH } = db;

/**
 * 音效素材库存储：
 * - 素材文件保存在 ASSET_DIR（默认与 SQLite 数据库同目录下的 assets/，
 *   Docker 中即 /app/data/assets，随 cue-data 命名卷持久化）；
 * - 磁盘文件名一律为 <sha256><扩展名>（由服务端生成，无路径注入风险）；
 * - 上传先写临时文件再原子重命名，任何失败都不会留下以素材名存在的残缺文件；
 *   模块加载时清理上次可能残留的上传临时文件与「落盘成功但登记记录前崩溃」的孤儿文件。
 */
const ASSET_DIR = path.resolve(
  process.env.ASSET_DIR || path.join(path.dirname(DB_PATH), 'assets')
);
const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 单个素材最大 10 MB

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

fs.mkdirSync(ASSET_DIR, { recursive: true });

/** 按文件头魔数识别真实音频格式；无法识别返回 null */
function sniffAudioExt(buf) {
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return '.wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return '.ogg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return '.mp3';
  // 无 ID3 标签的 MP3：帧同步 0xFFEx
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 把上传内容落盘：先写同目录临时文件，再原子重命名为 <sha256><ext>。
 * 重命名前崩溃/失败只会留下临时文件（启动时清理），绝不会留下以素材名存在的残缺文件。
 */
function saveAssetFile(buf, hash, ext) {
  const tmp = path.join(
    ASSET_DIR,
    `.upload-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const final = path.join(ASSET_DIR, `${hash}${ext}`);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, final); // 同目录 rename 原子生效；同名即同内容，覆盖无害
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略清理失败 */
    }
    throw err;
  }
  return final;
}

/** 删除素材文件；文件已不存在（ENOENT）视为成功 */
function removeAssetFile(storedName) {
  try {
    fs.unlinkSync(path.join(ASSET_DIR, storedName));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * 启动清理：
 * - 删除上次上传残留/中断的临时文件（.upload-*）；
 * - 删除没有任何数据库记录引用的孤儿文件（例如上次在「落盘成功、登记记录前」崩溃留下），
 *   保证上传失败既不留下可见记录，也不留下残缺文件。
 */
function sweepOrphanFiles() {
  const known = new Set(
    db.prepare('SELECT stored_name FROM sound_assets').all().map((r) => r.stored_name)
  );
  for (const name of fs.readdirSync(ASSET_DIR)) {
    if (name.startsWith('.upload-') || !known.has(name)) {
      try {
        fs.unlinkSync(path.join(ASSET_DIR, name));
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

sweepOrphanFiles();

module.exports = {
  ASSET_DIR,
  MAX_ASSET_SIZE,
  AUDIO_TYPES,
  sniffAudioExt,
  sha256,
  saveAssetFile,
  removeAssetFile,
};
