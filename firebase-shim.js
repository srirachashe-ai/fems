// เชื่อมหน้าเว็บกับ Firebase (Firestore + Email/Password Auth) พร้อมหน้าเข้าสู่ระบบ
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, terminate, clearIndexedDbPersistence, persistentLocalCache, persistentMultipleTabManager, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where, orderBy, limit, } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

window.__fbStarted = true;
const ready = window.__fbResolve;
async function start() {
  const conf = window.FIREBASE_CONFIG;
  if (!conf || !conf.apiKey || String(conf.apiKey).includes('ใส่')) throw new Error('missing config');
  const app = initializeApp(conf);
  const auth = getAuth(app);
  // ใช้ข้อมูลที่เครื่องจำไว้ก่อน แล้วค่อยอัปเดตจากเซิร์ฟเวอร์ (เปิดครั้งต่อไปเร็วขึ้นมาก)
  let fs;
  try { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { fs = initializeFirestore(app, { ignoreUndefinedProperties: true }); }
  const DOMAIN = conf.authDomain;
  const toEmail = u => { u = String(u || '').trim().toLowerCase(); return u.includes('@') ? u : u + '@' + DOMAIN; };
  const userName = e => String(e || '').toLowerCase().endsWith('@' + DOMAIN) ? e.slice(0, -(DOMAIN.length + 1)) : (e || '');
  const ADMINS = (window.FEMS_ADMINS || []).map(toEmail);
  // ถ้าเคยเข้าสู่ระบบในเครื่องนี้แล้ว ใช้บัญชีเดิมทันที
  let known = await new Promise(res => { const off = onAuthStateChanged(auth, u => { off(); res(u); }, () => res(null)); });
  if (known && known.isAnonymous) { await signOut(auth).catch(() => {}); known = null; }
  const cred = known ? { user: known } : { user: await loginScreen(auth, toEmail) };

  const mapErr = e => ({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : e && e.code === 'resource-exhausted' ? 'quota_exceeded' : 'unavailable', message: String(e && e.message || e) });
  const fail = e => { throw mapErr(e); };
  const sDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  const sQ = s => ({ docs: s.docs.map(sDoc), size: s.size, empty: s.empty });
  const Q = q => ({
    where: (f, o, v) => Q(query(q, where(f, o, v))),
    orderBy: (f, d) => Q(query(q, orderBy(f, d || 'asc'))),
    limit: n => Q(query(q, limit(n))),
    get: () => getDocs(q).then(sQ, fail),
    onSnapshot: (n, er) => onSnapshot(q, s => n(sQ(s)), e => er && er(mapErr(e)))
  });
  const D = p => {
    const r = doc(fs, p);
    return {
      id: r.id, path: p,
      get: () => getDoc(r).then(sDoc, fail),
      set: d => setDoc(r, d).catch(fail),
      update: d => updateDoc(r, d).catch(fail),
      delete: () => deleteDoc(r).catch(fail),
      onSnapshot: (n, er) => onSnapshot(r, s => n(sDoc(s)), e => er && er(mapErr(e))),
      collection: sp => C(p + '/' + sp)
    };
  };
  const C = p => {
    const c = collection(fs, p);
    return Object.assign(Q(c), {
      path: p,
      doc: id => D(id ? p + '/' + id : doc(c).path),
      add: d => addDoc(c, d).then(r => D(r.path), fail)
    });
  };
  const db = { doc: D, collection: C };

  const email = (cred.user.email || '').toLowerCase();
  const isAdm = ADMINS.includes(email);
  window.claude.account = { name: userName(email), admin: isAdm };
  window.claude.changePassword = async (cur, nw) => {
    const u = auth.currentUser; if (!u) throw { code: 'auth/no-user' };
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, cur));
    await updatePassword(u, nw);
  };
  window.claude.signOut = async () => {
    try { await signOut(auth); } catch (e) {}
    try { await terminate(fs); await clearIndexedDbPersistence(fs); } catch (e) {}
    try { localStorage.removeItem('fe-ident'); localStorage.removeItem('fe-adm'); } catch (e) {}
    location.hash = ''; location.reload();
  };

  // รูปภาพเก็บใน Firestore (คอลเลกชัน blobs) ย่อให้เล็กก่อนบันทึก
  const cache = new Map(), loading = new Set();
  const PH = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#d5d9d2"/></svg>');
  function blobUrl(id) {
    if (cache.has(id)) return cache.get(id);
    if (!loading.has(id)) {
      loading.add(id);
      getDoc(doc(fs, 'blobs/' + id)).then(s => { cache.set(id, s.exists() ? s.data().d : PH); window.dispatchEvent(new Event('claude-blob')); }).catch(() => loading.delete(id));
    }
    return PH;
  }
  const toDataUrl = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  async function shrink(blob) {
    if (blob.size < 300000) return blob;
    try {
      const bmp = await createImageBitmap(blob), sc = Math.min(1, 1100 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      return await new Promise(r => cv.toBlob(x => r(x || blob), 'image/jpeg', .72));
    } catch (e) { return blob; }
  }
  const assets = {
    async upload(blob) {
      const small = await shrink(blob);
      if (small.size > 700000) throw { code: 'too_large', message: 'too large' };
      const d = await toDataUrl(small);
      const ref = await addDoc(collection(fs, 'blobs'), { d, at: new Date().toISOString(), by: cred.user.uid }).catch(fail);
      cache.set(ref.id, d);
      return { id: ref.id, url: d, sizeBytes: small.size, contentType: small.type };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete(id) { await deleteDoc(doc(fs, 'blobs/' + id)); return { deleted: true }; }
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    }
  };
  const uid = cred.user.uid;
  const user = {
    async me() { return { id: uid, name: '', isOwner: isAdm, canEdit: true, email: null, avatarUrl: '', color: '#888' }; },
    async id() { return uid; },
    async isOwner() { return isAdm; },
    async canEdit() { return true; },
    async can() { return null; },
    async profiles(ids) { return Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: '', avatarUrl: '', color: '#888', email: null, isMe: i === uid, guest: false }])); },
    async search() { return []; }
  };
  window.claude.blobUrl = blobUrl;
  return { db, user, assets, downloads };
}
// หน้าเข้าสู่ระบบ: แสดงก่อนหน้าเว็บ จนกว่าจะล็อกอินสำเร็จ
function loginScreen(auth, toEmail) {
  return new Promise(resolve => {
    const st = document.createElement('style');
    st.textContent = `.lgov{position:fixed;inset:0;z-index:100;overflow:auto;background:#f3f4f1;font-family:"Prompt","Noto Sans Thai",system-ui,sans-serif;color:#1a2028;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}
.lghero{position:relative;overflow:hidden;color:#fff;background:radial-gradient(120% 90% at 85% 15%,#ef5a3c 0%,rgba(239,90,60,0) 55%),linear-gradient(155deg,#7d150a 0%,#b3261a 38%,#3a1a1f 72%,#1f2731 100%);display:flex;flex-direction:column;justify-content:space-between;padding:max(40px,env(safe-area-inset-top,0px)) 48px 44px max(48px,env(safe-area-inset-left,0px))}
.lghero::before{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.09) 1.2px,transparent 1.2px);background-size:22px 22px;mask-image:linear-gradient(180deg,#000 0%,transparent 75%);-webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 75%)}
.lghero .ring{position:absolute;border-radius:50%;border:1.5px solid rgba(255,255,255,.12)}
.lgtop{position:relative;display:flex;align-items:center;gap:12px}
.lgtop b{font-family:"Prompt",sans-serif;font-size:28px;letter-spacing:.08em;line-height:1}
.lgtop span{display:block;font-size:13px;color:rgba(255,255,255,.75);margin-top:3px}
.lgart{position:relative;align-self:center;width:min(300px,60%);filter:drop-shadow(0 24px 30px rgba(0,0,0,.35))}
.lgart svg{width:100%;height:auto;display:block}
.lgtag{position:relative;display:grid;gap:10px}
.lgtag h2{margin:0;font-family:"Prompt",sans-serif;font-size:40px;line-height:1.15;text-wrap:balance}
.lgtag p{margin:0;font-size:16px;color:rgba(255,255,255,.82);max-width:30em}
.lgchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.lgchips span{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:5px 12px;font-size:13.5px;backdrop-filter:blur(4px)}
.lgside{display:grid;place-items:center;padding:40px max(24px,env(safe-area-inset-right,0px)) max(40px,env(safe-area-inset-bottom,0px)) 24px}
.lgcard{width:100%;max-width:400px;display:grid;gap:18px}
.lgcard h1{margin:0;font-family:"Prompt",sans-serif;font-size:32px;line-height:1.2}
.lgcard .lead{margin:-8px 0 4px;color:#59636e;font-size:15px;line-height:1.55}
.lgf{display:grid;gap:7px;font-size:14px;font-weight:600;color:#3f4a55}
.lgin{position:relative}
.lgin svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#8a949e;pointer-events:none}
.lgin input{width:100%;box-sizing:border-box;min-height:54px;border:1.5px solid #d5d9d2;border-radius:12px;background:#fff;padding:10px 14px 10px 46px;font:inherit;font-size:17px;font-weight:400;color:#1a2028;transition:border-color .15s,box-shadow .15s}
.lgin input:focus{outline:none;border-color:#c22d1a;box-shadow:0 0 0 4px rgba(194,45,26,.12)}
.lgin input:focus+svg,.lgin:focus-within svg{color:#c22d1a}
.lgin.pw input{padding-right:72px}
.lgin .tg{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;color:#2d5b86;font:inherit;font-size:14px;font-weight:600;padding:10px;cursor:pointer;border-radius:8px}
.lgin .tg:focus-visible{outline:2px solid #2d5b86}
.lgerr{display:none;align-items:center;gap:8px;background:#fdecea;color:#a3200f;border-radius:10px;padding:10px 12px;font-size:14px;font-weight:600}
.lgerr.on{display:flex}
.lgbtn{min-height:56px;border:0;border-radius:12px;background:linear-gradient(135deg,#d63a24,#a8200f);color:#fff;font:inherit;font-size:18px;font-weight:600;cursor:pointer;box-shadow:0 10px 22px rgba(194,45,26,.28);display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .1s,box-shadow .15s}
.lgbtn:hover{box-shadow:0 12px 26px rgba(194,45,26,.36)}.lgbtn:active{transform:translateY(1px)}
.lgbtn:focus-visible{outline:3px solid #1a2028;outline-offset:2px}
.lgbtn[disabled]{opacity:.7;cursor:wait}
.lgspin{width:18px;height:18px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:lgsp .8s linear infinite;display:none}
.lgbtn[disabled] .lgspin{display:block}
@keyframes lgsp{to{transform:rotate(360deg)}}
.lghelp{display:flex;gap:10px;align-items:flex-start;border-top:1px solid #e3e6e0;padding-top:16px;color:#59636e;font-size:13.5px;line-height:1.5}
.lghelp svg{flex:none;color:#8a949e;margin-top:1px}
@media (max-width:820px){.lgov{grid-template-columns:1fr;grid-template-rows:auto 1fr;background:#f3f4f1}
.lghero{padding:max(22px,env(safe-area-inset-top,0px)) 20px 62px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"top top" "tag art";column-gap:10px;row-gap:18px;align-items:end}
.lgtop{grid-area:top}.lgtop b{font-size:24px}
.lgtag{grid-area:tag;min-width:0}.lgtag h2{font-size:24px}.lgtag p{font-size:14px}.lgchips{display:none}
.lgart{grid-area:art;width:86px;align-self:end;margin-bottom:-14px}
.lgside{place-items:start center;padding:0 16px 32px;margin-top:-40px;position:relative}
.lgcard{background:#fff;border-radius:20px;padding:24px 20px;box-shadow:0 16px 40px rgba(20,28,36,.14)}
.lgcard h1{font-size:26px}}
@media (prefers-reduced-motion:reduce){.lgspin{animation:none}.lgbtn,.lgin input{transition:none}}`;
    document.head.appendChild(st);
    const ext = `<svg viewBox="0 0 120 190" aria-hidden="true"><defs><linearGradient id="lgb" x1="0" x2="1"><stop offset="0" stop-color="#8f1d10"/><stop offset=".33" stop-color="#ff6b4d"/><stop offset=".58" stop-color="#d63a24"/><stop offset="1" stop-color="#6e140a"/></linearGradient><linearGradient id="lgm" x1="0" x2="1"><stop offset="0" stop-color="#3a4047"/><stop offset=".5" stop-color="#c7cfd6"/><stop offset="1" stop-color="#30353b"/></linearGradient></defs><path d="M24 62c0-16 14-24 34-24s34 8 34 24v112c0 7-5 11-11 11H35c-6 0-11-4-11-11z" fill="url(#lgb)"/><rect x="48" y="20" width="20" height="20" rx="4" fill="url(#lgm)"/><path d="M40 21h40l8-10H52z" fill="#1d2126"/><path d="M70 14l34-10 3 7-33 11z" fill="#1d2126"/><path d="M68 32c28 0 42 14 42 40v40" fill="none" stroke="#14171b" stroke-width="7" stroke-linecap="round"/><rect x="104" y="108" width="12" height="24" rx="3" fill="#14171b"/><rect x="34" y="84" width="48" height="56" rx="4" fill="#fff"/><rect x="34" y="84" width="48" height="10" rx="3" fill="#c22d1a"/><g fill="#1a2028"><rect x="39" y="99" width="17" height="17"/><rect x="60" y="100" width="18" height="3"/><rect x="60" y="106" width="14" height="3"/><rect x="60" y="112" width="16" height="3"/><rect x="39" y="122" width="38" height="3"/><rect x="39" y="128" width="28" height="3"/></g><rect x="42" y="102" width="11" height="11" fill="#fff"/><rect x="45" y="105" width="5" height="5" fill="#1a2028"/><path d="M33 52c3 7 8 10 13 11" stroke="#fff" stroke-width="4" opacity=".4" fill="none" stroke-linecap="round"/><rect x="28" y="70" width="4" height="96" rx="2" fill="#fff" opacity=".18"/></svg>`;
    const ov = document.createElement('div'); ov.className = 'lgov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-labelledby', 'lg-h');
    ov.innerHTML = `<section class="lghero"><span class="ring" style="width:420px;height:420px;right:-140px;top:-120px"></span><span class="ring" style="width:260px;height:260px;right:-60px;top:-40px"></span>
<div class="lgtop"><svg width="22" height="32" viewBox="0 0 22 32" aria-hidden="true"><rect x="2" y="8" width="18" height="24" rx="4" fill="#fff"/><rect x="7" y="2" width="8" height="6" rx="1.5" fill="#ffb3a3"/></svg><div><b>FEMS</b><span>Fire Extinguisher Management System</span></div></div>
<div class="lgart">${ext}</div>
<div class="lgtag"><h2>ระบบบริหารจัดการและตรวจสอบถังดับเพลิง</h2><p>สแกน QR ที่ถัง ถ่ายรูปยืนยัน และส่งผลตรวจประจำเดือนจากมือถือ</p>
<div class="lgchips"><span>✓ ตรวจครบทุกถัง</span><span>✓ มีรูปยืนยันทุกครั้ง</span><span>✓ ติดตามผลได้ทันที</span></div></div></section>
<section class="lgside"><form class="lgcard" novalidate><h1 id="lg-h">เข้าสู่ระบบ</h1>
<label class="lgf" for="lg-u">ชื่อผู้ใช้<span class="lgin"><input id="lg-u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="เช่น user" required><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg></span></label>
<label class="lgf" for="lg-p">รหัสผ่าน<span class="lgin pw"><input id="lg-p" name="password" type="password" autocomplete="current-password" placeholder="รหัสผ่าน" required><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><button type="button" class="tg" aria-label="แสดงรหัสผ่าน">แสดง</button></span></label>
<div class="lgerr" role="alert"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/></svg><span></span></div>
<button class="lgbtn" type="submit"><span class="lgspin" aria-hidden="true"></span><span class="lbl">เข้าสู่ระบบ</span></button>
<div class="lghelp"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg><span>ลืมรหัสผ่านหรือยังไม่มีบัญชี ติดต่อผู้ดูแลระบบของแผนก</span></div></form></section>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form'), u = ov.querySelector('#lg-u'), p = ov.querySelector('#lg-p'), er = ov.querySelector('.lgerr'), ert = er.querySelector('span'), btn = ov.querySelector('.lgbtn'), lbl = btn.querySelector('.lbl'), tg = ov.querySelector('.tg');
    const showErr = t => { ert.textContent = t; er.classList.toggle('on', !!t); };
    try { u.value = localStorage.getItem('fems-last-user') || ''; } catch (e) {}
    setTimeout(() => (u.value ? p : u).focus(), 50);
    tg.onclick = () => { const s = p.type === 'password'; p.type = s ? 'text' : 'password'; tg.textContent = s ? 'ซ่อน' : 'แสดง'; tg.setAttribute('aria-label', s ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'); p.focus(); };
    f.onsubmit = async ev => {
      ev.preventDefault(); showErr('');
      if (!u.value.trim() || !p.value) { showErr('กรอกชื่อผู้ใช้และรหัสผ่าน'); (u.value.trim() ? p : u).focus(); return; }
      btn.disabled = true; lbl.textContent = 'กำลังเข้าสู่ระบบ…';
      try {
        const c = await signInWithEmailAndPassword(auth, toEmail(u.value), p.value);
        try { localStorage.setItem('fems-last-user', u.value.trim()); } catch (e) {}
        ov.remove(); st.remove(); resolve(c.user);
      } catch (e) {
        const c = e && e.code || '';
        showErr(c.includes('too-many-requests') ? 'ใส่ผิดหลายครั้ง รอสักครู่แล้วลองใหม่' : c.includes('network') ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ ลองใหม่อีกครั้ง' : c.includes('user-disabled') ? 'บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        p.value = ''; p.focus(); btn.disabled = false; lbl.textContent = 'เข้าสู่ระบบ';
      }
    };
  });
}
start().then(ready, e => { console.error('Firebase:', e); ready({}); });
