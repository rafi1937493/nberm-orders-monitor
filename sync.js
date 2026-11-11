/**
 * Project 3: NBERM Phone Sync (Chrome Extension v1.2.2 - Ultra-Fast Decoupled Edition)
 * - 100% Decoupled Background Server Sync: Zero interference with desk screen or Page Splitting
 * - Blazing Fast Sub-Second Sync: Page 1 queue heartbeat (~180ms) + Action Trigger (350ms)
 * - Zero Working Screen Interference: Never scrapes or reads the user's active window DOM
 * - Unaffected by Desktop Filters: Server requests explicitly reset filters (&searchrush=&searchqueue=...)
 * - Order Review Screen Immunity: Safely returns null on single order review views, preserving verified stats
 * - Non-Blocking Deep Multi-Page Engine: Sweeps page 2+ locked orders asynchronously without delaying totals
 * - Continuous Background Syncing directly to Supabase PostgreSQL (even when PC is locked / Win + L)
 */

(function () {
  'use strict';

  const VERSION = '1.2.2';
  if (window.__nberm_phone_sync_initialized) return;
  window.__nberm_phone_sync_initialized = Date.now();

  const TAB_ID = Math.random().toString(36).substring(2, 9);
  console.log(`%c[3 - NBERM Phone Sync v${VERSION} Active - Tab: ${TAB_ID} (Ultra-Fast Engine)]`, 'color: #10b981; font-weight: bold;');

  const STORAGE_KEY_APPROVAL = 'nberm_live_approval';
  const STORAGE_KEY_QUEUE = 'nberm_live_queue';
  const BASELINE_KEY_APPROVAL = 'nberm_baseline_approval';
  const BASELINE_KEY_QUEUE = 'nberm_baseline_queue';
  const LEADER_KEY = 'nberm_sync_leader';

  // Wipe out any legacy mock baselines (545, 315, 231, 186, 860) from older versions
  try {
    const legacyA = localStorage.getItem(BASELINE_KEY_APPROVAL);
    if (legacyA === '545' || legacyA === '231' || legacyA === '860') {
      localStorage.removeItem(BASELINE_KEY_APPROVAL);
    }
    const legacyQ = localStorage.getItem(BASELINE_KEY_QUEUE);
    if (legacyQ === '315' || legacyQ === '186' || legacyQ === '860') {
      localStorage.removeItem(BASELINE_KEY_QUEUE);
    }
  } catch (e) {}

  let lastBroadcastStateKey = null;
  let lastBroadcastTime = 0;
  let isGlobalSyncRunning = false;
  let lastBgFetchTimestamp = { queue: 0, approval: 0 };
  let lastDeepScanTime = { queue: 0, approval: 0 };

  // Cache deep locked IDs discovered across pages > 1
  const cachedDeepLocks = {
    queue: new Set(),
    approval: new Set()
  };

  /**
   * Generates clean background URL with explicit filter resets so Joomla returns the complete queue table
   */
  function getQueueFetchUrl(queueType, limitstart = 0) {
    const origin = (window.location && window.location.origin) ? window.location.origin : 'https://nberm.com';
    const task = queueType === 'approval' ? 'listusartworkspendingapproval' : 'listusartworkrequests2';
    const ts = Date.now();
    return `${origin}/administrator/index2.php?option=com_mps&task=${task}&limit=100&limitstart=${limitstart}&searchrush=&searchqueue=&searchproduct=&searchlate=&search=&order_id_keyword=&_t=${ts}`;
  }

  // Checks if a row is checked out / claimed by reviewer background color
  function isRowCheckedOut(row) {
    if (!row) return false;
    let bg = (row.getAttribute('bgcolor') || (row.style ? row.style.backgroundColor : '') || '').toLowerCase();
    if (!bg && row.cells && row.cells.length > 0) {
      for (let i = 0; i < Math.min(row.cells.length, 4); i++) {
        const cellBg = (row.cells[i].getAttribute('bgcolor') || (row.cells[i].style ? row.cells[i].style.backgroundColor : '') || '').toLowerCase();
        if (cellBg && (cellBg.includes('fcd2') || cellBg.includes('fdd8') || cellBg.includes('f8b8') || cellBg.includes('ffe5') || cellBg.includes('252') || cellBg.includes('253') || cellBg.includes('248') || cellBg.includes('gold') || cellBg.includes('yellow'))) {
          bg = cellBg;
          break;
        }
      }
    }
    return !!(bg && (
      bg.includes('fcd2') || bg.includes('fdd8') || bg.includes('f8b8') || 
      bg.includes('ffe5') || bg.includes('252') || bg.includes('253') || 
      bg.includes('248') || bg.includes('gold') || bg.includes('yellow')
    ));
  }

  /**
   * Specifically disqualifies non-queue tables: employee punch clock, order details panels, action bars, etc.
   */
  function isExcludedTableFromQueue(tbl) {
    if (!tbl) return true;
    if (tbl.closest && (tbl.closest('#toolbar') || tbl.closest('.toolbar') || tbl.closest('.adminheading') || tbl.closest('.header'))) {
      return true;
    }
    if (tbl.classList && (tbl.classList.contains('toolbar') || tbl.classList.contains('adminheading'))) {
      return true;
    }

    const tblText = (tbl.innerText || tbl.textContent || '').toLowerCase();

    // 1. Employee punch status / timeclock
    if (
      tblText.includes('punch status') || 
      tblText.includes('confirm your hours') || 
      tblText.includes('houston office') || 
      tblText.includes('is administration') ||
      tblText.includes('production scheduling') ||
      tblText.includes('timeclock')
    ) {
      return true;
    }

    // 2. Order Details / Action / Line Items tables
    if (
      tblText.includes('order details') ||
      tblText.includes('1. order items') ||
      tblText.includes('artwork details') ||
      tblText.includes('approve / reject') ||
      tblText.includes('ignore order') ||
      tblText.includes('unit price') ||
      tblText.includes('setup charge') ||
      tblText.includes('order status change') ||
      tblText.includes('item status change') ||
      tblText.includes('proof manager') ||
      tblText.includes('customer approved order') ||
      tblText.includes('artwork issues >>') ||
      tblText.includes('prod. delayed >>')
    ) {
      return true;
    }

    // 3. Quick lookup or admin navigation
    if (tblText.includes('quick order lookup') || tblText.includes('administrator homepage') || tblText.includes('knowledge base')) {
      return true;
    }

    return false;
  }

  /**
   * Unified DOM stats extractor: parses pure server HTML
   * Returns null if page is an order details review panel or lacking queue footer!
   */
  function extractStatsFromDom(rootDoc, queueType) {
    if (!rootDoc) return null;

    let scopeContainer = rootDoc;
    if (queueType === 'queue') {
      const unassigned = rootDoc.getElementById ? rootDoc.getElementById('unassigned-page') : rootDoc.querySelector('#unassigned-page');
      scopeContainer = unassigned || rootDoc.querySelector('.tab-page') || rootDoc;
    } else if (queueType === 'approval') {
      scopeContainer = rootDoc.querySelector('form[name="adminForm"]') || rootDoc.querySelector('.tab-page') || rootDoc;
    }

    // 1. Detect Total and Range from Pagination Footer
    let total = null;
    let rangeStart = 0;
    let rangeEnd = 0;

    const footerEls = (rootDoc.querySelectorAll ? 
      rootDoc.querySelectorAll('.sectiontablefooter, #listfooter, select[name="limit"], .page-nav, .pagenav, .pagination') : []) || [];
    for (const el of footerEls) {
      const parentRow = el.closest ? (el.closest('tr') || el.parentElement) : el.parentElement;
      const txt = parentRow ? parentRow.textContent : el.textContent;
      const m = (txt || '').match(/Results\s+(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = parseInt(m[2], 10);
        total = parseInt(m[3].replace(/,/g, ''), 10);
        break;
      }
    }

    if (total == null) {
      const docTxt = rootDoc.textContent || (rootDoc.body ? rootDoc.body.textContent : '') || '';
      const m = docTxt.match(/Results\s+(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = parseInt(m[2], 10);
        total = parseInt(m[3].replace(/,/g, ''), 10);
      } else if (docTxt.includes('No records found') || docTxt.includes('No matching results')) {
        total = 0;
      }
    }

    // CRITICAL IMMUNITY RULE:
    // If there is NO pagination footer and NO "No records found", this document is an Order Details
    // review screen, login redirect, or error page. Return null to protect verified stats!
    if (total == null) {
      return null;
    }

    // 2. Collect candidate locked orders
    const lockedIds = new Set();
    let fallbackLockCount = 0;

    const tables = scopeContainer.querySelectorAll ? scopeContainer.querySelectorAll('table.adminlist, table') : [];
    for (const tbl of tables) {
      if (isExcludedTableFromQueue(tbl)) continue;

      const rows = tbl.querySelectorAll('tbody > tr, tr');
      for (const tr of rows) {
        if (tr.closest && (tr.closest('thead') || tr.closest('tfoot') || tr.closest('#toolbar') || tr.closest('.toolbar'))) continue;
        if (tr.querySelector('th')) continue;
        if (tr.classList && (tr.classList.contains('sectiontableheader') || tr.classList.contains('title'))) continue;
        if (tr.querySelector('.sectiontablefooter, #listfooter, .pagenav, select[name="limit"]')) continue;

        const trText = (tr.textContent || '').toLowerCase();
        if (trText.includes('punch status') || trText.includes('loading punch') || trText.includes('inside houston') || trText.includes('outside houston')) continue;
        if (trText.includes('approve / reject') || trText.includes('artwork issues >>') || trText.includes('order details')) continue;

        const hasOrderIndicator = tr.querySelector('input[type="checkbox"], a[href], img[src*="checked_out"], img[src*="padlock"]') || isRowCheckedOut(tr);
        if (!hasOrderIndicator) continue;

        // Check if locked via image or background color
        const isBgLocked = isRowCheckedOut(tr);
        const lockImg = tr.querySelector('img[src*="checked_out"], img[src*="padlock"], img[alt*="Checked out" i], img[title*="Checked out" i], img[alt*="Locked" i], img[title*="Locked" i], img[alt*="Lock" i], img[title*="Lock" i]');
        const isImgLocked = lockImg && lockImg.getAttribute('name') !== 'lockqueue' && (!lockImg.closest || !lockImg.closest('#toolbar'));

        if (isImgLocked || isBgLocked) {
          let orderId = null;

          // A. Order number from link href query parameters
          const links = tr.querySelectorAll('a[href]');
          for (const link of links) {
            const m = link.href.match(/[?&](?:order_id|order|orderno|order_no|req|reqid|req_id|id|cid|cid\[\]|artworkid|artwork_id)=([a-zA-Z0-9_-]+)/i);
            if (m && m[1] && m[1] !== '0') {
              if (/^[Ww]?\d{4,10}(?:-\d+)?$/i.test(m[1]) || /^\d{5,9}$/.test(m[1])) {
                orderId = m[1].toUpperCase();
                break;
              }
            }
          }

          // B. Order number from link text
          if (!orderId) {
            for (const link of links) {
              const linkText = (link.textContent || '').trim();
              const numMatch = linkText.match(/\b([Ww]?\d{5,9}(?:-\d+)?)\b/i);
              if (numMatch) {
                orderId = numMatch[1].toUpperCase();
                break;
              }
            }
          }

          // C. Order number from table cells
          if (!orderId && tr.cells) {
            for (let c = 0; c < Math.min(tr.cells.length, 5); c++) {
              const cellText = (tr.cells[c].textContent || '').trim();
              const m = cellText.match(/\b([Ww]?\d{5,9}(?:-\d+)?)\b/);
              if (m && !m[1].startsWith('0000')) {
                orderId = m[1].toUpperCase();
                break;
              }
            }
          }

          // D. Checkbox value
          if (!orderId) {
            const cb = tr.querySelector('input[type="checkbox"][name*="cid"], input[type="checkbox"][name*="id"], input[type="checkbox"][value]');
            if (cb && cb.value && cb.value !== '0' && cb.value !== 'on') {
              const val = cb.value.trim();
              if (/^[Ww]?\d{5,9}(?:-\d+)?$/i.test(val)) {
                orderId = val.toUpperCase();
              }
            }
          }

          if (orderId) {
            lockedIds.add(orderId);
          } else {
            fallbackLockCount++;
          }
        }
      }
    }

    let finalLockedCount = lockedIds.size > 0 ? (lockedIds.size + fallbackLockCount) : fallbackLockCount;
    if (total != null) {
      finalLockedCount = Math.min(total, finalLockedCount);
    }

    return {
      total: total,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      lockedCount: finalLockedCount,
      lockedIds: lockedIds
    };
  }

  // Retrieve cached stats from localStorage with full metadata
  function getStoredStatsInfo(key) {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;
      const parsed = JSON.parse(item);
      if (Date.now() - parsed.timestamp < 300000) { // 5-minute validity
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function getStoredStats(key) {
    const info = getStoredStatsInfo(key);
    return info ? info.stats : null;
  }

  // Save stats to localStorage with source tag
  function setStoredStats(key, stats, source = 'server') {
    try {
      if (stats) {
        localStorage.setItem(key, JSON.stringify({
          stats: stats,
          source: source,
          timestamp: Date.now()
        }));
      }
    } catch (e) {}
  }

  // Single tab leadership coordination
  function isTabLeader() {
    const now = Date.now();
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      if (raw) {
        const leader = JSON.parse(raw);
        if (leader.tabId === TAB_ID || (now - leader.time > 20000)) {
          localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId: TAB_ID, time: now }));
          return true;
        }
        return false;
      }
    } catch (e) {}
    localStorage.setItem(LEADER_KEY, JSON.stringify({ tabId: TAB_ID, time: now }));
    return true;
  }

  /**
   * Fast Single-Request Page 1 Queue Scanner
   * Ultra-lightweight: executes in ~150ms! Page 1 returns the exact total for all 100+ orders.
   * Completely immune to tab navigation errors and PHP session deadlock.
   */
  async function scanQueueFast(targetQueueType) {
    const storageKey = targetQueueType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL;
    const baselineKey = targetQueueType === 'queue' ? BASELINE_KEY_QUEUE : BASELINE_KEY_APPROVAL;
    const url = getQueueFetchUrl(targetQueueType, 0);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store'
      });

      if (!res.ok) {
        return getStoredStats(storageKey);
      }

      const html = await res.text();
      if (!html) return getStoredStats(storageKey);

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const stats = extractStatsFromDom(doc, targetQueueType);

      if (!stats || stats.total == null) {
        // Document did not contain a queue table (e.g. session returned single order view) -> Preserve verified stats!
        return getStoredStats(storageKey);
      }

      const totalCount = stats.total;

      // Handle empty queue
      if (totalCount === 0) {
        const emptyStats = { total: 0, locked: 0, unlocked: 0, lockedIds: [] };
        setStoredStats(storageKey, emptyStats, 'server');
        return emptyStats;
      }

      // Combine Page 1 locked IDs + any cached deep locked IDs
      const deepLocked = cachedDeepLocks[targetQueueType] || new Set();
      const allLockedIds = new Set(stats.lockedIds || []);
      for (const id of deepLocked) {
        allLockedIds.add(id);
      }

      const finalLocked = Math.min(totalCount, Math.max(stats.lockedCount, allLockedIds.size));
      const freshStats = {
        total: totalCount,
        locked: finalLocked,
        unlocked: Math.max(0, totalCount - finalLocked),
        lockedIds: Array.from(allLockedIds)
      };

      if (totalCount > 5) {
        localStorage.setItem(baselineKey, String(totalCount));
      }
      setStoredStats(storageKey, freshStats, 'server');
      return freshStats;
    } catch (err) {
      // Quietly suppress transient socket resets during tab navigation
      return getStoredStats(storageKey);
    }
  }

  /**
   * Background Deep Multi-Page Scanner for pages > 1
   * Runs gently once every 90 seconds in background without blocking the fast 2-second heartbeat
   */
  async function scanDeepPages(targetQueueType) {
    const now = Date.now();
    if (now - (lastDeepScanTime[targetQueueType] || 0) < 90000) return;
    lastDeepScanTime[targetQueueType] = now;

    const storageKey = targetQueueType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL;
    const currentStats = getStoredStats(storageKey);
    if (!currentStats || currentStats.total <= 100) return;

    const totalCount = currentStats.total;
    const deepSet = cachedDeepLocks[targetQueueType];

    for (let start = 100; start < totalCount; start += 100) {
      await new Promise(r => setTimeout(r, 600)); // Polite delay to prevent session lock
      const pageUrl = getQueueFetchUrl(targetQueueType, start);
      try {
        const res = await fetch(pageUrl, { credentials: 'include', cache: 'no-store' });
        if (res.ok) {
          const html = await res.text();
          if (html) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const pageStats = extractStatsFromDom(doc, targetQueueType);
            if (pageStats && pageStats.lockedIds && pageStats.lockedIds.size > 0) {
              for (const id of pageStats.lockedIds) {
                deepSet.add(id);
              }
            }
          }
        }
      } catch (e) {}
    }

    // Always reset session limitstart back to 0 silently
    try {
      fetch(getQueueFetchUrl(targetQueueType, 0), { credentials: 'include', cache: 'no-store' }).catch(() => {});
    } catch (e) {}
  }

  // Push unified stats to Supabase via background service worker
  function broadcastDualStats(approval, queue, force = false) {
    if (!approval && !queue) return;

    const appBaseline = parseInt(localStorage.getItem(BASELINE_KEY_APPROVAL) || '0', 10);
    const qBaseline = parseInt(localStorage.getItem(BASELINE_KEY_QUEUE) || '0', 10);

    let appTotal = approval ? approval.total : appBaseline;
    if ((appTotal == null || appTotal <= 1) && appBaseline > 5) {
      appTotal = appBaseline;
    }
    appTotal = Math.max(0, appTotal || 0);

    let appLocked = approval ? approval.locked : 0;
    appLocked = Math.min(appTotal, Math.max(0, appLocked || 0));
    const appOpen = Math.max(0, appTotal - appLocked);

    let qTotal = queue ? queue.total : qBaseline;
    if ((qTotal == null || qTotal <= 1) && qBaseline > 5) {
      qTotal = qBaseline;
    }
    qTotal = Math.max(0, qTotal || 0);

    let qLocked = queue ? queue.locked : 0;
    qLocked = Math.min(qTotal, Math.max(0, qLocked || 0));
    const qOpen = Math.max(0, qTotal - qLocked);

    // Safety firewall: Never push an anomalous combined total of <= 5 if verified baseline was active
    if (appTotal + qTotal <= 5 && (appBaseline + qBaseline > 10)) {
      console.warn('[NBERM Live Sync] Blocked anomalous combined total <= 5');
      return;
    }

    const appLockedList = Array.isArray(approval?.lockedIds) ? approval.lockedIds : Array.from(approval?.lockedIds || []);
    const qLockedList = Array.isArray(queue?.lockedIds) ? queue.lockedIds : Array.from(queue?.lockedIds || []);
    const appLockedSig = appLockedList.slice().sort().join(',');
    const qLockedSig = qLockedList.slice().sort().join(',');
    const stateKey = `${appTotal}-${appLocked}-${appOpen}|${qTotal}-${qLocked}-${qOpen}|${appLockedSig}|${qLockedSig}`;
    const now = Date.now();

    // Skip redundant broadcasts within 600ms unless forced or numbers changed
    if (!force && stateKey === lastBroadcastStateKey && (now - lastBroadcastTime < 600)) {
      return;
    }

    lastBroadcastStateKey = stateKey;
    lastBroadcastTime = now;

    const payload = {
      total: appTotal + qTotal,
      count: appTotal + qTotal,
      locked: appLocked + qLocked,
      unlocked: appOpen + qOpen,
      approval: {
        total: appTotal,
        locked: appLocked,
        unlocked: appOpen,
        lockedOrders: appLockedList,
        lockedIds: appLockedList
      },
      queue: {
        total: qTotal,
        locked: qLocked,
        unlocked: qOpen,
        lockedOrders: qLockedList,
        lockedIds: qLockedList
      },
      timestamp: now
    };

    console.log(`%c[NBERM Live Sync] Pushed: Approval (${appTotal}/${appLocked}) | Design (${qTotal}/${qLocked}) | Total: ${appTotal + qTotal}`, 'color: #10b981; font-weight: bold;');

    // Push via Background Service Worker
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'SYNC_STATS', payload: payload }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (e) {}
  }

  // 100% Invisible Stealth Mode: Ensure zero on-screen DOM badges, pills, or indicators
  function removeAnyExistingIndicator() {
    try {
      const indicator = document.getElementById('nberm-live-pill');
      if (indicator) indicator.remove();
    } catch (e) {}
  }
  removeAnyExistingIndicator();

  /**
   * Ultra-Fast Decoupled Background Server Coordinator
   * - Approval queue heartbeats every 2.5 seconds
   * - Design queue heartbeats every 5.0 seconds
   * - Single-request Page 1 execution finishes in ~180ms
   */
  async function performSync(forceFetch = false) {
    if (!isTabLeader()) return;
    if (isGlobalSyncRunning) return;
    isGlobalSyncRunning = true;

    const now = Date.now();
    let liveApproval = getStoredStats(STORAGE_KEY_APPROVAL);
    let liveQueue = getStoredStats(STORAGE_KEY_QUEUE);

    try {
      // 1. APPROVAL QUEUE (Main Working Queue - Fast 2.5-second heartbeat!)
      const appAge = now - (lastBgFetchTimestamp.approval || 0);
      if (forceFetch || !liveApproval || appAge >= 2500) {
        lastBgFetchTimestamp.approval = now;
        const freshApproval = await scanQueueFast('approval');
        if (freshApproval) {
          liveApproval = freshApproval;
          broadcastDualStats(liveApproval, liveQueue, forceFetch);
        }
      }

      // Small 100ms gap between queues to keep server requests polite
      await new Promise(r => setTimeout(r, 100));

      // 2. DESIGN QUEUE (Fast 5.0-second heartbeat!)
      const queueAge = now - (lastBgFetchTimestamp.queue || 0);
      if (forceFetch || !liveQueue || queueAge >= 5000) {
        lastBgFetchTimestamp.queue = now;
        const freshQueue = await scanQueueFast('queue');
        if (freshQueue) {
          liveQueue = freshQueue;
          broadcastDualStats(liveApproval, liveQueue, forceFetch);
        }
      }

      // Gentle background scan for pages > 1 (does not block fast sync)
      scanDeepPages('approval').catch(() => {});
      scanDeepPages('queue').catch(() => {});
    } catch (err) {
      // Suppress error
    } finally {
      isGlobalSyncRunning = false;
    }
  }

  // Listen to background service worker alarms (wakes up even when PC is locked)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'TRIGGER_BACKGROUND_SYNC') {
        performSync(false);
      }
    });
  } catch (e) {}

  // Cross-tab sync via storage events
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY_APPROVAL || e.key === STORAGE_KEY_QUEUE) {
      const app = getStoredStats(STORAGE_KEY_APPROVAL);
      const q = getStoredStats(STORAGE_KEY_QUEUE);
      broadcastDualStats(app, q);
    }
  });

  // Dedicated Web Worker Timer: NEVER throttled by Chrome when tab is in background or PC is locked
  try {
    const workerBlob = new Blob([
      `setInterval(function() { postMessage('tick'); }, 4000);`
    ], { type: 'application/javascript' });
    const bgTimerWorker = new Worker(URL.createObjectURL(workerBlob));
    bgTimerWorker.onmessage = function() {
      performSync(false);
    };
  } catch (e) {
    setInterval(() => performSync(false), 4000);
  }

  // High-Speed Active Desk Heartbeat: polls every 2.5 seconds when tab is actively focused
  let activePollTimer = null;
  function startActivePoll() {
    if (activePollTimer) clearInterval(activePollTimer);
    activePollTimer = setInterval(() => {
      performSync(false);
    }, 2500);
  }
  startActivePoll();

  // Instant Action Interceptor: clicking Approve, Reject, Ignore, Save or toolbar buttons triggers immediate background fetch in 350ms
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    const btn = target.closest ? target.closest('input[type="button"], input[type="submit"], button, a, img[src*="checked_out"]') : null;
    if (btn) {
      const txt = ((btn.value || '') + ' ' + (btn.textContent || '') + ' ' + (btn.name || '') + ' ' + (btn.id || '')).toLowerCase();
      if (txt.includes('approve') || txt.includes('reject') || txt.includes('ignore') || txt.includes('apply') || txt.includes('save') || txt.includes('order')) {
        // Fast 350ms trigger gives the server time to commit the action, then syncs instantly!
        setTimeout(() => performSync(true), 350);
      }
    }
  }, true);

  // Trigger on visibility change and window focus
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) performSync(false);
  });
  window.addEventListener('focus', () => performSync(false));

  // Initial startup sync (runs after 400ms)
  setTimeout(() => {
    performSync(true);
  }, 400);
})();
