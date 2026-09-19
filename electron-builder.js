// Cue yayin (build) ayarlari. Imzalama bilgileri asagidaki env degiskenlerinden okunur.
//
// Imza ortam degiskenleriyle secilir (dosyaya gizli bilgi YAZILMAZ):
//   1) Azure Artifact Signing (eski adi Trusted Signing):
//        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET  (kimlik)
//        CUE_AZURE_ENDPOINT, CUE_AZURE_ACCOUNT, CUE_AZURE_PROFILE, CUE_PUBLISHER  (hesap bilgileri)
//   2) Bulut HSM / sertifika saglayicisinin imzalama araci (SSL.com eSigner, DigiCert KeyLocker vb.):
//        CUE_SIGN_SCRIPT=<imzalama betiginin yolu>  (dosya yolunu arguman alan bir Node betigi)
//   3) Klasik .pfx dosyasi (eski sertifikalar / ozel anahtari dosyada olanlar):
//        CSC_LINK=<.pfx yolu>, CSC_KEY_PASSWORD=<parola>  (electron-builder bunu kendisi tanir)
// Hicbiri yoksa uygulama IMZASIZ uretilir (scripts/release.js bunu acikca uyarir).
const base = require('./package.json');
const env = process.env;

const win = {
    icon: 'icon.ico',
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    ...(env.CUE_PUBLISHER ? { publisherName: env.CUE_PUBLISHER } : {}),
};

if (env.CUE_AZURE_ENDPOINT && env.CUE_AZURE_ACCOUNT && env.CUE_AZURE_PROFILE && env.CUE_PUBLISHER) {
    win.azureSignOptions = {
        publisherName: env.CUE_PUBLISHER,
        endpoint: env.CUE_AZURE_ENDPOINT,
        codeSigningAccountName: env.CUE_AZURE_ACCOUNT,
        certificateProfileName: env.CUE_AZURE_PROFILE,
    };
} else if (env.CUE_SIGN_SCRIPT) {
    win.sign = env.CUE_SIGN_SCRIPT;   // electron-builder betigi her imzalanacak dosya icin cagirir
}

module.exports = {
    appId: 'com.cue.app',
    productName: 'Cue',
    copyright: 'Cue',
    compression: 'maximum',
    directories: { output: env.CUE_OUT || 'release' },
    files: ['main.js', 'roomServer.js', 'directory.js', 'public/**/*', 'icon.ico', 'package.json'],
    extraResources: [
        { from: 'bin/cloudflared.exe', to: 'cloudflared.exe' },
        { from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' },
    ],
    win,
    nsis: {
        oneClick: true,                  // yonetici izni istemeden, kullanici basina kurulum
        perMachine: false,
        deleteAppDataOnUninstall: false, // kaldirinca kullanicinin ayarlari silinmesin
        shortcutName: 'Cue',
        artifactName: 'Cue-Setup-${version}.${ext}',
    },
    portable: { artifactName: 'Cue-Portable-${version}.${ext}' },
};
