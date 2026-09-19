'use strict';
const { ipcRenderer } = require('electron');
const io = require('socket.io-client');

const $ = (id) => document.getElementById(id);
const webview = $('video-view');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Sayfa icindeki (iframe dahil) ilk video elemanini bulur
const FIND_VIDEO = `
    function findVideo(w) {
        try {
            if (!w || !w.document) return null;
            const v = w.document.querySelector('video'); if (v) return v;
            const frames = w.document.querySelectorAll('iframe, frame');
            for (let i = 0; i < frames.length; i++) {
                try { const f = findVideo(frames[i].contentWindow); if (f) return f; } catch (e) {}
            }
        } catch (e) {}
        return null;
    }`;

const EMOJI = ['😀','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','🙂','🤗','🤩','🤔','🤨','😐','🙄','😏','😮','😴','😌','😛','😜','🤤','😒','😔','🙃','😲','😞','😤','😢','😭','😱','😳','🤪','😵','😡','🤬','🤢','🤧','😇','🤠','🤡','🤫','🤭','🧐','🤓','😈','💀','👻','👽','🤖','💩','🙀','👋','✋','🖖','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','👍','👎','✊','👊','👏','🙌','🤝','🙏','💪','❤️','🧡','💛','💚','💙','💜','🖤','💔','💕','💞','💓','💗','💖','💝','🌟','⭐','✨','⚡','💥','🔥','🎬','🍿','🥤','📺','🌻','🌙','☕','🍕'];

// ---- Kalici ayarlar -----------------------------------------------------
const settings = (() => {
    const KEY = 'projesun.settings';
    let data = {};
    try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { data = {}; }
    return {
        get: (k, fallback) => (k in data ? data[k] : fallback),
        set: (k, v) => { data[k] = v; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} }
    };
})();

// ---- Durum ---------------------------------------------------------------
const S = {
    screen: 'setup', socket: null, pending: null, serverLabel: '', myName: '',
    entry: 'host',                       // odaya nasil girdik: 'host' | 'guest'
    isHost: false, roomID: '', roomName: '', isPublic: true,
    members: [], prevMembers: null, localRooms: [], globalRooms: [], watching: false,
    shareInfo: null, calls: false, hidden: new Set(), sync: 'waiting', drift: 0, hostState: null, videoFid: null, hostHref: '', rtt: 0, timecode: 0, syncTimer: null, lastSent: null, videoActive: false
};

// ---- Vurgu rengi (kullanicinin sectigi tek renk) ------------------------
function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d > 0.0001) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function hslLuminance(h, sPct, lPct) {
    const s = sPct / 100, l = lPct / 100, a = s * Math.min(l, 1 - l);
    const k = (n) => (n + h / 30) % 12;
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}
function applySignal(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    const { h, s, l } = hexToHsl(hex);
    const L = Math.min(68, Math.max(52, l));   // siyah zeminde her secim gorunur kalsin
    const lum = hslLuminance(h, s, L);
    const dark = (lum + 0.05) / (0.006 + 0.05), light = 1.05 / (lum + 0.05);
    const root = document.documentElement.style;
    root.setProperty('--signal', `hsl(${h} ${s}% ${L}%)`);
    root.setProperty('--on-signal', dark >= light ? '#14110c' : '#ffffff');
    if ($('signal-pick').value !== hex) $('signal-pick').value = hex;
    drawTrace();
}

// ---- Ekranlar ------------------------------------------------------------
const SCREENS = ['setup', 'create', 'browse', 'room'];
function go(screen) {
    S.screen = screen;
    document.body.dataset.screen = screen;
    SCREENS.forEach((n) => { $('screen-' + n).hidden = n !== screen; });
    syncWatch();
    renderDynamic();
    const focusId = { setup: $('username').value ? null : 'username', create: 'room-name', room: 'chat-msg' }[screen];
    if (focusId) $(focusId).focus();
}

// Acik oda dizini sadece oda listesi ekranindayken izlenir
function syncWatch() {
    const want = S.screen === 'browse';
    if (want && !S.watching) { S.watching = true; ipcRenderer.invoke('directory-watch'); }
    else if (!want && S.watching) { S.watching = false; ipcRenderer.invoke('directory-unwatch'); S.globalRooms = []; }
}
ipcRenderer.on('directory-update', (e, list) => { S.globalRooms = list; if (S.screen === 'browse') renderRooms(); });

// ---- Durum satiri --------------------------------------------------------
let statusTimer = 0;
function say(key, vars) {
    let text = t(key, vars);
    if (text === key) text = t('errConnect');
    $('status-text').textContent = text;
    $('status').hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').hidden = true; }, 6500);
}

// ---- Lider (geri sayim) --------------------------------------------------
// Bekleme suresi gercek: is bitince sayim kesilir, bitmezse 1'de sayaç donmadan halka doner.
function runLeader(labelKey, startN, task) {
    return new Promise((resolve) => {
        const el = $('leader'), num = $('leader-num');
        let n = startN, done = false;
        const setNum = () => {
            num.textContent = String(n);
            num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
            el.classList.remove('running'); void el.offsetWidth; el.classList.add('running');
        };
        let shownAt = 0, timer = 0;
        const show = () => {
            shownAt = Date.now();
            $('leader-label').textContent = t(labelKey);
            el.dataset.label = labelKey;
            el.hidden = false;
            document.body.classList.add('leading');
            setNum();
            timer = setInterval(() => { if (n > 1) { n--; setNum(); } }, 1000);
        };
        const showTimer = setTimeout(show, 250);       // hizli bir katilimda ekran yanip sonmesin
        const teardown = (res) => {
            clearInterval(timer);
            el.hidden = true; el.classList.remove('running');
            document.body.classList.remove('leading');
            resolve(res);
        };
        const finish = (res) => {
            if (done) return;
            done = true;
            clearTimeout(showTimer);
            if (!shownAt) return teardown(res);
            setTimeout(() => teardown(res), Math.max(0, 750 - (Date.now() - shownAt)));   // gorunduyse okunacak kadar kal
        };
        $('leader-cancel').onclick = () => { closeSocket(); finish({ cancelled: true }); };
        Promise.resolve().then(task).then((r) => finish({ ok: true, r }), (e) => finish({ ok: false, e }));
    });
}

// ---- Baglanti ------------------------------------------------------------
// Kod (abc-def-ghi), tam link veya IP:port kabul eder
function resolveServer(input) {
    const v = input.trim().replace(/\/$/, '');
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/i.test(v)) return `https://${v.toLowerCase()}.trycloudflare.com`;
    return `http://${v}${/:\d+$/.test(v) ? '' : ':3000'}`;
}

function closeSocket() {
    if (S.pending) { S.pending.close(); S.pending = null; }
    if (S.socket) { S.socket.close(); S.socket = null; }
    S.localRooms = [];
}

function openServer(address, label) {
    return new Promise((resolve, reject) => {
        closeSocket();
        const s = io(address, { reconnectionAttempts: 6, reconnectionDelay: 800, reconnectionDelayMax: 2500, timeout: 8000 });
        S.pending = s;
        s.once('connect', () => { S.pending = null; S.socket = s; S.serverLabel = label; bindSocket(s); resolve(s); });
        // Yeni acilan tunel adresi birkac saniye cozulmeyebilir: ilk hatada pes etme, hepsi bitince bildir
        s.io.once('reconnect_failed', () => {
            if (S.pending !== s) return;
            S.pending = null; s.close();
            reject(new Error('connect'));
        });
    });
}

