# närvaro

En liten, serverlös P2P-webapp för ljud/video mellan två enheter.

## Starta

Kör appen från en säker origin eftersom mikrofon och kamera kräver HTTPS eller `localhost`:

```bash
python3 -m http.server 4173
```

Öppna sedan [http://localhost:4173](http://localhost:4173). För två fysiska enheter behöver appen hostas på HTTPS, eller testas via en tunnel.

## Koppla två enheter

1. Välj `Parent` eller `Child` på respektive enhet.
2. På enhet A: tryck **Skapa en inbjudan**.
3. Dela länken, visa QR-koden eller skicka de fyra orden till enhet B.
4. På enhet B: öppna länken eller skriv in orden och tryck **Anslut med invite**.

Invite-koden pekar på en tillfällig signaling-post som raderas efter 15 minuter. Den innehåller bara WebRTC-handshaken; ljud och video transporteras fortfarande direkt mellan enheterna. Under **Avancerat** finns den tidigare manuella SDP-växlingen kvar som reserv.

Media går peer-to-peer med WebRTC. STUN används för att upptäcka en direkt nätväg, men ingen ljud- eller videodata skickas via en applikationsserver. I nätverk med strikt NAT/brandvägg kan en TURN-reläserver behövas för att anslutningen ska fungera.

Ljudtröskeln styrs från `Parent` och skickas över en krypterad data channel till `Child`. På child-enheten stängs mikrofonspåret av tills ljudnivån passerar tröskeln.

## Cloudflare Pages

Det här är en statisk app med Pages Functions för `/api/room`.

I Cloudflare Pages build-inställningarna:

- Framework preset: `None`
- Build command: `exit 0`
- Build output directory: `.`
- Root directory: tomt

`wrangler.toml` kopplar Pages Function till KV-bindingen `ROOMS`. KV-namespacen måste finnas i samma Cloudflare-konto som Pages-projektet. Bygg från repots rot; `functions/api/room.js` hanterar POST/GET/PATCH för den kortlivade invite-koden.
