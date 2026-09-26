'use strict';

/**
 * 提示重定位核心：
 * 保存新版剧本后，依据锚点台词及相邻行上下文，在新剧本中重新定位每个提示。
 *
 * 规则（绝不静默挂到另一句）：
 *  1. 规范化（忽略首尾及行内多余空白、不区分大小写）后在新版中全文匹配；
 *  2. 恰好 1 处命中且与原相邻上下文至少一处吻合（或无上下文快照） -> 自动绑定；
 *     仅 1 处命中但上下文完全不符（重复句之一被删、留下另一句的情形）-> 待确认；
 *  3. 0 处命中               -> 待确认（缺失，可能被删除或改写）；
 *  4. 多处命中               -> 用相邻行上下文打分，唯一最高分才自动绑定；
 *     并列或均无上下文匹配   -> 待确认（重复台词），返回候选行供人工选择。
 */

const CONTEXT_WINDOW = 2; // 锚点前后各取 2 行非空文本作为上下文

/** 规范化台词：统一换行，压缩空白，转小写 */
function normalize(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 拆分剧本为行（保留空行以便正确编号） */
function splitLines(content) {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').split('\n');
}

/** 取某索引前/后最多 n 行非空文本 */
function captureContext(lines, index, side, n) {
  const result = [];
  const step = side === 'before' ? -1 : 1;
  let i = index + step;
  while (i >= 0 && i < lines.length && result.length < n) {
    if (lines[i].trim() !== '') result.push(lines[i]);
    i += step;
  }
  return result;
}

/** 计算候选位置与原上下文的重合得分（前后分开计算，命中即计分） */
function scoreCandidate(lines, candIdx, ctxBefore, ctxAfter) {
  let score = 0;
  if (ctxBefore.length > 0) {
    const curBefore = captureContext(lines, candIdx, 'before', ctxBefore.length).map(normalize);
    const wantBefore = ctxBefore.map(normalize);
    for (let k = 0; k < curBefore.length && k < wantBefore.length; k++) {
      if (curBefore[k] && curBefore[k] === wantBefore[k]) score += k === 0 ? 2 : 1;
    }
  }
  if (ctxAfter.length > 0) {
    const curAfter = captureContext(lines, candIdx, 'after', ctxAfter.length).map(normalize);
    const wantAfter = ctxAfter.map(normalize);
    for (let k = 0; k < curAfter.length && k < wantAfter.length; k++) {
      if (curAfter[k] && curAfter[k] === wantAfter[k]) score += k === 0 ? 2 : 1;
    }
  }
  return score;
}

/**
 * 在新文本中定位单个提示。
 * @returns {{status:'bound'|'pending', lineNo, lineText, issueType, issueDetail, candidates}}
 */
function locateOne(cue, newContent) {
  const lines = splitLines(newContent);
  const anchor = normalize(cue.anchor_text);
  const ctxBefore = cue.context_before ? JSON.parse(cue.context_before) : [];
  const ctxAfter = cue.context_after ? JSON.parse(cue.context_after) : [];

  if (!anchor) {
    return {
      status: 'pending',
      lineNo: null,
      lineText: null,
      issueType: 'missing_anchor',
      issueDetail: '该提示缺少锚点台词，请手动指定。',
      candidates: [],
    };
  }

  // 全部精确匹配位置
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]) === anchor) matches.push(i);
  }

  if (matches.length === 0) {
    return {
      status: 'pending',
      lineNo: null,
      lineText: null,
      issueType: 'missing',
      issueDetail: '新版剧本中找不到这句台词（可能已删除或改写），请重新指定。',
      candidates: [],
    };
  }

  if (matches.length === 1) {
    const i = matches[0];
    // 唯一文本命中：若存有上下文快照，则要求上下文至少有一处吻合，
    // 否则可能是"重复句之一被删除、留下的是另一句"，交人工确认而非静默绑定。
    const haveContext = ctxBefore.length > 0 || ctxAfter.length > 0;
    if (!haveContext || scoreCandidate(lines, i, ctxBefore, ctxAfter) > 0) {
      return { status: 'bound', lineNo: i + 1, lineText: lines[i] };
    }
    return {
      status: 'pending',
      lineNo: null,
      lineText: null,
      issueType: 'duplicate',
      issueDetail:
        '新版中该台词虽只剩一处，但相邻上下文与原来完全不一致（被删的可能正是原句，留下的是另一句相同台词），请确认。',
      candidates: [{ lineNo: i + 1, lineText: lines[i], score: 0 }],
    };
  }

  // 多处命中：上下文打分
  const scored = matches
    .map((i) => ({ idx: i, score: scoreCandidate(lines, i, ctxBefore, ctxAfter) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const tied = scored.filter((s) => s.score === best.score);
  const haveContext = ctxBefore.length > 0 || ctxAfter.length > 0;

  if (best.score > 0 && tied.length === 1) {
    return { status: 'bound', lineNo: best.idx + 1, lineText: lines[best.idx] };
  }

  const candidates = scored.map((s) => ({
    lineNo: s.idx + 1,
    lineText: lines[s.idx],
    score: s.score,
  }));

  return {
    status: 'pending',
    lineNo: null,
    lineText: null,
    issueType: 'duplicate',
    issueDetail: haveContext
      ? `新版中有 ${matches.length} 句相同台词，相邻上下文仍无法唯一区分，请手动确认。`
      : `新版中有 ${matches.length} 句相同台词，请手动确认。`,
    candidates,
  };
}

/**
 * 对一批提示执行重定位。
 * @param cues 提示记录数组（含 anchor_text / context_before / context_after）
 * @param newContent 新版剧本全文
 * @returns {{results: Array, stats: {bound:number, pending:number, total:number}}}
 */
function relocalize(cues, newContent) {
  const results = cues.map((cue) => {
    const r = locateOne(cue, newContent);
    return { cueId: cue.id, ...r };
  });
  const stats = {
    total: results.length,
    bound: results.filter((r) => r.status === 'bound').length,
    pending: results.filter((r) => r.status === 'pending').length,
  };
  return { results, stats };
}

/** 为新添加/手动绑定的提示生成锚点快照 */
function buildAnchor(content, lineIndex) {
  const lines = splitLines(content);
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error('行号超出剧本范围');
  }
  return {
    lineIndex,
    anchorText: lines[lineIndex],
    contextBefore: captureContext(lines, lineIndex, 'before', CONTEXT_WINDOW),
    contextAfter: captureContext(lines, lineIndex, 'after', CONTEXT_WINDOW),
  };
}

module.exports = {
  normalize,
  splitLines,
  captureContext,
  locateOne,
  relocalize,
  buildAnchor,
};
