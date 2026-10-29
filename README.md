# Project 3: NBERM Phone Stats (Live Queue Monitor)

### What it does:
- Live Dual-Queue Sync: Monitors both **Designs Approval** and **Designs Queue**.
- Tracks total count, locked (checked out) orders, and open orders.
- Whole-Queue baseline: Even when you filter by a specific product type on PC, the phone dashboard continues displaying the complete queue totals across all product types.
- Background sync: Keeps updating via Web Worker even when PC is locked (`Win + L`).

### Mobile Dashboard / PWA URL:
👉 **https://nberm-orders-monitor.vercel.app**

### How to load the sync extension in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right switch).
3. Click **Load unpacked**.
4. Select this folder: `E:\The_Rafi\lET'S_see\3-Phone-Stats`
