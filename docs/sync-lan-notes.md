# Direct sync from phone to computer over the local network: feasibility

Status: not built. The app syncs through the private repository instead (see the README).

The idea was to sync directly between the phone and the computer on the same Wi-Fi, with WebRTC, so that no
server or GitHub account is involved.

## What it would take

- **Discovery and signalling.** WebRTC needs both ends to exchange an offer and an answer. On a LAN, the
  computer would have to serve a page that the phone opens, for example the editor server on
  `http://<computer>:<port>`, and that page would carry the signalling in one of two ways: a QR code that
  holds the offer (the phone scans it and sends back the answer on a second QR code), or a short code typed
  on both sides. Without a signalling server this is manual, so every sync is a pairing.
- **Secure context.** The browser's WebCrypto (used for hashing and the export) and the service worker
  need `https` or `localhost`. A page served from `http://192.168.x.x` has neither, so the LAN page would
  need its own TLS certificate, which a phone would not trust without an install step.
- **iOS limits.** Safari does not run a page in the background, so the transfer happens only while both
  pages are open. iOS 14 and later also asks the user for "Local Network" permission on first use.
- **Connectivity.** Host candidates (addresses on the LAN) are enough when both devices are on the same
  network, with no STUN or TURN server. A different network (or a guest Wi-Fi with client isolation) makes
  the transfer fail, and the user would not see why without a diagnostic.

## Why it was not built

The repository sync covers the same need: it works from any network, needs no pairing, keeps a copy in a
private place, and uses the same conflict rule. The LAN path would add a pairing step, a certificate
problem, and a second sync path to test, for little gain.

If it is reconsidered, the cheapest first step is a QR-based pairing on the editor server with the offer
and the answer in the query string, plus the same `syncDays` function used over the data channel.
