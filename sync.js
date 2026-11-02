/**
 * Project 3: NBERM Phone Sync (Chrome Extension v1.0.8)
 * - Complete Multi-Page Scanning: Scans ALL pages beyond the 100 limit (304+ items) for exact locked counts
 * - Non-Blocking Background Pagination: Zero lag on active desk work with polite throttling
 * - Continuous Background Syncing (Even when PC is locked / Win + L)
 * - Zero False Data: Always tracks live real-time queue states
 */

(function () {
  'use strict';

  const VERSION = '1.0.8';
  if (window.__nberm_phone_sync_initialized) return;
  window.__nberm_phone_sync_initialized = Date.now();

  const TAB_ID = Math.random().toString(36).substring(2, 9);
  console.log(`%c[3 - NBERM Phone Sync v${VERSION} Active - Tab: ${TAB_ID}]`, 'color: #10b981; font-weight: bold;');

  const APPROVAL_URL = 'https://nberm.com/administrator/index2.php?option=com_mps&task=listusartworkspendingapproval';
  const QUEUE_URL = 'https://nberm.com/administrator/index2.php?option=com_mps&task=listusartworkrequests2';

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
  let isBackgroundFetching = false;
  let lastBgFetchTimestamp = { queue: 0, approval: 0 };

  // Detect which queue this tab is viewing
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
   * Unified DOM stats extractor: works on live document or parsed HTML document
   */
  function extractStatsFromDom(rootDoc, queueType) {
    if (!rootDoc) return null;

    let scopeContainer = rootDoc;
    if (queueType === 'queue') {
      const unassigned = rootDoc.getElementById ? rootDoc.getElementById('unassigned-page') : rootDoc.querySelector('#unassigned-page');
      scopeContainer = unassigned || rootDoc.querySelector('.tab-page') || rootDoc;
    }

    // 1. Detect Total and Range from Pagination Footer
    let total = null;
    let rangeStart = 0;
    let rangeEnd = 0;

    const footerEls = scopeContainer.querySelectorAll('.sectiontablefooter, #listfooter, select[name="limit"], .page-nav, .pagenav');
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
      const containerTxt = scopeContainer.textContent || '';
      const m = containerTxt.match(/Results\s+(\d+)\s*-\s*(\d+)\s+of\s+([\d,]+)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd = parseInt(m[2], 10);
        total = parseInt(m[3].replace(/,/g, ''), 10);
      } else if (containerTxt.includes('No records found')) {
        total = 0;
      }
    }

    // 2. Count locked orders strictly within the list table
    const lockedIds = new Set();
    let fallbackLockCount = 0;

    const table = scopeContainer.querySelector('table.adminlist') || scopeContainer.querySelector('table');
    const rows = table ? table.querySelectorAll('tbody > tr, tr') : [];

    for (const tr of rows) {
      if (tr.closest('thead') || tr.closest('tfoot') || tr.closest('#toolbar') || tr.closest('.toolbar')) continue;
      if (tr.querySelector('th')) continue;
      if (tr.classList.contains('sectiontableheader') || tr.classList.contains('title')) continue;
      if (tr.querySelector('.sectiontablefooter, #listfooter, .pagenav, select[name="limit"]')) continue;

      const lockImg = tr.querySelector('img[src*="checked_out"], img[src*="padlock"], img[alt*="Checked out" i], img[title*="Checked out" i], img[alt*="Locked" i], img[title*="Locked" i]');
      if (lockImg) {
        if (lockImg.getAttribute('name') === 'lockqueue' || lockImg.closest('#toolbar')) continue;

        let orderId = null;

        // Checkbox value
        const cb = tr.querySelector('input[type="checkbox"][name*="cid"], input[type="checkbox"][name*="id"], input[type="checkbox"][value]');
        if (cb && cb.value && cb.value !== '0' && cb.value !== 'on') {
          orderId = cb.value.trim();
        }

        // Link href
        if (!orderId) {
          const links = tr.querySelectorAll('a[href]');
          for (const link of links) {
            const m = link.href.match(/[?&](?:id|order_id|order|orderno|req|reqid|cid\[\])=([a-zA-Z0-9_-]+)/i);
            if (m) {
              orderId = m[1];
              break;
            }
          }
        }

        // Alphanumeric order number pattern
        if (!orderId) {
          const orderNumMatch = (tr.textContent || '').match(/\b([A-Z]\d{6,8}[A-Z]?)\b/);
          if (orderNumMatch) {
            orderId = orderNumMatch[1];
          }
        }

        if (orderId) {
          lockedIds.add(orderId);
        } else {
          fallbackLockCount++;
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

  // Retrieve cached stats from localStorage
  function getStoredStats(key) {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;
      const parsed = JSON.parse(item);
      if (Date.now() - parsed.timestamp < 300000) { // 5-minute validity
        return parsed.stats;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Save stats to localStorage
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

  // Isolate active Requests section strictly between tab markers (from Design-Queue-Monitor)
  function extractRequestsSection(html) {
    if (!html || typeof html !== 'string') return '';
    const startMarker = 'id="unassigned-page"';
    const endMarker = 'id="escalated-page"';
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);
    return (startIdx !== -1 && endIdx !== -1) ? html.slice(startIdx, endIdx) : html;
  }

  // Multi-page queue scanner: counts ALL locked orders across ALL pages beyond the 100 limit
  async function scanQueueMultiPage(targetQueueType, initialDomStats = null) {
    const now = Date.now();
    const storageKey = targetQueueType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL;
    const baselineKey = targetQueueType === 'queue' ? BASELINE_KEY_QUEUE : BASELINE_KEY_APPROVAL;

    // Throttle background scans to at most once per 20 seconds unless forced with initialDomStats
    if (!initialDomStats && (now - lastBgFetchTimestamp[targetQueueType] < 20000)) {
      return getStoredStats(storageKey);
    }

    if (isBackgroundFetching) {
      return getStoredStats(storageKey);
    }
    isBackgroundFetching = true;

    const baseUrl = targetQueueType === 'queue' ? QUEUE_URL : APPROVAL_URL;

    try {
      lastBgFetchTimestamp[targetQueueType] = now;

      let basePageStats = initialDomStats;

      // If we don't have DOM stats from an active tab, fetch page 1 with cache-buster
      if (!basePageStats) {
        const cb = Date.now() + Math.random();
        const cleanUrl = `${baseUrl}&limit=100&limitstart=0&searchqueue=&searchrush=&searchlate=&search=&_cb=${cb}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(cleanUrl, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return getStoredStats(storageKey);

        const rawHtml = await res.text();
        const targetHtml = targetQueueType === 'queue' ? extractRequestsSection(rawHtml) : rawHtml;
        const parser = new DOMParser();
        const doc = parser.parseFromString(targetHtml, 'text/html');
        basePageStats = extractStatsFromDom(doc, targetQueueType);
      }

      if (!basePageStats) return getStoredStats(storageKey);

      const totalCount = basePageStats.total != null ? basePageStats.total : basePageStats.lockedCount;

      // If empty queue
      if (totalCount === 0) {
        const emptyStats = { total: 0, locked: 0, unlocked: 0, lockedIds: [] };
        setStoredStats(storageKey, emptyStats);
        return emptyStats;
      }

      const allLockedIds = new Set(basePageStats.lockedIds || []);
      let totalFallbackLocks = (basePageStats.lockedIds && basePageStats.lockedIds.size > 0) ? 0 : basePageStats.lockedCount;

      // Case 1: All records fit on 1 page (total <= 100 or rangeEnd >= total)
      if (totalCount <= 100 || basePageStats.rangeEnd >= totalCount || basePageStats.rangeEnd === 0) {
        const finalLocked = Math.min(totalCount, (allLockedIds.size > 0 ? allLockedIds.size : totalFallbackLocks));
        const singlePageStats = {
          total: totalCount,
          locked: finalLocked,
          unlocked: Math.max(0, totalCount - finalLocked),
          lockedIds: Array.from(allLockedIds)
        };
        if (totalCount > 0) localStorage.setItem(baselineKey, String(totalCount));
        setStoredStats(storageKey, singlePageStats);
        return singlePageStats;
      }

      // Case 2: Multi-Page Queue (e.g. 304 orders across 4 pages)
      const totalPages = Math.ceil(totalCount / 100);
      console.log(`[NBERM Multi-Page Scan: ${targetQueueType.toUpperCase()}] Scanning ${totalCount} orders across ${totalPages} pages (Page 1 has ${basePageStats.lockedCount} locks)...`);

      const remainingFetches = [];
      for (let start = 0; start < totalCount; start += 100) {
        // Skip whichever page range was already covered by basePageStats
        const isCovered = (start + 1 >= basePageStats.rangeStart && start < basePageStats.rangeEnd);
        if (isCovered) continue;

        const cb = Date.now() + Math.random();
        const pageUrl = `${baseUrl}&limit=100&limitstart=${start}&searchqueue=&searchrush=&searchlate=&search=&_cb=${cb}`;
        remainingFetches.push(
          fetch(pageUrl, { credentials: 'include', cache: 'no-store' })
            .then(r => r.ok ? r.text() : '')
            .then(html => {
              if (!html) return null;
              const targetHtml = targetQueueType === 'queue' ? extractRequestsSection(html) : html;
              const parser = new DOMParser();
              const doc = parser.parseFromString(targetHtml, 'text/html');
              return extractStatsFromDom(doc, targetQueueType);
            })
            .catch(() => null)
        );
      }

      const remainingResults = await Promise.all(remainingFetches);
      for (const pageStats of remainingResults) {
        if (pageStats) {
          if (pageStats.lockedIds && pageStats.lockedIds.size > 0) {
            for (const id of pageStats.lockedIds) {
              allLockedIds.add(id);
            }
          } else {
            totalFallbackLocks += (pageStats.lockedCount || 0);
          }
        }
      }

      // Always restore session limitstart back to 0 silently with limit=100 so user's PC view is unaffected
      try {
        fetch(`${baseUrl}&limit=100&limitstart=0`, { credentials: 'include' }).catch(() => {});
      } catch (e) {}

      const rawTotalLocks = allLockedIds.size > 0 ? (allLockedIds.size + totalFallbackLocks) : totalFallbackLocks;
      const finalLocked = Math.min(totalCount, Math.max(0, rawTotalLocks));
      const multiPageStats = {
        total: totalCount,
        locked: finalLocked,
        unlocked: Math.max(0, totalCount - finalLocked),
        lockedIds: Array.from(allLockedIds)
      };

      console.log(`%c[NBERM Multi-Page Scan: ${targetQueueType.toUpperCase()} COMPLETE] Total: ${totalCount} | ALL Locked: ${finalLocked} (Unique IDs: ${allLockedIds.size}) | Open: ${multiPageStats.unlocked}`, 'color: #10b981; font-weight: bold;');

      if (totalCount > 0) localStorage.setItem(baselineKey, String(totalCount));
      setStoredStats(storageKey, multiPageStats);
      return multiPageStats;
    } catch (err) {
      console.warn(`[NBERM Scan Error: ${targetQueueType}]`, err);
      return getStoredStats(storageKey);
    } finally {
      isBackgroundFetching = false;
    }
  }

  // Push unified stats to Vercel via background service worker
  function broadcastDualStats(approval, queue, force = false) {
    if (!approval && !queue) return;

    const appBaseline = parseInt(localStorage.getItem(BASELINE_KEY_APPROVAL) || '0', 10);
    const qBaseline = parseInt(localStorage.getItem(BASELINE_KEY_QUEUE) || '0', 10);

    const appTotal = Math.max(0, approval ? approval.total : appBaseline);
    const appLocked = Math.min(appTotal, Math.max(0, approval ? approval.locked : 0));
    const appOpen = Math.max(0, appTotal - appLocked);

    const qTotal = Math.max(0, queue ? queue.total : qBaseline);
    const qLocked = Math.min(qTotal, Math.max(0, queue ? queue.locked : 0));
    const qOpen = Math.max(0, qTotal - qLocked);

    const stateKey = `${appTotal}-${appLocked}-${appOpen}|${qTotal}-${qLocked}-${qOpen}`;
    const now = Date.now();

    // Skip duplicate broadcasts within 15 seconds unless forced
    if (!force && stateKey === lastBroadcastStateKey && (now - lastBroadcastTime < 15000)) {
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
        lockedOrders: approval?.lockedIds || []
      },
      queue: {
        total: qTotal,
        locked: qLocked,
        unlocked: qOpen,
        lockedOrders: queue?.lockedIds || []
      },
      timestamp: now
    };

    console.log(`%c[NBERM Live Sync] Pushed: Approval (${appTotal}/${appLocked}) | Design (${qTotal}/${qLocked})`, 'color: #10b981; font-weight: bold;');

    // Push via Background Service Worker with error suppression
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'SYNC_STATS', payload: payload }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } catch (e) {}
  }

  // Main sync coordinator: handles active desk mode AND locked-PC background mode
  async function performSync(forceFetch = false) {
    const pageType = detectCurrentPage();
    if (pageType === 'unknown') return;

    let liveApproval = getStoredStats(STORAGE_KEY_APPROVAL);
    let liveQueue = getStoredStats(STORAGE_KEY_QUEUE);

    const isHidden = document.hidden || forceFetch;

    // 1. FAST DESK MODE (User is looking at the tab)
    if (!isHidden) {
      const domStats = extractStatsFromDom(document, pageType);
      if (domStats) {
        const baselineKey = pageType === 'queue' ? BASELINE_KEY_QUEUE : BASELINE_KEY_APPROVAL;
        const totalCount = domStats.total != null ? domStats.total : domStats.lockedCount;

        // If single page (<= 100), DOM gives 100% full stats instantly
        if (totalCount <= 100 || domStats.rangeEnd >= totalCount || domStats.rangeEnd === 0) {
          const finalLocked = Math.min(totalCount, domStats.lockedCount);
          const activeStats = {
            total: totalCount,
            locked: finalLocked,
            unlocked: Math.max(0, totalCount - finalLocked),
            lockedIds: Array.from(domStats.lockedIds || [])
          };

          if (totalCount > 0) localStorage.setItem(baselineKey, String(totalCount));

          if (pageType === 'approval') {
            liveApproval = activeStats;
            setStoredStats(STORAGE_KEY_APPROVAL, activeStats);
          } else {
            liveQueue = activeStats;
            setStoredStats(STORAGE_KEY_QUEUE, activeStats);
          }

          broadcastDualStats(liveApproval, liveQueue);
        } else {
          // Multi-page queue (e.g. 304 orders across 4 pages):
          const cachedStats = getStoredStats(pageType === 'queue' ? STORAGE_KEY_QUEUE : STORAGE_KEY_APPROVAL);
          const cacheAge = Date.now() - (lastBgFetchTimestamp[pageType] || 0);

          if (cachedStats && Math.abs(cachedStats.total - totalCount) <= 2 && cacheAge < 25000) {
            // Keep full multi-page locked count so we don't drop to page 1's visible locks
            if (pageType === 'approval') liveApproval = cachedStats;
            else liveQueue = cachedStats;
            broadcastDualStats(liveApproval, liveQueue);
          } else {
            // Run multi-page scan in background using leader tab
            if (isTabLeader()) {
              scanQueueMultiPage(pageType, domStats).then(freshStats => {
                if (freshStats) {
                  if (pageType === 'approval') liveApproval = freshStats;
                  else liveQueue = freshStats;
                  broadcastDualStats(liveApproval, liveQueue, true);
                }
              });
            } else if (cachedStats) {
              if (pageType === 'approval') liveApproval = cachedStats;
              else liveQueue = cachedStats;
              broadcastDualStats(liveApproval, liveQueue);
            }
          }
        }
      }
    }

    // 2. BACKGROUND / LOCKED PC MODE: Only leader tab fetches fresh server HTML across all pages
    if (isTabLeader()) {
      const otherQueue = pageType === 'queue' ? 'approval' : 'queue';
      const otherStats = await scanQueueMultiPage(otherQueue, null);
      if (otherStats) {
        if (otherQueue === 'approval') liveApproval = otherStats;
        else liveQueue = otherStats;
        broadcastDualStats(liveApproval, liveQueue);
      }

      // If screen is locked, also scan current queue remotely across all pages
      if (isHidden) {
        const currentStats = await scanQueueMultiPage(pageType, null);
        if (currentStats) {
          if (pageType === 'approval') liveApproval = currentStats;
          else liveQueue = currentStats;
          broadcastDualStats(liveApproval, liveQueue, true);
        }
      }
    }
  }

  // Listen to background service worker alarms (wakes up even when PC is locked)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'TRIGGER_BACKGROUND_SYNC') {
        performSync(true);
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
      `setInterval(function() { postMessage('tick'); }, 25000);`
    ], { type: 'application/javascript' });
    const bgTimerWorker = new Worker(URL.createObjectURL(workerBlob));
    bgTimerWorker.onmessage = function() {
      performSync(document.hidden ? true : false);
    };
  } catch (e) {
    setInterval(() => performSync(document.hidden ? true : false), 25000);
  }

  // Trigger on visibility change and load
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) performSync(false);
  });
  window.addEventListener('focus', () => performSync(false));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => performSync(false));
  } else {
    performSync(false);
  }
})();
