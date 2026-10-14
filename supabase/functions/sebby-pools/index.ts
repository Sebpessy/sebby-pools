// Sebby Pools email via Resend.
//   POST /sebby-pools/contact  website lead form -> email to Seb (+ auto-reply to the customer)
//   GET  /sebby-pools/domain   adds sebbypools.com to Resend if missing, re-checks verification,
//                              and returns the DNS records still needed (public info only)
// Secrets: RESEND_API_KEY (required), LEAD_TO (optional, defaults to sebpessy@gmail.com)
// seb@sebbypools.com is an alias forwarded into sebpessy@gmail.com (ImprovMX); Gmail sends as it via Resend SMTP.

const DOMAIN = 'sebbypools.com';
const FROM = 'Sebby Pools <seb@sebbypools.com>';
const LEAD_TO = Deno.env.get('LEAD_TO') || 'sebpessy@gmail.com';
const REPLY_TO = 'seb@sebbypools.com';
const PHONE = '469-996-3789';
const ORIGINS = ['https://sebbypools.com', 'https://www.sebbypools.com'];

const recent = new Map<string, number>();

function cors(req: Request) {
  const o = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) || o.startsWith('http://localhost') ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {...cors(req), 'Content-Type': 'application/json'}});
}

async function resend(path: string, init: RequestInit = {}) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const r = await fetch('https://api.resend.com' + path, {...init,
    headers: {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${j.message || JSON.stringify(j)}`);
  return j;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

async function contact(req: Request) {
  let p: Record<string, unknown>;
  try { p = await req.json(); } catch { return json(req, {ok: false, error: 'bad json'}, 400); }
  if (p.website) return json(req, {ok: true}); // honeypot
  const f = {
    name: clip(p.name, 100), email: clip(p.email, 200), phone: clip(p.phone, 40),
    location: clip(p.location, 100), projectType: clip(p.projectType, 100),
    timeline: clip(p.timeline, 100), message: clip(p.message, 5000),
  };
  if (f.name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email))
    return json(req, {ok: false, error: 'name and valid email required'}, 400);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const key = ip + '|' + f.email.toLowerCase(), now = Date.now();
  if (now - (recent.get(key) || 0) < 5 * 60_000) return json(req, {ok: false, error: 'duplicate'}, 429);
  recent.set(key, now);

  const rows: [string, string][] = [['Name', f.name], ['Email', f.email], ['Phone', f.phone],
    ['Neighborhood', f.location], ['Project', f.projectType], ['Timeline', f.timeline]];
  const html = `<h2 style="font-family:sans-serif">New Sebby Pools inquiry</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td style="padding:4px 0">${esc(v || '-')}</td></tr>`).join('')}</table>
<p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${esc(f.message || '(no message)')}</p>`;
  const text = rows.map(([k, v]) => `${k}: ${v || '-'}`).join('\n') + '\n\n' + (f.message || '(no message)');

  try {
    await resend('/emails', {method: 'POST', body: JSON.stringify({
      from: FROM, to: [LEAD_TO], reply_to: f.email,
      subject: `Sebby Pools inquiry: ${f.name}`, html, text})});
  } catch (e) {
    recent.delete(key);
    console.error(e);
    return json(req, {ok: false, error: 'send failed'}, 502);
  }

  const first = f.name.split(' ')[0];
  await resend('/emails', {method: 'POST', body: JSON.stringify({
    from: FROM, to: [f.email], reply_to: REPLY_TO,
    subject: 'Thanks for reaching out to Sebby Pools',
    text: `Hi ${first},\n\nThanks for reaching out. Your message is with Seb and you will hear back within one business day.\n\nIf it's urgent, call or text ${PHONE}.\n\nSeb\nSebby Pools\nhttps://sebbypools.com`,
  })}).catch(e => console.error('auto-reply failed', e));

  return json(req, {ok: true});
}

async function domain(req: Request) {
  const list = await resend('/domains');
  let d = (list.data || []).find((x: {name: string}) => x.name === DOMAIN);
  if (!d) d = await resend('/domains', {method: 'POST', body: JSON.stringify({name: DOMAIN, region: 'us-east-1'})});
  if (d.status !== 'verified') await resend(`/domains/${d.id}/verify`, {method: 'POST'}).catch(() => {});
  const full = await resend(`/domains/${d.id}`);
  const ns = await fetch(`https://dns.google/resolve?name=${DOMAIN}&type=NS`).then(r => r.json())
    .then(j => (j.Answer || []).map((a: {data: string}) => a.data)).catch(() => []);
  return json(req, {domain: DOMAIN, status: full.status, nameservers: ns, records: full.records});
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, {headers: cors(req)});
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'POST' && path.endsWith('/contact')) return await contact(req);
    if (req.method === 'GET' && path.endsWith('/domain')) return await domain(req);
    return json(req, {ok: false, error: 'not found'}, 404);
  } catch (e) {
    console.error(e);
    return json(req, {ok: false, error: String((e as Error).message || e)}, 500);
  }
});
