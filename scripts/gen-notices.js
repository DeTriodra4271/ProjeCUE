// Uretir: THIRD-PARTY-NOTICES.txt  (uygulamayla birlikte gonderilen acik kaynak lisans bildirimi)
// Kullanim: node scripts/gen-notices.js   (sürümden önce, bağımlılıklar değiştiyse yeniden çalıştır)
const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function findPkgDir(name, fromDir) {
    let dir = fromDir;
    for (;;) {
        const p = path.join(dir, 'node_modules', name);
        if (fs.existsSync(path.join(p, 'package.json'))) return p;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}

// Uretim bagimliliklarinin tam kapanisi (devDependencies dahil degil)
const seen = new Map();
for (const dep of Object.keys(pkg.dependencies || {})) {
    (function walk(name, fromDir) {
        const dir = findPkgDir(name, fromDir);
        if (!dir) return;
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const key = j.name + '@' + j.version;
        if (seen.has(key)) return;
        seen.set(key, { dir, j });
        for (const d of Object.keys(j.dependencies || {})) walk(d, dir);
    })(dep, root);
}

const licenseFile = (dir) => {
    const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|$)/i.test(n));
    return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
};
const get = (url) => new Promise((res, rej) => https.get(url, { headers: { 'User-Agent': 'cue-notices' } }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return res(get(r.headers.location));
    if (r.statusCode !== 200) return rej(new Error(url + ' -> ' + r.statusCode));
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => (b += c)); r.on('end', () => res(b));
}).on('error', rej));

(async () => {
    const out = [];
    const bar = '='.repeat(78);
    out.push(`Cue ${pkg.version}: third-party notices\n\nCue includes the software below. Each component is licensed by its authors under the terms shown.\nElectron and Chromium are shipped with their own notices in LICENSE.electron.txt and LICENSES.chromium.html next to the application.\n`);

    // cloudflared (Apache-2.0)
    let cf;
    try { cf = await get('https://raw.githubusercontent.com/cloudflare/cloudflared/master/LICENSE'); } catch (e) { console.error('WARN: could not fetch cloudflared LICENSE:', e.message); }
    out.push(`${bar}\ncloudflared (Cloudflare, Inc.): bundled as cloudflared.exe\nLicense: Apache License 2.0\nSource: https://github.com/cloudflare/cloudflared\n${bar}\n\n${cf || 'License text: https://www.apache.org/licenses/LICENSE-2.0'}\n`);

    // Archivo font (OFL)
    const ofl = path.join(root, 'public', 'fonts', 'LICENSE-Archivo-OFL.txt');
    out.push(`${bar}\nArchivo (Omnibus-Type), bundled font files\nLicense: SIL Open Font License 1.1\nSource: https://github.com/Omnibus-Type/Archivo\n${bar}\n\n${fs.existsSync(ofl) ? fs.readFileSync(ofl, 'utf8').trim() : ''}\n`);

    // npm production dependencies
    const list = [...seen.values()].sort((a, b) => a.j.name.localeCompare(b.j.name));
    for (const { dir, j } of list) {
        const lic = typeof j.license === 'string' ? j.license : (j.license && j.license.type) || (j.licenses ? j.licenses.map((l) => l.type).join(' OR ') : 'see package');
        const repo = (typeof j.repository === 'string' ? j.repository : j.repository && j.repository.url || '').replace(/^git\+/, '');
        out.push(`${bar}\n${j.name} ${j.version}\nLicense: ${lic}${repo ? '\nSource: ' + repo : ''}\n${bar}\n\n${licenseFile(dir) || '(No separate license file in the package; license identifier above.)'}\n`);
    }
    fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), out.join('\n'), 'utf8');
    const counts = {};
    list.forEach(({ j }) => { const l = typeof j.license === 'string' ? j.license : 'other'; counts[l] = (counts[l] || 0) + 1; });
    console.log(`wrote THIRD-PARTY-NOTICES.txt: ${list.length} npm packages + cloudflared + Archivo`);
    console.log('licenses:', JSON.stringify(counts));
    const risky = list.filter(({ j }) => /GPL|AGPL|SSPL|UNLICENSED/i.test(String(j.license)));
    console.log(risky.length ? 'REVIEW THESE: ' + risky.map(({ j }) => j.name + ' (' + j.license + ')').join(', ') : 'no copyleft (GPL/AGPL/SSPL) or unlicensed packages found');
})();
