# Releasing Cue

## Build

```
npm run release          # builds an installer and a portable exe into release/, unsigned is allowed (prints a warning)
npm run release:signed   # same, but fails unless every exe carries a valid signature. Use this for public releases.
```

Each run refreshes `THIRD-PARTY-NOTICES.txt`, builds, checks the signature of every exe with Windows itself, and writes `release/SHA256SUMS.txt`.

Outputs: `Cue-Setup-<version>.exe` (installs for the current user, no admin prompt) and `Cue-Portable-<version>.exe`. Bump `version` in `package.json` first.

## Before the first public release

1. **Sign the app.** See below. Unsigned builds show "Windows protected your PC" and antivirus often flags unknown exes that bundle a tunnel program.
2. **Fill in the contact line** at the bottom of `PRIVACY.md` and host that text on a page you control.
3. **Decide Cue's own license** and add a `LICENSE` file. The dependencies are all permissive (MIT, BSD, ISC, 0BSD); nothing forces a choice on you.
4. **Test on a clean Windows PC** (a fresh user account or a VM): install, host, join from another network, quit, uninstall.
5. Publish the SHA256 sums with the download so people can verify it.

## Signing

Windows users see a SmartScreen warning for unsigned apps. Signing removes the "unknown publisher" part. SmartScreen also builds *reputation* per publisher and file as people download, so early downloads of a newly signed app can still show a softer warning; it fades over time.

The options, from the cheapest route to the most work (prices and eligibility are as reported in September 2026. Check the provider before paying):

| Option | Cost | Who can use it | Notes |
|---|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | about $10 / month | Organizations in the US, Canada, EU, UK. Individuals in the US and Canada only. | No hardware token, works in CI. Not available to an individual in Turkey. |
| **SignPath Foundation** | free | Open-source projects with an OSI-approved license, public code, actively maintained | Requires publishing the source. |
| **OV code signing certificate** from a CA (DigiCert, Sectigo, SSL.com, Certum ...) | roughly $150 to $300 / year | Anyone who passes the CA's identity check | New certificates come on a hardware token or a cloud signing service, not a .pfx file you can keep on disk. |
| **Microsoft Store** (MSIX) | small one-time developer fee | Individuals and companies | Microsoft signs it and there is no SmartScreen prompt, but it means a Store submission and review, and an MSIX build target. |

### Wiring it up

Secrets are read from environment variables only. Nothing secret goes in the repository (`*.pfx` is in `.gitignore`).

**Azure Artifact Signing.** Create the account, a certificate profile and an app registration with the signer role, then set:

```
AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET     (the app registration)
CUE_AZURE_ENDPOINT, CUE_AZURE_ACCOUNT, CUE_AZURE_PROFILE   (from the Azure portal)
CUE_PUBLISHER                                              (the subject name exactly as in the certificate)
```

**A CA's cloud or token signing.** Most providers ship a command line signing tool. Point `CUE_SIGN_SCRIPT` at a small Node script that receives the file path from electron-builder and calls that tool. electron-builder calls it for every file that needs a signature.

**A classic .pfx file** (older certificates): set `CSC_LINK` to its path and `CSC_KEY_PASSWORD` to its password. electron-builder handles the rest.

Then run `npm run release:signed`. It ends with a table like:

```
Cue-Setup-2.0.0.exe: Valid | CN=Your Publisher | timestamped: True
```

`timestamped: True` matters: without it the signature stops being valid when the certificate expires.

`cloudflared.exe` (the bundled tunnel program) is already signed by Cloudflare and keeps that signature.

## Things that can bite after release

- **Free services.** The tunnel (Cloudflare quick tunnels) and the public room list (three public MQTT servers) are free services with no guarantee. If one changes, hosting or the public list stops working.
- **No auto-update yet.** Users stay on the version they installed. Adding an updater is worth doing once the app is signed.
- **Internal names.** `appId` and the package name still say `projesun` on purpose: the app's saved settings and the public-room protocol depend on them. Do not rename them without a migration.
