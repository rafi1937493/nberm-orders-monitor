/**
 * Background Service Worker for NBERM Phone Sync (v1.0.7)
 * - Runs with full extension privileges, bypassing page CSP restrictions.
 * - Chrome Alarms keep this worker alive even when PC is locked (Win + L).
 * - Bulletproof error suppression for unmounted tabs and port disconnects.
 */

const VERCEL_URL = 'https://nberm-orders-monitor.vercel.app';

// Create persistent periodic heartbeat alarm (every 0.5 minutes = 30 seconds)
try {
  chrome.alarms.create('nberm_lock_sync_timer', { periodInMinutes: 0.5 });
} catch (e) {}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === 'nberm_lock_sync_timer') {
    try {
      chrome.tabs.query({ url: "*://*.nberm.com/*" }, (tabs) => {
        if (chrome.runtime.lastError) return;
        if (tabs && tabs.length > 0) {
          for (const tab of tabs) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_BACKGROUND_SYNC' }, () => {
                if (chrome.runtime.lastError) {
                  // Silently ignore tab sleep / unload
                }
              });
            }
          }
        }
      });
    } catch (e) {}
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'SYNC_STATS') {
    const payload = message.payload;

    fetch(`${VERCEL_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => {
        try { sendResponse({ success: true, status: res.status }); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message }); } catch (e) {}
      });

    return true; // Keep message channel open until fetch finishes
  }
  return false;
});
