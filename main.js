const { app, BrowserWindow, ipcMain, webContents, session, shell } = require('electron');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { attach } = require('./roomServer');
const { createPublisher, createWatcher } = require('./directory');

// 1. DAHİLİ REHBER SUNUCU MOTORU
const server = http.createServer();
let publisher = null;   // internet tuneli aciksa acik odalar dizine yazilir
attach(new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e5 }), (rooms) => { if (publisher) publisher.update(rooms); });

// Sunucu + otomatik internet tuneli (port acma / hesap gerekmez)
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

let tunnelProc = null;
let hostInfo = null; // { code, lan }

function lanAddress(port) {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const n of list) if (n.family === 'IPv4' && !n.internal) return `${n.address}:${port}`;
    }
    return null;
}

function cloudflaredPath() {
    const p = app.isPackaged
        ? path.join(process.resourcesPath, 'cloudflared.exe')
        : path.join(__dirname, 'bin', 'cloudflared.exe');
    return fs.existsSync(p) ? p : null;
}

function startTunnel(port) {
    return new Promise((resolve) => {
        const exe = cloudflaredPath();
        if (!exe) return resolve(null);
        tunnelProc = spawn(exe, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { windowsHide: true });
        const timer = setTimeout(() => resolve(null), 30000);
        const onData = (buf) => {
            const m = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/.exec(buf.toString());
            if (m) { clearTimeout(timer); resolve(m[1]); }
        };
        tunnelProc.stdout.on('data', onData);
        tunnelProc.stderr.on('data', onData);
        tunnelProc.on('error', () => { clearTimeout(timer); resolve(null); });
        tunnelProc.on('exit', () => { tunnelProc = null; hostInfo = null; serverReady = null; if (publisher) { publisher.close(); publisher = null; } });
    });
}

let serverReady = null;
ipcMain.handle('start-server', () => {
    if (!serverReady) {
        serverReady = (async () => {
            // Her zaman isletim sisteminden bos bir port iste. (3000'i denemek guvenilmez: Windows'ta baska bir program
            // ayni portu farkli adres ailesinden tuttuysa hata vermeden baglanabiliyor ve tunel yanlis programa gider.)
            const listenOn = (port) => new Promise((resolve) => {
                const onErr = () => { server.off('listening', onOk); resolve(0); };
                const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
                server.once('error', onErr); server.once('listening', onOk);
                server.listen(port);
            });
            const port = await listenOn(0);
            if (!port) return null;
            hostInfo = { code: await startTunnel(port), lan: lanAddress(port), port };
            if (hostInfo.code && !publisher) publisher = createPublisher(hostInfo.code);
            return hostInfo;
        })();
    }
    return serverReady;
});

// Video oynaticisi genelde baska siteden gelen bir iframe icindedir (capraz kaynak): sayfanin kendi
// scripti oraya erisemez. Ana surec, videonun bulundugu webview'in TUM cerceveleri icinde kod calistirir.
ipcMain.handle('cue-exec', async (event, wcId, code, only) => {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed() || wc.hostWebContents !== event.sender) return [];   // sadece kendi webview'i
    const frames = wc.mainFrame.framesInSubtree.filter((f) => !only || `${f.processId}:${f.routingId}` === only);
    const out = await Promise.all(frames.map(async (f) => {
        try {
            const r = await Promise.race([f.executeJavaScript(code), new Promise((res) => setTimeout(() => res(null), 1500))]);
            return r ? { fid: `${f.processId}:${f.routingId}`, r } : null;
        } catch (e) { return null; }
    }));
    return out.filter(Boolean);
});

// Hakkinda ekrani: surum ve acik kaynak lisans dosyasi
ipcMain.handle('app-info', () => ({ version: app.getVersion() }));
ipcMain.handle('open-notices', () => {
    const p = app.isPackaged ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt') : path.join(__dirname, 'THIRD-PARTY-NOTICES.txt');
    return shell.openPath(p);
});

