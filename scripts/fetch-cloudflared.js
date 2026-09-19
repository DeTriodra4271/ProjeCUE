// Indirir: bin/cloudflared.exe (Cloudflare'in resmi surumu) ve IMZASINI dogrular.
// Kullanim:  npm run setup        (bin/cloudflared.exe yoksa indirir)
//            node scripts/fetch-cloudflared.js --force   (yeniden indir)
//            node scripts/fetch-cloudflared.js --out <yol>  (baska yere; test icin)
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const dest = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, '..', 'bin', 'cloudflared.exe'));
const force = argv.includes('--force');

if (fs.existsSync(dest) && !force) { console.log('cloudflared.exe already present: ' + dest); process.exit(0); }
fs.mkdirSync(path.dirname(dest), { recursive: true });

const get = (url, file) => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cue-setup' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, file)); }
        if (res.statusCode !== 200) return reject(new Error(url + ' -> HTTP ' + res.statusCode));
        const out = fs.createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
    }).on('error', reject);
});

(async () => {
    const tmp = dest + '.download';
    console.log('Downloading cloudflared...');
    await get(URL, tmp);
    // Sadece Cloudflare tarafindan gecerli sekilde imzalanmis dosya kabul edilir
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${tmp}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`], { encoding: 'utf8' });
    const [status, subject] = (ps.stdout || '').trim().split('|');
    if (status !== 'Valid' || !/Cloudflare/i.test(subject || '')) {
        fs.rmSync(tmp, { force: true });
        console.error(`REFUSED: signature is "${status}" for "${subject}". Not installing.`);
        process.exit(1);
    }
    fs.renameSync(tmp, dest);
    const v = spawnSync(dest, ['--version'], { encoding: 'utf8' });
    console.log(`OK: ${dest}\n    ${(v.stdout || '').trim()}\n    signed by Cloudflare, Inc. (valid)`);
})().catch((e) => { console.error('Download failed: ' + e.message); process.exit(1); });
