/**
 * Background Service Worker for NBERM Phone Sync
 * Runs with full extension privileges, bypassing page CSP restrictions.
 */

const VERCEL_URL = 'https://nberm-orders-monitor.vercel.app';

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
