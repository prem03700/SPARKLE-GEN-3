# SPARKLE GEN-3 — Private device HTTPS trust

The private server's current URL is reported by `/api/health` and Settings; as of 2026-10-11 it is `https://10.210.108.19:4173` on the current USB-linked private network. The server certificate covers both `10.58.17.55` (previous LAN) and `10.210.108.19` (current address), plus localhost. TLS is active; plain HTTP is disabled. The host certificate is issued by a private CA, so each client device must explicitly trust that CA before browser pairing.

## Certificate and verification

- Public CA certificate on host: `~/.config/sparkle/gen3-tls/ca.crt`
- Convenient transfer copy: `~/Downloads/SPARKLE-GEN3-Private-CA.crt`
- SHA-256 fingerprint: `25:30:5C:75:15:78:8F:BE:54:4A:0B:47:9D:6C:06:8D:88:44:F8:7C:47:8F:AF:96:C7:55:4D:F2:63:CD:74:FA`
- Certificate currently covers `localhost`, `127.0.0.1`, `10.58.17.55`, and `10.210.108.19`. If the host address changes again, reissue the server certificate with the new address before using HTTPS there.

Verify the fingerprint through this independently recorded value before trusting/importing the CA. The CA certificate is public; **never transfer** `ca.key` or `server.key` to any client.

## Android

1. Transfer only `SPARKLE-GEN3-Private-CA.crt` to the phone/tablet (USB is preferred).
2. Open Android Settings and find **Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**. Labels vary by Android version/vendor; the device may require a screen lock and warn that a user-installed CA can inspect encrypted traffic.
3. Confirm the imported certificate name is `SPARKLE GEN-3 Private Device CA` and verify its SHA-256 fingerprint against the value above before trusting it.
4. While on a trusted private network that permits peer-to-peer traffic (the current successful route is the USB-linked private network), open the current HTTPS LAN URL shown in host Settings or `/api/health` (currently `https://10.210.108.19:4173`). Confirm the browser shows a secure connection with no certificate warning, then pair through SPARKLE Settings using a fresh single-use code generated on the host.

## iPhone/iPad

1. Transfer only the public `.crt` CA certificate to the device using a trusted local transfer method.
2. Install the resulting configuration profile from Settings, then open **Settings → General → About → Certificate Trust Settings** and explicitly enable full trust for the SPARKLE private CA if the OS exposes that option.
3. Verify the fingerprint out-of-band, open `https://10.58.17.55:4173` on the same trusted Wi-Fi, and confirm no certificate warning before pairing.

## Latest physical-device test note — 2026-10-11

- Host-side strict TLS verification passes for `https://10.58.17.55:4173` using the private CA, with a matching IP SAN and TLS 1.3. Plain HTTP does not serve the application.
- A USB-connected Android 15 device (model `2312DRAABI`) and the host are associated with the same Wi-Fi access point/BSSID and report addresses in `10.58.0.0/19`, but TCP to `10.58.17.55:4173` times out. Both host and phone neighbor tables show the peer address as `FAILED`; the host route to the phone is directly through Wi-Fi, not the VPN interface. This strongly suggests Wi-Fi client isolation/network ACL or another link-layer policy, but the exact cause is not proven.
- The earlier VPN hypothesis has been rechecked: the user confirmed the phone VPN is disconnected, and read-only Android settings show no configured always-on VPN or global HTTP proxy. These checks do not rule out every filtering app, but the peer neighbor entry still fails. The current leading hypothesis remains Wi-Fi peer isolation, VLAN/ACL policy, or another link-layer restriction. Test on a trusted private network that permits peer-to-peer traffic, or ask the Wi-Fi administrator to check client isolation; do not alter host firewall rules or expose the server publicly.
- Only the public CA certificate was copied to the device's Downloads folder. Its SHA-256 file hash matches the host transfer copy (`92070c816e05099aff6836aeb2d953daa2881bd34c9980d5fc69346776232640`), confirming the copied file is intact; this byte-level hash is not the certificate fingerprint. The CA was **not installed or trusted**. Do not install/trust it until the device can reach the host and the certificate fingerprint has been independently verified.

## Acceptance checklist

- [ ] Client trusts the CA and browser displays a valid HTTPS connection.
- [ ] `/api/health` loads and advertises the same HTTPS LAN URL.
- [ ] Device pairs using a fresh code generated only on the host.
- [ ] A task created on that device appears on the host/another paired device after sync.
- [ ] Revoking the test device makes its old token return `401`.
- [ ] If using voice, microphone permission and audio input/output are tested on the physical device.

Do not port-forward the service or expose it through a public tunnel. The host certificate currently has a private LAN IP SAN and does not enable remote internet access.


### Retest after Android VPN disconnect — 2026-10-11 09:44 UTC

- User confirmed the Android VPN is already disconnected; Chrome still times out / cannot reach the site.
- Read-only host checks confirm `0.0.0.0:4173` is listening and strict local HTTPS health succeeds with the private CA; health reports the expected LAN URL and selected NVIDIA model available.
- Host route to `10.58.17.255` is directly through `wlp0s20f3`, but host neighbor discovery reports `10.58.17.255 FAILED`.
- Android route table shows `10.58.0.0/19 dev wlan0 src 10.58.17.255`; its neighbor table reports `10.58.17.55 FAILED`, and a TCP probe to `10.58.17.55:4173` returns `No route to host`.
- Both peers can resolve the gateway, but cannot resolve each other. This is strong evidence of peer-to-peer/L2 filtering or another Wi-Fi/client policy, rather than an HTTPS or application failure. It is not definitive proof of client isolation. UFW's effective allow rules remain unverified because the remote terminal policy blocks `sudo`; do not change firewall/router settings. Next safe discriminator: test on a trusted private network that permits peer-to-peer traffic, or ask the current Wi-Fi administrator to check client isolation/VLAN/ACL policy. Keep public exposure disabled.


### Retest with USB file-transfer enabled — 2026-10-11

- The Android phone is reachable over the current USB-linked private network: phone `10.210.108.20` on `ap0`, host `10.210.108.19`; phone ping and TCP connection to host port `4173` succeeded. The Wi-Fi interface on the phone is currently down, so this test is not evidence that the prior Wi-Fi permits peer-to-peer traffic.
- Reissued `server.crt` under the existing private CA with SANs for `localhost`, `127.0.0.1`, previous host address `10.58.17.55`, and current host address `10.210.108.19`. Strict-CA HTTPS health passed on loopback and the current address after restarting `sparkle-gen3.service`.
- Transferred only the public CA certificate to `/sdcard/Download/SPARKLE-GEN3-Private-CA.crt`. The file hash matches the host copy and the CA fingerprint matches the independently recorded fingerprint above. The CA is not installed/trusted yet; Android's direct installer intent was unavailable, and the Security settings screen is open for manual installation. Pairing and workspace sync acceptance remain pending until the user completes certificate trust and a fresh one-time pairing flow.
