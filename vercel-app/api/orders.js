export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qloghdvzdvdaecvggtuh.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'sb_publishable_sp8meDyllLX-AKO_Xsnw4A_6M9XazTb';
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  // Retrieve persistent data across cold starts (Supabase > Upstash KV > In-Memory)
  async function loadPersistentStatus() {
    if (global.__nberm_orders) return global.__nberm_orders;

    // 1. Try Supabase REST API
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/orders_status?id=eq.current&select=*`, {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
          }
        });
        if (sbRes.ok) {
          const rows = await sbRes.json();
          if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
            global.__nberm_orders = rows[0];
            return rows[0];
          }
        }
      } catch (err) {}
    }

    // 2. Try Upstash / KV if configured
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

  // Save persistent data (Supabase + In-memory + Upstash KV)
  async function savePersistentStatus(payload) {
    global.__nberm_orders = payload;

    // 1. Save to Supabase REST API
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/orders_status?on_conflict=id`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            id: 'current',
            total: payload.total,
            count: payload.count,
            locked: payload.locked,
            unlocked: payload.unlocked,
            approval: payload.approval,
            queue: payload.queue,
            updated_at: payload.updatedAt,
            timestamp: payload.timestamp
          })
        });
      } catch (err) {}
    }

    // 2. Save to Upstash / KV if configured
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
          unlocked: appOpen,
          lockedOrders: Array.isArray(body?.approval?.lockedOrders) ? body.approval.lockedOrders : (prevData?.approval?.lockedOrders || [])
        },
        queue: {
          total: qTotal,
          locked: qLocked,
          unlocked: qOpen,
          lockedOrders: Array.isArray(body?.queue?.lockedOrders) ? body.queue.lockedOrders : (prevData?.queue?.lockedOrders || [])
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
        if (!Array.isArray(data.approval.lockedOrders)) data.approval.lockedOrders = [];
      }
      if (data.queue) {
        const qTotal = Math.max(0, Number(data.queue.total ?? 0));
        const qLocked = Math.min(qTotal, Math.max(0, Number(data.queue.locked ?? 0)));
        data.queue.total = qTotal;
        data.queue.locked = qLocked;
        data.queue.unlocked = Math.max(0, qTotal - qLocked);
        if (!Array.isArray(data.queue.lockedOrders)) data.queue.lockedOrders = [];
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
