/**
 * Background Service Worker for NBERM Phone Sync
 * Runs with full extension privileges, bypassing page CSP restrictions.
 */

const VERCEL_URL = 'https://nberm-orders-monitor.vercel.app';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'SYNC_STATS') {
    const payload = message.payload;
    console.log('[NBERM Background Worker] Pushing stats to Vercel API:', payload);

    fetch(`${VERCEL_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(res => {
      console.log('[NBERM Background Worker] Vercel sync status:', res.status);
    }).catch(err => {
      console.error('[NBERM Background Worker] Vercel sync error:', err);
    });

    sendResponse({ success: true });
  }
  return true;
});
