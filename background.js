/**
 * Background Service Worker for NBERM Phone Sync (v1.0.9 - Supabase Edition)
 * - Direct real-time sync to Supabase PostgreSQL (zero quota restrictions).
 * - Runs with full extension privileges, bypassing page CSP restrictions.
 * - Chrome Alarms keep this worker alive even when PC is locked (Win + L).
 * - Bulletproof error suppression for unmounted tabs and port disconnects.
 */

const SUPABASE_URL = 'https://qloghdvzdvdaecvggtuh.supabase.co';
const SUPABASE_KEY = 'sb_secret_dCCEjkX06RoaKG44MDkkyg_k5mSxc4u';
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

    // 1. Primary Push directly to Supabase REST API (Instant & Unlimited)
    const supabasePayload = {
      id: 'current',
      total: Number(payload.total || 0),
      count: Number(payload.count || payload.total || 0),
      locked: Number(payload.locked || 0),
      unlocked: Number(payload.unlocked || 0),
      approval: payload.approval || {},
      queue: payload.queue || {},
      updated_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: payload.timestamp || Date.now()
    };

    fetch(`${SUPABASE_URL}/rest/v1/orders_status?on_conflict=id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(supabasePayload)
    })
      .then(res => {
        try { sendResponse({ success: true, status: res.status }); } catch (e) {}
      })
      .catch(err => {
        try { sendResponse({ success: false, error: err.message }); } catch (e) {}
      });

    // 2. Secondary fallback
    try {
      fetch(`${VERCEL_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch (e) {}

    return true; // Keep message channel open until fetch finishes
  }
  return false;
});
