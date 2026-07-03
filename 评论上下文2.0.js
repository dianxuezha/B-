// ==UserScript==
// @name         B站评论上下文补全(Bilibili)
// @namespace    https://tampermonkey.net/
// @version      2.0.0
// @description  优化B站评论区，鼠标悬浮回复时显示完整对话链（根评论 → 所有上文祖先 → 当前回复 → 所有下文后代）
// @author       ArcherEmiya
// @license      MIT
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        GM_addStyle
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/572814/B%E7%AB%99%E8%AF%84%E8%AE%BA%E4%B8%8A%E4%B8%8B%E6%96%87%E8%A1%A5%E5%85%A8%28Bilibili%29.user.js
// @updateURL https://update.greasyfork.org/scripts/572814/B%E7%AB%99%E8%AF%84%E8%AE%BA%E4%B8%8A%E4%B8%8B%E6%96%87%E8%A1%A5%E5%85%A8%28Bilibili%29.meta.js
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG_STORAGE_KEY = 'tm-bili-context-debug';
  const DEBUG = localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
  const MODAL_ID = 'tm-bili-context-popover';
  const REPLY_API_PATH = '/x/v2/reply/reply';
  const HOVER_OPEN_DELAY = 100;
  const HOVER_CLOSE_DELAY = 180;

  const replyCacheByRoot = new Map();
  const replyByRpid = new Map();
  let activeAnchor = null;
  let popoverFollowRaf = 0;
  let resolvedOidPromise = null;
  let capturedOid = '';
  let scanTimer = 0;
  const pendingScanRoots = new Set();
  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;
  let activeHost = null;
  let commentsObserver = null;

  function setDebugEnabled(enabled) {
    try {
      localStorage.setItem(DEBUG_STORAGE_KEY, enabled ? '1' : '0');
    } catch (_) {}
  }

  function log(...args) {
    if (DEBUG) console.log('[BiliContext]', ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function toSafeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  function toId(value) {
    const num = Math.trunc(toSafeNumber(value));
    return num > 0 ? num : 0;
  }

  function normalizeText(str = '') {
    return String(str).replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(str = '') {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function safelyRead(value, key) {
    try {
      return value?.[key];
    } catch (_) {
      return undefined;
    }
  }

  function rememberOid(oid) {
    const normalized = String(toId(oid) || '').trim();
    if (!normalized) return;
    capturedOid = normalized;
    log('捕获到 oid:', capturedOid);
  }

  function rememberOidFromUrl(rawUrl) {
    if (!rawUrl) return;

    try {
      const url = new URL(String(rawUrl), location.origin);
      const oid = url.searchParams.get('oid');
      if (oid) rememberOid(oid);
    } catch (_) {}
  }

  function extractRootFromUrl(rawUrl) {
    if (!rawUrl) return 0;

    try {
      const url = new URL(String(rawUrl), location.origin);
      return toId(url.searchParams.get('root'));
    } catch (_) {
      return 0;
    }
  }

  function getCurrentOidFromState() {
    if (capturedOid) return capturedOid;

    const st = window.__INITIAL_STATE__;
    if (st?.aid) return String(st.aid);
    if (st?.videoData?.aid) return String(st.videoData.aid);
    if (st?.epInfo?.aid) return String(st.epInfo.aid);
    if (window.__INITIAL_STATE__?.avInfo?.aid) return String(window.__INITIAL_STATE__.avInfo.aid);
    if (window.__INITIAL_STATE__?.videoInfo?.aid) return String(window.__INITIAL_STATE__.videoInfo.aid);
    return null;
  }

  function extractBvidFromText(text = '') {
    const match = String(text).match(/BV[0-9A-Za-z]{10}/);
    return match ? match[0] : '';
  }

  function getCurrentBvid() {
    const st = window.__INITIAL_STATE__;
    const fromState = [
      st?.bvid,
      st?.videoData?.bvid,
      st?.epInfo?.bvid,
      st?.avInfo?.bvid,
      st?.videoInfo?.bvid
    ].find(Boolean);
    if (fromState) return String(fromState);

    const fromUrl = extractBvidFromText(location.href) || extractBvidFromText(location.pathname);
    if (fromUrl) return fromUrl;

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
    const pageHtml = document.documentElement?.innerHTML?.slice(0, 300000) || '';

    return (
      extractBvidFromText(canonical) ||
      extractBvidFromText(ogUrl) ||
      extractBvidFromText(pageHtml) ||
      ''
    );
  }

  async function fetchAidByBvid(bvid) {
    if (!bvid) return null;

    const url = new URL('https://api.bilibili.com/x/web-interface/view');
    url.searchParams.set('bvid', bvid);

    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });

    if (!res.ok) throw new Error(`视频信息请求失败：HTTP ${res.status}`);

    const json = await res.json();
    if (json?.code !== 0) {
      throw new Error(`视频信息接口异常：${json?.message || json?.code}`);
    }

    const aid = toId(json?.data?.aid);
    if (aid) rememberOid(aid);
    return aid ? String(aid) : null;
  }

  async function resolveCurrentOid() {
    const directOid = getCurrentOidFromState();
    if (directOid) return directOid;

    if (!resolvedOidPromise) {
      resolvedOidPromise = (async () => {
        const retryOid = getCurrentOidFromState();
        if (retryOid) return retryOid;

        const bvid = getCurrentBvid();
        if (bvid) {
          const aid = await fetchAidByBvid(bvid);
          if (aid) return aid;
        }

        return null;
      })().catch(err => {
        resolvedOidPromise = null;
        throw err;
      });
    }

    return resolvedOidPromise;
  }

  // Reply cache and normalization
  function getOrCreateRootEntry(rootId) {
    if (!replyCacheByRoot.has(rootId)) {
      replyCacheByRoot.set(rootId, { rootReply: null, replies: [] });
    }
    return replyCacheByRoot.get(rootId);
  }

  function mergeReply(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;

    return {
      ...base,
      ...extra,
      content: {
        ...(base.content || {}),
        ...(extra.content || {})
      },
      member: {
        ...(base.member || {}),
        ...(extra.member || {})
      },
      parent_reply_member: {
        ...(base.parent_reply_member || {}),
        ...(extra.parent_reply_member || {})
      }
    };
  }

  function normalizeReply(reply, fallback = {}) {
    if (!reply || typeof reply !== 'object') return null;

    const merged = {
      ...fallback,
      ...reply,
      content: {
        ...(fallback.content || {}),
        ...(reply.content || {})
      },
      member: {
        ...(fallback.member || {}),
        ...(reply.member || {})
      },
      parent_reply_member: {
        ...(fallback.parent_reply_member || {}),
        ...(reply.parent_reply_member || {})
      }
    };

    const rpid = toId(merged.rpid || fallback.rpid);
    const root = toId(merged.root || fallback.root || rpid);
    const parent = toId(merged.parent || fallback.parent || root);

    if (!rpid || !root || !parent) return null;

    return {
      ...merged,
      rpid,
      root,
      parent
    };
  }

  function cacheReplyRecord(reply, { asRootReply = false, fallback = {} } = {}) {
    const normalized = normalizeReply(reply, fallback);
    if (!normalized) return null;

    const merged = mergeReply(replyByRpid.get(normalized.rpid), normalized);
    replyByRpid.set(merged.rpid, merged);

    const entry = getOrCreateRootEntry(merged.root);
    if (asRootReply) {
      entry.rootReply = mergeReply(entry.rootReply, merged);
      return entry.rootReply;
    }

    const index = entry.replies.findIndex(item => toId(item?.rpid) === merged.rpid);
    if (index >= 0) {
      entry.replies[index] = mergeReply(entry.replies[index], merged);
    } else {
      entry.replies.push(merged);
    }

    return entry.replies[index >= 0 ? index : entry.replies.length - 1];
  }

  function cacheReplyData(data, context = {}) {
    if (!data) return;

    if (data.root) {
      const rootId = toId(context.root || data.root?.rpid || data.root?.root);
      cacheReplyRecord(data.root, {
        asRootReply: true,
        fallback: rootId ? { rpid: rootId, root: rootId, parent: rootId } : {}
      });
    }

    const replies = Array.isArray(data.replies) ? data.replies : [];
    for (const reply of replies) {
      cacheReplyRecord(reply);
    }

    log('缓存回复数据:', {
      roots: replyCacheByRoot.size,
      replies: replyByRpid.size
    });
  }

  function getCachedReplyByRpid(rpid, root = 0) {
    const id = toId(rpid);
    if (!id) return null;

    const cached = replyByRpid.get(id);
    if (cached) return cached;

    if (root) {
      const entry = replyCacheByRoot.get(toId(root));
      const found = entry?.replies.find(item => toId(item?.rpid) === id);
      if (found) return found;
    }

    return null;
  }

  function getCachedRootReply(root) {
    const rootId = toId(root);
    if (!rootId) return null;
    return replyCacheByRoot.get(rootId)?.rootReply || replyByRpid.get(rootId) || null;
  }

  // DOM extraction helpers
  function extractVisibleTextFromReplyHost(host) {
    const root = host?.shadowRoot;
    if (!root) return '';

    const body = root.querySelector('#body');
    const raw = body?.textContent || root.textContent || '';
    return normalizeText(raw);
  }

  function extractUserNameFromReplyHost(host) {
    const root = host?.shadowRoot;
    if (!root) return '';

    const userInfoHost = root.querySelector('bili-comment-user-info');
    if (!userInfoHost?.shadowRoot) return '';

    const anchor = userInfoHost.shadowRoot.querySelector('a');
    const txt = normalizeText(anchor?.textContent || userInfoHost.shadowRoot.textContent || '');
    return txt.split(/\s+/)[0] || '';
  }

  function stripLeadingReplyPrefix(text) {
    return normalizeText(String(text).replace(/^回复\s*@?[^:：]+[:：]\s*/, ''));
  }

  function hasReplyPrefix(text = '') {
    return /^回复\s*@?[^:：]+[:：]\s*/.test(normalizeText(text));
  }

  function getInterestingChildren(value) {
    const children = [];
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return children;

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 10)) {
        children.push(item);
      }
      return children;
    }

    const preferredKeys = [
      'reply',
      'data',
      'item',
      'comment',
      'props',
      'memoizedProps',
      'pendingProps',
      'state',
      '__data',
      '__props',
      'detail',
      'payload',
      'value',
      'model',
      'ctx',
      'context'
    ];

    for (const key of preferredKeys) {
      const child = safelyRead(value, key);
      if (child !== undefined) children.push(child);
    }

    const ownNames = Object.getOwnPropertyNames(value)
      .filter(name => /reply|comment|data|props|item|detail|payload|state/i.test(name))
      .slice(0, 20);

    for (const name of ownNames) {
      const child = safelyRead(value, name);
      if (child !== undefined) children.push(child);
    }

    for (const sym of Object.getOwnPropertySymbols(value).slice(0, 8)) {
      const child = safelyRead(value, sym);
      if (child !== undefined) children.push(child);
    }

    return children;
  }

  function extractReplyFromObjectGraph(startValue) {
    const queue = [{ value: startValue, depth: 0 }];
    const visited = new Set();
    let steps = 0;

    while (queue.length && steps < 250) {
      const { value, depth } = queue.shift();
      steps += 1;

      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (visited.has(value)) continue;
      visited.add(value);

      const directReply = normalizeReply(value);
      if (directReply) return directReply;

      const shellCandidates = [
        safelyRead(value, 'reply'),
        safelyRead(value, 'data'),
        safelyRead(value, 'item'),
        safelyRead(value, 'comment'),
        safelyRead(safelyRead(value, 'props'), 'reply'),
        safelyRead(safelyRead(value, 'props'), 'data'),
        safelyRead(safelyRead(value, 'memoizedProps'), 'reply'),
        safelyRead(safelyRead(value, 'pendingProps'), 'reply')
      ];

      for (const candidate of shellCandidates) {
        const normalized = normalizeReply(candidate);
        if (normalized) return normalized;
      }

      if (depth >= 4) continue;

      for (const child of getInterestingChildren(value)) {
        queue.push({ value: child, depth: depth + 1 });
      }
    }

    return null;
  }

  function extractIdFromUnknown(value) {
    if (value == null || value === '') return 0;
    const direct = toId(value);
    if (direct) return direct;

    const match = String(value).match(/\d{4,}/);
    return match ? toId(match[0]) : 0;
  }

  function mergeReplyHints(target, source) {
    if (!source) return target;
    if (!target.rpid && source.rpid) target.rpid = source.rpid;
    if (!target.root && source.root) target.root = source.root;
    if (!target.parent && source.parent) target.parent = source.parent;
    return target;
  }

  function extractReplyHintsFromElement(element) {
    const hints = {};
    if (!element || typeof element.getAttributeNames !== 'function') return hints;

    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name);
      const lower = name.toLowerCase();
      const id = extractIdFromUnknown(value);
      if (!id) continue;

      if (!hints.rpid && /(rpid|replyid|reply-id)/.test(lower)) {
        hints.rpid = id;
      } else if (!hints.root && /(root|rootid|root-id)/.test(lower)) {
        hints.root = id;
      } else if (!hints.parent && /(parent|parentid|parent-id)/.test(lower)) {
        hints.parent = id;
      }
    }

    for (const [key, value] of Object.entries(element.dataset || {})) {
      const lower = key.toLowerCase();
      const id = extractIdFromUnknown(value);
      if (!id) continue;

      if (!hints.rpid && /(rpid|replyid|reply-id)/.test(lower)) {
        hints.rpid = id;
      } else if (!hints.root && /root/.test(lower)) {
        hints.root = id;
      } else if (!hints.parent && /parent/.test(lower)) {
        hints.parent = id;
      }
    }

    return hints;
  }

  function extractReplyHintsFromHost(host) {
    const hints = {};
    const nodes = [host];

    if (host?.shadowRoot) {
      nodes.push(...Array.from(host.shadowRoot.querySelectorAll('*')).slice(0, 24));
    }

    for (const node of nodes) {
      mergeReplyHints(hints, extractReplyHintsFromElement(node));
      if (hints.rpid && hints.root && hints.parent) break;
    }

    if (hints.root && !hints.parent) {
      hints.parent = hints.root;
    }

    return hints;
  }

  function setMatchedReply(host, reply, source = '未标记', trace = null) {
    const cached = cacheReplyRecord(reply) || normalizeReply(reply);
    if (!cached) return null;
    host.__tmMatchedReply = cached;
    host.__tmContextTrace = {
      ...(host.__tmContextTrace || {}),
      ...(trace || {}),
      matched: true,
      matchSource: source,
      rpid: cached.rpid,
      root: cached.root,
      parent: cached.parent
    };
    log('当前回复已定位:', { source, rpid: cached.rpid, root: cached.root, parent: cached.parent });
    return cached;
  }

  function extractReplyFromHostData(host, trace = null) {
    const roots = [host, host?.shadowRoot].filter(Boolean);

    for (const value of roots) {
      const reply = extractReplyFromObjectGraph(value);
      if (reply) {
        if (trace) trace.directSource = 'host-or-shadow-root';
        return reply;
      }
    }

    if (host?.shadowRoot) {
      const descendants = Array.from(host.shadowRoot.querySelectorAll('*')).slice(0, 18);
      for (const node of descendants) {
        const reply = extractReplyFromObjectGraph(node);
        if (reply) {
          if (trace) trace.directSource = 'shadow-descendant';
          return reply;
        }
      }
    }

    const hints = extractReplyHintsFromHost(host);
    if (trace) trace.hints = { ...hints };
    if (!hints.rpid || !hints.root) return null;

    if (trace) trace.directSource = 'dom-id-hints';
    return normalizeReply({
      ...hints,
      content: {
        message: extractVisibleTextFromReplyHost(host)
      },
      member: {
        uname: extractUserNameFromReplyHost(host)
      }
    });
  }

  function findCurrentReplyByHost(host, hints = {}) {
    const hostUser = extractUserNameFromReplyHost(host);
    const hostText = extractVisibleTextFromReplyHost(host);
    const strippedHost = stripLeadingReplyPrefix(hostText);

    let best = null;
    let bestScore = -1;

    for (const reply of replyByRpid.values()) {
      if (toId(reply?.rpid) === toId(reply?.root)) continue;
      if (hints.root && toId(reply?.root) !== toId(hints.root)) continue;

      if (hints.rpid && toId(reply?.rpid) === toId(hints.rpid)) {
        return reply;
      }

      const replyUser = normalizeText(reply?.member?.uname || '');
      const replyText = normalizeText(reply?.content?.message || '');
      const parentName = normalizeText(reply?.parent_reply_member?.name || '');
      let score = 0;

      if (hostUser && replyUser && hostUser === replyUser) score += 8;
      if (hostText && replyText && hostText === replyText) score += 20;
      if (strippedHost && replyText && strippedHost === replyText) score += 18;
      if (hostText && replyText && hostText.includes(replyText)) score += 5;
      if (strippedHost && replyText && strippedHost.includes(replyText)) score += 5;
      if (parentName && hostText.includes(parentName)) score += 4;
      if (hints.parent && toId(reply?.parent) === toId(hints.parent)) score += 3;
      if (hints.root && toId(reply?.root) === toId(hints.root)) score += 2;

      if (score > bestScore) {
        best = reply;
        bestScore = score;
      }
    }

    if (best && bestScore >= (hints.root ? 14 : 18)) {
      return best;
    }

    log('模糊匹配未命中:', { bestScore, hostUser, hostText, hints });
    return null;
  }

  function buildReplyHostSignature(host) {
    if (!host) return '';

    const hints = extractReplyHintsFromHost(host);
    const user = normalizeText(extractUserNameFromReplyHost(host));
    const text = normalizeText(extractVisibleTextFromReplyHost(host));

    return [
      hints.rpid || 0,
      hints.root || 0,
      hints.parent || 0,
      user,
      text
    ].join('|');
  }

  function refreshReplyHostState(host) {
    if (!host) return;

    const nextSignature = buildReplyHostSignature(host);
    if (!nextSignature) return;

    if (host.__tmReplyHostSignature && host.__tmReplyHostSignature !== nextSignature) {
      host.__tmMatchedReply = null;
      host.__tmContextTrace = null;
      log('回复宿主已刷新，清理旧状态:', nextSignature);
    }

    host.__tmReplyHostSignature = nextSignature;
  }

  function resolveCurrentReplyForHost(host) {
    refreshReplyHostState(host);

    const trace = {
      matched: false,
      matchSource: '',
      directSource: '',
      hints: null
    };

    if (host.__tmMatchedReply) {
      const cached = getCachedReplyByRpid(host.__tmMatchedReply.rpid, host.__tmMatchedReply.root);
      if (cached) {
        host.__tmMatchedReply = mergeReply(host.__tmMatchedReply, cached);
      }
      host.__tmContextTrace = {
        ...(host.__tmContextTrace || {}),
        reusedMatchedReply: true
      };
      return host.__tmMatchedReply;
    }

    const directReply = extractReplyFromHostData(host, trace);
    if (directReply) {
      return setMatchedReply(host, directReply, 'direct-data', trace);
    }

    const hints = extractReplyHintsFromHost(host);
    trace.hints = trace.hints || { ...hints };
    if (hints.rpid) {
      const cached = getCachedReplyByRpid(hints.rpid, hints.root);
      if (cached) return setMatchedReply(host, cached, 'id-hints', trace);
    }

    const fuzzyReply = findCurrentReplyByHost(host, hints);
    if (fuzzyReply) {
      return setMatchedReply(host, fuzzyReply, 'fuzzy', trace);
    }

    host.__tmContextTrace = {
      ...(host.__tmContextTrace || {}),
      ...trace,
      matched: false,
      failureStage: 'resolve-current-reply'
    };
    return null;
  }

  function collectReplyRendererHosts(root, result = []) {
    const visited = new Set();

    function traverse(node) {
      if (!node) return;
      if (visited.has(node)) return;
      visited.add(node);

      if (isReplyHostTag(node?.tagName)) {
        result.push(node);
      }

      if (node?.tagName === 'SLOT' && typeof node.assignedElements === 'function') {
        for (const child of node.assignedElements({ flatten: true })) {
          traverse(child);
        }
      }

      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }

      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
    }

    traverse(root);
    return result;
  }

  function findReplyRendererHosts(root = document) {
    return collectReplyRendererHosts(root, []);
  }

  function findCommentsScanRoot() {
    const commentsHost = document.querySelector('bili-comments');
    if (commentsHost?.shadowRoot) {
      return commentsHost.shadowRoot;
    }

    return document.getElementById('commentapp') || document;
  }

  function findInsertTargetInReplyHost(host) {
    const root = host?.shadowRoot;
    if (!root) return null;
    return root.querySelector('#footer') || root.querySelector('#body') || root.querySelector('#main');
  }

  function isReplyHostTag(tagName = '') {
    const tag = String(tagName || '').toUpperCase();
    if (!tag) return false;
    if (tag === 'BILI-COMMENT-REPLY-RENDERER') return true;
    if (tag === 'BILI-COMMENT-REPLY-ITEM-RENDERER') return true;
    if (tag === 'BILI-COMMENT-REPLIES-RENDERER') return false;
    return /^BILI-COMMENT-REP/.test(tag);
  }

  function isThreadScopeTag(tagName = '') {
    const tag = String(tagName || '').toUpperCase();
    if (!tag) return false;
    if (tag === 'BILI-COMMENT-REPLIES-RENDERER') return true;
    return /^BILI-COMMENT-THR/.test(tag);
  }

  function getReplyHostFromEvent(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (isReplyHostTag(node?.tagName)) {
        return node;
      }
    }

    let current = event?.target || null;
    while (current) {
      if (isReplyHostTag(current?.tagName)) {
        return current;
      }
      current = getComposedParent(current);
    }

    return null;
  }

  function getComposedParent(node) {
    if (!node) return null;
    if (node.parentNode) return node.parentNode;
    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root?.host || null;
  }

  function findNearestThreadScope(host) {
    let current = host;
    const visited = new Set();

    while (current && !visited.has(current)) {
      visited.add(current);

      if (isThreadScopeTag(current?.tagName)) {
        return current;
      }

      if (current?.id === 'replies' || current?.id === 'expander') {
        return current;
      }

      current = getComposedParent(current);
    }

    return null;
  }

  function findRootReplyFromThreadHost(host, rootId) {
    const targetRootId = toId(rootId);
    if (!host || !targetRootId) return null;

    let current = host;
    const visited = new Set();

    while (current && !visited.has(current)) {
      visited.add(current);

      const directReply = extractReplyFromObjectGraph(current);
      if (toId(directReply?.rpid) === targetRootId) {
        return cacheReplyRecord(directReply, {
          asRootReply: true,
          fallback: { rpid: targetRootId, root: targetRootId, parent: targetRootId }
        });
      }

      if (current.shadowRoot) {
        const candidates = current.shadowRoot.querySelectorAll('*');
        for (const node of candidates) {
          const reply = extractReplyFromObjectGraph(node);
          if (toId(reply?.rpid) === targetRootId) {
            return cacheReplyRecord(reply, {
              asRootReply: true,
              fallback: { rpid: targetRootId, root: targetRootId, parent: targetRootId }
            });
          }
        }
      }

      current = getComposedParent(current);
    }

    return null;
  }

  function findReplyByRpidInScope(scope, targetRpid, rootId = 0) {
    const targetId = toId(targetRpid);
    const normalizedRoot = toId(rootId);
    if (!scope || !targetId) return null;

    const scanRoot = scope.shadowRoot || scope;
    const hosts = findReplyRendererHosts(scanRoot);

    for (const host of hosts) {
      const directReply = extractReplyFromHostData(host);
      if (directReply) {
        const cached = cacheReplyRecord(directReply, {
          fallback: normalizedRoot ? { root: normalizedRoot } : {}
        });
        if (toId(cached?.rpid) === targetId) {
          return cached;
        }
      }

      const hints = extractReplyHintsFromHost(host);
      if (toId(hints.rpid) === targetId) {
        const cached = getCachedReplyByRpid(targetId, normalizedRoot || hints.root);
        if (cached) return cached;
      }
    }

    return null;
  }

  function findReplyByRpidFromThreadHost(host, targetRpid, rootId = 0) {
    const targetId = toId(targetRpid);
    const normalizedRoot = toId(rootId);
    if (!host || !targetId) return null;

    const scope = findNearestThreadScope(host);
    if (scope) {
      const scoped = findReplyByRpidInScope(scope, targetId, normalizedRoot);
      if (scoped) return scoped;
    }

    let current = host;
    const visited = new Set();

    while (current && !visited.has(current)) {
      visited.add(current);

      const directReply = extractReplyFromObjectGraph(current);
      if (toId(directReply?.rpid) === targetId) {
        return cacheReplyRecord(directReply, {
          fallback: normalizedRoot ? { root: normalizedRoot } : {}
        });
      }

      if (current.shadowRoot) {
        const candidates = current.shadowRoot.querySelectorAll('*');
        for (const node of candidates) {
          const reply = extractReplyFromObjectGraph(node);
          if (toId(reply?.rpid) === targetId) {
            return cacheReplyRecord(reply, {
              fallback: normalizedRoot ? { root: normalizedRoot } : {}
            });
          }
        }
      }

      current = getComposedParent(current);
    }

    return null;
  }

  function findReplyByRpidFromVisibleHosts(targetRpid, rootId = 0) {
    const targetId = toId(targetRpid);
    const normalizedRoot = toId(rootId);
    if (!targetId) return null;

    return findReplyByRpidInScope(findCommentsScanRoot(), targetId, normalizedRoot);
  }

  function cacheReplyFromHost(host, fallback = {}) {
    const reply = extractReplyFromHostData(host);
    if (!reply) return null;
    return cacheReplyRecord(reply, { fallback });
  }

  function warmupReplyCacheInScope(scope, fallback = {}) {
    if (!scope) return 0;
    const scanRoot = scope.shadowRoot || scope;
    const hosts = findReplyRendererHosts(scanRoot);
    let warmed = 0;

    for (const replyHost of hosts) {
      if (cacheReplyFromHost(replyHost, fallback)) {
        warmed += 1;
      }
    }

    return warmed;
  }

  function warmupThreadReplyCache(host) {
    return warmupReplyCacheInScope(findNearestThreadScope(host));
  }

  function primeReplyCachesForHost(host) {
    if (!host) return 0;
    return warmupThreadReplyCache(host) + warmupVisibleReplyCache(findCommentsScanRoot());
  }

  GM_addStyle(`
    #${MODAL_ID} {
      position: fixed;
      width: min(360px, calc(100vw - 20px));
      max-height: min(62vh, 520px);
      overflow: auto;
      background: #fff;
      border: 1px solid #e7eaf0;
      border-radius: 12px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
      z-index: 999999;
      padding: 12px;
      color: #18191c;
      font-size: 13px;
      line-height: 1.6;
    }

    #${MODAL_ID} .tm-close {
      position: absolute;
      top: 8px;
      right: 8px;
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      cursor: pointer;
      color: #666;
      font-size: 18px;
      line-height: 1;
      border-radius: 6px;
      user-select: none;
      background: rgba(255, 255, 255, 0.92);
    }

    #${MODAL_ID} .tm-close:hover {
      background: #f4f5f7;
    }

    #${MODAL_ID} .tm-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    #${MODAL_ID} .tm-note {
      padding: 8px 10px;
      border-radius: 8px;
      background: #f6f7f9;
      color: #61666d;
    }

    #${MODAL_ID} .tm-debug {
      padding: 8px 10px;
      border-radius: 8px;
      background: #fff7e6;
      color: #8b5e00;
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }

    #${MODAL_ID} .tm-block {
      border: 1px solid #e3e5e7;
      border-radius: 10px;
      padding: 10px 12px;
      background: #fafafa;
    }

    #${MODAL_ID} .tm-block.role-root {
      border-color: #dfc27a;
      background: #fff3d6;
    }

    #${MODAL_ID} .tm-block.role-parent {
      border-color: #b8c2cf;
      background: #eef2f7;
    }

    #${MODAL_ID} .tm-block.role-current,
    #${MODAL_ID} .tm-block.current {
      border-color: #75bdd8;
      background: #dff4fb;
    }

    #${MODAL_ID} .tm-user {
      font-weight: 600;
      color: #18191c;
      margin-right: 6px;
    }

    #${MODAL_ID} .tm-user.with-sep {
      margin-right: 0;
    }

    #${MODAL_ID} .tm-user-sep {
      font-weight: 700;
      color: #18191c;
      margin-left: 4px;
    }

    #${MODAL_ID} .tm-message {
      word-break: break-word;
    }

    #${MODAL_ID} .tm-message.clamped {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
    }

    #${MODAL_ID} .tm-expand {
      margin-top: 6px;
      padding: 0;
      border: 0;
      background: transparent;
      color: #00a1d6;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }

    #${MODAL_ID} .tm-expand:hover {
      color: #008ac5;
    }

    #${MODAL_ID} .tm-reply-target {
      font-weight: 700;
      color: #18191c;
    }

    #${MODAL_ID} .tm-emote {
      display: inline-block;
      width: 20px;
      height: 20px;
      margin: 0 1px;
      vertical-align: -4px;
      object-fit: contain;
    }

    #${MODAL_ID} .tm-meta {
      font-size: 12px;
      color: #9499a0;
      margin-top: 6px;
      word-break: break-all;
    }

    #${MODAL_ID} .tm-tree {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    #${MODAL_ID} .tm-node {
      position: relative;
    }

    #${MODAL_ID} .tm-node.depth-1 { margin-left: 22px; }
    #${MODAL_ID} .tm-node.depth-2 { margin-left: 44px; }
    #${MODAL_ID} .tm-node.depth-3 { margin-left: 66px; }
    #${MODAL_ID} .tm-node.depth-4 { margin-left: 88px; }
    #${MODAL_ID} .tm-node.depth-5 { margin-left: 110px; }
    #${MODAL_ID} .tm-node.depth-6 { margin-left: 132px; }
    #${MODAL_ID} .tm-node.depth-7 { margin-left: 154px; }
    #${MODAL_ID} .tm-node.depth-8 { margin-left: 176px; }

    #${MODAL_ID} .tm-node.depth-1::before,
    #${MODAL_ID} .tm-node.depth-2::before,
    #${MODAL_ID} .tm-node.depth-3::before,
    #${MODAL_ID} .tm-node.depth-4::before,
    #${MODAL_ID} .tm-node.depth-5::before,
    #${MODAL_ID} .tm-node.depth-6::before,
    #${MODAL_ID} .tm-node.depth-7::before,
    #${MODAL_ID} .tm-node.depth-8::before {
      content: '';
      position: absolute;
      left: -14px;
      top: -10px;
      bottom: 50%;
      width: 1px;
      background: #d8dee9;
    }

    #${MODAL_ID} .tm-node.depth-1::after,
    #${MODAL_ID} .tm-node.depth-2::after,
    #${MODAL_ID} .tm-node.depth-3::after,
    #${MODAL_ID} .tm-node.depth-4::after,
    #${MODAL_ID} .tm-node.depth-5::after,
    #${MODAL_ID} .tm-node.depth-6::after,
    #${MODAL_ID} .tm-node.depth-7::after,
    #${MODAL_ID} .tm-node.depth-8::after {
      content: '';
      position: absolute;
      left: -14px;
      top: 50%;
      width: 10px;
      height: 1px;
      background: #d8dee9;
    }

    #${MODAL_ID} .tm-block.role-ancestor {
      border-color: #c0c8d4;
      background: #f0f3f8;
    }

    #${MODAL_ID} .tm-block.role-descendant {
      border-color: #c8d8c0;
      background: #f0f8f0;
    }

    #${MODAL_ID} .tm-loading {
      color: #666;
      padding: 8px 0;
    }

    #${MODAL_ID} .tm-error {
      color: #d03050;
      padding: 8px 0;
    }

  `);

  function removeModal() {
    if (hoverOpenTimer) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = 0;
    }
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = 0;
    }
    if (popoverFollowRaf) {
      cancelAnimationFrame(popoverFollowRaf);
      popoverFollowRaf = 0;
    }
    activeAnchor = null;
    activeHost = null;
    document.getElementById(MODAL_ID)?.remove();
  }

  function clearHoverOpenTimer() {
    if (!hoverOpenTimer) return;
    clearTimeout(hoverOpenTimer);
    hoverOpenTimer = 0;
  }

  function clearHoverCloseTimer() {
    if (!hoverCloseTimer) return;
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = 0;
  }

  function getAnchorElement(anchor) {
    if (!anchor) return null;
    if (anchor.host?.isConnected) {
      return findInsertTargetInReplyHost(anchor.host) || anchor.host;
    }
    return anchor?.isConnected ? anchor : null;
  }

  function positionPopover(modal, anchor) {
    if (!modal) return;

    const margin = 12;
    const gap = 12;
    const anchorElement = getAnchorElement(anchor);
    const anchorRect = anchorElement?.getBoundingClientRect?.() || {
      top: window.innerHeight / 2,
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      bottom: window.innerHeight / 2
    };

    const width = modal.offsetWidth || 360;
    const height = modal.offsetHeight || 200;

    const spaceRight = window.innerWidth - anchorRect.right - margin;
    const spaceLeft = anchorRect.left - margin;
    const spaceBelow = window.innerHeight - anchorRect.bottom - margin;
    const spaceAbove = anchorRect.top - margin;

    const preferredLeft = anchorRect.left + Math.max(0, anchorRect.width - width);
    let left = preferredLeft;
    let top = anchorRect.top - height - gap;

    if (spaceAbove >= height) {
      left = preferredLeft;
      top = anchorRect.top - height - gap;
    } else if (spaceBelow >= height || spaceBelow >= spaceLeft || spaceBelow >= spaceRight) {
      left = preferredLeft;
      top = anchorRect.bottom + gap;
    } else if (spaceRight >= width) {
      left = anchorRect.right + gap;
      top = anchorRect.top - 4;
    } else {
      left = anchorRect.left - width - gap;
      top = anchorRect.top - 4;
    }

    if (left + width > window.innerWidth - margin) {
      left = window.innerWidth - width - margin;
    }
    if (left < margin) left = margin;

    if (top + height > window.innerHeight - margin) {
      top = window.innerHeight - height - margin;
    }
    if (top < margin) top = margin;

    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
    modal.style.visibility = 'visible';
  }

  function startPopoverFollow() {
    if (popoverFollowRaf) {
      cancelAnimationFrame(popoverFollowRaf);
      popoverFollowRaf = 0;
    }

    const tick = () => {
      const modal = document.getElementById(MODAL_ID);
      const anchorElement = getAnchorElement(activeAnchor);
      if (!modal || !anchorElement) {
        popoverFollowRaf = 0;
        return;
      }

      positionPopover(modal, activeAnchor);
      popoverFollowRaf = requestAnimationFrame(tick);
    };

    popoverFollowRaf = requestAnimationFrame(tick);
  }

  function schedulePopoverClose(delay = HOVER_CLOSE_DELAY) {
    clearHoverCloseTimer();
    hoverCloseTimer = window.setTimeout(() => {
      hoverCloseTimer = 0;
      const modal = document.getElementById(MODAL_ID);
      const hostHovered = activeHost?.matches?.(':hover');
      const modalHovered = modal?.matches?.(':hover');
      if (hostHovered || modalHovered) return;
      removeModal();
    }, delay);
  }

  function attachModalHoverHandlers(modal) {
    if (!modal || modal.dataset.tmHoverBound === '1') return;

    modal.addEventListener('mouseenter', () => {
      clearHoverCloseTimer();
    });

    modal.addEventListener('mouseleave', () => {
      schedulePopoverClose();
    });

    modal.dataset.tmHoverBound = '1';
  }

  function showModalSkeleton(anchor) {
    document.getElementById(MODAL_ID)?.remove();
    clearHoverCloseTimer();
    activeAnchor = anchor || null;

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="tm-close">×</div>
      <div class="tm-content">
        <div class="tm-loading">正在加载上下文…</div>
      </div>
    `;
    modal.querySelector('.tm-close')?.addEventListener('click', removeModal);
    attachModalHoverHandlers(modal);

    document.body.appendChild(modal);
    positionPopover(modal, activeAnchor);
    startPopoverFollow();
  }

  function updateModal(html) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    modal.innerHTML = `
      <div class="tm-close">×</div>
      <div class="tm-content">
        ${html}
      </div>
    `;
    modal.querySelector('.tm-close')?.addEventListener('click', removeModal);
    modal.querySelectorAll('[data-expand-root="1"]').forEach(btn => {
      btn.addEventListener('click', event => {
        const button = event.currentTarget;
        const message = button?.previousElementSibling;
        if (!message) return;
        message.classList.remove('clamped');
        button.remove();
        positionPopover(modal, activeAnchor);
      });
    });
    attachModalHoverHandlers(modal);
    positionPopover(modal, activeAnchor);
  }

  function formatTraceDetails(trace) {
    if (!trace) return '';

    const parts = [];
    if (trace.matchSource) parts.push(`命中来源: ${toDebugLabel(trace.matchSource)}`);
    if (trace.directSource) parts.push(`直接读取: ${toDebugLabel(trace.directSource)}`);
    if (trace.usedPaging) parts.push('跨页查询: 已执行');
    if (trace.parentLookup) parts.push(`父回复查找: ${toDebugLabel(trace.parentLookup)}`);
    if (trace.degradedReason) parts.push(`降级原因: ${trace.degradedReason}`);
    if (trace.failureStage) parts.push(`失败阶段: ${toDebugLabel(trace.failureStage)}`);
    if (trace.rootFetched) parts.push('主评论获取: 已请求');
    if (trace.reusedMatchedReply) parts.push('当前回复: 复用已匹配结果');
    if (trace.hints) {
      const hintParts = ['rpid', 'root', 'parent']
        .filter(key => trace.hints[key])
        .map(key => `${key}=${trace.hints[key]}`);
      if (hintParts.length) parts.push(`DOM线索: ${hintParts.join(', ')}`);
    }

    return parts.join(' ｜ ');
  }

  function buildDebugBlock(trace) {
    const detail = formatTraceDetails(trace);
    if (!detail) return '';
    return `<div class="tm-debug">${escapeHtml(detail)}</div>`;
  }

  function toDebugLabel(value = '') {
    const map = {
      'direct-data': '直接数据',
      'id-hints': 'ID 线索',
      'fuzzy': '模糊匹配',
      'host-or-shadow-root': '宿主或 ShadowRoot',
      'shadow-descendant': 'Shadow 子节点',
      'dom-id-hints': 'DOM ID 线索',
      'paging': '跨页查询',
      'visible-dom': '当前可见区',
      'thread-dom': '当前线程',
      'cache': '缓存',
      'direct-root': '直接主评论',
      'resolve-current-reply': '定位当前回复',
      'open-context': '打开上下文'
    };

    return map[String(value)] || String(value || '');
  }

  function isEmptyReplyResponse(json) {
    const message = String(json?.message || json?.msg || '').trim();
    return /啥都木有|什么都没有|nothing/i.test(message);
  }

  function extractEmoteUrl(emote) {
    if (!emote) return '';
    if (typeof emote === 'string') return emote;

    return String(
      emote.url ||
      emote.webp_url ||
      emote.webp ||
      emote.gif_url ||
      emote.static_url ||
      emote.icon_url ||
      emote.meta?.url ||
      ''
    ).trim();
  }

  function getReplyEmoteMap(reply) {
    const map = new Map();
    const content = reply?.content || {};
    const sources = [
      content.emote,
      content.emote_detail,
      content.emoteDetail,
      reply?.emote,
      reply?.emote_detail
    ].filter(Boolean);

    for (const source of sources) {
      if (Array.isArray(source)) {
        for (const item of source) {
          const key = String(
            item?.text ||
            item?.emoji ||
            item?.emote ||
            item?.name ||
            ''
          ).trim();
          const url = extractEmoteUrl(item);
          if (key && url) map.set(key, url);
        }
        continue;
      }

      if (typeof source !== 'object') continue;

      for (const [key, value] of Object.entries(source)) {
        const normalizedKey = String(key || value?.text || '').trim();
        const url = extractEmoteUrl(value);
        if (normalizedKey && url) {
          map.set(normalizedKey, url);
        }
      }
    }

    return map;
  }

  function buildMessageHtml(reply) {
    const rawMessage = normalizeText(reply?.content?.message || '[无文本]');
    const emoteMap = getReplyEmoteMap(reply);

    if (!emoteMap.size) {
      return escapeHtml(rawMessage);
    }

    return rawMessage.replace(/\[[^[\]\r\n]{1,40}\]/g, token => {
      const url = emoteMap.get(token);
      if (!url) return escapeHtml(token);
      return `<img class="tm-emote" src="${escapeHtml(url)}" alt="${escapeHtml(token)}" title="${escapeHtml(token)}" referrerpolicy="no-referrer">`;
    });
  }

  function emphasizeReplyTargetHtml(rawMessage, messageHtml) {
    const prefixMatch = normalizeText(rawMessage).match(/^(回复\s*)(@?[^:：]+[:：]\s*)/);
    if (!prefixMatch) return messageHtml;

    const escapedReplyWord = escapeHtml(prefixMatch[1]);
    const escapedReplyTarget = escapeHtml(prefixMatch[2]);
    const highlightedPrefix = `${escapedReplyWord}<span class="tm-reply-target">${escapedReplyTarget}</span>`;
    const plainPrefix = `${escapedReplyWord}${escapedReplyTarget}`;

    if (messageHtml.startsWith(plainPrefix)) {
      return highlightedPrefix + messageHtml.slice(plainPrefix.length);
    }

    return messageHtml.replace(plainPrefix, highlightedPrefix);
  }

  function buildBlock(label, reply, extraMeta = '', isCurrent = false, depth = 0) {
    if (!reply) return '';

    const user = escapeHtml(
      reply?.member?.uname ||
      reply?.parent_reply_member?.name ||
      '未知用户'
    );
    const message = emphasizeReplyTargetHtml(
      normalizeText(reply?.content?.message || ''),
      buildMessageHtml(reply)
    );
    const userClass = isCurrent ? 'tm-user' : 'tm-user with-sep';
    const userSuffix = isCurrent ? '' : '<span class="tm-user-sep">:</span>';
    const meta = DEBUG ? [extraMeta, reply?.rpid ? `rpid: ${reply.rpid}` : ''].filter(Boolean).join(' ｜ ') : '';
    const roleClass = (() => {
      switch (label) {
        case '主评论': return 'role-root';
        case '上文': return 'role-ancestor';
        case '当前回复': return 'role-current';
        case '下文': return 'role-descendant';
        default: return 'role-current';
      }
    })();
    // 主评论和上文评论默认折叠，当前回复和下文评论默认展开
    const clampClass = (label === '主评论' || label === '上文') ? ' clamped' : '';
    const expandButton = (label === '主评论' || label === '上文')
      ? '<button type="button" class="tm-expand" data-expand-root="1">展开</button>'
      : '';

    return `
      <div class="tm-node depth-${Math.min(depth, 8)}">
        <div class="tm-block ${roleClass} ${isCurrent ? 'current' : ''}">
          <div class="tm-message${clampClass}"><span class="${userClass}">${user}</span>${userSuffix}${message}</div>
          ${expandButton}
          ${meta ? `<div class="tm-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
      </div>
    `;
  }

  async function fetchReplyPage({ oid, root, pn, ps = 10 }) {
    rememberOid(oid);

    const url = new URL('https://api.bilibili.com/x/v2/reply/reply');
    url.searchParams.set('oid', oid);
    url.searchParams.set('type', '1');
    url.searchParams.set('root', String(root));
    url.searchParams.set('ps', String(ps));
    url.searchParams.set('pn', String(pn));

    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });

    if (!res.ok) throw new Error(`接口请求失败：HTTP ${res.status}`);

    const json = await res.json();
    if (json?.code !== 0) {
      if (isEmptyReplyResponse(json)) {
        return {
          root: null,
          replies: [],
          page: {
            num: pn,
            size: ps,
            count: 0
          }
        };
      }
      throw new Error(`接口返回异常：${json?.message || json?.code}`);
    }

    return json.data || {};
  }

  async function ensureRootReplyLoaded({ oid, root }) {
    const cached = getCachedRootReply(root);
    if (cached) return cached;

    const data = await fetchReplyPage({ oid, root, pn: 1, ps: 10 });
    cacheReplyData(data, { root });
    return getCachedRootReply(root);
  }

  function warmupVisibleReplyCache(root = null) {
    return warmupReplyCacheInScope(root || findCommentsScanRoot());
  }

  async function warmupCurrentRootFirstPage({ oid, host }) {
    const hints = extractReplyHintsFromHost(host);
    const root = toId(hints.root);
    if (!oid || !root) return false;

    const data = await fetchReplyPage({ oid, root, pn: 1, ps: 20 });
    cacheReplyData(data, { root });

    host.__tmMatchedReply = null;
    host.__tmContextTrace = {
      ...(host.__tmContextTrace || {}),
      warmedRootFirstPage: true,
      warmupRoot: root
    };
    return true;
  }

  async function fetchParentReplyByPaging({ oid, root, parentRpid, maxPages = 200, trace = null }) {
    let rootReply = getCachedRootReply(root);
    let parentReply = getCachedReplyByRpid(parentRpid, root);
    let totalPages = 1;

    if (trace) {
      trace.usedPaging = true;
      trace.parentLookup = 'paging';
    }

    for (let pn = 1; pn <= maxPages; pn++) {
      const data = await fetchReplyPage({ oid, root, pn, ps: 10 });
      cacheReplyData(data, { root });

      rootReply = rootReply || data.root || getCachedRootReply(root);
      parentReply = parentReply || getCachedReplyByRpid(parentRpid, root);

      const replies = Array.isArray(data.replies) ? data.replies : [];
      const pageSize = Math.max(1, Math.trunc(toSafeNumber(data?.page?.size) || 10));
      const count = Math.max(replies.length, Math.trunc(toSafeNumber(data?.page?.count)));
      totalPages = Math.max(1, Math.ceil(count / pageSize));

      if (parentReply || pn >= totalPages) break;
      await sleep(120);
    }

    return {
      rootReply: rootReply || getCachedRootReply(root),
      parentReply: parentReply || getCachedReplyByRpid(parentRpid, root) || null
    };
  }

  // === 完整对话树：获取根评论下的所有回复 ===
  async function fetchAllRepliesForRoot({ oid, root, maxPages = 50 }) {
    rememberOid(oid);
    const rootId = toId(root);
    if (!oid || !rootId) return [];

    let totalPages = 1;

    for (let pn = 1; pn <= Math.min(maxPages, 200); pn++) {
      const data = await fetchReplyPage({ oid, root: rootId, pn, ps: 20 });
      cacheReplyData(data, { root: rootId });

      const replies = Array.isArray(data.replies) ? data.replies : [];
      const count = Math.trunc(toSafeNumber(data?.page?.count));
      const pageSize = Math.max(1, Math.trunc(toSafeNumber(data?.page?.size) || 20));
      totalPages = Math.max(1, Math.ceil(count / pageSize));

      if (pn >= totalPages) break;
      if (pn < totalPages) await sleep(100);
    }

    const entry = replyCacheByRoot.get(rootId);
    return entry?.replies || [];
  }

  // === 构建 parent_rpid → [child_replies] 映射表 ===
  function buildReplyChildrenMap(rootId) {
    const map = new Map();
    const entry = replyCacheByRoot.get(toId(rootId));
    const replies = entry?.replies || [];

    for (const reply of replies) {
      const parent = toId(reply.parent);
      if (!parent) continue;
      if (!map.has(parent)) map.set(parent, []);
      const siblings = map.get(parent);
      if (!siblings.some(r => toId(r.rpid) === toId(reply.rpid))) {
        siblings.push(reply);
      }
    }

    return map;
  }

  // === 从当前回复向上追溯到根评论，返回祖先链（不包含根评论和当前回复） ===
  function buildAncestorChain(reply, rootId) {
    const chain = [];
    const root = toId(rootId);
    let parentId = toId(reply.parent);
    const visited = new Set();

    while (parentId && parentId !== root && !visited.has(parentId)) {
      visited.add(parentId);
      const parentReply = replyByRpid.get(parentId);
      if (parentReply) {
        chain.unshift(parentReply);
        parentId = toId(parentReply.parent);
      } else {
        break; // 缓存中找不到，中断追溯
      }
    }

    return chain;
  }

  // === 递归构建后代回复树 ===
  function buildDescendantTree(rpid, childrenMap, visited) {
    const result = [];
    const id = toId(rpid);
    if (!id) return result;

    const visitSet = visited || new Set();
    if (visitSet.has(id)) return result;
    visitSet.add(id);

    const children = childrenMap.get(id) || [];
    for (const child of children) {
      if (visitSet.has(toId(child.rpid))) continue;
      result.push({
        reply: child,
        children: buildDescendantTree(child.rpid, childrenMap, visitSet)
      });
    }

    return result;
  }

  // === 将后代树展平为带深度的列表，便于渲染 ===
  function flattenDescendantTree(tree, depth) {
    const result = [];
    const startDepth = depth || 0;
    for (const node of tree) {
      result.push({ reply: node.reply, depth: startDepth });
      if (node.children && node.children.length > 0) {
        const flatChildren = flattenDescendantTree(node.children, startDepth + 1);
        result.push(...flatChildren);
      }
    }
    return result;
  }

  function resolveParentReplyLocally(parent, root, host = null) {
    if (!parent || !root || parent === root) return null;

    return (
      getCachedReplyByRpid(parent, root) ||
      findReplyByRpidFromVisibleHosts(parent, root) ||
      (host ? findReplyByRpidFromThreadHost(host, parent, root) : null) ||
      null
    );
  }

  function resolveRootReplyLocally(root, host = null) {
    if (!root) return null;

    return (
      getCachedRootReply(root) ||
      findReplyByRpidFromVisibleHosts(root, root) ||
      (host ? findReplyByRpidFromThreadHost(host, root, root) : null) ||
      (host ? findRootReplyFromThreadHost(host, root) : null) ||
      null
    );
  }

  async function resolveFullContext({ oid, currentReply, host = null }) {
    const root = toId(currentReply?.root);
    const trace = {
      usedPaging: false,
      degradedReason: '',
      rootFetched: false,
      fullChainBuilt: false
    };

    // 1. 先从缓存和本地DOM尝试获取根评论
    let rootReply = getCachedRootReply(root);

    if (host) {
      primeReplyCachesForHost(host);
      if (!rootReply) {
        rootReply = resolveRootReplyLocally(root, host);
        if (rootReply) trace.rootFetched = true;
      }
    }

    // 2. 拉取该根评论下的所有回复，构建完整对话树
    if (oid && root) {
      await fetchAllRepliesForRoot({ oid, root, maxPages: 50 });
      trace.usedPaging = true;
    }

    // 3. 再次确认根评论
    if (!rootReply) {
      rootReply = getCachedRootReply(root);
    }
    if (!rootReply) {
      rootReply = await ensureRootReplyLoaded({ oid, root });
      trace.rootFetched = true;
    }

    // 4. 构建子回复映射表和完整对话链
    const childrenMap = buildReplyChildrenMap(root);
    const ancestors = currentReply ? buildAncestorChain(currentReply, root) : [];
    const descendantTree = currentReply ? buildDescendantTree(currentReply.rpid, childrenMap) : [];

    trace.fullChainBuilt = true;

    if (!rootReply) {
      trace.degradedReason = '主评论未获取到';
    }

    return {
      rootReply,
      ancestors,       // 从根评论到当前回复之间的所有祖先回复（不含根和当前）
      currentReply,
      descendantTree,  // 当前回复的所有后代回复树
      trace
    };
  }

  function renderContext(context) {
    const pieces = [];
    const nodes = [];
    const currentReply = context?.currentReply || null;
    const isDirectReply = currentReply ? toId(currentReply.parent) === toId(currentReply.root) : false;
    const ancestorCount = context?.ancestors?.length || 0;

    // 无任何数据时显示提示
    if (!context?.rootReply && ancestorCount === 0 && !currentReply) {
      pieces.push('<div class="tm-note">暂无上下文数据。</div>');
    }

    // 1. 根评论（对话的起点）
    if (context?.rootReply) {
      nodes.push(buildBlock('主评论', context.rootReply, 'root', false, 0));
    } else if (ancestorCount === 0 && currentReply) {
      pieces.push('<div class="tm-note">主评论暂时没拿到，先展示已确认的回复内容。</div>');
    }

    // 2. 上文祖先链（从根评论下一层到当前回复的父评论）
    if (ancestorCount > 0) {
      for (let i = 0; i < ancestorCount; i++) {
        const depth = i + 1;
        nodes.push(buildBlock('上文', context.ancestors[i], 'ancestor', false, depth));
      }
    }

    // 3. 当前回复（高亮显示）
    if (currentReply) {
      const currentDepth = ancestorCount + 1;
      nodes.push(buildBlock(
        '当前回复',
        currentReply,
        isDirectReply ? '直接回复主评论' : (ancestorCount > 0 ? '回复上文' : '回复某条子回复'),
        true,
        currentDepth
      ));
    }

    // 4. 下文后代树（当前回复的所有后代）
    if (context?.descendantTree?.length > 0) {
      const currentDepth = ancestorCount + 1;
      const flatDescendants = flattenDescendantTree(context.descendantTree, currentDepth + 1);
      for (const { reply, depth } of flatDescendants) {
        nodes.push(buildBlock('下文', reply, '', false, Math.min(depth, 8)));
      }
    }

    if (!nodes.length) {
      pieces.push('<div class="tm-error">没有可展示的上下文。</div>');
    } else {
      pieces.push(`<div class="tm-tree">${nodes.join('')}</div>`);
    }

    if (DEBUG) {
      pieces.unshift(buildDebugBlock(context?.trace));
    }

    updateModal(pieces.join(''));
  }

  // Hover lifecycle
  async function openContextForHost(host, anchor) {
    let skeletonShown = false;
    try {
      let oid = '';
      primeReplyCachesForHost(host);
      let currentReply = resolveCurrentReplyForHost(host);

      // 直接回复根评论也要显示上下文（主评论 + 可能的子回复）
      // 只有完全无法定位到回复时才跳过

      showModalSkeleton(anchor);
      skeletonShown = true;

      if (!currentReply) {
        primeReplyCachesForHost(host);
        currentReply = resolveCurrentReplyForHost(host);
      }

      if (!currentReply) {
        oid = await resolveCurrentOid();
        if (!oid) {
          throw new Error('未能识别当前视频 oid/aid。');
        }

        await warmupCurrentRootFirstPage({ oid, host });
        currentReply = resolveCurrentReplyForHost(host);
        if (!currentReply) {
          removeModal();
          return;
        }
      }

      // 不再跳过直接回复根评论 —— 同样展示完整上下文
      oid = oid || await resolveCurrentOid();
      if (!oid) {
        throw new Error('未能识别当前视频 oid/aid。');
      }

      const context = await resolveFullContext({ oid, currentReply, host });
      context.trace = {
        ...(host.__tmContextTrace || {}),
        ...(context.trace || {})
      };
      renderContext(context);
    } catch (err) {
      if (!skeletonShown) {
        showModalSkeleton(anchor);
      }
      console.error('[BiliContext] openContextForHost error', err);
      const trace = host?.__tmContextTrace || null;
      const debugBlock = DEBUG ? buildDebugBlock({
        ...(trace || {}),
        failureStage: trace?.failureStage || 'open-context',
        degradedReason: err?.message || '加载失败'
      }) : '';
      updateModal(`${debugBlock}<div class="tm-error">${escapeHtml(err?.message || '加载失败')}</div>`);
    }
  }

  function scheduleHoverOpen(host) {
    activeHost = host;
    clearHoverCloseTimer();
    clearHoverOpenTimer();

    hoverOpenTimer = window.setTimeout(() => {
      hoverOpenTimer = 0;
      if (activeHost !== host) return;
      openContextForHost(host, { host });
    }, HOVER_OPEN_DELAY);
  }

  function bindHoverIntoReplyHost(host) {
    if (!host) return;

    refreshReplyHostState(host);
    if (host.dataset.tmContextEnhanced === '1') return;

    host.addEventListener('mouseenter', () => {
      refreshReplyHostState(host);
      scheduleHoverOpen(host);
    });

    host.addEventListener('mouseleave', event => {
      const nextTarget = event.relatedTarget;
      const modal = document.getElementById(MODAL_ID);
      const movingIntoModal = !!(modal && nextTarget && modal.contains(nextTarget));

      clearHoverOpenTimer();
      if (movingIntoModal) {
        clearHoverCloseTimer();
        return;
      }
      schedulePopoverClose();
    });

    host.dataset.tmContextEnhanced = '1';
  }

  function installFetchHook() {
    if (window.__tmBiliContextFetchHookInstalled) return;
    window.__tmBiliContextFetchHookInstalled = true;

    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await rawFetch.apply(this, args);

      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        rememberOidFromUrl(url);
        const root = extractRootFromUrl(url);
        if (String(url).includes(REPLY_API_PATH) || String(url).includes('/x/v2/reply')) {
          res.clone().json().then(json => {
            if (json?.code === 0 && json?.data) {
              cacheReplyData(json.data, { root });
              scheduleScan(null, 50);
            }
          }).catch(() => {});
        }
      } catch (_) {}

      return res;
    };
  }

  function installXhrHook() {
    if (window.__tmBiliContextXhrHookInstalled) return;
    window.__tmBiliContextXhrHookInstalled = true;

    const rawOpen = XMLHttpRequest.prototype.open;
    const rawSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__tmContextUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const url = String(this.responseURL || this.__tmContextUrl || '');
          rememberOidFromUrl(url);
          const root = extractRootFromUrl(url);
          if (!url.includes(REPLY_API_PATH) && !url.includes('/x/v2/reply')) return;
          if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;

          const json = JSON.parse(this.responseText);
          if (json?.code === 0 && json?.data) {
            cacheReplyData(json.data, { root });
            scheduleScan(null, 50);
          }
        } catch (_) {}
      });

      return rawSend.apply(this, args);
    };
  }

  function flushScheduledScan() {
    scanTimer = 0;

    try {
      const roots = pendingScanRoots.size ? Array.from(pendingScanRoots) : [findCommentsScanRoot()];
      pendingScanRoots.clear();

      const hostSet = new Set();
      for (const root of roots) {
        const scanRoot = root || findCommentsScanRoot();
        const hosts = findReplyRendererHosts(scanRoot);
        for (const host of hosts) {
          hostSet.add(host);
        }
      }

      for (const host of hostSet) {
        refreshReplyHostState(host);
        cacheReplyFromHost(host);
        bindHoverIntoReplyHost(host);
      }

      log('扫描完成，reply hosts =', hostSet.size);
    } catch (err) {
      console.error('[BiliContext] scan flush error', err);
    }
  }

  function scheduleScan(root = null, delay = 50) {
    pendingScanRoots.add(root || findCommentsScanRoot());

    if (scanTimer) return;
    scanTimer = window.setTimeout(flushScheduledScan, delay);
  }

  function scheduleScanBurst(delays = [0], { refreshObserver = false } = {}) {
    for (const delay of delays) {
      window.setTimeout(() => {
        if (refreshObserver) {
          initObserver();
        }
        scheduleScan(null, 0);
      }, delay);
    }
  }

  function getCommentObserverTargets() {
    const targets = new Set();
    const commentsHost = document.querySelector('bili-comments');
    const commentApp = document.getElementById('commentapp');
    const scanRoot = findCommentsScanRoot();

    if (commentsHost) targets.add(commentsHost);
    if (commentsHost?.shadowRoot) targets.add(commentsHost.shadowRoot);
    if (commentApp) targets.add(commentApp);
    if (scanRoot) targets.add(scanRoot);
    if (document.body) targets.add(document.body);

    return Array.from(targets).filter(Boolean);
  }

  function initObserver() {
    if (commentsObserver) {
      commentsObserver.disconnect();
      commentsObserver = null;
    }

    commentsObserver = new MutationObserver(mutations => {
      try {
        let shouldRescan = false;
        for (const mutation of mutations) {
          if (mutation.addedNodes?.length || mutation.removedNodes?.length) {
            shouldRescan = true;
            break;
          }
        }

        if (shouldRescan) {
          scheduleScan(null, 50);
        }
      } catch (err) {
        console.error('[BiliContext] observer error', err);
      }
    });

    const targets = getCommentObserverTargets();
    if (!targets.length) return;

    for (const target of targets) {
      commentsObserver.observe(target, {
        childList: true,
        subtree: true
      });
    }
  }

  function installPaginationRescan() {
    if (window.__tmBiliContextPaginationRescanInstalled) return;
    window.__tmBiliContextPaginationRescanInstalled = true;

    document.addEventListener('click', event => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const hit = path.find(node => {
        const text = (node?.textContent || '').trim();
        const cls = typeof node?.className === 'string' ? node.className : '';
        return /下一页|上一页|下一页回复|上一页回复/.test(text) || /pager|page|next|prev/i.test(cls);
      });

      const interactionHit = path.find(node => {
        const text = (node?.textContent || '').trim();
        const cls = typeof node?.className === 'string' ? node.className : '';
        return /点击查看|收起|展开|更多回复|共\d+条回复/.test(text) || /reply|replies|expander|view-more/i.test(cls);
      });

      if (!hit && !interactionHit) return;

      scheduleScanBurst([80, 500, 1200], { refreshObserver: true });
    }, true);
  }

  function installHoverFallback() {
    if (window.__tmBiliContextHoverFallbackInstalled) return;
    window.__tmBiliContextHoverFallbackInstalled = true;

    document.addEventListener('mouseover', event => {
      const host = getReplyHostFromEvent(event);
      if (!host || host.dataset.tmContextEnhanced === '1') return;

      refreshReplyHostState(host);
      cacheReplyFromHost(host);
      bindHoverIntoReplyHost(host);
      scheduleHoverOpen(host);
    }, true);
  }

  function initPopoverReposition() {
    const handler = () => {
      const modal = document.getElementById(MODAL_ID);
      if (!modal || !getAnchorElement(activeAnchor)) return;
      positionPopover(modal, activeAnchor);
    };

    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
  }

  function init() {
    window.__tmBiliContextDebug = {
      enabled: DEBUG,
      enable() {
        setDebugEnabled(true);
        return '调试模式已开启，刷新页面后生效。';
      },
      disable() {
        setDebugEnabled(false);
        return '调试模式已关闭，刷新页面后生效。';
      },
      status() {
        return {
          enabled: localStorage.getItem(DEBUG_STORAGE_KEY) === '1',
          capturedOid,
          stateOid: getCurrentOidFromState(),
          bvid: getCurrentBvid()
        };
      }
    };

    installFetchHook();
    installXhrHook();
    initPopoverReposition();
    initObserver();
    installPaginationRescan();
    installHoverFallback();

    const bootScan = () => {
      scheduleScanBurst([0, 300, 1000]);
      scheduleScanBurst([2000, 4000], { refreshObserver: true });
      log('评论上下文补全已启动（悬停绑定模式）');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootScan, { once: true });
    } else {
      bootScan();
    }
  }

  init();
})();
