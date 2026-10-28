/* Minimal secure server for Agape Foundation. Run behind HTTPS in production. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const sharp = require('sharp');
const root = __dirname, store = path.join(root, 'data', 'content.json'), mediaDir = path.join(root, 'assets', 'uploads');
const password = process.env.ADMIN_PASSWORD, adminUsername = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!password) console.warn('ADMIN_PASSWORD is not set. Set a strong password before deploying.');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set — a random one was generated for this run, so every restart/deploy will log every admin out. Set SESSION_SECRET as a fixed env var in production.');
const attempts = new Map();
// Ulinzi wa jumla dhidi ya watumiaji wanaotuma maombi mengi kupita kiasi (suspicious high-frequency
// requesters) — hii inalinda afya ya server kwa MAOMBI YOTE, si tu kuingia (login). IP moja
// haiwezi kuzidi ombi 120 kwa dakika moja; ikizidi, server inajibu 429 badala ya kuzidiwa mzigo.
const generalTraffic = new Map();
const GENERAL_LIMIT = 120, GENERAL_WINDOW = 60000;
const isRateLimited = ip => {
  const now = Date.now();
  const recent = (generalTraffic.get(ip) || []).filter(t => now - t < GENERAL_WINDOW);
  recent.push(now);
  generalTraffic.set(ip, recent);
  return recent.length > GENERAL_LIMIT;
};
// Idadi ya juu ya kadi kwa kila orodha (gallery/programs/leaders/blog) — inalazimishwa hapa
// server-side pia (si tu kwenye admin.html), ili tovuti iendelee kupakia haraka (sekunde 1-6)
// hata kama mtu atajaribu kutuma ombi moja kwa moja kwenye API bila kupitia dashboard.
const MAX_CARDS = 25;
const MAX_USERS = 5;
const MAX_UPDATES = 5;
// Gallery/Programs/Leadership/Blog sasa zinashiriki KIKOMO KIMOJA cha jumla (kadi 25),
// badala ya kila orodha kuwa na kikomo chake cha 25 (ambacho kingeruhusu kadi 100 jumla).
// Admin anaweza kugawanya idadi hiyo apendavyo — mfano kadi 10 Gallery + 5 Blog + 10 Programs.
const sharedCardTotal = data => ['gallery', 'programs', 'leaders', 'blog'].reduce((sum, key) => sum + (Array.isArray(data[key]) ? data[key].length : 0), 0);
const overCap = data => sharedCardTotal(data) > MAX_CARDS || (Array.isArray(data.whatsappContacts) && data.whatsappContacts.length > 3) || (Array.isArray(data.updates) && data.updates.length > MAX_UPDATES);
// Safisha "attempts" ya zamani kila baada ya dakika 30 ili kuepuka kujaza kumbukumbu (memory)
// milele — bila hii, ramani hii ingekua bila kikomo kadri muda unavyopita kwenye server ya AWS.
setInterval(() => { const cutoff = Date.now() - 900000; for (const [ip, times] of attempts) { const recent = times.filter(t => t > cutoff); if (recent.length) attempts.set(ip, recent); else attempts.delete(ip); } }, 1800000).unref();
setInterval(() => { const cutoff = Date.now() - GENERAL_WINDOW; for (const [ip, times] of generalTraffic) { const recent = times.filter(t => t > cutoff); if (recent.length) generalTraffic.set(ip, recent); else generalTraffic.delete(ip); } }, 300000).unref();
if (password && password.length < 12) console.warn('ADMIN_PASSWORD is shorter than 12 characters. Use a longer, unique password in production.');

// ============================================================
// TOTP (RFC 6238) kwa uthibitisho wa hatua-mbili (two-factor authentication) — imejengwa
// kwa crypto ya ndani ya Node pekee, imethibitishwa dhidi ya mifano rasmi ya RFC 4226.
// ============================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Encode = buffer => { let bits = 0, value = 0, output = ''; for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]; return output; };
const base32Decode = str => { str = String(str).replace(/=+$/, '').toUpperCase(); let bits = 0, value = 0; const bytes = []; for (const char of str) { const idx = BASE32_ALPHABET.indexOf(char); if (idx === -1) continue; value = (value << 5) | idx; bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; } } return Buffer.from(bytes); };
const totpCode = (base32Secret, counter) => { const key = base32Decode(base32Secret); const counterBuffer = Buffer.alloc(8); counterBuffer.writeBigUInt64BE(BigInt(counter)); const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest(); const offset = hmac[hmac.length - 1] & 0xf; const binCode = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff); return String(binCode % 1000000).padStart(6, '0'); };
// Ruhusu dirisha la ±1 hatua (sekunde 30 kila moja) kuvumilia tofauti ndogo za saa kati ya
// simu na server, bila kupunguza usalama kwa kiasi kikubwa.
const verifyTotp = (base32Secret, code) => { code = String(code || '').trim(); if (!/^\d{6}$/.test(code)) return false; const currentStep = Math.floor(Date.now() / 30000); for (let i = -1; i <= 1; i++) { if (totpCode(base32Secret, currentStep + i) === code) return true; } return false; };
// Soma data kutoka faili. Kama faili haipo au imeharibika, andika sababu kwenye logi ya server
// badala ya kunyamaza kimya — hii ndiyo sababu kuu admin "haoni cards" baada ya kuhamia AWS:
// zamani kosa lilifichwa na kurudisha {} tu, bila dalili yoyote kwenye logi.
const read = () => {
  try {
    const data = JSON.parse(fs.readFileSync(store, 'utf8'));
    // Futa "updates" (matangazo ya muda) zilizoisha muda wake kila mara data inaposomwa —
    // hii ndiyo inayofanya tangazo "lijifute lenyewe" bila kuhitaji kazi ya nyuma (cron job).
    // Kuandika (write) kunatokea TU kama kitu kimeisha muda — si kila ombi la kusoma.
    if (Array.isArray(data.updates) && data.updates.length) {
      const now = Date.now();
      const active = data.updates.filter(u => !u.expiresAt || new Date(u.expiresAt).getTime() > now);
      if (active.length !== data.updates.length) { data.updates = active; write(data); }
    }
    return data;
  } catch (error) {
    console.error(`[content-store] Imeshindwa kusoma ${store}:`, error.code || error.message);
    if (error.code === 'ENOENT') {
      console.error('[content-store] Faili halipo kabisa kwenye server hii. Kama umehamia AWS, hakikisha data/content.json ilihamishwa (si tu code).');
    }
    return {};
  }
};
const dataImage = value => typeof value === 'string' && /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(value);
const localImage = value => typeof value === 'string' ? value.replace(/^(?:\/agape)?(\/assets\/uploads\/[a-f0-9]{64}\.jpg)$/, '$1') : value;
const saveImage = value => {
  value=localImage(value);
  if (!dataImage(value)) return value;
  const encoded=value.slice(value.indexOf(',')+1), bytes=Buffer.from(encoded,'base64');
  if (!bytes.length || bytes.length>8*1024*1024) throw Error('Image is invalid or too large.');
  const file=`${crypto.createHash('sha256').update(bytes).digest('hex')}.jpg`;
  fs.mkdirSync(mediaDir,{recursive:true});
  const target=path.join(mediaDir,file);
  if(!fs.existsSync(target)) { fs.writeFileSync(target,bytes); scheduleCompression(target,bytes); }
  return `/assets/uploads/${file}`;
};
// Ubanaji WA ZIADA hutokea NYUMA YA PAZIA (background, fire-and-forget) mara baada ya
// picha kuhifadhiwa — HAUCHELEWESHI jibu la ombi la mtumiaji, na haubadilishi jina la
// faili wala aina yake (JPEG hubaki JPEG, PNG yenye uwazi (transparency) hubaki PNG),
// hivyo hakuna sehemu nyingine ya mfumo (content.json, regex za kutafuta picha, n.k.)
// inayohitaji kujua kuhusu hili. Faili inabadilishwa PALE PALE, TU kama toleo dogo zaidi
// limepatikana kwa kweli.
function scheduleCompression(filePath, originalBytes) {
  sharp(originalBytes).metadata()
    .then(meta => {
      const isTransparentPng = meta.format === 'png' && meta.hasAlpha;
      const pipeline = isTransparentPng
        ? sharp(originalBytes).png({ compressionLevel: 9, quality: 85 })
        : sharp(originalBytes).jpeg({ quality: 82, mozjpeg: true });
      return pipeline.toBuffer();
    })
    .then(compressed => {
      if (compressed.length > 0 && compressed.length < originalBytes.length && fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, compressed);
      }
    })
    .catch(error => console.error('[image-compress] Imeshindwa kubana picha (si hitilafu mbaya, faili la awali linabaki):', error.message));
}
const storeImages = value => Array.isArray(value) ? value.map(storeImages) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,storeImages(item)])) : saveImage(value);
const serveImages = (value, prefix) => Array.isArray(value) ? value.map(item=>serveImages(item,prefix)) : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,serveImages(item,prefix)])) : typeof value==='string' && value.startsWith('/assets/uploads/') ? `${prefix}${value}` : value;
const referencedImages = (value, files=new Set()) => { if(Array.isArray(value)) value.forEach(item=>referencedImages(item,files)); else if(value&&typeof value==='object') Object.values(value).forEach(item=>referencedImages(item,files)); else if(typeof value==='string'){const match=value.match(/(?:\/agape)?\/assets\/uploads\/([a-f0-9]{64}\.jpg)$/);if(match)files.add(match[1]);} return files; };
const removeUnusedImages = data => { if(!fs.existsSync(mediaDir))return; const keep=referencedImages(data); for(const file of fs.readdirSync(mediaDir)){if(/^[a-f0-9]{64}\.jpg$/.test(file)&&!keep.has(file))fs.unlinkSync(path.join(mediaDir,file));} };
// Andika data kwenye faili. Tunaandika logi ya kina server-side kabla ya kurusha kosa juu,
// ili anayeangalia AWS logs aone HASA sababu (mfano: EACCES = ruhusa za folder hazitoshi).
const write = data => {
  const stored = storeImages(data);
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(stored));
    removeUnusedImages(stored);
  } catch (error) {
    console.error(`[content-store] Imeshindwa kuandika ${store}:`, error.code || error.message);
    if (error.code === 'EACCES') {
      console.error('[content-store] Ruhusa (permissions) za folder ya data/ hazitoshi kwa mtumiaji anayeendesha node kwenye AWS.');
    }
    throw error;
  }
};
const hasDataImage = value => Array.isArray(value) ? value.some(hasDataImage) : value && typeof value==='object' ? Object.values(value).some(hasDataImage) : dataImage(value);
const currentContent=read(); if(hasDataImage(currentContent)){fs.copyFileSync(store,`${store}.before-image-migration`);write(currentContent);}
const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const cleanUsername = value => String(value || '').trim().toLowerCase();
const hashPassword = password => new Promise((resolve,reject) => { const salt=crypto.randomBytes(16).toString('hex'); crypto.scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(`${salt}:${key.toString('hex')}`)); });
const verifyPassword = (password, stored) => new Promise(resolve => { const [salt, hash]=String(stored||'').split(':'); if(!salt||!hash)return resolve(false); crypto.scrypt(password,salt,64,(err,key)=>resolve(!err && hash.length===key.toString('hex').length && crypto.timingSafeEqual(Buffer.from(hash,'hex'),key))); });
const session = req => { const pair=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('aff_session=')); if(!pair)return null; const [value,sig]=decodeURIComponent(pair.slice(12)).split('.'); if(!value||!sig||sig.length!==sign(value).length||!crypto.timingSafeEqual(Buffer.from(sign(value)),Buffer.from(sig)))return null; try { const data=JSON.parse(Buffer.from(value,'base64url').toString()); if(!data.username||data.expires<Date.now())return null; if(data.username!==adminUsername){const user=(read().users||[]).find(u=>u.username===data.username);if(!user||!user.active)return null;} return data; } catch { return null; } };
const issueSession = (req, res, username, role='editor', mustChangePassword=false) => { const value=Buffer.from(JSON.stringify({username,role,mustChangePassword,expires:Date.now()+8*60*60*1000})).toString('base64url'), cookiePath=publicPrefix(req)||'/', secure=String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'?'; Secure':'', cookie=`aff_session=${encodeURIComponent(value+'.'+sign(value))}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=28800${secure}`; res.writeHead(204,{'Set-Cookie':cookie,'Cache-Control':'no-store'});res.end(); };
const publicContent = data => {
  const copy=JSON.parse(JSON.stringify(data));
  delete copy.messages; delete copy.adminProfile; delete copy.analytics; delete copy.users; delete copy.security; delete copy.donationDeclarations;
  // Ficha kadi za "draft" (bado hazijachapishwa) na zile zilizoratibiwa kwa tarehe ya baadaye
  // (scheduled) kutoka kwa wageni wa tovuti — admin bado anaziona kupitia /api/admin/content.
  const now = Date.now();
  const isHidden = meta => meta && (meta.status === 'draft' || (meta.publishAt && new Date(meta.publishAt).getTime() > now));
  if (Array.isArray(copy.gallery)) copy.gallery = copy.gallery.filter(item => !isHidden(item[3]));
  if (Array.isArray(copy.blog)) copy.blog = copy.blog.filter(post => !isHidden(post));
  return copy;
};
// Vichwa vya usalama (security headers) — vinazuia clickjacking, MIME-sniffing, na kuvujisha
// URL kwa tovuti nyingine. img-src imepanuliwa kwa data: kwa sababu picha za admin huhifadhiwa
// kama base64 data URIs kabla ya kubadilishwa kuwa faili.
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()'
};
const json = (res, code, body) => { res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store',...securityHeaders}); res.end(JSON.stringify(body)); };
const body = req => new Promise((resolve, reject) => { let raw=''; req.on('data', c => { raw += c; if(raw.length > 8*1024*1024) reject(Error('Payload too large')); }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Error('Invalid request')); } }); });
const safeFile = url => { const file = path.normalize(path.join(root, decodeURIComponent(url.split('?')[0]))); return file.startsWith(root) ? file : null; };
const publicPrefix = req => String(req.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '');
// Muundo wa "base URL" (protocol + host + prefix) ulikuwa umeandikwa mara 3 tofauti —
// sasa ni sehemu MOJA inayotumika kila mahali, ili kubadilisha jinsi tunavyotambua
// protocol/host kufanyike sehemu moja tu.
const requestBaseUrl = req => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}${publicPrefix(req)}`;
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8'};
http.createServer(async (req,res) => {
  try {
    // Zuia watumiaji wanaotuma maombi mengi kupita kiasi kwa muda mfupi (suspicious high-frequency
    // requesters) KABLA ya kufanya kazi nyingine yoyote — hii inalinda afya ya server kwa ujumla.
    const clientIp = req.socket.remoteAddress;
    if (isRateLimited(clientIp)) return json(res,429,{error:'Too many requests. Please slow down and try again shortly.'});
    // Zuia ufikiaji WOWOTE wa admin (isipokuwa kubadilisha nenosiri lako mwenyewe) kama akaunti
    // bado ina bendera ya "lazima libadilishwe nenosiri" — hii inalazimisha mtumiaji wa nenosiri
    // la mara-moja (one-time password) kuweka nenosiri jipya kabla ya kuona dashboard.
    if (req.url.startsWith('/api/admin/') && req.url !== '/api/admin/me/password') {
      const auth = session(req);
      if (auth && auth.mustChangePassword) return json(res, 403, { error: 'You must set a new password before continuing.', mustChangePassword: true });
    }
    if (req.url === '/api/content' && req.method === 'GET') return json(res,200,serveImages(publicContent(read()),publicPrefix(req)));
    if (req.url === '/api/admin/content' && req.method === 'GET') { const auth=session(req); if(!auth)return json(res,401,{error:'Sign in required'}); const data=read();delete data.users; if(auth.role!=='admin')delete data.security; return json(res,200,serveImages(data,publicPrefix(req))); }
    if (req.url === '/api/admin/content' && req.method === 'PUT') { if (!session(req)) return json(res,401,{error:'Sign in required'}); const existing=read(), incoming=await body(req); if(overCap(incoming))return json(res,400,{error:`Gallery, Programs, Leadership and Blog share one combined limit of ${MAX_CARDS} cards total (plus 3 for WhatsApp contacts, ${MAX_UPDATES} for Updates, each on their own). Remove a card from any of those four sections before adding another.`}); incoming.users=existing.users||[]; incoming.security=existing.security||{}; write(incoming); return json(res,200,{ok:true}); }
    if (req.url === '/api/messages' && req.method === 'POST') { const msg=await body(req), data=read(); data.messages=[...(data.messages||[]), msg].slice(-500); write(data); return json(res,201,{ok:true}); }
    // Taarifa ya "nimeshalipa" (self-reported) kutoka kwa mchangiaji baada ya kulipa mwenyewe
    // kupitia Lipa Namba — kwa ajili ya admin kuhakiki dhidi ya akaunti halisi ya pesa za simu.
    // SI uthibitisho wa malipo — tovuti haiwezi kuona muamala halisi wa pesa za simu.
    if (req.url === '/api/donations/declare' && req.method === 'POST') { const input=await body(req), data=read(); const entry={name:String(input.name||'').slice(0,80),amount:String(input.amount||'').slice(0,20),network:['mpesa','tigopesa','airtel','halotel'].includes(input.network)?input.network:'unknown',reference:String(input.reference||'').slice(0,40),at:new Date().toISOString()}; if(!entry.name||!entry.amount)return json(res,400,{error:'Name and amount are required.'}); data.donationDeclarations=[...(data.donationDeclarations||[]),entry].slice(-500); write(data); return json(res,201,{ok:true}); }
    if (req.url === '/api/analytics' && req.method === 'POST') { const event=await body(req), data=read(); data.analytics=[...(data.analytics||[]),{type:String(event.type||'pageview').slice(0,40),page:String(event.page||'/').slice(0,120),label:String(event.label||'').slice(0,60),at:new Date().toISOString()}].slice(-5000); write(data); return json(res,201,{ok:true}); }
    if (req.url === '/api/login' && req.method === 'POST') { const ip=req.socket.remoteAddress,now=Date.now(),limit=attempts.get(ip)||[],recent=limit.filter(t=>now-t<900000); if(recent.length>=5)return json(res,429,{error:'Too many attempts. Try again later.'}); const supplied=await body(req),username=cleanUsername(supplied.username)||adminUsername,input=String(supplied.password||''); let valid=false,role='editor',mustChangePassword=false; if(username===adminUsername){valid=!!password&&input.length===password.length&&crypto.timingSafeEqual(Buffer.from(input),Buffer.from(password));role='admin';}else{const user=(read().users||[]).find(u=>u.username===username);valid=!!user&&user.active&&await verifyPassword(input,user.passwordHash);role=(user&&user.role)||'editor';mustChangePassword=!!(user&&user.mustChangePassword);} if(!valid){recent.push(now);attempts.set(ip,recent);
      // Kumbuka jaribio lililoshindwa kwa ripoti ya usalama itakayoonekana kwenye admin dashboard —
      // hii inamsaidia admin kutambua mtu asiyeidhinishwa anayejaribu kuingia.
      const data=read();data.security=data.security||{};data.security.failedLogins=[...(data.security.failedLogins||[]),{username,ip,at:new Date().toISOString()}].slice(-50);write(data);
      return json(res,401,{error:'Invalid credentials'});}
    // Hatua ya pili (2FA) — inatumika kwa akaunti kuu ya admin pekee. Nenosiri limekuwa sahihi
    // lakini bado tunahitaji msimbo wa tarakimu 6 kutoka programu ya authenticator kabla ya
    // kuingia. Kosa hapa bado linahesabiwa kwenye kikomo cha majaribio (rate limit) ili
    // kuzuia mtu kujaribu kubahatisha msimbo huo bila kikomo.
    const totp = (read().security || {}).totp;
    if (username === adminUsername && totp && totp.enabled) {
      if (!verifyTotp(totp.secret, supplied.code)) { recent.push(now); attempts.set(ip, recent); return json(res, 401, { error: 'Enter the 6-digit code from your authenticator app.', requires2fa: true }); }
    }
    attempts.delete(ip);
    // Rekodi mafanikio ya kuingia (mtumiaji, IP, muda) ili admin aone historia ya kuingia kwenye dashboard.
    const data=read();data.security=data.security||{};data.security.loginHistory=[...(data.security.loginHistory||[]),{username,ip,at:new Date().toISOString()}].slice(-20);write(data);
    return issueSession(req,res,username,role,mustChangePassword); }
    // Kubadilisha nenosiri lako mwenyewe — kinachotumika hasa mara ya kwanza baada ya kuingia
    // na nenosiri la mara-moja (one-time password). Baada ya hapa, nenosiri jipya linahitaji
    // herufi 12+ kama nenosiri la kawaida la kudumu, na bendera ya "lazima libadilishwe" inaondolewa.
    if (req.url === '/api/admin/me/password' && req.method === 'PUT') { const auth=session(req); if(!auth)return json(res,401,{error:'Sign in required'}); if(auth.username===adminUsername)return json(res,400,{error:'The primary admin password is set via the ADMIN_PASSWORD environment variable, not here.'}); const input=await body(req),newPassword=String(input.password||''); if(newPassword.length<12)return json(res,400,{error:'Choose a permanent password with at least 12 characters.'}); const data=read(),user=(data.users||[]).find(u=>u.username===auth.username); if(!user)return json(res,404,{error:'User not found.'}); user.passwordHash=await hashPassword(newPassword); user.mustChangePassword=false; write(data); return issueSession(req,res,auth.username,auth.role,false); }
    if (req.url === '/api/admin/totp/setup' && req.method === 'POST') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const data=read(); const totpSecret=base32Encode(crypto.randomBytes(20)); data.security=data.security||{}; data.security.totpPending={secret:totpSecret}; write(data); const label=encodeURIComponent(`Agape Admin (${adminUsername})`); return json(res,200,{secret:totpSecret,otpauth:`otpauth://totp/${label}?secret=${totpSecret}&issuer=Agape%20Family%20Foundation`}); }
    if (req.url === '/api/admin/totp/confirm' && req.method === 'POST') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),data=read(),pending=(data.security||{}).totpPending; if(!pending)return json(res,400,{error:'Start setup again — no pending code found.'}); if(!verifyTotp(pending.secret,input.code))return json(res,400,{error:'That code did not match. Check your authenticator app and try again.'}); data.security.totp={secret:pending.secret,enabled:true}; delete data.security.totpPending; write(data); return json(res,200,{ok:true}); }
    if (req.url === '/api/admin/totp/disable' && req.method === 'POST') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),data=read(),totp=(data.security||{}).totp; if(!totp||!totp.enabled)return json(res,400,{error:'Two-factor authentication is not enabled.'}); if(!verifyTotp(totp.secret,input.code))return json(res,400,{error:'That code did not match.'}); delete data.security.totp; write(data); return json(res,200,{ok:true}); }
    if (req.url === '/api/admin/users' && req.method === 'GET') { if(!session(req))return json(res,401,{error:'Sign in required'}); return json(res,200,(read().users||[]).map(({username,active,createdAt,role,mustChangePassword})=>({username,active,createdAt,role:role||'editor',mustChangePassword:!!mustChangePassword}))); }
    if (req.url === '/api/admin/users' && req.method === 'POST') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),username=cleanUsername(input.username),newPassword=String(input.password||''),role=input.role==='admin'?'admin':'editor',oneTime=!!input.mustChangePassword; if(!/^[a-z0-9._-]{3,40}$/.test(username)||username===adminUsername)return json(res,400,{error:'Username must be 3–40 characters: letters, numbers, dot, dash, or underscore.'});
      // Nenosiri la mara-moja (one-time/temporary) linaruhusiwa kuwa fupi kidogo (herufi 8+)
      // kwa sababu mtumiaji ATALAZIMIKA kulibadilisha mara tu baada ya kuingia mara ya kwanza —
      // sio nenosiri la kudumu. Nenosiri la kawaida (la kudumu) bado linahitaji herufi 12+.
      if(oneTime ? newPassword.length<8 : newPassword.length<12)return json(res,400,{error:oneTime?'A one-time password must contain at least 8 characters.':'Password must contain at least 12 characters.'});
      const data=read();data.users=data.users||[]; if(data.users.length>=MAX_USERS)return json(res,400,{error:`You can register at most ${MAX_USERS} additional users. Deactivate or remove one before adding another.`}); if(data.users.some(u=>u.username===username))return json(res,409,{error:'That username already exists.'});data.users.push({username,passwordHash:await hashPassword(newPassword),active:true,role,mustChangePassword:oneTime,createdAt:new Date().toISOString()});write(data);return json(res,201,{username,active:true,role,mustChangePassword:oneTime}); }
    if (req.url === '/api/admin/users/status' && req.method === 'PUT') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),username=cleanUsername(input.username),data=read(),user=(data.users||[]).find(u=>u.username===username); if(!user)return json(res,404,{error:'User not found.'}); user.active=!!input.active;write(data);return json(res,200,{username,active:user.active}); }
    // Ondoa akaunti ya mtumiaji kabisa (sio kuizima tu) — admin pekee anaweza kufanya hivi.
    if (req.url === '/api/admin/users' && req.method === 'DELETE') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),username=cleanUsername(input.username),data=read(); const before=(data.users||[]).length; data.users=(data.users||[]).filter(u=>u.username!==username); if(data.users.length===before)return json(res,404,{error:'User not found.'}); write(data); return json(res,200,{ok:true}); }
    // Onyesha picha zilizopo kwenye server (assets/uploads/) lakini hazitumiki tena kwenye
    // maudhui yoyote — kwa kawaida hufutwa kiotomatiki kwenye "save" inayofuata, lakini hii
    // inamruhusu admin kuthibitisha na kusafisha papo hapo bila kusubiri.
    if (req.url === '/api/admin/orphaned-images' && req.method === 'GET') {
      if (!session(req)) return json(res, 401, { error: 'Sign in required' });
      if (!fs.existsSync(mediaDir)) return json(res, 200, []);
      const keep = referencedImages(read());
      const orphans = fs.readdirSync(mediaDir).filter(f => /^[a-f0-9]{64}\.jpg$/.test(f) && !keep.has(f)).map(f => { const stat = fs.statSync(path.join(mediaDir, f)); return { file: f, url: `${publicPrefix(req)}/assets/uploads/${f}`, bytes: stat.size }; });
      return json(res, 200, orphans);
    }
    if (req.url === '/api/admin/orphaned-images' && req.method === 'DELETE') {
      const auth = session(req); if (!auth) return json(res, 401, { error: 'Sign in required' });
      if (!fs.existsSync(mediaDir)) return json(res, 200, { removed: 0 });
      const keep = referencedImages(read());
      let removed = 0;
      for (const f of fs.readdirSync(mediaDir)) { if (/^[a-f0-9]{64}\.jpg$/.test(f) && !keep.has(f)) { fs.unlinkSync(path.join(mediaDir, f)); removed++; } }
      return json(res, 200, { removed });
    }
    // Kubadilisha nenosiri la mtumiaji (mfano: amesahau nenosiri lake) — admin pekee anaweza
    // kufanya hivi, na hauhitaji kujua nenosiri la zamani.
// ============================================================
// UTOAJI WA HTML KUTOKA SERVER (Server-Side Rendering) — maandishi halisi ya sasa (kutoka
// content.json) yanaandikwa NDANI YA ukurasa KABLA haujatumwa kwa mteja. Hii ndiyo
// inayowezesha Google na roboti za AI (nyingi HAZIENDESHI JavaScript kabisa, au huchelewesha
// sana) kuona maudhui halisi badala ya maandishi ya mfano (placeholder) yaliyowekwa kwenye
// faili tuli. JS ya mteja (site-data.js) bado inaendesha baadaye kwa mwingiliano wa papo hapo
// (kubadilisha lugha, fomu, n.k.) bila kupakia upya ukurasa — mchoro huu unajulikana kama
// "hydration": server inachora HTML kamili, kisha JS inaifanya hai.
const escHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function injectMarker(html, name, innerHtml) {
  return html.replace(new RegExp(`<!-- SSR:${name}:START -->[\\s\\S]*?<!-- SSR:${name}:END -->`), `<!-- SSR:${name}:START -->${innerHtml}<!-- SSR:${name}:END -->`);
}
// Badilisha maandishi ya ndani ya kipengele chenye id maalum — inatambua jina la tag
// kiotomatiki (\2) ili kufunga tag SAHIHI, si tag yoyote ya kwanza inayofuata.
function replaceTextById(html, id, newText) {
  return html.replace(new RegExp(`(<([a-zA-Z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`), (_, open, tag, close) => `${open}${newText}${close}`);
}
function setStyleOnId(html, id, styleAddition) {
  return html.replace(new RegExp(`(<div\\b[^>]*\\bid="${id}"[^>]*)(>)`), (match, openPart, closeBracket) => {
    if (/style="/.test(openPart)) return openPart.replace(/style="([^"]*)"/, (m, existing) => `style="${existing}${existing.trim().endsWith(';') || !existing.trim() ? '' : ';'}${styleAddition}"`) + closeBracket;
    return `${openPart} style="${styleAddition}"${closeBracket}`;
  });
}
function setHrefById(html, id, href) {
  if (!href) return html;
  return html.replace(new RegExp(`(<a\\b[^>]*\\bid="${id}"[^>]*\\bhref=")[^"]*(")`), `$1${href}$2`);
}
function setMetaTag(html, selectorAttr, selectorValue, contentValue) {
  const re = new RegExp(`(<meta\\b[^>]*${selectorAttr}="${selectorValue}"[^>]*\\bcontent=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, `$1${escHtml(contentValue)}$2`);
  return html.replace('</head>', `  <meta ${selectorAttr}="${selectorValue}" content="${escHtml(contentValue)}" />\n</head>`);
}
function setTitle(html, title) { return html.replace(/<title[^>]*>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`); }
function setCanonical(html, url) {
  html = /rel="canonical"/.test(html) ? html.replace(/<link\s+rel="canonical"[^>]*>/, `<link rel="canonical" href="${url}" />`) : html.replace('</head>', `  <link rel="canonical" href="${url}" />\n</head>`);
  return setMetaTag(html, 'property', 'og:url', url);
}

const renderProgramsHtml = programs => (programs || []).map(p => `<article class="program-card reveal visible" role="listitem"><div class="program-img"><div class="program-img-inner" style="background-image:url('${escHtml(p[4])}')" role="img" aria-label="${escHtml(p[0])}"></div><div class="program-icon-wrap" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-8-4.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.5-8 11-8 11Z"/></svg></div></div><div class="program-body"><h3 class="program-title">${escHtml(p[0])}</h3><p class="program-text">${escHtml(p[1])}</p><div class="program-stat"><strong>${escHtml(p[2])}</strong> ${escHtml(p[3])}</div></div></article>`).join('');
const renderStoriesHtml = reviews => (reviews || []).slice(0, 3).map((r, i) => `<article class="story-card reveal reveal-delay-${i + 1}"><div class="story-img"><div class="story-img-inner" style="background-image:url('${escHtml(r[3])}')" role="img" aria-label="${escHtml(r[0])}"></div></div><div class="story-body"><div class="story-quote-mark" aria-hidden="true">"</div><h3 class="story-name">${escHtml(r[0])}</h3><div class="story-age">${escHtml(r[1])}</div><p class="story-text">${escHtml(r[2])}</p></div></article>`).join('');
const renderGalleryHtml = gallery => (gallery || []).map(item => `<div class="gallery-item"><img src="${escHtml(item[0])}" alt="${escHtml(item[1])}"><div class="gallery-overlay"><div class="gallery-overlay-text"><strong>${escHtml(item[1])}</strong><br><span>${escHtml(item[2])}</span></div></div></div>`).join('');
const renderBlogGridHtml = blog => (blog || []).map(post => `<a class="blog-card" href="blog-post.html?id=${encodeURIComponent(post.id)}" style="text-decoration:none;color:inherit;display:block"><div class="blog-card-img" style="background-image:url('${escHtml(post.image)}');background-size:cover;background-position:center"></div><div class="blog-card-body"><div class="blog-card-date">${escHtml(post.date)}</div><h3 class="blog-card-title">${escHtml(post.title)}</h3><p class="blog-card-excerpt">${escHtml(post.excerpt)}</p><span class="blog-card-link">Read More →</span></div></a>`).join('') || '<p style="color:var(--text-body)">No posts yet.</p>';
const renderTeamHtml = leaders => (leaders || []).map(l => `<article class="team-card"><div class="team-card-img team-card-photo" style="background-image:url('${escHtml(l[3])}')" role="img" aria-label="${escHtml(l[0])}"></div><div class="team-card-body"><div class="team-card-name">${escHtml(l[0])}</div><div class="team-card-title">${escHtml(l[1])}</div><p class="team-card-bio">${escHtml(l[2])}</p></div></article>`).join('') || '<p>No leaders have been added yet.</p>';
const renderUpdatesHtml = updates => {
  if (!updates || !updates.length) return '<div class="updates-empty">There are no active updates right now — check back soon.</div>';
  return updates.map(u => {
    const hoursLeft = u.expiresAt ? Math.max(0, Math.round((new Date(u.expiresAt).getTime() - Date.now()) / 3600000)) : null;
    return `<article class="update-card"><div class="update-imgwrap"><img src="${escHtml(u.image)}" alt="${escHtml(u.title)}"><span class="update-badge">Update</span></div><div class="update-body"><h2 class="update-title">${escHtml(u.title)}</h2><p class="update-details">${escHtml(u.details)}</p>${hoursLeft !== null ? `<div class="update-time">${hoursLeft < 1 ? 'Ending soon' : `Active for ${hoursLeft}h more`}</div>` : ''}</div></article>`;
  }).join('');
};

// Kwa kila ukurasa unaojulikana, chora upya maeneo yake yenye maudhui yanayobadilika,
// kwa kutumia data ya SASA (ya moja kwa moja) kutoka content.json — si data ya wakati
// ukurasa ulipoandikwa (build time), kwa sababu hakuna "build time" hapa kabisa.
function serverRenderHtml(urlPath, html, data) {
  const hero = data.hero || {}, seo = data.seo || {}, contact = data.contact || {};
  if (urlPath === '/' || urlPath === '/index.html') {
    if (data.heroImage) html = setStyleOnId(html, 'heroBg', `background-image:url('${data.heroImage}')`);
    html = replaceTextById(html, 'heroChildrenCount', escHtml(hero.childrenCount || '520+'));
    html = replaceTextById(html, 'heroChildrenHeadline', escHtml(hero.headline || 'Children Given a Second Chance'));
    html = replaceTextById(html, 'heroChildrenDescription', escHtml(hero.description || 'Providing education, healthcare, and daily support to orphaned children across Tanzania.'));
    if (data.programs && data.programs.length) html = injectMarker(html, 'PROGRAMS', renderProgramsHtml(data.programs));
    if (data.reviews && data.reviews.length) html = injectMarker(html, 'STORIES', renderStoriesHtml(data.reviews));
    if (seo.homeTitle) html = setTitle(html, seo.homeTitle);
    if (seo.homeDescription) html = setMetaTag(html, 'name', 'description', seo.homeDescription);
    if (seo.shareImage) html = setMetaTag(html, 'property', 'og:image', seo.shareImage);
  } else if (urlPath === '/pages/gallery.html') {
    if (data.gallery) html = injectMarker(html, 'GALLERY', renderGalleryHtml(data.gallery));
  } else if (urlPath === '/pages/blog.html') {
    if (data.blog) html = injectMarker(html, 'BLOG', renderBlogGridHtml(data.blog));
  } else if (urlPath === '/pages/leadership.html') {
    if (data.leaders) html = injectMarker(html, 'TEAM', renderTeamHtml(data.leaders));
  } else if (urlPath === '/pages/updates.html') {
    html = injectMarker(html, 'UPDATES', renderUpdatesHtml(data.updates));
  } else if (urlPath === '/pages/contact.html') {
    if (contact.intro) html = replaceTextById(html, 'contactIntro', escHtml(contact.intro));
    if (contact.email) { html = replaceTextById(html, 'contactEmail', escHtml(contact.email)); html = setHrefById(html, 'contactEmail', `mailto:${contact.email}`); }
    const wa = String(contact.whatsapp || '').replace(/\D/g, '');
    if (wa) { html = replaceTextById(html, 'contactWhatsapp', `+${escHtml(wa)}`); html = setHrefById(html, 'contactWhatsapp', `https://wa.me/${wa}`); }
    if (contact.phone) { html = replaceTextById(html, 'contactPhone', escHtml(contact.phone)); html = setHrefById(html, 'contactPhone', `tel:${contact.phone.replace(/[^+\d]/g, '')}`); }
    if (contact.office) html = replaceTextById(html, 'contactOffice', escHtml(contact.office));
    if (contact.availability) html = replaceTextById(html, 'contactAvailability', escHtml(contact.availability));
  } else if (urlPath === '/pages/blog-post.html') {
    // Kila chapisho la blog linahitaji <title> na maelezo (description) yake MAALUM — hii
    // ndiyo faida kubwa zaidi ya SEO: kila makala inaonekana kwa jina lake halisi kwenye
    // matokeo ya utafutaji, si jina la ukurasa la jumla.
  }
  return html;
}
function renderBlogPostPage(html, post, urlObj) {
  if (!post) return html.replace('<div id="postContent">', `<div id="postContent"><div class="post-missing"><p>This post could not be found. It may have been removed.</p></div>`);
  html = setTitle(html, `${post.title} | Agape Family Foundation`);
  html = setMetaTag(html, 'name', 'description', (post.excerpt || post.body || '').slice(0, 200));
  html = setMetaTag(html, 'property', 'og:title', post.title);
  html = setMetaTag(html, 'property', 'og:description', (post.excerpt || post.body || '').slice(0, 200));
  html = setMetaTag(html, 'property', 'og:image', post.image);
  const content = `<div class="post-date">${escHtml(post.date)}</div><h1 class="post-title">${escHtml(post.title)}</h1><img class="post-image" src="${escHtml(post.image)}" alt="${escHtml(post.title)}"><div class="post-body">${escHtml(post.body || post.excerpt)}</div>`;
  return html.replace('<div id="postContent">', `<div id="postContent">${content}`);
}
const SSR_PAGES = new Set(['/', '/index.html', '/pages/gallery.html', '/pages/blog.html', '/pages/leadership.html', '/pages/updates.html', '/pages/contact.html', '/pages/blog-post.html']);

    if (req.url === '/api/admin/users/password' && req.method === 'PUT') { const auth=session(req); if(!auth||auth.role!=='admin')return json(res,403,{error:'Administrator access required'}); const input=await body(req),username=cleanUsername(input.username),newPassword=String(input.password||''),data=read(),user=(data.users||[]).find(u=>u.username===username); if(!user)return json(res,404,{error:'User not found.'}); if(newPassword.length<12)return json(res,400,{error:'Password must contain at least 12 characters.'}); user.passwordHash=await hashPassword(newPassword); write(data); return json(res,200,{ok:true}); }
    if (req.url === '/api/logout' && req.method === 'POST') { res.writeHead(204,{'Set-Cookie':`aff_session=; HttpOnly; SameSite=Strict; Path=${publicPrefix(req)||'/'}; Max-Age=0`}); return res.end(); }
    // sitemap.xml na llms.txt zinatengenezwa MOJA KWA MOJA (dynamically) kutoka data ya sasa —
    // hivyo huwa hazipitwi na wakati (stale) machapisho ya blog yanapoongezwa au kuondolewa,
    // tofauti na faili tuli ambalo lingehitaji kusasishwa kila mara kwa mkono.
    if (req.url === '/sitemap.xml') {
      const data = publicContent(read());
      const base = requestBaseUrl(req);
      const staticPages = ['/', '/pages/about.html', '/pages/leadership.html', '/pages/gallery.html', '/pages/blog.html', '/pages/updates.html', '/pages/volunteer.html', '/pages/contact.html'];
      const blogUrls = (data.blog || []).map(p => `/pages/blog-post.html?id=${encodeURIComponent(p.id)}`);
      const urls = [...staticPages, ...blogUrls];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${base}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(xml);
    }
    // llms.txt — mkataba unaokua maarufu wa kutoa muhtasari safi, wenye muundo, kwa AI/LLM
    // badala ya kuvichambua vibaya HTML nzima. Angalia https://llmstxt.org
    if (req.url === '/llms.txt') {
      const data = publicContent(read());
      const base = requestBaseUrl(req);
      const hero = data.hero || {};
      const lines = [
        '# Agape Family Foundation', '',
        `> ${hero.description || 'A registered NGO in Tanzania providing education, healthcare, and daily support to orphaned and vulnerable children.'}`, '',
        `Agape Family Foundation has supported ${hero.childrenCount || '520+'} children across Tanzania. This site describes the foundation's programs, leadership, impact stories, and how to donate or volunteer.`, '',
        '## Pages', '',
        `- [Home](${base}/): Mission, impact statistics, and ways to donate (M-Pesa, Tigo Pesa, Airtel Money, Halotel)`,
        `- [About](${base}/pages/about.html): Mission, vision, values, and history`,
        `- [Leadership](${base}/pages/leadership.html): Foundation leadership team`,
        `- [Gallery](${base}/pages/gallery.html): Photos of programs and community work`,
        `- [Volunteer](${base}/pages/volunteer.html): Volunteer opportunities and application`,
        `- [Contact](${base}/pages/contact.html): Contact details and message form`,
        `- [Updates](${base}/pages/updates.html): Current announcements and events`,
        `- [Blog](${base}/pages/blog.html): News and stories`, ''
      ];
      if (data.programs && data.programs.length) { lines.push('## Programs', ''); data.programs.forEach(p => lines.push(`- **${p[0]}**: ${p[1]}`)); lines.push(''); }
      if (data.blog && data.blog.length) { lines.push('## Recent blog posts', ''); data.blog.forEach(p => lines.push(`- [${p.title}](${base}/pages/blog-post.html?id=${encodeURIComponent(p.id)}): ${p.excerpt}`)); lines.push(''); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(lines.join('\n'));
    }
    if (req.url === '/control') { if (!session(req)) { res.writeHead(302,{Location:`${publicPrefix(req)}/pages/login.html`}); return res.end(); } req.url='/pages/admin.html'; }
    if (req.url === '/pages/admin.html') { if (!session(req)) return json(res,401,{error:'Sign in required'}); }
    const urlPath = req.url.split('?')[0];
    const file=safeFile(req.url === '/' ? '/index.html' : req.url); if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    // Kurasa zenye maudhui yanayobadilika (SSR) — soma HTML, andika ndani yake maudhui ya
    // SASA kutoka content.json, KISHA tuma. Hazitumii ETag/cache ya muda mrefu, kwa sababu
    // lazima ziwe SAHIHI kila wakati (mara moja admin akihariri, ukurasa lazima ubadilike).
    if (SSR_PAGES.has(urlPath) && path.extname(file) === '.html') {
      let html = fs.readFileSync(file, 'utf8');
      const data = publicContent(read());
      const queryIndex = req.url.indexOf('?');
      const canonicalUrl = `${requestBaseUrl(req)}${urlPath}${urlPath === '/pages/blog-post.html' && queryIndex !== -1 ? req.url.slice(queryIndex) : ''}`;
      if (urlPath === '/pages/blog-post.html') {
        const id = new URL(req.url, 'http://internal').searchParams.get('id');
        const post = (data.blog || []).find(p => p.id === id);
        html = renderBlogPostPage(html, post, null);
      } else {
        html = serverRenderHtml(urlPath, html, data);
      }
      html = setCanonical(html, canonicalUrl);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...securityHeaders });
      return res.end(html);
    }
    const stat = fs.statSync(file);
    const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream',...securityHeaders};
    if (file.startsWith(mediaDir)) {
      headers['Cache-Control']='public, max-age=31536000, immutable';
    } else if (['.html','.js','.css'].includes(path.extname(file))) {
      // ETag ya bei nafuu (mtime+ukubwa, si kusoma faili zima) inaruhusu majibu ya 304
      // yenye kasi kwa ziara zinazorudia — "no-cache" haimaanishi "usihifadhi kabisa",
      // inamaanisha "hakiki kabla ya kutumia nakala iliyohifadhiwa", ambayo ETag inafanya
      // kuwa haraka sana badala ya kupakua ukurasa mzima kila mara.
      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      headers['ETag'] = etag;
      headers['Cache-Control'] = path.extname(file) === '.js' ? 'public, max-age=86400, must-revalidate' : 'no-cache';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    }
    res.writeHead(200,headers); fs.createReadStream(file).pipe(res);
  } catch (error) { json(res,400,{error:error.message}); }
}).listen(process.env.PORT || 3000, process.env.HOST || '127.0.0.1', () => {
  console.log('Agape server running on http://localhost:'+(process.env.PORT||3000));
  // Uchunguzi wa mwanzo (startup diagnostics) — huonekana kwenye AWS logs mara moja unapoanzisha server,
  // hivyo hutahitaji kukisia kwa nini admin haoni "cards".
  const exists = fs.existsSync(store);
  console.log(`[startup] Content file: ${store} — ${exists ? 'ipo' : 'HAIPO (itaundwa tupu mara ya kwanza utakapo-save)'}`);
  if (exists) {
    const keys = Object.keys(read());
    console.log(`[startup] Content keys loaded: ${keys.length ? keys.join(', ') : '(faili tupu — hakuna cards zitaonekana)'}`);
  }
  try { fs.accessSync(path.dirname(store), fs.constants.W_OK); console.log('[startup] data/ folder inaweza kuandikwa (writable): ndiyo'); }
  catch { console.error('[startup] data/ folder inaweza kuandikwa (writable): HAPANA — admin ataona kosa akijaribu save.'); }
});