// Misafir: herkese acik oda dizinini izle (kod girmeden liste)
const watchers = new Map();   // webContents.id -> watcher
ipcMain.handle('directory-watch', (event) => {
    const wc = event.sender;
    if (watchers.has(wc.id)) return;
    watchers.set(wc.id, createWatcher((rooms) => { if (!wc.isDestroyed()) wc.send('directory-update', rooms); }));
    wc.once('destroyed', () => { const w = watchers.get(wc.id); if (w) { w.close(); watchers.delete(wc.id); } });
});
ipcMain.handle('directory-unwatch', (event) => {
    const w = watchers.get(event.sender.id);
    if (w) { w.close(); watchers.delete(event.sender.id); }
});

app.on('before-quit', () => {
    if (publisher) publisher.close();
    watchers.forEach((w) => w.close());
    if (tunnelProc) tunnelProc.kill();
});

// 2. ELECTRON PENCERE YÖNETİMİ
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 860,
        minHeight: 600,
        title: 'Cue',
        backgroundColor: '#0d0c0b',
        autoHideMenuBar: true, // Üstteki File/Edit menüsünü gizler
        icon: path.join(__dirname, 'icon.ico'), // İŞTE GÖREV ÇUBUĞUNDA İKONUNU GÖSTERECEK SİHİRLİ SATIR!
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            autoplayPolicy: 'no-user-gesture-required'   // sesli sohbetteki uzak ses tik gerektirmeden calsin
        }
    });

    // Menü çubuğunun görünürlüğünü tamamen kapatarak arayüzü jilet gibi yaparız
    mainWindow.setMenuBarVisibility(false); 

    mainWindow.loadFile('public/index.html');

    // TAM EKRAN (FULLSCREEN) ÇÖZÜCÜ
    mainWindow.webContents.on('enter-html-full-screen', () => mainWindow.setFullScreen(true));
    mainWindow.webContents.on('leave-html-full-screen', () => mainWindow.setFullScreen(false));

    // REKLAM VE POP-UP ENGELLEYİCİ
    mainWindow.webContents.on('did-attach-webview', (event, webContents) => {
        webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        webContents.on('will-navigate', (e, url) => {
            const blockedKeywords = ['bet', 'casino', 'slot', 'adclick', 'doubleclick', 'popunder', 'onclick'];
            if (blockedKeywords.some(keyword => url.toLowerCase().includes(keyword))) e.preventDefault();
        });
    });

    // Uygulama penceresi asla baska bir sayfaya gitmesin / yeni pencere acmasin
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Video sitelerinin oturumu uygulamadan ayri (persist:video); sadece gerekli izinler verilir.
// Kamera, mikrofon, konum, bildirim gibi her sey reddedilir (eskiden hepsi otomatik onaylaniyordu).
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
function lockVideoSession() {
    const ses = session.fromPartition('persist:video');
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

// Uygulama penceresinin kendi oturumu: mikrofon (sesli sohbet) ve panoya yazma izni, sadece kendi dosyalarimiz icin.
// Video sitelerinin oturumu (persist:video) ayri ve yukaridaki kuralla kamera/mikrofon dahil her seyi reddeder.
const APP_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
function lockAppSession() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
        const mine = String((details && details.requestingUrl) || wc.getURL()).startsWith('file://');
        // 'media' = mikrofon ve/veya kamera; sadece uygulamanin kendi penceresine (file://) verilir.
        const types = (details && details.mediaTypes) || [];
        const known = permission !== 'media' || (types.length > 0 && types.every((t) => t === 'audio' || t === 'video'));
        cb(APP_PERMISSIONS.has(permission) && mine && known);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => APP_PERMISSIONS.has(permission) && String(origin || '').startsWith('file://'));
}

app.whenReady().then(() => {
    lockAppSession();
    lockVideoSession();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});