function emitJoin(payload) {
    return new Promise((resolve, reject) => {
        const s = S.socket;
        if (!s) return reject(new Error('connect'));
        const cleanup = () => { s.off('host-status', ok); s.off('join-error', bad); };
        const ok = (status) => { cleanup(); resolve(status); };
        const bad = (code) => { cleanup(); reject(Object.assign(new Error(code), { code })); };
        s.on('host-status', ok);
        s.on('join-error', bad);
        s.emit('join-room', { username: S.myName, ...payload });
    });
}

function bindSocket(s) {
    s.on('room-list', (list) => {
        S.localRooms = list.map((r) => ({ ...r, server: S.serverLabel }));
        if (S.screen === 'browse') renderRooms();
    });
    s.on('room-members', updateMembers);
    s.on('peer-url-change', (url) => { if (!S.isHost && (url === 'about:blank' || /^https?:\/\//i.test(String(url)))) setVideoUrl(url); });   // misafir sadece http(s) acar
    s.on('peer-video-sync', (state) => { if (!S.isHost) applySync(state); });
    s.on('receive-chat', addChat);
    s.on('mod-notice', (kind) => {
        if (kind === 'camoff') { say('camOffNotice'); stopCamera(false); return; }
        say(kind === 'muted' ? 'mutedNotice' : 'unmutedNotice');
        if (kind === 'muted' && V.on) setMicMuted(true, true);
    });
    s.on('voice-peers', onVoicePeers);
    s.on('rtc-signal', onSignal);
    s.on('voice-error', (c) => { say('err_' + c); teardownVoice(false); });
    s.on('kicked', () => { say('kickedNotice'); leaveLocal(); });
    s.on('room-closed', () => { say('errRoomClosed'); leaveLocal(); });
    s.on('disconnect', (reason) => {
        if (reason === 'io client disconnect') return;
        closeSocket(); resetRoom(); go('setup'); say('errDropped');
    });
}

function failure(e) {
    if (!e || e.cancelled) return;
    if (e.code) say('err_' + e.code);
    else if (e.message === 'start') say('errStart');
    else say('errConnect');
}

// ---- Oda -----------------------------------------------------------------
function enterRoom(status) {
    S.isHost = status.isHost;
    S.roomID = status.roomID;
    S.roomName = status.name;
    S.isPublic = status.isPublic !== false;
    S.calls = status.calls === true;
    S.rtt = 0; measureRtt();
    setTime(0);      // (prevMembers sifirlanmaz: ilk uye listesi bu olaydan once gelmis olabilir)
    $('room-title').textContent = S.roomName;
    $('host-url-form').hidden = !S.isHost;
    setSync('waiting');
    setVideoUrl('about:blank');
    go('room');
    renderInvite();
    renderVoice();
    startHostSync();
}

function resetRoom() {
    teardownVoice(false);
    S.calls = false;
    clearInterval(S.syncTimer); S.syncTimer = null; S.lastSent = null;
    S.hidden.clear();
    S.isHost = false; S.roomID = ''; S.members = []; S.prevMembers = null; S.hostState = null; S.videoFid = null; S.hostHref = '';
    $('chat-messages').textContent = '';
    $('members').textContent = '';
    $('video-url').value = '';
    $('invite-strip').hidden = true;
    $('site-bar').hidden = true;
    $('emoji-panel').hidden = true;
    if (webview.src !== 'about:blank') webview.src = 'about:blank';
    S.videoActive = false;
    cancelAnimationFrame(trace.raf);
}

function leaveLocal() {
    resetRoom();
    go(S.entry === 'host' ? 'create' : 'browse');
    if (S.socket) S.socket.emit('list-rooms');
}

function updateMembers(list) {
    const names = list.map((m) => m.name);
    if (S.prevMembers) {
        names.filter((n) => !S.prevMembers.includes(n)).forEach((n) => addNote(t('joinedLine', { name: n })));
        S.prevMembers.filter((n) => !names.includes(n)).forEach((n) => addNote(t('leftLine', { name: n })));
    }
    S.prevMembers = names;
    S.members = list;
    syncVoicePeers();
    renderMembers();
    renderTiles();
}

// ---- Video ve senkron ----------------------------------------------------
function setVideoUrl(url) {
    S.videoActive = !!url && url !== 'about:blank';
    if (S.videoActive && webview.src !== url) webview.src = url;
    renderDynamic();
}

function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`;
}
function setTime(sec) { S.timecode = sec; $('timecode').textContent = fmtTime(sec); }

// ---- Evrensel video baglama --------------------------------------------
// Kod HER cercevede (capraz kaynakli iframe dahil) calisir; her cerceve kendi en uygun videosunu secer.
// Secim: gorunen alan buyuk, sure uzun, oynuyorsa artı puan. Kucuk/reklam videolari elenir.
const PICK = `
    function cuePick() {
        const list = [];
        const walk = (root) => root.querySelectorAll('video').forEach((v) => list.push(v));
        walk(document);
        if (!list.length) {   // shadow DOM icindeki oynaticilar
            const deep = (root) => root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot && el.tagName.includes('-')) { walk(el.shadowRoot); deep(el.shadowRoot); } });
            deep(document);
        }
        let best = null, bestScore = 0;
        for (const v of list) {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, Math.min(r.width, innerWidth)) * Math.max(0, Math.min(r.height, innerHeight));
            if (area < 4800) continue;
            const dur = isFinite(v.duration) ? Math.min(v.duration, 7200) : 0;
            const score = area + dur * 10 + (!v.paused ? 5000 : 0);
            if (score > bestScore) { bestScore = score; best = v; }
        }
        return best ? { v: best, score: bestScore } : null;
    }`;

// Yonetici: videonun kendi olaylari (oynat, durdur, ileri sar, hiz) ANINDA bildirilir (console-message).
const HOST_HOOK = `(() => { ${PICK}
    const top = window === window.top, base = { top, url: location.href };
    const p = cuePick();
    if (!p) return base;
    const v = p.v;
    const playing = () => !v.paused && v.readyState >= 3;   // yonetici tamponluyorsa herkes bekler
    if (!v.__cueHost) {
        v.__cueHost = true;
        const send = (k) => console.log('__CUE__' + JSON.stringify({ k, t: v.currentTime, p: playing(), r: v.playbackRate, h: location.href }));
        ['play', 'pause', 'seeked', 'ratechange', 'waiting', 'playing'].forEach((e) => v.addEventListener(e, () => send(e)));
        setInterval(() => { if (!v.paused) send('tick'); }, 2000);   // konum duzeltmesi icin
        send('init');
    }
    return { ...base, video: { score: p.score, t: v.currentTime, paused: !playing(), rate: v.playbackRate } };
})()`;

const GUEST_SCAN = `(() => { ${PICK} const p = cuePick(); return p ? { score: p.score } : null; })()`;

// Misafir: kendi saatini tutar ve yoneticiye YUMUSAKCA uyar.
//  - 1 saniyeye kadar sapmaya HIC dokunulmaz (hosgoru payi)
//  - 1 s - 3 s sapma: oynatma hizi %8'e kadar yumusakca ayarlanir, video atlamaz, tamponlanmaz
//  - buyuk sapma (>= 3 s): tek seferlik atlama; en fazla 4 sn'de bir, ve tamponda olmayan yere atlanmaz
//  - baglanti gecikmesi (RTT/2) hesaba katilir; kullanici durdurur/ileri sarar/hizi degistirirse geri alinir
function guestHook(st, ageMs) {
    return `(() => { ${PICK}
        const p = cuePick();
        if (!p) return null;
        const v = p.v;
        const W = window.__cue = window.__cue || {};
        W.st = { t: ${JSON.stringify(st.t)}, p: ${JSON.stringify(st.p)}, r: ${JSON.stringify(st.r)}, at: performance.now() - ${JSON.stringify(Math.max(0, ageMs || 0))} };
        const expected = () => W.st.t + (W.st.p ? (performance.now() - W.st.at) / 1000 * W.st.r : 0);
        const buffered = (t) => { for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) - 0.2 && t <= v.buffered.end(i)) return true; return false; };
        const setRate = (r) => { W.cur = r; if (Math.abs(v.playbackRate - r) > 0.001) v.playbackRate = r; };
        const seek = (t, force) => {
            const now = performance.now();
            if (!force && W.lastSeek && now - W.lastSeek < 4000) return;
            W.lastSeek = now; W.selfSeek = now; v.currentTime = t;
        };
        const HARD = 3, GRACE = 1;
        const reconcile = () => {
            if (v.seeking) return { drift: 0, exp: expected() };
            const e = expected(), d = v.currentTime - e;            // d < 0: geride
            if (!W.st.p) {                                          // duran videoda: 1 sn'ye kadar dokunma
                if (Math.abs(d) > GRACE) seek(e, true);
                setRate(W.st.r);
            } else if (Math.abs(d) > HARD) {
                const before = W.lastSeek;
                if (d > 0 || buffered(e) || Math.abs(d) > 10) seek(e, Math.abs(d) > 10);
                // atlama olmadiysa (bekleme suresi / tamponda degil) en guclu yumusak duzeltmeyle devam
                if (W.lastSeek === before) setRate(W.st.r * (d < 0 ? 1.08 : 0.92)); else setRate(W.st.r);
            } else if (Math.abs(d) > GRACE) {
                const adj = Math.min(0.08, (Math.abs(d) - GRACE) * 0.05);   // 1 s'den fazlasi kadar, yavas yavas
                setRate(W.st.r * (d < 0 ? 1 + adj : 1 - adj));
            } else {
                setRate(W.st.r);
            }
            return { drift: d, exp: e };
        };
        if (!v.__cueGuest) {
            v.__cueGuest = true;
            v.addEventListener('pause', () => { if (W.st.p && !v.ended && v.readyState >= 2) v.play().catch(() => {}); });
            v.addEventListener('play', () => { if (!W.st.p) v.pause(); });
            v.addEventListener('ratechange', () => { const want = W.cur || W.st.r; if (Math.abs(v.playbackRate - want) > 0.001) v.playbackRate = want; });
            v.addEventListener('seeked', () => {                    // kullanici kendisi ileri/geri sardiysa geri al
                if (performance.now() - (W.selfSeek || 0) < 1500) return;
                const e = expected();
                if (Math.abs(v.currentTime - e) > 1.5) seek(e, true);
            });
            setInterval(reconcile, 1000);                           // yerel, ag gerektirmez
        }
        const out = reconcile();
        if (W.st.p && v.paused && v.readyState >= 2) v.play().catch(() => {});
        if (!W.st.p && !v.paused) v.pause();
        return out;
    })()`;
}

async function execFrames(code, only) {
    let id;
    try { id = webview.getWebContentsId(); } catch (e) { return []; }   // webview henuz hazir degil
    try { return await ipcRenderer.invoke('cue-exec', id, code, only || null); } catch (e) { return []; }
}

function sendHostState(t, playing, rate) {
    if (!S.socket || !S.isHost) return;
    S.lastSent = { playing, time: t, at: Date.now() };
    S.socket.emit('host-video-sync', { isPlaying: playing, currentTime: t, rate: rate || 1 });
}

// Yonetici: olaylar anlik gider; 1 sn'lik tarama adres degisimini, yeni acilan videoyu baglamayi
// ve olay vermeyen oynaticilarda sapmayi yakalar.
function startHostSync() {
    clearInterval(S.syncTimer); S.lastSent = null; S.hostHref = '';
    if (!S.isHost) return;
    S.syncTimer = setInterval(async () => {
        if (!S.socket || webview.src === 'about:blank') return;
        const res = await execFrames(HOST_HOOK);
        const top = res.find((x) => x.r.top);
        if (top && top.r.url && top.r.url !== webview.src && !top.r.url.includes('about:blank')) S.socket.emit('host-url-change', top.r.url);
        const vids = res.filter((x) => x.r.video).sort((a, b) => b.r.video.score - a.r.video.score);
        if (!vids.length) { S.hostHref = ''; setSync('waiting'); return; }
        const best = vids[0], v = best.r.video;
        S.hostHref = best.r.url;
        setSync('leading'); setTime(v.t);
        const now = Date.now(), playing = !v.paused;
        const expected = S.lastSent ? S.lastSent.time + (S.lastSent.playing ? (now - S.lastSent.at) / 1000 * (v.rate || 1) : 0) : -1;
        if (!S.lastSent || S.lastSent.playing !== playing || Math.abs(v.t - expected) > 1) sendHostState(v.t, playing, v.rate);
    }, 1000);
}

webview.addEventListener('console-message', (e) => {
    if (!S.isHost || typeof e.message !== 'string' || !e.message.startsWith('__CUE__')) return;
    let m; try { m = JSON.parse(e.message.slice(7)); } catch (err) { return; }
    if (S.hostHref && m.h !== S.hostHref) return;   // reklam / ikinci video degil, secilen oynatici
    setSync('leading'); setTime(m.t);
    sendHostState(m.t, m.p, m.r);
});

// Misafir
async function applyGuest(rescan) {
    const h = S.hostState;
    if (!h || S.isHost) return;
    if (rescan || !S.videoFid) {
        const scans = (await execFrames(GUEST_SCAN)).sort((a, b) => b.r.score - a.r.score);
        S.videoFid = scans.length ? scans[0].fid : null;
    }
    if (!S.videoFid) { S.drift = 0; setSync('waiting'); return; }
    // Konumun "yasi": mesajin gelisinden bu yana gecen sure + tek yon gecikme. Yeniden uygulamalar bu saati SIFIRLAMAZ.
    const age = (performance.now() - h.recvAt) + Math.min(1500, (S.rtt || 0) / 2);
    const res = await execFrames(guestHook(h, age), S.videoFid);
    const r = res[0] && res[0].r;
    if (!r) { S.videoFid = null; S.drift = 0; setSync('waiting'); return; }
    S.drift = Math.abs(r.drift);
    setTime(r.exp);
    setSync(S.drift > 1 ? 'rolling' : 'locked');
}
function applySync(state) {
    S.hostState = { t: Number(state.currentTime) || 0, p: !!state.isPlaying, r: Number(state.rate) || 1, recvAt: performance.now() };
    applyGuest(false);
}
function measureRtt() {
    if (!S.socket || S.isHost) return;
    const t0 = performance.now();
    S.socket.timeout(4000).emit('cue-ping', (err) => {
        if (err) return;
        const r = performance.now() - t0;
        S.rtt = S.rtt ? S.rtt * 0.7 + r * 0.3 : r;
    });
}
setInterval(() => { if (S.screen === 'room' && !S.isHost) measureRtt(); }, 4000);
setInterval(() => { if (S.screen === 'room' && !S.isHost) applyGuest(true); }, 1000);   // gec yuklenen video, cerceve degisimi, sapma olcumu

// ---- Senkron izi (osiloskop) --------------------------------------------
const trace = { raf: 0, phase: 0 };
function setSync(state) {
    if (S.sync === state) return;
    S.sync = state;
    renderSyncLabel();
    drawTrace();
}
function renderSyncLabel() {
    const key = { locked: 'syncLocked', rolling: 'syncRolling', waiting: 'syncWaiting', leading: 'syncLeading' }[S.sync];
    $('sync-label').textContent = t(key);
}
function drawTrace() {
    const c = $('sync-trace');
    if (!c) return;
    cancelAnimationFrame(trace.raf);
    const W = 112, H = 28, dpr = 2;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const signal = css.getPropertyValue('--signal').trim() || '#ff9d2e';
    const dim = css.getPropertyValue('--lamp-faint').trim() || '#8f8a80';
    const state = S.sync;
    // Yayin: sinyal renginde, yavasca akan genis dalga (saat yoneticide).
    // Kayiyor: sinyal renginde, sapma buyudukce genisleyen tırtıklı iz (osiloskopta tetiklenmemis iz).
    // Senkron: tetiklenmis, duran sakin iz.  Bekliyor: kesik cizgi.
    const drift = Math.min(30, S.drift || 0);
    const animated = (state === 'leading' || state === 'rolling') && !reducedMotion && S.screen === 'room';
    const frame = () => {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        g.lineWidth = 1.75; g.lineJoin = 'round';
        const mid = H / 2;
        if (state === 'waiting') {
            g.strokeStyle = dim; g.setLineDash([3, 4]);
            g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
            g.setLineDash([]);
            return;
        }
        g.strokeStyle = signal;
        g.beginPath();
        for (let x = 0; x <= W; x += 1) {
            let y;
            if (state === 'rolling') y = mid + (6 + drift * 0.25) * Math.sin(x / W * Math.PI * 6 + trace.phase) + (2 + drift * 0.15) * Math.sin(x * 1.3 + trace.phase * 3.1);
            else if (state === 'leading') y = mid + 8 * Math.sin(x / W * Math.PI * 4 + trace.phase);
            else y = mid + 3 * Math.sin(x / W * Math.PI * 4);       // locked: still, small, settled
            x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
        if (state === 'locked') {          // tetik isareti: iz sabitlendi
            g.fillStyle = signal;
            g.beginPath(); g.arc(W - 4, mid, 2.5, 0, Math.PI * 2); g.fill();
        }
        if (animated) { trace.phase += state === 'rolling' ? 0.34 : 0.06; trace.raf = requestAnimationFrame(frame); }
    };
    frame();
}

// ---- Sohbet --------------------------------------------------------------
function pushMessage(li) {
    const box = $('chat-messages');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(li);
    if (near) box.scrollTop = box.scrollHeight;
}
function addChat(data) {
    if (S.hidden.has(data.username)) return;   // bu kisinin mesajlarini gizledin (sadece senin ekraninda)
    const li = document.createElement('li');
    li.className = 'msg' + (data.username === S.myName ? ' own' : '');
    const who = document.createElement('span'); who.className = 'who'; who.textContent = data.username;
    li.append(who, document.createTextNode(String((data.msg && data.msg.msg) ?? '')));
    pushMessage(li);
}
function addNote(text) {
    const li = document.createElement('li'); li.className = 'note'; li.textContent = text;
    pushMessage(li);
}
function sendChat() {
    const input = $('chat-msg'), text = input.value.trim();
    if (!text || !S.socket) return;
    S.socket.emit('send-chat', { msg: text });
    input.value = '';
    $('emoji-panel').hidden = true; $('emoji-btn').setAttribute('aria-expanded', 'false');
}

// ---- Sesli sohbet (WebRTC): ses sunucudan gecmez, seste olanlar arasinda dogrudan akar -----------
// Sunucu sadece kimin seste oldugunu tutar ve baglanti mesajlarini (teklif/cevap/ICE) iletir.
let iceServers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const V = { on: false, stream: null, muted: false, peers: new Map(), speaking: new Set(), localMuted: new Set(), ctx: null, meters: new Map(), timer: 0,
            volumes: settings.get('voiceVolumes', {}), volOpen: null };   // volumes: takma ada gore % (0-200), kalici

function askVoiceConsent() {
    return new Promise((resolve) => {
        const d = $('voice-consent');
        let done = false;
        const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); resolve(v); };
        $('voice-consent-ok').onclick = () => finish(true);
        $('voice-consent-cancel').onclick = () => finish(false);
        d.addEventListener('cancel', () => finish(false), { once: true });
        d.showModal();
    });
}

async function joinVoice() {
    if (V.on || !S.calls || !S.socket) return;
    if (!settings.get('voiceConsent', false)) {
        if (!(await askVoiceConsent())) return;
        settings.set('voiceConsent', true);
    }
    try {
        V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
        say(e && e.name === 'NotFoundError' ? 'errMicMissing' : 'errMicDenied');
        return;
    }
    V.on = true; V.muted = false;
    watchLevel('self', V.stream);
    S.socket.emit('voice-join');
    renderVoice(); renderMembers();
}

function makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers });
    // Mukemmel muzakere: iki taraf ayni anda teklif gonderirse (ornegin ikisi de kamerayi ayni anda acarsa)
    // "kibar" taraf (kucuk kimlik) kendi teklifini geri alir. Bu yuzden sabit bir yeni-gelen/eski ayrimina gerek kalmaz.
    const peer = { pc, id, polite: !!S.socket && S.socket.id < id, makingOffer: false, ignoreOffer: false, audio: null, gain: null, vsender: null, vstream: null, pendingIce: [] };
    V.stream.getTracks().forEach((tr) => { const sender = pc.addTrack(tr, V.stream); if (tr.kind === 'video') peer.vsender = sender; });
    pc.onnegotiationneeded = async () => {
        try {
            peer.makingOffer = true;
            await pc.setLocalDescription();
            sendSignal(id, { type: 'offer', sdp: pc.localDescription.sdp });
        } catch (e) { /* baglanti kapandi */ } finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(id, { type: 'ice', candidate: e.candidate }); };
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') tuneVideo(); };
    pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (e.track.kind === 'video') {          // sadece goruntu: sesi tekrar calmamak icin ayri bir akis
            peer.vstream = new MediaStream([e.track]);
            renderTiles();
            return;
        }
        // Chrome uzak sesi ancak bir ses ogesine bagliyken akitir; oge sessiz, asil cikis kazanc dugumu uzerinden (0-200%)
        const a = new Audio();
        a.autoplay = true; a.muted = true; a.srcObject = stream;
        a.play().catch(() => {});
        peer.audio = a;
        try {
            V.ctx = V.ctx || new AudioContext();
            peer.gain = V.ctx.createGain();
            V.ctx.createMediaStreamSource(stream).connect(peer.gain);
            peer.gain.connect(V.ctx.destination);
        } catch (err) { a.muted = false; peer.gain = null; }   // yedek: ses ogesinin kendi sesi
        applyPeerVolume(id);
        watchLevel(id, stream);
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState !== 'failed') return;
        const m = S.members.find((x) => x.id === id);
        say('voiceFailed', { name: m ? m.name : '?' });
    };
    V.peers.set(id, peer);
    return peer;
}

function sendSignal(to, data) { if (S.socket) S.socket.emit('rtc-signal', { to, data }); }

function onVoicePeers(ids) {   // yeni katilan, zaten seste olanlari arar: izleri eklemek muzakereyi kendiliginden baslatir
    if (!V.on) return;
    for (const id of ids) makePeer(id);
}

async function onSignal({ from, data } = {}) {
    if (!V.on || !data) return;
    try {
        let peer = V.peers.get(from);
        if (data.type === 'offer') {
            if (!peer) peer = makePeer(from);
            const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
            peer.ignoreOffer = !peer.polite && collision;
            if (peer.ignoreOffer) return;                        // kibar olmayan taraf cakismada kendi teklifini korur
            await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });   // kibar taraf otomatik geri alir
            for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
            await peer.pc.setLocalDescription();
            sendSignal(from, { type: 'answer', sdp: peer.pc.localDescription.sdp });
        } else if (!peer) {
            return;
        } else if (data.type === 'answer') {
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
            for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
        } else if (data.type === 'ice') {
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch((err) => { if (!peer.ignoreOffer) throw err; });
            else peer.pendingIce.push(data.candidate);
        }
    } catch (e) { /* bozuk mesaj: yok say */ }
}

function closePeer(id) {
    const peer = V.peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch (e) {}
    if (peer.audio) peer.audio.srcObject = null;
    unwatchLevel(id);
    V.peers.delete(id);
    V.speaking.delete(id);
    renderTiles();
}

// Seste olmayan kisilerin baglantilarini kapat
function syncVoicePeers() {
    const inVoice = new Set(S.members.filter((m) => m.voice).map((m) => m.id));
    for (const id of [...V.peers.keys()]) if (!inVoice.has(id)) closePeer(id);
    for (const id of [...V.localMuted]) if (!inVoice.has(id)) V.localMuted.delete(id);
}

function setMicMuted(muted, forced) {
    if (!V.on || !V.stream) return;
    if (!muted) {   // yonetici susturduysa mikrofon acilamaz
        const me = S.members.find((m) => S.socket && m.id === S.socket.id);
        if (me && me.muted) { say('mutedNotice'); return; }
    }
    V.muted = muted;
    V.stream.getAudioTracks().forEach((tr) => { tr.enabled = !muted; });
    renderVoice();
}

function memberName(id) { const m = S.members.find((x) => x.id === id); return m ? m.name : ''; }
function volumeOf(id) { const v = V.volumes[memberName(id)]; return Number.isFinite(v) ? v : 100; }   // yuzde

// Bu kisinin sesini bu bilgisayarda ayarla: sessize alma ve 0-200% seviye (sadece sende)
function applyPeerVolume(id) {
    const peer = V.peers.get(id);
    if (!peer) return;
    const level = V.localMuted.has(id) ? 0 : volumeOf(id) / 100;
    if (peer.gain) peer.gain.gain.value = level;
    else if (peer.audio) { peer.audio.muted = level === 0; peer.audio.volume = Math.min(1, level); }
}
function setPeerVolume(id, pct, persist) {
    const name = memberName(id);
    if (!name) return;
    V.volumes[name] = pct;
    if (persist) settings.set('voiceVolumes', V.volumes);
    applyPeerVolume(id);
}
function setPeerMuted(id, muted) {
    if (muted) V.localMuted.add(id); else V.localMuted.delete(id);
    applyPeerVolume(id);
    renderMembers();
}

function leaveVoice() { teardownVoice(true); }

function teardownVoice(notify) {
    if (!V.on && !V.stream && !V.peers.size) return;
    if (V.camTrack) { V.camTrack.onended = null; }
    for (const id of [...V.peers.keys()]) closePeer(id);
    if (V.stream) V.stream.getTracks().forEach((tr) => tr.stop());
    if (V.camTrack) V.camTrack.stop();
    V.stream = null; V.on = false; V.muted = false; V.cam = false; V.camTrack = null; V.selfStream = null;
    V.hiddenVideo.clear();
    for (const tile of V.tiles.values()) tile.el.remove();
    V.tiles.clear(); if ($('tiles')) $('tiles').hidden = true;
    unwatchLevel('self');
    V.speaking.clear(); V.localMuted.clear(); V.volOpen = null;
    if (V.timer && !V.meters.size) { clearInterval(V.timer); V.timer = 0; }
    if (notify && S.socket) S.socket.emit('voice-leave');
    renderVoice(); renderMembers();
}

// Kim konusuyor: ses seviyesinden (ag gerektirmez). Yumusatilmis frekans verisi + kisa tutma suresi:
// tek bir kisa ornek kacirsa bile konusma "acik" kalir, yanip sonmez.
function watchLevel(key, stream) {
    try {
        V.ctx = V.ctx || new AudioContext();
        const src = V.ctx.createMediaStreamSource(stream);
        const an = V.ctx.createAnalyser();
        an.fftSize = 512; an.smoothingTimeConstant = 0.7;
        src.connect(an);
        V.meters.set(key, { an, src, buf: new Uint8Array(an.frequencyBinCount), lastLoud: 0 });
    } catch (e) { return; }
    if (!V.timer) V.timer = setInterval(pollLevels, 100);
}
function unwatchLevel(key) {
    const m = V.meters.get(key);
    if (m) { try { m.src.disconnect(); } catch (e) {} V.meters.delete(key); }
}
function pollLevels() {
    let changed = false;
    const now = Date.now();
    for (const [key, m] of V.meters) {
        m.an.getByteFrequencyData(m.buf);
        let sum = 0;
        const n = 48;                                   // insan sesi araligi (yaklasik 0-4 kHz)
        for (let i = 1; i <= n; i++) sum += m.buf[i];
        const avg = sum / n;
        if (avg > 14) m.lastLoud = now;
        const on = now - m.lastLoud < 350 && !(key === 'self' && V.muted);
        if (on !== V.speaking.has(key)) { on ? V.speaking.add(key) : V.speaking.delete(key); changed = true; }
        // seviye cubuklari: sesin gercek yuksekligiyle oynar (yumusatilmis)
        m.level = on ? Math.min(1, (m.level || 0) * 0.5 + Math.min(1, avg / 70) * 0.5) : 0;
        const id = key === 'self' ? (S.socket && S.socket.id) : key;
        const li = id && document.querySelector('#members .member[data-id="' + id + '"]');
        if (li) li.style.setProperty('--lvl', m.level.toFixed(2));
    }
    if (changed) renderSpeaking();
}

// Konusan kisiyi sadece sinif degistirerek isaretle: listeyi yeniden cizmek, yoneticinin yarim kalan
// "Cikar?" onayini ve uzerine gelinen dugmeleri silerdi.
function renderSpeaking() {
    const me = S.socket && S.socket.id;
    document.querySelectorAll('#members .member').forEach((li) => {
        const id = li.dataset.id;
        li.classList.toggle('speaking', V.speaking.has(id) || (id === me && V.speaking.has('self')));
    });
    for (const [id, tile] of V.tiles) tile.el.classList.toggle('speaking', V.speaking.has(id) || (id === me && V.speaking.has('self')));
}

function renderVoice() {
    $('voice-bar').hidden = !S.calls || S.screen !== 'room';
    $('voice-join').hidden = V.on;
    $('voice-active').hidden = !V.on;
    const label = t(V.muted ? 'voiceUnmute' : 'voiceMute');
    $('voice-mute-label').textContent = label;
    $('voice-mute-icon').setAttribute('href', V.muted ? '#i-mic-off' : '#i-mic');
    $('voice-mute').classList.toggle('on', V.muted);
    $('voice-mute').setAttribute('aria-pressed', String(V.muted));
    $('cam-toggle-label').textContent = t(V.cam ? 'camStop' : 'camStart');
    $('cam-toggle-icon').setAttribute('href', V.cam ? '#i-cam-off' : '#i-cam');
    $('cam-toggle').classList.toggle('on', V.cam);
    $('cam-toggle').setAttribute('aria-pressed', String(V.cam));
}

// ---- Kamera ---------------------------------------------------------------
// Goruntu de sesle ayni dogrudan baglantilardan gider. Kamera ancak seste olan biri tarafindan acilabilir.
V.cam = false; V.camTrack = null; V.hiddenVideo = new Set(); V.tiles = new Map(); V.selfStream = null;

function askCamConsent() {
    return new Promise((resolve) => {
        const d = $('cam-consent');
        let done = false;
        const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); resolve(v); };
        $('cam-consent-ok').onclick = () => finish(true);
        $('cam-consent-cancel').onclick = () => finish(false);
        d.addEventListener('cancel', () => finish(false), { once: true });
        d.showModal();
    });
}

async function startCamera() {
    if (!V.on || V.cam || !S.socket) return;
    if (!settings.get('camConsent', false)) {
        if (!(await askCamConsent())) return;
        settings.set('camConsent', true);
    }
    let track;
    try {
        const cs = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
        track = cs.getVideoTracks()[0];
    } catch (e) {
        say(e && e.name === 'NotFoundError' ? 'errCamMissing' : e && (e.name === 'NotReadableError' || e.name === 'AbortError') ? 'errCamBusy' : 'errCamDenied');
        return;
    }
    if (!V.on) { track.stop(); return; }           // izin beklerken sesten cikildiysa
    V.camTrack = track;
    V.stream.addTrack(track);
    V.selfStream = new MediaStream([track]);
    for (const peer of V.peers.values()) {
        if (peer.vsender) peer.vsender.replaceTrack(track);
        else peer.vsender = peer.pc.addTrack(track, V.stream);      // ilk kez: yeniden muzakere baslar
    }
    V.cam = true;
    track.onended = () => stopCamera(true);         // kamera cikarildiysa / baska uygulama aldiysa
    S.socket.emit('cam-set', { on: true });
    tuneVideo(); renderVoice(); renderTiles();
}

function stopCamera(notify) {
    if (!V.cam && !V.camTrack) return;
    const track = V.camTrack;
    for (const peer of V.peers.values()) { if (peer.vsender) peer.vsender.replaceTrack(null).catch(() => {}); }
    if (track) { track.onended = null; track.stop(); if (V.stream) V.stream.removeTrack(track); }
    V.camTrack = null; V.selfStream = null; V.cam = false;
    if (notify && S.socket) S.socket.emit('cam-set', { on: false });
    renderVoice(); renderTiles();
}

// Baglanti sayisina gore goruntu hizini sinirla (herkes herkese gonderdigi icin): yukleme yuku dagilir
function tuneVideo() {
    const n = Math.max(1, V.peers.size);
    const kbps = Math.max(120, Math.min(500, Math.floor(900 / n)));
    for (const peer of V.peers.values()) {
        if (!peer.vsender) continue;
        try {
            const p = peer.vsender.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = kbps * 1000;
            p.encodings[0].maxFramerate = 24;
            peer.vsender.setParameters(p).catch(() => {});
        } catch (e) { /* henuz muzakere edilmedi */ }
    }
}

// Karolar: kamerasi acik herkes icin bir tane; goruntu akisi degismedikce eleman yeniden kurulmaz (video kesilmesin)
function renderTiles() {
    const box = $('tiles');
    if (!box) return;
    const meId = S.socket && S.socket.id;
    const want = new Map();
    for (const m of S.members) {
        if (!m.cam) continue;
        if (m.id === meId) { if (V.cam && V.selfStream) want.set(m.id, { m, stream: V.selfStream, self: true }); continue; }
        if (V.hiddenVideo.has(m.name)) continue;
        const peer = V.peers.get(m.id);
        if (peer && peer.vstream) want.set(m.id, { m, stream: peer.vstream, self: false });
    }
    for (const [id, tile] of [...V.tiles]) if (!want.has(id)) { tile.el.remove(); V.tiles.delete(id); }
    for (const [id, w] of want) {
        let tile = V.tiles.get(id);
        if (!tile) {
            const elTile = el('div', 'tile' + (w.self ? ' self' : ''));
            const v = document.createElement('video');
            v.autoplay = true; v.muted = true; v.playsInline = true;
            const name = el('span', 'tile-name');
            const btn = el('button', 'tile-btn');
            btn.type = 'button';
            btn.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-eye-off"/></svg>';
            elTile.append(v, name, btn);
            elTile.onclick = (e) => { if (e.target.closest('.tile-btn')) return; elTile.classList.toggle('big'); };
            tile = { el: elTile, video: v, name, btn, stream: null };
            V.tiles.set(id, tile);
            box.append(elTile);
        }
        if (tile.stream !== w.stream) { tile.stream = w.stream; tile.video.srcObject = w.stream; tile.video.play().catch(() => {}); }
        tile.name.textContent = w.self ? t('tileYou') : w.m.name;
        tile.el.dataset.id = id;
        tile.btn.hidden = w.self;
        tile.btn.title = t('modCamHide');
        tile.btn.setAttribute('aria-label', t('modCamHide') + ': ' + w.m.name);
        tile.btn.onclick = () => { V.hiddenVideo.add(w.m.name); renderTiles(); renderMembers(); };
    }
    box.hidden = V.tiles.size === 0;
    renderSpeaking();
}

$('cam-toggle').onclick = () => (V.cam ? stopCamera(true) : startCamera());

$('voice-join').onclick = joinVoice;
$('voice-leave').onclick = leaveVoice;
$('voice-mute').onclick = () => setMicMuted(!V.muted);

function buildEmoji() {
    const panel = $('emoji-panel');
    EMOJI.forEach((e) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'emoji'; b.textContent = e;
        b.onclick = () => { const i = $('chat-msg'); i.value += e; i.focus(); };
        panel.appendChild(b);
    });
}

// ---- Cizim ---------------------------------------------------------------
function copyButton(value) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-icon copy-btn';
    b.title = t('copy'); b.setAttribute('aria-label', t('copy'));
    b.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>';
    b.onclick = () => {
        navigator.clipboard.writeText(value);
        b.title = t('copied'); b.setAttribute('aria-label', t('copied'));
        b.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
        setTimeout(() => { b.title = t('copy'); b.setAttribute('aria-label', t('copy')); b.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>'; }, 1400);
    };
    return b;
}
function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

function renderServerZone() {
    const box = $('server-body');
    box.textContent = '';
    const info = S.shareInfo || {};
    if (info.code) {
        const line = el('div', 'code-line');
        line.append(el('span', 'code-value', info.code), copyButton(info.code));
        box.append(line, el('p', 'zone-note', t('serverCodeHint')));
    } else {
        box.append(el('p', 'zone-note', t('noTunnel')));
    }
    if (info.lan) {
        const line = el('div', 'code-line');
        line.append(el('span', 'code-value small', info.lan), copyButton(info.lan));
        box.append(el('span', 'zone-label', t('sameNetwork')), line);
    }
}

function renderInvite() {
    const strip = $('invite-strip');
    strip.textContent = '';
    if (S.isPublic || !S.roomID) { strip.hidden = true; return; }   // herkese acik odalar listeden girilir
    strip.hidden = false;
    const item = (label, value) => {
        const d = el('div', 'invite-item');
        d.append(el('span', 'zone-label', label), el('span', 'code-value', value), copyButton(value));
        strip.append(d);
    };
    item(t('roomCodeLabel'), S.roomID);
    if (S.serverLabel) item(t('fullInviteLabel'), `${S.serverLabel}~${S.roomID}`);
}

function renderMembers() {
    $('presence-count').textContent = t('peopleCount', { count: S.members.length });
    const ul = $('members');
    ul.textContent = '';
    const meId = S.socket && S.socket.id;
    S.members.forEach((m) => {
        const li = el('li', 'member' + (m.isHost ? ' host' : '') + (m.muted ? ' is-muted' : '') + (S.hidden.has(m.name) ? ' is-hidden' : ''));
        li.dataset.id = m.id;
        li.append(el('span', 'member-name', m.name));
        if (m.voice) {
            const vf = el('span', 'voice-flag');
            vf.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#' + (V.localMuted.has(m.id) ? 'i-speaker-off' : 'i-mic') + '"/></svg>';
            vf.title = t('voiceOn');
            li.append(vf);
            if (m.cam) {
                const cf = el('span', 'voice-flag');
                cf.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-cam"/></svg>';
                cf.title = t('camOnFlag');
                li.append(cf);
            }
            const meter = el('span', 'meter');
            meter.setAttribute('aria-hidden', 'true');
            meter.innerHTML = '<i></i><i></i><i></i><i></i>';
            li.append(meter);
            if (V.speaking.has(m.id) || (m.id === meId && V.speaking.has('self'))) li.classList.add('speaking');
        }
        if (m.muted || S.hidden.has(m.name)) {
            const flag = el('span', 'flag');
            flag.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#' + (m.muted ? 'i-mute' : 'i-eye-off') + '"/></svg>';
            flag.title = t(m.muted ? 'modMuted' : 'modHidden');
            li.append(flag);
        }
        if (m.id !== meId) {
            const box = el('span', 'member-actions');
            const iconBtn = (icon, title, cls, onclick) => {
                const b = el('button', 'btn-mini ' + cls);
                b.type = 'button'; b.title = title; b.setAttribute('aria-label', title + ': ' + m.name);
                b.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#' + icon + '"/></svg>';
                b.onclick = onclick;
                return b;
            };
            const hid = S.hidden.has(m.name);
            box.append(iconBtn('i-eye-off', t(hid ? 'modShow' : 'modHide'), hid ? 'on' : '', () => { hid ? S.hidden.delete(m.name) : S.hidden.add(m.name); renderMembers(); }));
            if (m.voice && V.on) {   // sadece senin tarafinda: bu kisinin sesini ayarla
                box.append(iconBtn('i-volume', t('volumeTitle'), V.volOpen === m.id ? 'on' : '', () => { V.volOpen = V.volOpen === m.id ? null : m.id; renderMembers(); }));
                const lm = V.localMuted.has(m.id);
                box.append(iconBtn('i-speaker-off', t(lm ? 'modVoiceUnmute' : 'modVoiceMute'), lm ? 'on' : '', () => setPeerMuted(m.id, !lm)));
            }
            if (m.cam && V.hiddenVideo.has(m.name)) box.append(iconBtn('i-cam', t('modCamShow'), 'on', () => { V.hiddenVideo.delete(m.name); renderTiles(); renderMembers(); }));
            if (S.isHost && !m.isHost && m.cam) box.append(iconBtn('i-cam-off', t('modCamOff'), '', () => S.socket.emit('mod', { action: 'camoff', target: m.id })));
            if (S.isHost && !m.isHost) {
                box.append(iconBtn('i-mute', t(m.muted ? 'modUnmute' : 'modMute'), m.muted ? 'on' : '', () => S.socket.emit('mod', { action: m.muted ? 'unmute' : 'mute', target: m.id })));
                const kick = iconBtn('i-kick', t('modKick'), 'danger', () => {
                    if (kick.classList.contains('armed')) { S.socket.emit('mod', { action: 'kick', target: m.id }); return; }
                    kick.classList.add('armed'); li.classList.add('armed'); kick.textContent = t('modKickConfirm');
                    setTimeout(() => { if (kick.isConnected) renderMembers(); }, 3000);   // onay suresi dolunca eski haline
                });
                box.append(kick);
            }
            li.append(box);
        }
        if (V.volOpen === m.id && m.voice && V.on && m.id !== meId) {
            const row = el('div', 'vol-row');
            const slider = document.createElement('input');
            slider.type = 'range'; slider.min = '0'; slider.max = '200'; slider.step = '5';
            slider.value = String(volumeOf(m.id));
            slider.setAttribute('aria-label', t('volumeLabel') + ': ' + m.name);
            const val = el('button', 'vol-val', slider.value + '%');
            val.type = 'button'; val.title = t('volumeReset');
            slider.oninput = () => { val.textContent = slider.value + '%'; setPeerVolume(m.id, +slider.value, false); };
            slider.onchange = () => setPeerVolume(m.id, +slider.value, true);
            val.onclick = () => { slider.value = '100'; val.textContent = '100%'; setPeerVolume(m.id, 100, true); };
            row.append(slider, val);
            li.append(row);
        }
        ul.append(li);
    });
}

function renderRooms() {
    const merged = new Map();
    S.globalRooms.forEach((r) => merged.set(r.server + '|' + r.id, r));
    S.localRooms.forEach((r) => merged.set(r.server + '|' + r.id, r));
    const list = [...merged.values()];
    const ul = $('room-list');
    ul.textContent = '';
    if (!list.length) {
        const li = el('li', 'room-empty');
        li.innerHTML = '<svg class="ring-art" viewBox="0 0 600 600" aria-hidden="true"><use href="#ring"/></svg>';
        li.append(el('span', '', t('noRooms')));
        ul.append(li);
        return;
    }
    list.forEach((r) => {
        const li = el('li', 'room-item');
        const info = el('div');
        info.append(el('div', 'room-name', r.name));
        const meta = el('div', 'room-meta');
        const ticks = el('span', 'ticks');
        ticks.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 8; i++) ticks.append(el('i', i < r.count ? 'on' : ''));
        meta.append(ticks, el('span', '', t('roomMeta', { host: r.host, count: r.count })));
        if (r.calls) {
            const mic = el('span', 'calls-tag');
            mic.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-mic"/></svg>';
            mic.title = t('callsTag'); mic.setAttribute('role', 'img'); mic.setAttribute('aria-label', t('callsTag'));
            meta.append(mic);
        }
        info.append(meta);
        if (r.description) info.append(el('p', 'room-desc', r.description));
        const btn = el('button', 'btn-ghost', t('roomJoin'));
        btn.type = 'button';
        btn.onclick = () => joinListed(r);
        li.append(info, btn);
        ul.append(li);
    });
}

function renderDynamic() {
    $('role-tag').textContent = S.isHost ? t('roleHost') : t('roleGuest');
    renderSyncLabel();
    $('stage-empty').hidden = S.videoActive;
    $('stage-empty-text').textContent = t(S.isHost ? 'emptyHost' : 'emptyGuest');
    renderMembers();
    renderRooms();
    renderServerZone();
    renderVoice();
    if (S.screen === 'room') renderInvite();
    if (!$('leader').hidden) $('leader-label').textContent = t($('leader').dataset.label);
}

// ---- Eylemler ------------------------------------------------------------
function requireName() {
    const name = $('username').value.trim();
    if (!name) { say('errNeedName'); $('username').focus(); return null; }
    S.myName = name;
    settings.set('username', name);
    return name;
}

$('host-btn').onclick = async () => {
    if (!requireName()) return;
    S.entry = 'host';
    const res = await runLeader('leaderHost', 5, async () => {
        const info = await ipcRenderer.invoke('start-server');
        if (!info) throw new Error('start');
        S.shareInfo = info;
        await openServer('http://localhost:' + (info.port || 3000), info.code || info.lan || '');
    });
    if (res.ok) go('create'); else failure(res.cancelled ? null : res.e);
};

$('join-btn').onclick = async () => {
    if (!requireName()) return;
    const raw = $('invite-input').value.trim();
    if (!raw) { say('errNeedInvite'); $('invite-input').focus(); return; }
    const i = raw.lastIndexOf('~');
    const server = (i >= 0 ? raw.slice(0, i) : raw).trim();
    const code = i >= 0 ? raw.slice(i + 1).trim() : '';
    if (!server) { say('errNeedInvite'); return; }
    settings.set('serverCode', server);
    S.entry = 'guest';
    const res = await runLeader('leaderJoin', 3, async () => {
        await openServer(resolveServer(server), server);
        return code ? emitJoin({ roomID: code }) : null;
    });
    if (!res.ok) { closeSocket(); failure(res.cancelled ? null : res.e); return; }
    if (res.r) enterRoom(res.r); else go('browse');
};

$('browse-btn').onclick = () => {
    if (!requireName()) return;
    S.entry = 'guest';
    closeSocket();
    go('browse');
};

async function joinListed(r) {
    S.entry = 'guest';
    if (S.socket && S.socket.connected && r.server === S.serverLabel) {
        try { enterRoom(await emitJoin({ roomID: r.id })); } catch (e) { failure(e); }
        return;
    }
    const res = await runLeader('leaderJoin', 3, async () => {
        await openServer(resolveServer(r.server), r.server);
        return emitJoin({ roomID: r.id });
    });
    if (res.ok) enterRoom(res.r); else { closeSocket(); failure(res.cancelled ? null : res.e); }
}

$('create-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('room-name').value.trim();
    if (!name) { say('err_room_name_empty'); $('room-name').focus(); return; }
    const isPublic = $('create-form').elements.vis.value === 'public';
    const description = $('room-desc').value;
    const calls = $('calls-check').checked;
    settings.set('lastRoom', name); settings.set('lastDescription', description); settings.set('lastPublic', isPublic); settings.set('lastCalls', calls);
    try { enterRoom(await emitJoin({ create: true, name, description, isPublic, calls })); } catch (err) { failure(err); }
};

$('create-back').onclick = () => { closeSocket(); go('setup'); };
$('browse-back').onclick = () => { closeSocket(); go('setup'); };
$('leave-btn').onclick = () => { if (S.socket) S.socket.emit('leave-room'); leaveLocal(); };

$('host-url-form').onsubmit = (e) => {
    e.preventDefault();
    let url = $('video-url').value.trim();
    if (!url || !S.isHost) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');
    setVideoUrl(url);
    S.socket.emit('host-url-change', url);
};

$('send-chat-btn').onclick = sendChat;
$('chat-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
$('emoji-btn').onclick = () => {
    const panel = $('emoji-panel');
    panel.hidden = !panel.hidden;
    $('emoji-btn').setAttribute('aria-expanded', String(!panel.hidden));
};
document.addEventListener('click', (e) => {
    const panel = $('emoji-panel');
    if (!panel.hidden && !panel.contains(e.target) && !$('emoji-btn').contains(e.target)) {
        panel.hidden = true; $('emoji-btn').setAttribute('aria-expanded', 'false');
    }
});
// Hakkinda ve gizlilik
$('about-btn').onclick = async () => {
    let v = '';
    try { v = (await ipcRenderer.invoke('app-info')).version; } catch (e) {}
    $('about-version').textContent = v ? t('aboutVersion', { v }) : '';
    $('about').showModal();
};
$('about-close').onclick = () => $('about').close();
$('about').addEventListener('click', (e) => { if (e.target === $('about')) $('about').close(); });   // disina tiklayinca kapan
$('licenses-btn').onclick = () => { ipcRenderer.invoke('open-notices').catch(() => {}); };

$('setup-form').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (e.target.id === 'invite-input' ? $('join-btn') : $('host-btn')).click();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('leader').hidden) $('leader-cancel').click();
});
// Misafir hangi siteye baktigini gorsun (yonetici herhangi bir adres gonderebilir)
function updateSiteBar() {
    const bar = $('site-bar');
    let u = null;
    try { u = new URL(webview.getURL()); } catch (e) {}
    if (S.isHost || !u || !/^https?:$/.test(u.protocol)) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.classList.toggle('insecure', u.protocol !== 'https:');
    $('site-host').textContent = u.hostname;
}
['did-navigate', 'did-navigate-in-page', 'dom-ready'].forEach((ev) => webview.addEventListener(ev, updateSiteBar));
webview.addEventListener('did-navigate', () => { if (webview.src && webview.src !== 'about:blank') { S.videoActive = true; $('stage-empty').hidden = true; } });

// ---- Baslangic -----------------------------------------------------------
const langSelect = $('lang-pick');
langSelect.innerHTML = Object.entries(LANGS).map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
langSelect.addEventListener('change', (e) => { settings.set('lang', e.target.value); applyLanguage(e.target.value); });
$('username').addEventListener('change', (e) => settings.set('username', e.target.value.trim()));
$('signal-pick').addEventListener('input', (e) => applySignal(e.target.value));
$('signal-pick').addEventListener('change', (e) => settings.set('signalColor', e.target.value));

langListeners.push(() => {
    const name = $('username');
    if (!name.value || Object.values(STRINGS).some((l) => l.defaultName === name.value)) name.value = t('defaultName');
    renderDynamic();
});

buildEmoji();
applyLanguage(settings.get('lang', detectLanguage()));
applySignal(settings.get('signalColor', '#ff9d2e'));
$('username').value = settings.get('username', '') || t('defaultName');
$('invite-input').value = settings.get('serverCode', '');
$('room-name').value = settings.get('lastRoom', '');
$('room-desc').value = settings.get('lastDescription', '');
$('calls-check').checked = settings.get('lastCalls', false);
const vis = $('create-form').elements.vis;
if (vis) vis.value = settings.get('lastPublic', true) ? 'public' : 'private';
go('setup');
