(function () {
  if (window.__WRT_INJECTED__) return;
  window.__WRT_INJECTED__ = true;

  // ============================================================
  //  Web Request Trace – 数据溯源
  //  捕获所有接口响应体  →  选中元素  →  反查数据来自哪个接口
  // ============================================================

  var MAX_TRACES = 500;        // 请求环形缓冲上限
  var MAX_RESP = 300 * 1024;   // 单个响应体最多保存多少字符（防止内存爆）
  var MAX_TOKENS = 40;         // 选中元素最多取多少个值用于匹配

  var traces = [];             // 全部请求记录（含响应体）
  var recordOff = false;       // 已知开关为关 → 停止记录，省内存

  // 常见 UI 文案/通用词，命中也没意义，降噪用
  var STOP = {
    '操作': 1, '编辑': 1, '删除': 1, '查看': 1, '详情': 1, '新增': 1, '查询': 1,
    '确定': 1, '取消': 1, '提交': 1, '保存': 1, '返回': 1, '更多': 1, '展开': 1,
    'true': 1, 'false': 1, 'null': 1, 'undefined': 1, 'data': 1, 'list': 1,
    'name': 1, 'id': 1, 'code': 1, 'type': 1, 'status': 1, 'value': 1
  };

  // ---------- 工具函数 ----------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function buildUrl(url) {
    try { return new URL(url, location.href).href; } catch (e) { return String(url); }
  }
  function extractPath(url) {
    try { var u = new URL(url, location.href); return u.pathname + u.search; }
    catch (e) { return String(url); }
  }
  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + el.id;
    var parts = [], cur = el;
    while (cur && cur !== document.body && parts.length < 3) {
      var tag = cur.tagName ? cur.tagName.toLowerCase() : '*';
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) tag += '.' + cls;
      }
      parts.unshift(tag);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 记录请求 / 响应体 ----------

  function recordTrace(method, url, initiator) {
    if (recordOff) return null;   // 开关已知为关，不记录
    var t = {
      id: uid(),
      method: (method || 'GET').toUpperCase(),
      url: buildUrl(url),
      path: extractPath(url),
      initiator: initiator,
      time: Date.now(),
      status: undefined,
      statusText: '',
      respBody: null      // 响应体文本（用于反查）
    };
    traces.push(t);
    if (traces.length > MAX_TRACES) traces.shift();
    return t;
  }
  function setStatus(trace, status, statusText) {
    if (!trace) return;
    trace.status = status;
    trace.statusText = statusText || '';
  }
  function setResp(trace, text) {
    if (!trace || text == null) return;
    trace.respBody = String(text).slice(0, MAX_RESP);
  }

  // ============================================================
  //  探测模式：拦截并阻断「将要发出的请求」
  //  表单没填完 / 不想真提交时，先看看点某个按钮会打哪个接口、带什么参数。
  //  原理：临时拦下下一批请求，记录 method/url/headers/body，然后阻断（不发到后端）。
  // ============================================================

  var probeArmed = false;   // 已就绪：拦截下一批请求
  var probeCaught = [];     // 本次探测捕获到的请求
  var probeTimer = null;    // 突发请求收集窗口计时器

  function snapshotHeaders(h) {
    if (!h) return null;
    try {
      var out = {};
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) out[h[i][0]] = h[i][1];
      } else {
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k];
      }
      return out;
    } catch (e) { return null; }
  }

  function snapshotBody(body) {
    if (body == null || body === '') return null;
    try {
      if (typeof body === 'string') return body;
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var parts = [];
        body.forEach(function (v, k) { parts.push(k + '=' + (typeof v === 'string' ? v : '[file]')); });
        return parts.join('&');
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' 字节, type=' + (body.type || '?') + ']';
      if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '[ArrayBuffer ' + body.byteLength + ' 字节]';
      return String(body);
    } catch (e) { return '[无法读取请求体]'; }
  }

  function prettyBody(text) {
    if (text == null) return '';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return String(text); }
  }

  function probeCapture(method, url, headers, body) {
    probeCaught.push({
      id: uid(),
      method: (method || 'GET').toUpperCase(),
      url: buildUrl(url),
      path: extractPath(url),
      headers: headers || null,
      body: snapshotBody(body),
      time: Date.now()
    });
    // 一次点击可能连发多个请求（校验 + 提交…），用一个短窗口把它们收集到一起
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(finishProbe, 500);
  }

  function finishProbe() {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    probeArmed = false;
    var caught = probeCaught.slice();
    refreshFab();
    hideTip();
    renderProbeCard(caught);
  }

  // ---------- hook fetch ----------

  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      var method = 'GET', url = '', hdr = null, bdy = null;
      if (typeof input === 'string') url = input;
      else if (input && input.url) { url = input.url; method = input.method || 'GET'; hdr = input.headers; bdy = (typeof input.body !== 'undefined') ? input.body : null; }
      if (init && init.method) method = init.method;
      if (init && init.headers) hdr = init.headers;
      if (init && typeof init.body !== 'undefined') bdy = init.body;

      // 探测模式：记录后阻断，不真正发到后端
      if (probeArmed) {
        probeCapture(method, url, snapshotHeaders(hdr), bdy);
        return Promise.reject(new DOMException('Request blocked by Web Request Trace (探测模式)', 'AbortError'));
      }

      var trace = recordTrace(method, url, 'fetch');

      var p = _fetch.apply(this, arguments);
      p.then(function (resp) {
        setStatus(trace, resp.status, resp.statusText);
        // clone 后读取，不影响页面消费 body
        try {
          resp.clone().text().then(function (txt) { setResp(trace, txt); }, function () {});
        } catch (e) { /* ignore */ }
        return resp;
      }, function (err) {
        setStatus(trace, 0, (err && err.message) || 'Network Error');
        throw err;
      });
      return p;
    };
  }

  // ---------- hook XMLHttpRequest ----------

  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    window.XMLHttpRequest = function () {
      var xhr = new OrigXHR();
      var _open = xhr.open;
      var _send = xhr.send;
      var _setHeader = xhr.setRequestHeader;
      var m = 'GET', u = '', reqHeaders = {};

      xhr.open = function (method, url) { m = method; u = url; return _open.apply(xhr, arguments); };
      xhr.setRequestHeader = function (k, v) {
        try { reqHeaders[k] = reqHeaders[k] ? reqHeaders[k] + ', ' + v : v; } catch (e) {}
        return _setHeader.apply(xhr, arguments);
      };
      xhr.send = function (body) {
        // 探测模式：记录后阻断（abort），不真正发到后端
        if (probeArmed) {
          probeCapture(m, u, reqHeaders, body);
          try { xhr.abort(); } catch (e) {}
          return;
        }
        var trace = recordTrace(m, u, 'xhr');
        xhr.addEventListener('loadend', function () {
          setStatus(trace, xhr.status, xhr.statusText);
          try {
            var rt = xhr.responseType;
            if (rt === '' || rt === 'text') setResp(trace, xhr.responseText);
            else if (rt === 'json' && xhr.response != null) setResp(trace, JSON.stringify(xhr.response));
            // blob/arraybuffer/document 跳过
          } catch (e) { /* ignore */ }
        });
        return _send.apply(xhr, arguments);
      };
      return xhr;
    };
    window.XMLHttpRequest.prototype = OrigXHR.prototype;
  }

  // ============================================================
  //  数据溯源核心：从选中元素提取「值」，反查响应体
  // ============================================================

  // 从一段文本里抽取候选「值」token：CJK 串 / 字母数字串（含日期、邮箱、小数）
  function extractTokens(text) {
    if (!text) return [];
    var raw = text.match(/[一-龥]{2,}|[A-Za-z0-9_@.:\-]{2,}/g) || [];
    var seen = {}, out = [];
    for (var i = 0; i < raw.length && out.length < MAX_TOKENS; i++) {
      var tk = raw[i];
      // 去掉纯标点残留、过长噪声
      if (tk.length < 2 || tk.length > 60) continue;
      if (STOP[tk.toLowerCase()]) continue;
      // 纯小整数（0-9 一两位）几乎每个接口都有，降噪
      if (/^\d{1,2}$/.test(tk)) continue;
      if (seen[tk]) continue;
      seen[tk] = 1;
      out.push(tk);
    }
    return out;
  }

  // 对单个 trace 计算匹配分数
  function scoreTrace(trace, tokens) {
    if (!trace.respBody) return null;
    var body = trace.respBody;
    var matched = [];
    var score = 0;
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i];
      if (body.indexOf(tk) !== -1) {
        matched.push(tk);
        // 越长 / 越像具体值（含中文或较长）权重越高
        score += Math.min(tk.length, 20);
      }
    }
    if (matched.length === 0) return null;
    return { trace: trace, score: score, matched: matched, tokenTotal: tokens.length };
  }

  // 按文本搜索来源（供选中元素 / 手动输入框共用）
  function findByText(text) {
    text = (text || '').trim();
    var tokens = extractTokens(text);
    var results = [];
    if (tokens.length > 0) {
      for (var i = 0; i < traces.length; i++) {
        var r = scoreTrace(traces[i], tokens);
        if (r) results.push(r);
      }
      results.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return b.matched.length - a.matched.length;
      });
    }
    return { text: text, tokens: tokens, results: results };
  }

  // 主入口：从选中元素提取文本后搜索
  function findDataSources(el) {
    return findByText((el.textContent || '').trim());
  }

  // ============================================================
  //  UI 浮层（Shadow DOM 隔离）
  // ============================================================

  var host = null, root = null, overlay = null, card = null, inspecting = false, tipEl = null;
  var fab = null;            // 常驻浮动按钮(数据溯源)
  var fab2 = null;           // 常驻浮动按钮(接口探测)
  var enabled = false;       // 总开关状态（由 background 推送）

  var STYLE = '' +
    ':host{ all: initial; }' +
    '.wrt-overlay{ position:fixed; pointer-events:none; z-index:2147483646;' +
      ' border:2px solid #2563eb; background:rgba(37,99,235,0.10); border-radius:3px; display:none; }' +
    '.wrt-card{ position:fixed; right:16px; bottom:16px; width:440px; max-height:74vh;' +
      ' display:flex; flex-direction:column; z-index:2147483647;' +
      ' background:#1e1e2e; color:#e5e7eb; border-radius:10px;' +
      ' box-shadow:0 12px 40px rgba(0,0,0,0.45); overflow:hidden;' +
      ' font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; }' +
    '.wrt-head{ display:flex; align-items:center; gap:8px; padding:10px 12px;' +
      ' background:#2a2a3c; border-bottom:1px solid #3a3a4c; }' +
    '.wrt-head .t{ flex:1; font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
    '.wrt-x{ cursor:pointer; border:none; background:transparent; color:#9ca3af; font-size:16px; line-height:1; padding:2px 6px; border-radius:4px; }' +
    '.wrt-x:hover{ background:#3a3a4c; color:#fff; }' +
    '.wrt-sel{ display:flex; align-items:center; gap:8px; padding:7px 12px; background:#16161f; border-bottom:1px solid #34344a; font-size:12px; color:#cbd5e1; }' +
    '.wrt-sel label{ flex-shrink:0; color:#9ca3af; }' +
    '.wrt-search{ flex:1; min-width:0; background:#0d0d14; color:#fde68a; border:1px solid #34344a; border-radius:5px;' +
      ' padding:5px 8px; font-size:12px; font-family:ui-monospace,Menlo,Consolas,monospace; outline:none; }' +
    '.wrt-search:focus{ border-color:#2563eb; }' +
    '.wrt-go{ flex-shrink:0; cursor:pointer; border:none; background:#2563eb; color:#fff; border-radius:5px; padding:5px 10px; font-size:12px; font-weight:600; }' +
    '.wrt-go:hover{ background:#1d4ed8; }' +
    '.wrt-body{ overflow:auto; padding:6px; }' +
    '.wrt-item{ border:1px solid #34344a; border-radius:6px; margin:6px 0; overflow:hidden; }' +
    '.wrt-item.top{ border-color:#2563eb; }' +
    '.wrt-row{ display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; }' +
    '.wrt-row:hover{ background:#2a2a3c; }' +
    '.wrt-m{ font-weight:700; font-size:11px; padding:2px 6px; border-radius:4px; flex-shrink:0; }' +
    '.wrt-m.GET{ background:#1e3a5f; color:#7dd3fc; }' +
    '.wrt-m.POST{ background:#14532d; color:#86efac; }' +
    '.wrt-m.PUT{ background:#78350f; color:#fcd34d; }' +
    '.wrt-m.DELETE{ background:#7f1d1d; color:#fca5a5; }' +
    '.wrt-m.PATCH,.wrt-m.HEAD,.wrt-m.OPTIONS{ background:#3b0764; color:#d8b4fe; }' +
    '.wrt-path{ flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; cursor:copy; border-radius:4px; padding:1px 4px; }' +
    '.wrt-path:hover{ background:#34344a; color:#fff; }' +
    '.wrt-path.copied{ background:#14532d; color:#86efac; }' +
    '.wrt-hit{ flex-shrink:0; font-size:11px; font-weight:600; color:#4ade80; background:#14532d; padding:2px 7px; border-radius:10px; }' +
    '.wrt-detail{ display:none; padding:8px 10px; background:#16161f; border-top:1px solid #34344a; font-size:12px; }' +
    '.wrt-detail.open{ display:block; }' +
    '.wrt-d-row{ margin:5px 0; word-break:break-all; line-height:1.5; }' +
    '.wrt-d-k{ color:#9ca3af; margin-right:6px; }' +
    '.wrt-d-v{ font-family:ui-monospace,Menlo,Consolas,monospace; }' +
    '.wrt-tag{ display:inline-block; background:#14532d; color:#86efac; padding:1px 6px; border-radius:4px; margin:2px 4px 2px 0; font-size:11px; }' +
    '.wrt-snip{ margin-top:4px; padding:6px 8px; background:#0d0d14; border-radius:4px; max-height:120px; overflow:auto;' +
      ' font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:#94a3b8; white-space:pre-wrap; word-break:break-all; }' +
    '.wrt-snip mark{ background:#fbbf24; color:#1e1e2e; border-radius:2px; padding:0 1px; }' +
    '.wrt-empty{ padding:24px 12px; text-align:center; color:#9ca3af; line-height:1.7; }' +
    '.wrt-tip{ position:fixed; left:50%; top:14px; transform:translateX(-50%); z-index:2147483647;' +
      ' background:#2563eb; color:#fff; padding:7px 16px; border-radius:20px; font-size:13px;' +
      ' font-family:-apple-system,sans-serif; box-shadow:0 4px 16px rgba(0,0,0,0.3); pointer-events:none; }' +
    '.wrt-fab{ position:fixed; right:16px; bottom:16px; z-index:2147483645; cursor:pointer;' +
      ' background:#2563eb; color:#fff; border:none; border-radius:22px; padding:9px 16px;' +
      ' font-size:13px; font-weight:600; font-family:-apple-system,sans-serif;' +
      ' box-shadow:0 4px 16px rgba(0,0,0,0.35); display:none; align-items:center; gap:6px; }' +
    '.wrt-fab:hover{ background:#1d4ed8; }' +
    '.wrt-fab.active{ background:#f43f5e; }' +
    '.wrt-fab2{ position:fixed; right:140px; bottom:16px; z-index:2147483645; cursor:pointer;' +
      ' background:#7c3aed; color:#fff; border:none; border-radius:22px; padding:9px 16px;' +
      ' font-size:13px; font-weight:600; font-family:-apple-system,sans-serif;' +
      ' box-shadow:0 4px 16px rgba(0,0,0,0.35); display:none; align-items:center; gap:6px; }' +
    '.wrt-fab2:hover{ background:#6d28d9; }' +
    '.wrt-fab2.active{ background:#f59e0b; color:#1e1e2e; }' +
    '.wrt-warn{ padding:8px 12px; background:#3b2f10; color:#fcd34d; border-bottom:1px solid #5a4a18; font-size:12px; line-height:1.5; }' +
    '.wrt-req{ border:1px solid #34344a; border-radius:6px; margin:6px 0; overflow:hidden; }' +
    '.wrt-req.top{ border-color:#7c3aed; }' +
    '.wrt-kv{ margin:6px 0; word-break:break-all; line-height:1.5; }' +
    '.wrt-kv .wrt-d-k{ display:inline-block; min-width:54px; }' +
    '.wrt-pre{ margin-top:4px; padding:8px; background:#0d0d14; border-radius:4px; max-height:240px; overflow:auto;' +
      ' font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; color:#cbd5e1; white-space:pre-wrap; word-break:break-all; }';

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__wrt_host__';
    root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    overlay = document.createElement('div');
    overlay.className = 'wrt-overlay';
    root.appendChild(overlay);

    fab = document.createElement('button');
    fab.className = 'wrt-fab';
    fab.textContent = '🔎 数据溯源';
    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleInspect();
    });
    root.appendChild(fab);

    fab2 = document.createElement('button');
    fab2.className = 'wrt-fab2';
    fab2.textContent = '🎯 接口探测';
    fab2.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleProbe();
    });
    root.appendChild(fab2);

    document.documentElement.appendChild(host);
  }

  function refreshFab() {
    ensureUI();
    fab.style.display = enabled ? 'inline-flex' : 'none';
    fab2.style.display = enabled ? 'inline-flex' : 'none';
    if (inspecting) { fab.classList.add('active'); fab.textContent = '⏹ 退出选择'; }
    else { fab.classList.remove('active'); fab.textContent = '🔎 数据溯源'; }
    if (probeArmed) { fab2.classList.add('active'); fab2.textContent = '⏹ 取消探测'; }
    else { fab2.classList.remove('active'); fab2.textContent = '🎯 接口探测'; }
  }
  function showOverlay(el) {
    ensureUI();
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }
  function showTip(text) {
    ensureUI();
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'wrt-tip'; root.appendChild(tipEl); }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  // ---------- 渲染：响应体片段（高亮第一个命中的值） ----------

  function buildSnippet(body, matched) {
    if (!body) return '';
    var anchor = matched && matched.length ? matched[0] : '';
    var idx = anchor ? body.indexOf(anchor) : 0;
    if (idx < 0) idx = 0;
    var start = Math.max(0, idx - 80);
    var end = Math.min(body.length, idx + 220);
    var seg = (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
    var html = esc(seg);
    // 高亮所有命中值
    for (var i = 0; i < matched.length; i++) {
      var safe = matched[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { html = html.replace(new RegExp(esc(safe), 'g'), '<mark>' + esc(matched[i]) + '</mark>'); } catch (e) {}
    }
    return html;
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;');
  }

  // 复制到剪贴板：优先 navigator.clipboard，失败回退 execCommand。复制后短暂高亮该元素。
  function copyText(text, el) {
    function flash() {
      if (!el) return;
      el.classList.add('copied');
      var old = el.getAttribute('title');
      el.setAttribute('title', '已复制！');
      setTimeout(function () {
        el.classList.remove('copied');
        if (old != null) el.setAttribute('title', old);
      }, 900);
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flash();
      } catch (e) { /* ignore */ }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, fallback);
    } else {
      fallback();
    }
  }

  function renderCard(info, keepFocus) {
    ensureUI();
    if (!card) { card = document.createElement('div'); card.className = 'wrt-card'; root.appendChild(card); }

    var results = info.results;

    var html = '' +
      '<div class="wrt-head">' +
        '<span class="t">🔎 数据来源 · 命中 ' + results.length + ' 个接口</span>' +
        '<button class="wrt-x" data-act="close">✕</button>' +
      '</div>' +
      '<div class="wrt-sel">' +
        '<label>搜索</label>' +
        '<input class="wrt-search" type="text" value="' + escAttr(info.text || '') + '" placeholder="点页面数据自动填入，或手动输入后回车" />' +
        '<button class="wrt-go" data-act="search">搜索</button>' +
      '</div>' +
      '<div class="wrt-body">';

    if (info.tokens.length === 0) {
      html += '<div class="wrt-empty">未能从选中元素提取到有效数据值<br><small>请点击具体的数据单元格（如某个姓名、编号、日期）</small></div>';
    } else if (results.length === 0) {
      html += '<div class="wrt-empty">没有接口的响应体包含这段数据<br><small>可能数据在选中前就已加载（请点插件图标后刷新页面再试），<br>或前端对数据做了格式化（如时间戳转日期）导致文本对不上</small></div>';
    } else {
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var t = r.trace;
        var tags = r.matched.slice(0, 8).map(function (m) { return '<span class="wrt-tag">' + esc(m) + '</span>'; }).join('');
        html += '' +
          '<div class="wrt-item' + (i === 0 ? ' top' : '') + '" data-id="' + t.id + '">' +
            '<div class="wrt-row" data-act="toggle">' +
              '<span class="wrt-m ' + t.method + '">' + t.method + '</span>' +
              '<span class="wrt-path" data-copy="' + escAttr(t.method + ' ' + t.path) + '" title="点击复制：' + escAttr(t.method + ' ' + t.path) + '">' + esc(t.path) + '</span>' +
              '<span class="wrt-hit">命中 ' + r.matched.length + '/' + r.tokenTotal + '</span>' +
            '</div>' +
            '<div class="wrt-detail">' +
              '<div class="wrt-d-row"><span class="wrt-d-k">URL</span><span class="wrt-d-v">' + esc(t.url) + '</span></div>' +
              '<div class="wrt-d-row"><span class="wrt-d-k">命中值</span>' + tags + '</div>' +
              '<div class="wrt-d-row"><span class="wrt-d-k">响应片段</span><div class="wrt-snip">' + buildSnippet(t.respBody, r.matched) + '</div></div>' +
            '</div>' +
          '</div>';
      }
    }
    html += '</div>';
    card.innerHTML = html;
    card.style.display = 'flex';

    card.querySelector('[data-act="close"]').addEventListener('click', function () {
      hideCard();
      exitInspect();
    });

    // 可编辑搜索：回车或点「搜索」按钮，按输入文本重新查来源
    var searchInput = card.querySelector('.wrt-search');
    function doSearch() { renderCard(findByText(searchInput.value), true); }
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
      // 输入框内的按键不应触发页面/溯源的全局监听
      e.stopPropagation();
    });
    card.querySelector('[data-act="search"]').addEventListener('click', doSearch);

    // 若用户正在编辑搜索框（重新渲染前 input 有焦点），渲染后恢复焦点与光标位置
    if (keepFocus) {
      searchInput.focus();
      var v = searchInput.value;
      try { searchInput.setSelectionRange(v.length, v.length); } catch (e) {}
    }
    var rows = card.querySelectorAll('.wrt-row[data-act="toggle"]');
    for (var j = 0; j < rows.length; j++) {
      rows[j].addEventListener('click', function () {
        this.parentNode.querySelector('.wrt-detail').classList.toggle('open');
      });
    }

    // 点击接口路径 → 复制 "METHOD /path?query" 到剪贴板（不触发展开/收起）
    var paths = card.querySelectorAll('.wrt-path[data-copy]');
    for (var k = 0; k < paths.length; k++) {
      paths[k].addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(this.getAttribute('data-copy'), this);
      });
    }
    // 默认展开第一条（最可能的来源）
    var first = card.querySelector('.wrt-item.top .wrt-detail');
    if (first) first.classList.add('open');
  }

  function hideCard() { if (card) card.style.display = 'none'; }

  // ============================================================
  //  溯源模式交互
  // ============================================================

  function enterInspect() {
    if (probeArmed) disarmProbe();   // 与接口探测互斥
    inspecting = true;
    ensureUI();
    document.documentElement.style.cursor = 'crosshair';
    showTip('🔎 数据溯源：点击页面上某块数据，查看它来自哪个接口（Esc 退出）');
    refreshFab();
  }
  function exitInspect() {
    inspecting = false;
    document.documentElement.style.cursor = '';
    hideOverlay();
    hideTip();
    refreshFab();
  }
  function toggleInspect() {
    if (inspecting) exitInspect();
    else { hideCard(); enterInspect(); }
  }

  // ---------- 接口探测模式 ----------

  function armProbe() {
    if (inspecting) exitInspect();   // 与数据溯源互斥
    probeArmed = true;
    probeCaught = [];
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    hideCard();
    ensureUI();
    showTip('🎯 接口探测已就绪：去点「确定/提交」等按钮，将拦截并显示它要请求的接口（请求不会真正发出）');
    refreshFab();
  }
  function disarmProbe() {
    probeArmed = false;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    hideTip();
    refreshFab();
  }
  function toggleProbe() {
    if (probeArmed) disarmProbe();
    else armProbe();
  }

  function renderProbeCard(caught) {
    ensureUI();
    if (!card) { card = document.createElement('div'); card.className = 'wrt-card'; root.appendChild(card); }

    var html = '' +
      '<div class="wrt-head">' +
        '<span class="t">🎯 接口探测 · 捕获 ' + caught.length + ' 个请求</span>' +
        '<button class="wrt-x" data-act="close">✕</button>' +
      '</div>' +
      '<div class="wrt-warn">⚠️ 这些请求已被拦截、<b>未真正发送到后端</b>。前端可能因此报错或停在 loading，属正常现象（刷新页面即可恢复）。</div>' +
      '<div class="wrt-body">';

    if (caught.length === 0) {
      html += '<div class="wrt-empty">没有捕获到请求<br><small>可能是：①该按钮的前端校验未通过（必填项没填完，请求未发出）——把必填项填到能提交为止再试；<br>②点击没有触发网络请求；<br>③请求由非 fetch/XHR 方式发出（如 sendBeacon、WebSocket）</small></div>';
    } else {
      for (var i = 0; i < caught.length; i++) {
        var c = caught[i];
        var hdrText = c.headers ? Object.keys(c.headers).map(function (k) { return k + ': ' + c.headers[k]; }).join('\n') : '';
        var bodyText = prettyBody(c.body);
        html += '' +
          '<div class="wrt-req' + (i === 0 ? ' top' : '') + '">' +
            '<div class="wrt-row" data-act="toggle">' +
              '<span class="wrt-m ' + c.method + '">' + c.method + '</span>' +
              '<span class="wrt-path" data-copy="' + escAttr(c.method + ' ' + c.path) + '" title="点击复制：' + escAttr(c.method + ' ' + c.path) + '">' + esc(c.path) + '</span>' +
            '</div>' +
            '<div class="wrt-detail">' +
              '<div class="wrt-kv"><span class="wrt-d-k">URL</span><span class="wrt-d-v">' + esc(c.url) + '</span></div>' +
              (hdrText ? '<div class="wrt-kv"><span class="wrt-d-k">请求头</span><div class="wrt-pre">' + esc(hdrText) + '</div></div>' : '') +
              (bodyText ? '<div class="wrt-kv"><span class="wrt-d-k">请求体</span><div class="wrt-pre">' + esc(bodyText) + '</div></div>' : '<div class="wrt-kv"><span class="wrt-d-k">请求体</span><span class="wrt-d-v">（无）</span></div>') +
            '</div>' +
          '</div>';
      }
    }
    html += '</div>';
    card.innerHTML = html;
    card.style.display = 'flex';

    card.querySelector('[data-act="close"]').addEventListener('click', function () { hideCard(); });

    var rows = card.querySelectorAll('.wrt-row[data-act="toggle"]');
    for (var j = 0; j < rows.length; j++) {
      rows[j].addEventListener('click', function () {
        this.parentNode.querySelector('.wrt-detail').classList.toggle('open');
      });
    }
    var paths = card.querySelectorAll('.wrt-path[data-copy]');
    for (var k = 0; k < paths.length; k++) {
      paths[k].addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(this.getAttribute('data-copy'), this);
      });
    }
    var firstReq = card.querySelector('.wrt-req.top .wrt-detail');
    if (firstReq) firstReq.classList.add('open');
  }

  document.addEventListener('mousemove', function (e) {
    if (!inspecting) return;
    if (e.target && e.target !== host) showOverlay(e.target);
  }, true);

  // 数据溯源：点击仅用于「选中」元素，阻止其触发页面行为（导航/弹窗等）。
  // 选中后保持溯源模式不变，可连续点击不同数据；直到手动关闭浮层或按 Esc 才退出。
  document.addEventListener('click', function (e) {
    if (!inspecting) return;
    if (e.target === host) return;
    e.preventDefault();
    e.stopPropagation();
    renderCard(findDataSources(e.target));
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var cardOpen = card && card.style.display !== 'none';
    if (inspecting || probeArmed || cardOpen) {
      e.preventDefault();
      exitInspect();
      disarmProbe();
      hideCard();
    }
  }, true);

  // ---------- 接收 content-script 的开关信号 ----------

  function applyEnabled(on) {
    enabled = !!on;
    recordOff = !enabled;
    if (!enabled) {
      // 关闭：退出选择、收起 UI、清空已捕获数据释放内存
      if (inspecting) exitInspect();
      if (probeArmed) disarmProbe();
      probeCaught = [];
      hideCard();
      traces.length = 0;
    }
    refreshFab();
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d) return;
    if (d.type === '__WRT_SET_ENABLED__') applyEnabled(d.enabled);
  });

  // 主动索要一次开关状态：inject.js 是异步加载的，可能晚于 content-script 的首次推送，
  // 错过那条消息会导致 FAB 永不出现。就绪后主动请求一次，content-script 会回推当前状态。
  window.postMessage({ type: '__WRT_REQUEST_STATE__' }, '*');

})();
