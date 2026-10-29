/**
 * Project 3: NBERM Phone Sync (Chrome Extension v1.0.3)
 * - Complete Multi-Page Scanner: Fetches ALL orders across ALL pages beyond the 100 limit
 * - Bulletproof Lock Detection: Uses DOMParser & Order ID Sets to count exact unique locked orders
 * - Dual-Queue Live Tracking: Syncs Approval & Queue simultaneously
 * - Zero Lag & Safe Session: Non-destructive background requests
 * - Background Web Worker Timer: Keeps syncing even when PC is locked (Win + L)
 */

(function () {
  'use strict';

  const VERSION = '1.0.3';
  window.__nberm_phone_sync_initialized = Date.now();

  console.log(`%c[3 - NBERM Phone Sync v${VERSION} Initialized]`, 'color: #10b981; font-weight: bold; font-size: 14px;');

  const VERCEL_URL = 'https://nberm-orders-monitor.vercel.app';
  try { localStorage.removeItem('nberm_vercel_url'); } catch (e) {}

  const APPROVAL_URL = 'https://nberm.com/administrator/index2.php?option=com_mps&task=listusartworkspendingapproval';
  const QUEUE_URL = 'https://nberm.com/administrator/index2.php?option=com_mps&task=listusartworkrequests2';

  const STORAGE_KEY_APPROVAL = 'nberm_live_approval';
  const STORAGE_KEY_QUEUE = 'nberm_live_queue';
  const BASELINE_KEY_APPROVAL = 'nberm_baseline_approval';
  const BASELINE_KEY_QUEUE = 'nberm_baseline_queue';

  // Seed baseline memory with known totals
  if (!localStorage.getItem(BASELINE_KEY_APPROVAL)) {
    localStorage.setItem(BASELINE_KEY_APPROVAL, '231');
  }
  if (!localStorage.getItem(BASELINE_KEY_QUEUE)) {
    localStorage.setItem(BASELINE_KEY_QUEUE, '186');
  }

  let lastBroadcastStateKey = null;
  let lastBroadcastTime = 0;

  let cachedApproval = null;
  let cachedQueue = null;
  let isScanning = false;

  const SCAN_INTERVAL_MS = 10000; // Rescan all pages every 10 seconds
  let lastScanTimestamp = { queue: 0, approval: 0 };
  let cachedScanData = { queue: null, approval: null };

  function detectCurrentPage() {
    const url = window.location.href;
    if (url.includes('listusartworkrequests2')) return 'queue';
    if (url.includes('listusartworkspendingapproval')) return 'approval';

    const pathway = document.querySelector('.pathway');
    if (pathway) {
      const pText = (pathway.innerText || '').toLowerCase();
      if (pText.includes('listusartworkrequests2')) return 'queue';
      if (pText.includes('listusartworkspendingapproval')) return 'approval';
    }

    const heading = document.querySelector('.adminheading');
    if (heading) {
      const hText = (heading.innerText || '').toLowerCase();
      if (hText.includes('designs queue')) return 'queue';
      if (hText.includes('designs approval')) return 'approval';
    }

    if (document.getElementById('unassigned-page')) return 'queue';
    return 'unknown';
  }

  /**
   * Parses an HTML string using DOMParser to extract:
   * 1. Total order count from pagination footer (e.g. "Results 1 - 100 of 231")
   * 2. Range displayed (start, end)
   * 3. Set of unique locked order IDs
   */
  function parsePageHtml(html, queueName = '') {
    if (!html || typeof html !== 'string') {
      return { total: null, rangeStart: 0, rangeEnd: 0, lockedIds: new Set(), lockedCount: 0 };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // 1. Detect Total and Range from Pagination Footer
    let total = null;
    let rangeStart = 0;
    let rangeEnd = 0;

    const footerEls = doc.querySelectorAll('.sectiontablefooter, #listfooter, select[name="limit"], .page-nav, .pagenav');
    for (const el of footerEls) {
      const parentRow = el.closest('tr') || el.parentElement;
      const txt = parentRow ? parentRow.textContent : el.textContent;
      const m = txt.match(/Results\s+(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = parseInt(m[2], 10);
        total = parseInt(m[3].replace(/,/g, ''), 10);
        break;
      }
    }

    if (total == null) {
      const bodyTxt = doc.body ? (doc.body.textContent || '') : '';
      const m = bodyTxt.match(/Results\s+(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = parseInt(m[2], 10);
        total = parseInt(m[3].replace(/,/g, ''), 10);
      } else if (bodyTxt.includes('No records found')) {
        total = 0;
      }
    }

    // 2. Count locked orders from order table rows
    const lockedIds = new Set();
    let fallbackLockCount = 0;

    // Select all rows inside list tables
    const rows = doc.querySelectorAll('table.adminlist tbody tr, table.adminlist tr, .adminlist tr, table tr');
    for (const tr of rows) {
      // Exclude navigation, toolbars, headers
      if (tr.closest('thead') || tr.closest('tfoot') || tr.closest('#toolbar') || tr.closest('.toolbar')) continue;
      if (tr.querySelector('th')) continue;

      // Check for lock / checked_out icons inside this row
      const lockImg = tr.querySelector('img[src*="checked_out"], img[src*="padlock"], img[alt*="Check" i], img[alt*="Lock" i]');
      if (lockImg) {
        // Skip queue-lock buttons or toolbar buttons
        if (lockImg.getAttribute('name') === 'lockqueue' || lockImg.closest('#toolbar')) continue;

        // Extract row order identifier (checkbox value `cid[]`, order link ID, or row text)
        const cb = tr.querySelector('input[type="checkbox"][name*="cid"], input[type="checkbox"][name*="id"], input[type="checkbox"][value]');
        const link = tr.querySelector('a[href*="id="], a[href*="order_id="]');
        let orderId = null;

        if (cb && cb.value && cb.value !== '0' && cb.value !== 'on') {
          orderId = cb.value.trim();
        } else if (link && link.href) {
          const match = link.href.match(/[?&](?:id|order_id)=(\d+)/i);
          if (match) orderId = match[1];
        }

        if (orderId) {
          lockedIds.add(orderId);
        } else {
          fallbackLockCount++;
        }
      }
    }

    const finalLockedCount = lockedIds.size > 0 ? (lockedIds.size + fallbackLockCount) : fallbackLockCount;

    return {
      total: total,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      pageSize: (rangeEnd - rangeStart + 1) > 0 ? (rangeEnd - rangeStart + 1) : 100,
      lockedIds: lockedIds,
      lockedCount: finalLockedCount
    };
  }

  /**
   * Scans an entire queue across ALL pages (beyond the 100 limit):
   * 1. Attempts single-fetch with large limit (e.g. limit=1000)
   * 2. If Joomla caps at 100, sequentially/parallel fetches pages 1, 2, 3...
   * 3. Collects and deduplicates every locked order across all pages!
   */
  async function scanEntireQueue(queueType, force = false) {
    const now = Date.now();
    if (!force && cachedScanData[queueType] && (now - lastScanTimestamp[queueType] < SCAN_INTERVAL_MS)) {
      return cachedScanData[queueType];
    }

    const baseUrl = queueType === 'queue' ? QUEUE_URL : APPROVAL_URL;
    const taskName = queueType === 'queue' ? 'listusartworkrequests2' : 'listusartworkspendingapproval';

    try {
      // Step 1: Fetch Page 1 (request limit=1000 to attempt retrieving all records in one shot)
      const cleanUrl1 = `${baseUrl}&limit=1000&limitstart=0&searchqueue=&searchrush=&searchlate=&search=`;
      const res1 = await fetch(cleanUrl1, { credentials: 'include' });
      if (!res1.ok) {
        console.warn(`[NBERM Phone Sync] Fetch failed for ${queueType} (status ${res1.status})`);
        return cachedScanData[queueType];
      }

      const html1 = await res1.text();
      const page1 = parsePageHtml(html1, queueType);

      if (page1.total === 0) {
        const emptyResult = { total: 0, locked: 0, unlocked: 0 };
        cachedScanData[queueType] = emptyResult;
        lastScanTimestamp[queueType] = now;
        return emptyResult;
      }

      // Determine baseline / fallback total if pagination footer wasn't matched
      const baselineKey = queueType === 'queue' ? BASELINE_KEY_QUEUE : BASELINE_KEY_APPROVAL;
      const savedBaseline = parseInt(localStorage.getItem(baselineKey) || (queueType === 'queue' ? '186' : '231'), 10);
      const totalCount = page1.total != null ? page1.total : savedBaseline;

      const allLockedIds = new Set(page1.lockedIds);
      let totalFallbackLocks = page1.lockedIds.size === 0 ? page1.lockedCount : 0;

      // Check if limit=1000 returned all rows (e.g. rangeEnd >= totalCount)
      if (page1.rangeEnd >= totalCount || page1.rangeEnd === 0) {
        // All rows were returned in page 1!
        const totalLocked = allLockedIds.size > 0 ? (allLockedIds.size + totalFallbackLocks) : page1.lockedCount;
        const result = {
          total: totalCount,
          locked: totalLocked,
          unlocked: Math.max(0, totalCount - totalLocked)
        };

        cachedScanData[queueType] = result;
        lastScanTimestamp[queueType] = now;
        if (totalCount > 0) localStorage.setItem(baselineKey, String(totalCount));

        console.log(`%c[NBERM Scan: ${queueType.toUpperCase()}] Complete in 1 page: Total: ${totalCount} | Locked: ${totalLocked} | Open: ${result.unlocked}`, 'color: #38bdf8; font-weight: bold;');
        return result;
      }

      // Step 2: Joomla capped at pageSize (typically 100). Fetch remaining pages (100, 200, 300...)
      const pageSize = page1.rangeEnd > 0 ? page1.rangeEnd : 100;
      const totalPages = Math.ceil(totalCount / pageSize);
      console.log(`[NBERM Scan: ${queueType.toUpperCase()}] Paginating: Total ${totalCount} items across ${totalPages} pages (Page 1 has ${page1.lockedCount} locks)`);

      const remainingFetches = [];
      for (let start = pageSize; start < totalCount; start += pageSize) {
        // Send via both POST and GET parameters so Joomla accepts limitstart regardless of configuration
        const pageUrl = `${baseUrl}&limit=${pageSize}&limitstart=${start}&searchqueue=&searchrush=&searchlate=&search=`;
        const postData = new URLSearchParams();
        postData.append('option', 'com_mps');
        postData.append('task', taskName);
        postData.append('limit', String(pageSize));
        postData.append('limitstart', String(start));
        postData.append('searchqueue', '');
        postData.append('searchrush', '');
        postData.append('searchlate', '');
        postData.append('search', '');

        remainingFetches.push(
          fetch(pageUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: postData.toString(),
            credentials: 'include'
          })
            .then(r => r.ok ? r.text() : '')
            .catch(() => '')
        );
      }

      const remainingHtmls = await Promise.all(remainingFetches);
      let pageIdx = 2;
      for (const pageHtml of remainingHtmls) {
        if (pageHtml) {
          const parsed = parsePageHtml(pageHtml, queueType);
          console.log(`[NBERM Scan: ${queueType.toUpperCase()}] Page ${pageIdx}/${totalPages}: found ${parsed.lockedCount} locks`);
          if (parsed.lockedIds.size > 0) {
            for (const id of parsed.lockedIds) {
              allLockedIds.add(id);
            }
          } else {
            totalFallbackLocks += parsed.lockedCount;
          }
        }
        pageIdx++;
      }

      // Reset session limitstart back to 0 silently so user's PC view is unaffected
      try {
        fetch(`${baseUrl}&limit=${pageSize}&limitstart=0`, { credentials: 'include' }).catch(() => {});
      } catch (e) {}

      const finalLockedTotal = allLockedIds.size > 0 ? (allLockedIds.size + totalFallbackLocks) : (page1.lockedCount + totalFallbackLocks);
      const stats = {
        total: totalCount,
        locked: finalLockedTotal,
        unlocked: Math.max(0, totalCount - finalLockedTotal)
      };

      cachedScanData[queueType] = stats;
      lastScanTimestamp[queueType] = now;
      if (totalCount > 0) localStorage.setItem(baselineKey, String(totalCount));

      console.log(`%c[NBERM Scan: ${queueType.toUpperCase()} FINISHED]`, 'color: #10b981; font-weight: bold;',
        `Total: ${stats.total} | Locked: ${stats.locked} | Open: ${stats.unlocked} across ALL ${totalPages} pages`);

      return stats;
    } catch (err) {
      console.warn(`[NBERM Scan Error: ${queueType}]`, err);
      return cachedScanData[queueType];
    }
  }

  function getStoredStats(key) {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;
      const parsed = JSON.parse(item);
      if (Date.now() - parsed.timestamp < 120000) {
        return parsed.stats;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function setStoredStats(key, stats) {
    try {
      if (stats) {
        localStorage.setItem(key, JSON.stringify({
          stats: stats,
          timestamp: Date.now()
        }));
      }
    } catch (e) {}
  }

  function broadcastDualStats(approval, queue, force = false) {
    if (!approval && !queue) return;

    const appBaseline = parseInt(localStorage.getItem(BASELINE_KEY_APPROVAL) || '231', 10);
    const qBaseline = parseInt(localStorage.getItem(BASELINE_KEY_QUEUE) || '186', 10);

    const appTotal = approval ? approval.total : appBaseline;
    const appLocked = approval ? approval.locked : 0;
    const appOpen = approval ? approval.unlocked : Math.max(0, appTotal - appLocked);

    const qTotal = queue ? queue.total : qBaseline;
    const qLocked = queue ? queue.locked : 0;
    const qOpen = queue ? queue.unlocked : Math.max(0, qTotal - qLocked);

    const stateKey = `${appTotal}-${appLocked}-${appOpen}|${qTotal}-${qLocked}-${qOpen}`;
    const now = Date.now();

    if (!force && stateKey === lastBroadcastStateKey && (now - lastBroadcastTime < 5000)) {
      return;
    }

    lastBroadcastStateKey = stateKey;
    lastBroadcastTime = now;

    const payload = {
      total: appTotal + qTotal,
      count: appTotal + qTotal,
      locked: appLocked + qLocked,
      unlocked: appOpen + qOpen,
      approval: { total: appTotal, locked: appLocked, unlocked: appOpen },
      queue: { total: qTotal, locked: qLocked, unlocked: qOpen },
      timestamp: now
    };

    console.log('%c[NBERM Phone Sync] Broadcasting Live Stats:', 'color: #38bdf8; font-weight: bold;', {
      Approval: `${appTotal} (Locked: ${appLocked}, Open: ${appOpen})`,
      Queue: `${qTotal} (Locked: ${qLocked}, Open: ${qOpen})`
    });

    // 1. Send via Background Service Worker
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'SYNC_STATS', payload: payload }, () => {
          const err = chrome.runtime.lastError;
        });
      }
    } catch (e) {}

    // 2. Direct fetch fallback to Vercel API
    try {
      fetch(`${VERCEL_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch (e) {}
  }

  async function syncAllQueues() {
    if (isScanning) return;
    isScanning = true;

    try {
      const pageType = detectCurrentPage();
      if (pageType === 'unknown') {
        console.log('[NBERM Phone Sync] Not on a queue/approval page. URL:', window.location.href);
        return;
      }

      // Scan BOTH queues completely across ALL pages (beyond the 100 limit)
      const [qStats, aStats] = await Promise.all([
        scanEntireQueue('queue'),
        scanEntireQueue('approval')
      ]);

      if (qStats) {
        cachedQueue = qStats;
        setStoredStats(STORAGE_KEY_QUEUE, qStats);
      }
      if (aStats) {
        cachedApproval = aStats;
        setStoredStats(STORAGE_KEY_APPROVAL, aStats);
      }

      broadcastDualStats(cachedApproval, cachedQueue);
    } catch (err) {
      console.error('[NBERM Sync Error]:', err);
    } finally {
      isScanning = false;
    }
  }

  // Cross-tab synchronization via storage events (0 CPU overhead)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY_APPROVAL || e.key === STORAGE_KEY_QUEUE) {
      const storedApp = getStoredStats(STORAGE_KEY_APPROVAL);
      const storedQ = getStoredStats(STORAGE_KEY_QUEUE);
      if (storedApp) cachedApproval = storedApp;
      if (storedQ) cachedQueue = storedQ;
      broadcastDualStats(cachedApproval, cachedQueue);
    }
  });

  // Background Web Worker timer: keeps firing every 10 seconds even if tab is in background or PC is locked
  try {
    const workerBlob = new Blob([
      `setInterval(function() { postMessage('t'); }, 10000);`
    ], { type: 'application/javascript' });
    const bgTimerWorker = new Worker(URL.createObjectURL(workerBlob));
    bgTimerWorker.onmessage = function() {
      syncAllQueues();
    };
  } catch (e) {
    setInterval(syncAllQueues, 10000);
  }

  // Initial scan immediately upon page load
  syncAllQueues();
})();
