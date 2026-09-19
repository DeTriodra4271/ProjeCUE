// Herkese acik oda dizini: hesap gerektirmeyen halka acik MQTT sunuculari uzerinden.
// Host (internet tuneli olan) acik odalarini yayinlar, misafirler herhangi bir kod girmeden listeyi gorur.
// Ayni bilgi birden fazla sunucuya yazilir/okunur; biri kapaliysa digerleri calisir.
const dns = require('dns');
const mqtt = require('mqtt');

const BROKERS = [
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081'
];
const PREFIX = 'cue/v1/hosts/';
const SERVER_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;   // sadece trycloudflare tunel kodu (rastgele adrese baglanmayi engeller)
const ID_RE = /^[A-Z2-9]{6}$/;

const clip = (v, n) => String(v ?? '').slice(0, n);

// ---- Host tarafi --------------------------------------------------------
function createPublisher(serverCode) {
    const topic = PREFIX + serverCode;
    let payload = '';
    let timer = null;
    let closed = false;
    let reachable = false;   // yeni tunel adresi herkesin agında hemen cozulmez: ulasilabilir olunca yayinla

    const clients = BROKERS.map((url) => {
        const c = mqtt.connect(url, {
            reconnectPeriod: 5000, connectTimeout: 10000,
            will: { topic, payload: '', retain: true, qos: 0 }   // cokerse dizin kendiliginden temizlenir
        });
        c.on('connect', () => { if (reachable) c.publish(topic, payload, { retain: true, qos: 0 }); });
        c.on('error', () => {});
        return c;
    });

    const push = () => { if (reachable) clients.forEach((c) => { if (c.connected) c.publish(topic, payload, { retain: true, qos: 0 }); }); };

    // Yeni tunel adresi once herkese acik DNS'te gorunmeli. Isletim sistemi cozucusunu KULLANMA:
    // erken sorgu "yok" cevabini onbellege alip bu bilgisayarda adresi dakikalarca bozar.
    (async () => {
        const host = `${serverCode}.trycloudflare.com`;
        const resolver = new dns.promises.Resolver();
        resolver.setServers(['1.1.1.1', '8.8.8.8']);
        for (let i = 0; i < 60 && !closed; i++) {
            try { const a = await resolver.resolve4(host); if (a.length) { reachable = true; push(); return; } } catch (e) {}
            await new Promise((res) => setTimeout(res, 1000));
        }
        reachable = true; push();   // hic cevap gelmese de en sonunda yayinla
    })();

    return {
        update(rooms) {
            payload = rooms.length ? JSON.stringify({ rooms, ts: Date.now() }) : '';
            clearTimeout(timer);
            timer = setTimeout(push, 1500);   // hizli degisimleri birlestir
        },
        close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            clients.forEach((c) => {
                if (c.connected) c.publish(topic, '', { retain: true, qos: 0 }, () => c.end(true));
                else c.end(true);
            });
        }
    };
}

// ---- Misafir tarafi -----------------------------------------------------
function parse(topic, message) {
    if (!topic.startsWith(PREFIX)) return [];
    const server = topic.slice(PREFIX.length);
    if (!SERVER_RE.test(server) || server.length > 80) return [];
    let data;
    try { data = JSON.parse(message.toString()); } catch { return []; }
    if (!data || !Array.isArray(data.rooms)) return [];
    return data.rooms.slice(0, 20).filter((r) => r && ID_RE.test(String(r.id))).map((r) => ({
        server, id: String(r.id), name: clip(r.name, 32), host: clip(r.host, 24),
        count: Math.max(0, Math.min(9999, Number(r.count) || 0)), description: clip(r.description, 140)
    }));
}

function createWatcher(onChange) {
    const perTopic = new Map();   // "broker|topic" -> rooms[]
    let timer = null;

    const emit = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const seen = new Map();
            for (const rooms of perTopic.values()) for (const r of rooms) seen.set(r.server + '|' + r.id, r);
            onChange([...seen.values()].slice(0, 200));
        }, 300);
    };

    const clients = BROKERS.map((url) => {
        const c = mqtt.connect(url, { reconnectPeriod: 5000, connectTimeout: 10000 });
        c.on('connect', () => c.subscribe(PREFIX + '+'));
        c.on('message', (topic, message) => {
            const key = url + '|' + topic;
            const rooms = message.length ? parse(topic, message) : [];
            if (rooms.length) perTopic.set(key, rooms); else perTopic.delete(key);
            emit();
        });
        c.on('error', () => {});
        return c;
    });

    return {
        close() {
            clearTimeout(timer);
            clients.forEach((c) => c.end(true));
            perTopic.clear();
        }
    };
}

module.exports = { createPublisher, createWatcher };
