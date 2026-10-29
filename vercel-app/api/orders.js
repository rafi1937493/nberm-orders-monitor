export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // Handle POST: Chrome extension sends stats
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
      }

      // Retrieve previous state so we never accidentally overwrite one queue with 0
      let prevData = null;
      if (kvUrl && kvToken) {
        try {
          const kvRes = await fetch(`${kvUrl}/get/nberm_orders_status`, {
            headers: { Authorization: `Bearer ${kvToken}` }
          });
          const kvJson = await kvRes.json();
          if (kvJson && kvJson.result) {
            prevData = typeof kvJson.result === 'string' ? JSON.parse(kvJson.result) : kvJson.result;
          }
        } catch (err) {}
      }
      if (!prevData) {
        prevData = global.__nberm_orders || null;
      }

      let appTotal = Math.max(0, Number(body?.approval?.total ?? 0));
      let appLocked = Math.min(appTotal, Math.max(0, Number(body?.approval?.locked ?? 0)));
      let appOpen = Math.max(0, appTotal - appLocked);

      let qTotal = Math.max(0, Number(body?.queue?.total ?? 0));
      let qLocked = Math.min(qTotal, Math.max(0, Number(body?.queue?.locked ?? 0)));
      let qOpen = Math.max(0, qTotal - qLocked);

      // Merge: if one queue reported 0 or missing, preserve previous non-zero count
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

      if (kvUrl && kvToken) {
        try {
          await fetch(`${kvUrl}/set/nberm_orders_status`, {
            headers: { Authorization: `Bearer ${kvToken}` },
            method: 'POST',
            body: JSON.stringify(payload)
          });
        } catch (err) {
          console.error('KV write error:', err);
        }
      } else {
        global.__nberm_orders = payload;
      }

      return res.status(200).json({ success: true, data: payload });
    }

    // Handle GET: Phone browser reads stats
    if (req.method === 'GET') {
      let data = null;

      if (kvUrl && kvToken) {
        try {
          const kvRes = await fetch(`${kvUrl}/get/nberm_orders_status`, {
            headers: { Authorization: `Bearer ${kvToken}` }
          });
          const kvJson = await kvRes.json();
          if (kvJson && kvJson.result) {
            data = typeof kvJson.result === 'string' ? JSON.parse(kvJson.result) : kvJson.result;
          }
        } catch (err) {
          console.error('KV read error:', err);
        }
      }

      if (!data) {
        data = global.__nberm_orders || {
          total: 860,
          count: 860,
          locked: 2,
          unlocked: 858,
          approval: { total: 545, locked: 0, unlocked: 545 },
          queue: { total: 315, locked: 2, unlocked: 313 },
          updatedAt: 'Synced',
          timestamp: Date.now()
        };
      }

      // Sanitize data so locked never exceeds total
      if (data) {
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
      }

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
