# NBERM Live Orders Monitor (Vercel)

A clean, mobile-first live orders counter deployed on Vercel.

---

## 🚀 How to Deploy to Vercel (1-Minute Setup)

### Option 1: Via Vercel Dashboard (Easiest)
1. Go to [vercel.com](https://vercel.com/) and sign in.
2. Click **Add New...** $\rightarrow$ **Project**.
3. Import your GitHub repository (or drag-and-drop the `vercel-app` folder).
4. *(Optional for permanent storage)*: In your Vercel Project Dashboard, click the **Storage** tab $\rightarrow$ **Create Database** $\rightarrow$ select **KV** (or Upstash Redis) $\rightarrow$ Connect it to your project.
5. Click **Deploy**.

---

### Connecting to your Chrome Extension

Once deployed, copy your Vercel URL (e.g. `https://nberm-orders-monitor.vercel.app`):
1. In your office browser on `nberm.com`, open the DevTools Console (**F12** $\rightarrow$ **Console**).
2. Type:
   ```javascript
   localStorage.setItem('nberm_vercel_url', 'https://YOUR-PROJECT.vercel.app');
   ```
3. Hit **Enter** and refresh the page!

Now open your Vercel URL on your phone and tap **Add to Home Screen**!
