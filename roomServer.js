// Oda sunucusu mantigi: main.js (Electron) ve server.js (bagimsiz) ortak kullanir.
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
// Kontrol ve yon-degistirme (bidi) karakterlerini at: sahte/yanilticı isim ve mesajlari engeller
const clean = (v, n) => clip(v, n).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
// Tunel arkasinda gercek istemci adresi cf-connecting-ip basligindadir
const ipOf = (socket) => String(socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address || '');
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

// Sunucu internete acik oldugu icin sinirlar
const MAX_ROOMS = 30, MAX_MEMBERS = 40, MAX_VOICE = 8;   // sesli sohbet herkes-herkesle baglandigi icin 8 kisiyle sinirli
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);
const limiter = (max, windowMs) => {
    const hits = [];
    return () => {
        const now = Date.now();
        while (hits.length && now - hits[0] > windowMs) hits.shift();
        if (hits.length >= max) return false;
        hits.push(now);
        return true;
    };
};

// Karisabilecek harfler (0/O, 1/I/L) yok
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function attach(io, onRoomsChange) {
    // rooms[code] = { host: socketId, hostName, name, description, isPublic, url, state, members: Map(socketId -> username) }
    const rooms = {};

    function newCode() {
        let code;
        do {
            code = Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        } while (rooms[code]);
        return code;
    }

    // Sadece herkese acik odalar listelenir; gizli odalara oda koduyla girilir
    const roomList = () => Object.entries(rooms).filter(([, r]) => r.isPublic).map(([code, r]) => ({
        id: code, name: r.name, host: r.hostName, count: r.members.size, description: r.description, calls: r.calls
    }));
    const broadcastList = () => {
        const list = roomList();
        io.emit('room-list', list);
        if (onRoomsChange) onRoomsChange(list);   // dis dizine (internet listesi) haber ver
    };

    // Odadakilerin listesi (yonetici basta); presence icin
    const emitMembers = (code) => {
        const room = rooms[code];
        if (!room) return;
        const members = [...room.members.entries()].map(([id, name]) => ({ id, name, isHost: id === room.host, muted: room.muted.has(id), voice: room.voice.has(id), cam: room.cam.has(id) }));
        members.sort((a, b) => Number(b.isHost) - Number(a.isHost));
        io.to(code).emit('room-members', members);
    };

    function leave(socket) {
        const id = socket.data.roomID;
        if (!id) return;
        socket.data.roomID = null;
        socket.leave(id);
        const room = rooms[id];
        if (!room) return;
        room.members.delete(socket.id);
        room.muted.delete(socket.id);
        room.voice.delete(socket.id);
        room.cam.delete(socket.id);
        if (room.host === socket.id) {
            socket.to(id).emit('room-closed');
            io.in(id).socketsLeave(id);
            delete rooms[id];
        }
        emitMembers(id);
        broadcastList();
    }

    io.on('connection', (socket) => {
        socket.emit('room-list', roomList());
        socket.on('list-rooms', () => socket.emit('room-list', roomList()));

        // create: { create: true, name, description, isPublic }   join: { roomID: <oda kodu> }
        socket.on('join-room', ({ roomID, username, create, name, isPublic, description, calls } = {}) => {
            if (!socket.data.joinRl) socket.data.joinRl = limiter(10, 10000);
            if (!socket.data.joinRl()) return socket.emit('join-error', 'too_fast');
            username = clean(username, 24) || 'Guest';

            let code, room;
            if (create) {
                name = clean(name, 32);
                if (!name) return socket.emit('join-error', 'room_name_empty');
                if (Object.keys(rooms).length >= MAX_ROOMS) return socket.emit('join-error', 'server_full');
                if (socket.data.roomID) leave(socket);
                code = newCode();
                room = rooms[code] = {
                    host: socket.id, hostName: username, name,
                    description: clean(description, 140), isPublic: isPublic !== false,
                    url: 'about:blank', state: { isPlaying: false, currentTime: 0, rate: 1 }, stateAt: 0, members: new Map(),
                    muted: new Set(), bans: new Set(), voice: new Set(), cam: new Set(), calls: calls === true
                };
            } else {
                code = clip(roomID, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
                room = rooms[code];
                if (!room) return socket.emit('join-error', 'room_not_found');
                if (room.bans.has(ipOf(socket))) return socket.emit('join-error', 'banned');
                if (room.members.size >= MAX_MEMBERS && !room.members.has(socket.id)) return socket.emit('join-error', 'room_full');
                if (socket.data.roomID) leave(socket);
            }

            const isHost = room.host === socket.id;
            room.members.set(socket.id, username);
            socket.data.roomID = code;
            socket.data.username = username;
            socket.join(code);

            socket.emit('host-status', { isHost, roomID: code, name: room.name, description: room.description, isPublic: room.isPublic, calls: room.calls });
            if (!isHost) {
                socket.emit('peer-url-change', room.url);
                // Gec katilana, son durumdan bu yana gecen sure eklenmis konumu ver
                const s = room.state, ahead = s.isPlaying && room.stateAt ? (Date.now() - room.stateAt) / 1000 * (s.rate || 1) : 0;
                socket.emit('peer-video-sync', { ...s, currentTime: s.currentTime + ahead });
            }
            emitMembers(code);
            broadcastList();
        });

        socket.on('leave-room', () => leave(socket));

        // Sesli sohbet: sunucu SES tasimaz; sadece kimin seste oldugunu tutar ve baglanti kurma mesajlarini iletir.
        // Ses, seste olan kisiler arasinda dogrudan (WebRTC) akar. Yeni katilan, zaten seste olanlara teklif gonderir.
        socket.on('voice-join', () => {
            const code = socket.data.roomID, room = rooms[code];
            if (!room) return;
            if (!socket.data.voiceRl) socket.data.voiceRl = limiter(10, 10000);
            if (!socket.data.voiceRl()) return;
            if (!room.calls) return socket.emit('voice-error', 'calls_off');
            if (!room.voice.has(socket.id) && room.voice.size >= MAX_VOICE) return socket.emit('voice-error', 'voice_full');
            const peers = [...room.voice].filter((id) => id !== socket.id);
            room.voice.add(socket.id);
            socket.emit('voice-peers', peers);
            emitMembers(code);
        });
        socket.on('voice-leave', () => {
            const code = socket.data.roomID, room = rooms[code];
            if (!room || !room.voice.delete(socket.id)) return;
            room.cam.delete(socket.id);
            emitMembers(code);
        });
        // Kamera: sunucu goruntu tasimaz, sadece kimin kamerasinin acik oldugunu tutar (sadece seste olanlar acabilir)
        socket.on('cam-set', ({ on } = {}) => {
            const code = socket.data.roomID, room = rooms[code];
            if (!room || !room.calls || !room.voice.has(socket.id)) return;
            if (!socket.data.camRl) socket.data.camRl = limiter(20, 10000);
            if (!socket.data.camRl()) return;
            if (on === true) room.cam.add(socket.id); else room.cam.delete(socket.id);
            emitMembers(code);
        });
        socket.on('rtc-signal', ({ to, data } = {}) => {
            const room = rooms[socket.data.roomID];
            if (!room || !room.calls) return;
            if (!socket.data.sigRl) socket.data.sigRl = limiter(200, 5000);
            if (!socket.data.sigRl()) return;
            if (typeof to !== 'string' || !data || !SIGNAL_TYPES.has(data.type)) return;
            if (!room.voice.has(socket.id) || !room.voice.has(to)) return;              // sadece seste olanlar arasinda
            let size; try { size = JSON.stringify(data).length; } catch (e) { return; }
            if (size > 30000) return;
            const target = io.sockets.sockets.get(to);
            if (target) target.emit('rtc-signal', { from: socket.id, data });
        });

        // Moderasyon: sadece odanin yoneticisi. kick = odadan cikar + bu odaya (IP ile) tekrar girmeyi engelle.
        socket.on('mod', ({ action, target } = {}) => {
            const code = socket.data.roomID, room = rooms[code];
            if (!room || room.host !== socket.id) return;
            if (!socket.data.modRl) socket.data.modRl = limiter(20, 5000);
            if (!socket.data.modRl()) return;
            if (typeof target !== 'string' || target === socket.id || !room.members.has(target)) return;
            const t = io.sockets.sockets.get(target);
            if (!t) return;
            if (action === 'camoff') {   // yonetici baskasinin kamerasini kapattirir (kisi tekrar acabilir; kotuye kullanirsa cikarilir)
                if (room.cam.delete(target)) { t.emit('mod-notice', 'camoff'); emitMembers(code); }
            } else if (action === 'mute' || action === 'unmute') {
                if (action === 'mute') room.muted.add(target); else room.muted.delete(target);
                t.emit('mod-notice', action === 'mute' ? 'muted' : 'unmuted');
                emitMembers(code);
            } else if (action === 'kick') {
                room.bans.add(ipOf(t));
                room.members.delete(target);
                room.muted.delete(target);
                room.voice.delete(target);
                room.cam.delete(target);
                t.data.roomID = null;
                t.leave(code);
                t.emit('kicked');
                emitMembers(code);
                broadcastList();
            }
        });
        socket.on('cue-ping', (cb) => { if (typeof cb === 'function') cb(); });   // gidis-donus gecikmesi olcumu (senkron icin)

        const hostRoom = () => {
            const r = rooms[socket.data.roomID];
            return r && r.host === socket.id ? r : null;
        };
        socket.on('host-url-change', (url) => {
            const r = hostRoom();
            if (r && isHttp(url)) { r.url = clip(url, 2048); socket.to(socket.data.roomID).emit('peer-url-change', r.url); }   // sadece http(s): file:, data: vb. misafire gitmez
        });
        socket.on('host-video-sync', (state) => {
            const r = hostRoom();
            if (r) {
                const rate = Math.min(4, Math.max(0.25, Number(state?.rate) || 1));
                r.state = { isPlaying: !!state?.isPlaying, currentTime: Number(state?.currentTime) || 0, rate };
                r.stateAt = Date.now();
                socket.to(socket.data.roomID).emit('peer-video-sync', r.state);
            }
        });
        socket.on('send-chat', (data) => {
            const id = socket.data.roomID;
            if (!socket.data.chatRl) socket.data.chatRl = limiter(6, 3000);
            const r = rooms[id];
            if (r && r.muted.has(socket.id)) {   // susturulmus: mesaj dagitilmaz, gonderene bildirilir (5 sn'de bir)
                if (!socket.data.muteNote || Date.now() - socket.data.muteNote > 5000) { socket.data.muteNote = Date.now(); socket.emit('mod-notice', 'muted'); }
                return;
            }
            if (id && socket.data.chatRl()) io.to(id).emit('receive-chat', { username: socket.data.username, msg: { msg: clean(data?.msg, 500) } });
        });
        socket.on('trigger-emoji', (emoji) => {
            const id = socket.data.roomID;
            if (id) io.to(id).emit('broadcast-emoji', clip(emoji, 8));
        });

        socket.on('disconnect', () => leave(socket));
    });
}

module.exports = { attach };
