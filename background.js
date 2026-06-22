// background.js – MV3 service worker
// 维护「数据溯源」全局总开关（持久化到 storage.local），并在图标显示 ON/OFF 角标。
// 开关对所有标签页生效；content-script 启动时主动来问当前状态。

var KEY = 'wrt_enabled';

function setBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  chrome.action.setTitle({ title: enabled ? '数据溯源：已开启（点击关闭）' : '数据溯源：已关闭（点击开启）' });
}

// 启动 / 安装时恢复角标
function refreshBadge() {
  chrome.storage.local.get(KEY, function (r) { setBadge(!!r[KEY]); });
}
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
refreshBadge();

// 点击图标 → 翻转总开关，并广播给所有标签页
chrome.action.onClicked.addListener(function () {
  chrome.storage.local.get(KEY, function (r) {
    var next = !r[KEY];
    chrome.storage.local.set({ wrt_enabled: next }, function () {
      setBadge(next);
      chrome.tabs.query({}, function (tabs) {
        for (var i = 0; i < tabs.length; i++) {
          if (!tabs[i].id) continue;
          chrome.tabs.sendMessage(tabs[i].id, { type: '__WRT_SET_ENABLED__', enabled: next }, function () {
            if (chrome.runtime.lastError) { /* 该页面不支持注入，忽略 */ }
          });
        }
      });
    });
  });
});

// content-script 启动时来问当前开关状态
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === '__WRT_QUERY_ENABLED__') {
    chrome.storage.local.get(KEY, function (r) { sendResponse({ enabled: !!r[KEY] }); });
    return true; // 异步响应
  }
});
