// Vercel serverless function — receives a landing-page lead and notifies Hillel on WhatsApp.
// Secrets are read from environment variables ONLY (set them in Vercel → Project → Settings → Environment Variables).
// Never hardcode the Green API token here.
//   GREEN_API_URL       e.g. https://7103xxxxxx.api.greenapi.com
//   GREEN_API_INSTANCE  the idInstance (digits)
//   GREEN_API_TOKEN     the apiTokenInstance
//   LEAD_NOTIFY_CHAT    optional, defaults to 972549116092@c.us

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = (body.name || '').toString().trim().slice(0, 120);
    const phone = (body.phone || '').toString().trim().slice(0, 40);
    const source = (body.source || 'landing').toString().trim().slice(0, 60);

    if (!name || phone.replace(/\D/g, '').length < 9) {
      return res.status(400).json({ error: 'missing_or_invalid' });
    }

    // Defensive: strip stray leading '=' and surrounding whitespace that can sneak in via dashboard paste.
    const clean = (v) => (v || '').trim().replace(/^=+/, '').trim();
    const base = clean(process.env.GREEN_API_URL).replace(/\/+$/, '');
    const instance = clean(process.env.GREEN_API_INSTANCE);
    const token = clean(process.env.GREEN_API_TOKEN);
    const chatId = process.env.LEAD_NOTIFY_CHAT || '972549116092@c.us';

    const dbg = { hasUrl: !!base, hasInstance: !!instance, hasToken: !!token };

    if (!base || !instance || !token) {
      // Don't fail the user — log server-side so the lead isn't lost silently.
      console.error('[lead] Green API env vars missing — lead NOT delivered:', { name, phone, source });
      return res.status(200).json({ ok: true, delivered: false, _debug: dbg });
    }

    const url = `${base}/waInstance${instance}/sendMessage/${token}`;
    const message =
      `🟢 ליד חדש — דף בניית פורטלים\n` +
      `שם: ${name}\n` +
      `טלפון: ${phone}\n` +
      `מקור: ${source}\n` +
      `רוצה לשריין שיחת אסטרטגיה.`;

    const gr = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message })
    });

    if (!gr.ok) {
      console.error('[lead] Green API send failed', gr.status, await gr.text().catch(() => ''));
      return res.status(200).json({ ok: true, delivered: false, _debug: { ...dbg, greenStatus: gr.status } });
    }

    return res.status(200).json({ ok: true, delivered: true, _debug: { ...dbg, greenStatus: gr.status } });
  } catch (e) {
    console.error('[lead] handler error', e);
    return res.status(200).json({ ok: true, delivered: false, _debug: { stage: 'exception' } });
  }
}
