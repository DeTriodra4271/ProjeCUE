// Surum uretimi: bildirimleri yeniler, uygulamayi derler, imzayi DOGRULAR ve SHA256 listesi yazar.
//   npm run release            -> imzasiz olabilir (uyarir)
//   npm run release:signed     -> imza gecerli degilse basarisiz olur (yayin icin bunu kullan)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const requireSigned = process.argv.includes('--require-signed');
const env = process.env;
const out = path.resolve(root, env.CUE_OUT || 'release');
const log = (m) => console.log(m);

const mode = env.CUE_AZURE_ENDPOINT && env.CUE_AZURE_ACCOUNT && env.CUE_AZURE_PROFILE && env.CUE_PUBLISHER ? 'Azure Artifact Signing'
    : env.CUE_SIGN_SCRIPT ? 'custom sign script (cloud HSM / provider tool)'
    : env.CSC_LINK ? 'PFX certificate'
    : null;
log(mode ? `Signing: ${mode}` : 'Signing: NONE. This build will be UNSIGNED (Windows SmartScreen will warn users). See RELEASE.md.');
if (!mode && requireSigned) { console.error('\nrelease:signed needs a signing method configured. Aborting.'); process.exit(1); }

const cleanEnv = { ...env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;   // bazi ortamlar Electron'u Node modunda zorlar; derleme bunu istemez
const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: cleanEnv, ...opts });
    if (r.status !== 0) { console.error(`\n${cmd} ${args.join(' ')} failed (${r.status})`); process.exit(r.status || 1); }
};

if (!fs.existsSync(path.join(root, 'bin', 'cloudflared.exe'))) { log('\n0/4 Fetching the tunnel program'); run('node', ['scripts/fetch-cloudflared.js']); }
log('\n1/4 Refreshing open-source notices');
run('node', ['scripts/gen-notices.js']);

log('\n2/4 Building');
fs.rmSync(out, { recursive: true, force: true });
run('node', [path.join('node_modules', 'electron-builder', 'cli.js'), '--config', 'electron-builder.js', '--win']);

log('\n3/4 Verifying signatures');
const artifacts = fs.readdirSync(out).filter((f) => /\.exe$/i.test(f)).map((f) => path.join(out, f));
let allValid = artifacts.length > 0;
for (const f of artifacts) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${f}'; "$($s.Status)|$($s.SignerCertificate.Subject)|$($s.TimeStamperCertificate -ne $null)"`], { encoding: 'utf8' });
    const [status, signer, stamped] = (ps.stdout || '').trim().split('|');
    if (status !== 'Valid') allValid = false;
    log(`  ${path.basename(f)}: ${status}${status === 'Valid' ? ` | ${(signer || '').split(',')[0]} | timestamped: ${stamped}` : ''}`);
}

log('\n4/4 Checksums');
const sums = artifacts.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
sums.forEach((s) => log('  ' + s));

log(`\nOutput: ${out}`);
if (!allValid) {
    log(requireSigned ? '\nFAILED: at least one file is not validly signed.' : '\nNOTE: unsigned build. Fine for testing, NOT for public release.');
    if (requireSigned) process.exit(1);
}
