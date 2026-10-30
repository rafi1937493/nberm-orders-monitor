export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const edgeConfigId = process.env.EDGE_CONFIG_ID || 'ecfg_l7tb6qpjasuveerkpgmj7wcxmfik';
  const vercelApiToken = process.env.VERCEL_API_TOKEN || 'vcp_7AqYSevH2P9pHR8WRsrhWBG773ITlMHqR25PhjAcAZePOvfrVZ3mf8vE';
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // Retrieve persistent data across cold starts (Edge Config > Upstash KV > In-Memory)
  async function loadPersistentStatus() {
    if (global.__nberm_orders) return global.__nberm_orders;

    // 1. Try Vercel Edge Config (Global distributed key-value store, <1ms)
    if (edgeConfigId && vercelApiToken) {
      try {
        const ecRes = await fetch(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/item/nberm_orders_status`, {
          headers: { Authorization: `Bearer ${vercelApiToken}` }
        });
        if (ecRes.ok) {
          const ecJson = await ecRes.json();
          if (ecJson && ecJson.value) {
            const val = typeof ecJson.value === 'string' ? JSON.parse(ecJson.value) : ecJson.value;
            global.__nberm_orders = val;
            return val;
          }
        }
      } catch (err) {}
    }

    // 2. Try Upstash / KV
    if (kvUrl && kvToken) {
      try {
        const kvRes = await fetch(`${kvUrl}/get/nberm_orders_status`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        const kvJson = await kvRes.json();
        if (kvJson && kvJson.result) {
          const val = typeof kvJson.result === 'string' ? JSON.parse(kvJson.result) : kvJson.result;
          global.__nberm_orders = val;
          return val;
        }
      } catch (err) {}
    }

    return null;
  }

  // Save persistent data
  async function savePersistentStatus(payload) {
    global.__nberm_orders = payload;

    // 1. Save to Vercel Edge Config
    if (edgeConfigId && vercelApiToken) {
      try {
        await fetch(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${vercelApiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            items: [{ operation: 'upsert', key: 'nberm_orders_status', value: payload }]
          })
        });
      } catch (err) {}
    }

    // 2. Save to Upstash / KV if available
    if (kvUrl && kvToken) {
      try {
        await fetch(`${kvUrl}/set/nberm_orders_status`, {
          headers: { Authorization: `Bearer ${kvToken}` },
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } catch (err) {}
    }
  }

  try {
    // Handle POST: Chrome extension pushes live stats
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
      }

      const prevData = await loadPersistentStatus();

      let appTotal = Math.max(0, Number(body?.approval?.total ?? 0));
      let appLocked = Math.min(appTotal, Math.max(0, Number(body?.approval?.locked ?? 0)));
      let appOpen = Math.max(0, appTotal - appLocked);

      let qTotal = Math.max(0, Number(body?.queue?.total ?? 0));
      let qLocked = Math.min(qTotal, Math.max(0, Number(body?.queue?.locked ?? 0)));
      let qOpen = Math.max(0, qTotal - qLocked);

      // Merge: if one queue was temporarily missing, keep previous known real count
      if (appTotal === 0 && prevData?.approval?.total > 0) {
        appTotal = Math.max(0, Number(prevData.approval.total));
        appLocked = Math.min(appTotal, Math.max(0, Number(prevData.approval.locked ?? 0)));
        appOpen = Math.max(0, appTotal - appLocked);
      }
      if (qTotal === 0 && prevData?.queue?.total > 0) {
        qTotal = Math.max(0, Number(prevData.queue.total));
        qLocked = Math.min(qTotal, Math.max(0, Number(prevData.queue.locked ?? 0)));
        qOpen = Math.max(0, qTotal - qLocked);
      }

      const total = appTotal + qTotal;
      const locked = appLocked + qLocked;
      const unlocked = appOpen + qOpen;

      const payload = {
        total: total,
        count: total,
        locked: locked,
        unlocked: unlocked,
        approval: {
          total: appTotal,
          locked: appLocked,
          unlocked: appOpen
        },
        queue: {
          total: qTotal,
          locked: qLocked,
          unlocked: qOpen
        },
        updatedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      };

      await savePersistentStatus(payload);

      return res.status(200).json({ success: true, data: payload });
    }

    // Handle GET: Phone browser reads stats
    if (req.method === 'GET') {
      let data = await loadPersistentStatus();

      // Zero fake data: if no data exists yet, return clean zeroes
      if (!data) {
        data = {
          total: 0,
          count: 0,
          locked: 0,
          unlocked: 0,
          approval: { total: 0, locked: 0, unlocked: 0 },
          queue: { total: 0, locked: 0, unlocked: 0 },
          updatedAt: 'Connecting...',
          timestamp: Date.now()
        };
      }

      // Hard clamp verification: locked can never exceed total
      if (data.approval) {
        const aTotal = Math.max(0, Number(data.approval.total ?? 0));
        const aLocked = Math.min(aTotal, Math.max(0, Number(data.approval.locked ?? 0)));
        data.approval.total = aTotal;
        data.approval.locked = aLocked;
        data.approval.unlocked = Math.max(0, aTotal - aLocked);
      }
      if (data.queue) {
        const qTotal = Math.max(0, Number(data.queue.total ?? 0));
        const qLocked = Math.min(qTotal, Math.max(0, Number(data.queue.locked ?? 0)));
        data.queue.total = qTotal;
        data.queue.locked = qLocked;
        data.queue.unlocked = Math.max(0, qTotal - qLocked);
      }
      const appT = data.approval ? data.approval.total : 0;
      const appL = data.approval ? data.approval.locked : 0;
      const qT = data.queue ? data.queue.total : 0;
      const qL = data.queue ? data.queue.locked : 0;
      data.total = appT + qT;
      data.count = data.total;
      data.locked = appL + qL;
      data.unlocked = Math.max(0, data.total - data.locked);

      return res.status(200).json(data);
    }
  } catch (err) {
    return res.status(200).json({
      total: 0,
      count: 0,
      locked: 0,
      unlocked: 0,
      approval: { total: 0, locked: 0, unlocked: 0 },
      queue: { total: 0, locked: 0, unlocked: 0 },
      updatedAt: 'Online',
      timestamp: Date.now()
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
