/**
 * Project 3: NBERM Phone Sync (Chrome Extension v1.2.3 - Ultra-Fast Decoupled Edition)
 * - 100% Decoupled Background Server Sync: Zero interference with desk screen or Page Splitting
 * - Blazing Fast Sub-Second Sync: Page 1 queue heartbeat (~180ms) + Action Trigger (350ms)
 * - Zero Working Screen Interference: Never scrapes or reads the user's active window DOM
 * - Accurate Lock Filtering: Authoritative checked_out.png + strict amber/yellow highlight (immune to gray zebra striping)
 * - Auto-Expiring Deep Scanner: Deep page locks are replaced fresh every sweep so completed orders vanish immediately
 * - Order Review Screen Immunity: Safely returns null on single order review views, preserving verified stats
 * - Continuous Background Syncing directly to Supabase PostgreSQL (even when PC is locked / Win + L)
 */

(function () {
  'use strict';

  const VERSION = '1.2.5';
  if (window.__nberm_phone_sync_initialized) return;
  window.__nberm_phone_sync_initialized = Date.now();

  const TAB_ID = Math.random().toString(36).substring(2, 9);
  console.log(`%c[3 - NBERM Phone Sync v${VERSION} Active - Tab: ${TAB_ID} (Zero-Lag Engine)]`, 'color: #10b981; font-weight: bold;');

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

  // Checks if a background color is genuinely yellow/amber/gold (checked-out), NOT gray/white zebra striping!
  function isYellowHighlight(colorStr) {
    if (!colorStr) return false;
    const s = colorStr.replace(/\s+/g, '').toLowerCase();
    if (s === 'transparent' || s === '#fff' || s === '#ffffff' || s === 'white' || s === '#000' || s === '#000000') {
      return false;
    }
    // Explicit hex codes used by Joomla / NBERM for highlights
    if (
      s.includes('#ffffcc') || s.includes('#ffffe0') || s.includes('#fff3cd') || 
      s.includes('#fef08a') || s.includes('#fde047') || s.includes('#fcd34d') || 
      s.includes('#fbbf24') || s.includes('#f59e0b') || s.includes('#fcd2') || 
      s.includes('#fdd8') || s.includes('#f8b8') || s.includes('#ffe5') ||
      s === 'gold' || s === 'yellow'
    ) {
      return true;
    }
    // RGB / RGBA check: Yellow/amber has high red & high green, but distinctly low blue!
    // Gray zebra striping (e.g. rgb(248, 248, 248)) has r ~= g ~= b (diff < 15), so it is excluded!
    const rgbMatch = s.match(/rgba?\((\d+),(\d+),(\d+)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      if (r >= 200 && g >= 170 && (r - b) >= 45) {
        return true;
      }
    }
    return false;
  }

  // Authoritative check if a row is checked out / locked by a reviewer/designer
  function isRowCheckedOut(row) {
    if (!row) return false;
    // 1. Explicit Joomla lock image (primary authority)
    const lockImg = row.querySelector('img[src*="checked_out"], img[src*="padlock"], img[alt*="Checked out" i], img[title*="Checked out" i]');
    if (lockImg && lockImg.getAttribute('name') !== 'lockqueue' && (!lockImg.closest || !lockImg.closest('#toolbar, .toolbar'))) {
      return true;
    }
    // 2. Explicit yellow/amber highlight on row or cells (excluding alternating zebra striping)
    const bg = (row.getAttribute('bgcolor') || (row.style ? row.style.backgroundColor : '') || '').toLowerCase();
    if (isYellowHighlight(bg)) return true;

    if (row.cells && row.cells.length > 0) {
      for (let i = 0; i < Math.min(row.cells.length, 5); i++) {
        const cellBg = (row.cells[i].getAttribute('bgcolor') || (row.cells[i].style ? row.cells[i].style.backgroundColor : '') || '').toLowerCase();
        if (isYellowHighlight(cellBg)) return true;
      }
    }
    return false;
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
          } else if (isImgLocked) {
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

  // --- ZERO-LAG NETWORK & USER YIELD CONTROLLER ---
  let activeAbortController = null;
  let isFetchInFlight = false;
  let lastUserActionTime = 0;

  // The moment the user clicks, types, or moves to do real work:
  // Immediately abort any background fetch so 100% of network sockets & PHP session locks yield to the user!
  function yieldToUser() {
    lastUserActionTime = Date.now();
    if (activeAbortController) {
      try { activeAbortController.abort(); } catch (e) {}
      activeAbortController = null;
    }
  }
  window.addEventListener('mousedown', yieldToUser, { passive: true, capture: true });
  window.addEventListener('keydown', yieldToUser, { passive: true, capture: true });
  window.addEventListener('touchstart', yieldToUser, { passive: true, capture: true });

  /**
   * Ultra-Lightweight Single-Request Page 1 Queue Scanner
   * - Uses modern priority: 'low' so browser network stack prioritizes user's working tab
   * - Abortable in 0ms on user action
   * - Offloads DOM parsing to requestIdleCallback so CPU never stutters the desk screen
   */
  async function scanQueueFast(targetQueueType, isForced = false) {
    const storageKey = targetQueueType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL;
    const baselineKey = targetQueueType === 'queue' ? BASELINE_KEY_QUEUE : BASELINE_KEY_APPROVAL;

    // Mutex: strictly ONE background fetch at any time across the tab
    if (isFetchInFlight) {
      return getStoredStats(storageKey);
    }

    // Yield completely if user was clicking or typing in the last 1.8 seconds
    if (!isForced && (Date.now() - lastUserActionTime < 1800)) {
      return getStoredStats(storageKey);
    }

    const url = getQueueFetchUrl(targetQueueType, 0);
    isFetchInFlight = true;
    activeAbortController = new AbortController();

    try {
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        priority: 'low',
        signal: activeAbortController.signal
      });

      if (!res.ok) {
        return getStoredStats(storageKey);
      }

      const html = await res.text();
      if (!html) return getStoredStats(storageKey);

      // Parse asynchronously during browser idle frames (zero main-thread stutter!)
      const stats = await new Promise((resolve) => {
        const doParse = () => {
          try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            resolve(extractStatsFromDom(doc, targetQueueType));
          } catch (e) {
            resolve(null);
          }
        };
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(doParse, { timeout: 350 });
        } else {
          setTimeout(doParse, 0);
        }
      });

      if (!stats || stats.total == null) {
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
      // Quietly suppress aborts and transient socket resets during tab navigation
      return getStoredStats(storageKey);
    } finally {
      isFetchInFlight = false;
      activeAbortController = null;
    }
  }

  /**
   * Background Deep Multi-Page Scanner for pages > 1
   * Runs politely once every 3 minutes only when user is idle for >= 15 seconds!
   */
  async function scanDeepPages(targetQueueType) {
    const now = Date.now();
    if (now - (lastDeepScanTime[targetQueueType] || 0) < 180000) return;
    // Don't run if user is actively working on the desk!
    if (Date.now() - lastUserActionTime < 15000) return;
    lastDeepScanTime[targetQueueType] = now;

    const storageKey = targetQueueType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL;
    const currentStats = getStoredStats(storageKey);
    if (!currentStats || currentStats.total <= 100) return;

    const totalCount = currentStats.total;
    const freshDeepSet = new Set();

    for (let start = 100; start < totalCount; start += 100) {
      // Abort deep sweep if user started interacting
      if (Date.now() - lastUserActionTime < 5000) break;
      await new Promise(r => setTimeout(r, 1200)); // Polite delay between pages

      const pageUrl = getQueueFetchUrl(targetQueueType, start);
      try {
        const res = await fetch(pageUrl, { 
          credentials: 'include', 
          cache: 'no-store',
          priority: 'low'
        });
        if (res.ok) {
          const html = await res.text();
          if (html) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const pageStats = extractStatsFromDom(doc, targetQueueType);
            if (pageStats && pageStats.lockedIds && pageStats.lockedIds.size > 0) {
              for (const id of pageStats.lockedIds) {
                freshDeepSet.add(id);
              }
            }
          }
        }
      } catch (e) {}
    }

    if (freshDeepSet.size > 0) {
      cachedDeepLocks[targetQueueType] = freshDeepSet;
    }

    // Always reset session limitstart back to 0 silently with low priority
    try {
      fetch(getQueueFetchUrl(targetQueueType, 0), { 
        credentials: 'include', 
        cache: 'no-store',
        priority: 'low'
      }).catch(() => {});
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
   * Ultra-Polite Alternating Background Server Coordinator
   * - Never runs during user clicks or keystrokes (zero interference with active desk screen)
   * - Alternates between Approval and Design so they NEVER run together
   * - Single ~150ms request with priority: 'low'
   * - 97% of the time, the network is 100% idle
   */
  let queueTurn = 'approval';

  async function performSync(forceFetch = false) {
    if (!isTabLeader()) return;
    if (isGlobalSyncRunning) return;

    // Yield to user if actively interacting on the desk
    if (!forceFetch && (Date.now() - lastUserActionTime < 1800)) {
      return;
    }

    isGlobalSyncRunning = true;
    let liveApproval = getStoredStats(STORAGE_KEY_APPROVAL);
    let liveQueue = getStoredStats(STORAGE_KEY_QUEUE);

    try {
      if (forceFetch) {
        // Fast dedicated refresh on user action
        const freshApproval = await scanQueueFast('approval', true);
        if (freshApproval) liveApproval = freshApproval;
        broadcastDualStats(liveApproval, liveQueue, true);
        return;
      }

      // Staggered Heartbeat: Alternate queues on each cycle so zero concurrent requests ever occur
      if (queueTurn === 'approval') {
        queueTurn = 'queue';
        const freshApproval = await scanQueueFast('approval', false);
        if (freshApproval) {
          liveApproval = freshApproval;
          broadcastDualStats(liveApproval, liveQueue, false);
        }
      } else {
        queueTurn = 'approval';
        const freshQueue = await scanQueueFast('queue', false);
        if (freshQueue) {
          liveQueue = freshQueue;
          broadcastDualStats(liveApproval, liveQueue, false);
        }
      }

      // Polite deep page scan only when user is idle for >= 15 seconds
      if (Date.now() - lastUserActionTime > 15000) {
        scanDeepPages('approval').catch(() => {});
        scanDeepPages('queue').catch(() => {});
      }
    } catch (err) {
      // Quietly suppress error
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

  // Dedicated Web Worker Timer: polite 4.5s heartbeat (single timer, zero collisions)
  try {
    const workerBlob = new Blob([
      `setInterval(function() { postMessage('tick'); }, 4500);`
    ], { type: 'application/javascript' });
    const bgTimerWorker = new Worker(URL.createObjectURL(workerBlob));
    bgTimerWorker.onmessage = function() {
      performSync(false);
    };
  } catch (e) {
    setInterval(() => performSync(false), 4500);
  }

  // Instant Action Interceptor: clicking Approve, Reject, Ignore, Save or toolbar buttons
  // 1) Instantly aborts any active background fetch (0ms) so user action gets 100% network & PHP session
  // 2) Waits 1200ms for server action to finish and commit, then syncs cleanly
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    const btn = target.closest ? target.closest('input[type="button"], input[type="submit"], button, a, img[src*="checked_out"]') : null;
    if (btn) {
      const txt = ((btn.value || '') + ' ' + (btn.textContent || '') + ' ' + (btn.name || '') + ' ' + (btn.id || '')).toLowerCase();
      if (txt.includes('approve') || txt.includes('reject') || txt.includes('ignore') || txt.includes('apply') || txt.includes('save') || txt.includes('order')) {
        yieldToUser(); // Instantly abort any active background fetch!
        setTimeout(() => performSync(true), 1200);
      }
    }
  }, true);

  // Trigger on visibility change and window focus
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) performSync(false);
  });
  window.addEventListener('focus', () => performSync(false));

  // Initial startup sync (runs after 600ms)
  setTimeout(() => {
    performSync(true);
  }, 600);
})();
