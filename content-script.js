// content-script.js – 隔离世界桥接
// 职责一：把 inject.js 注入页面真实环境（hook 必须在页面 window 上生效）。
// 职责二：维护「总开关」状态，并在 inject.js 就绪 / background 变更时推送给页面环境。

(function () {
  'use strict';

  var currentEnabled = false;
  var known = false;   // 是否已确定开关状态

  // ---- 注入页面环境拦截脚本 ----

  function injectScript() {
    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () { script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  if (document.head || document.documentElement) {
    injectScript();
  } else {
    new MutationObserver(function (_, obs) {
      if (document.head || document.documentElement) {
        obs.disconnect();
        injectScript();
      }
    }).observe(document, { childList: true, subtree: true });
  }

  // ---- 把当前开关状态推送给页面环境 ----

  function pushEnabled() {
    if (!known) return;
    window.postMessage({ type: '__WRT_SET_ENABLED__', enabled: currentEnabled }, '*');
  }

  // ---- 向 background 查询当前开关状态 ----

  try {
    chrome.runtime.sendMessage({ type: '__WRT_QUERY_ENABLED__' }, function (resp) {
      currentEnabled = chrome.runtime.lastError ? false : !!(resp && resp.enabled);
      known = true;
      pushEnabled();
    });
  } catch (e) {
    currentEnabled = false; known = true; pushEnabled();
  }

  // ---- inject.js 就绪后会主动索要状态（解决脚本异步加载的时序竞态） ----

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.data && e.data.type === '__WRT_REQUEST_STATE__') pushEnabled();
  });

  // ---- background 广播开关变更 ----

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === '__WRT_SET_ENABLED__') {
      currentEnabled = !!msg.enabled;
      known = true;
      pushEnabled();
    }
  });

})();
