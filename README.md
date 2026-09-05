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
2. På enhet A: tryck **Skapa en inbjudan**, kopiera koden och skicka den till enhet B.
3. På enhet B: klistra in koden och tryck **Acceptera kod**. Skicka sedan svarskoden tillbaka till enhet A.
4. På enhet A: klistra in svarskoden och tryck **Acceptera kod**.

Media går peer-to-peer med WebRTC. STUN används för att upptäcka en direkt nätväg, men ingen ljud- eller videodata skickas via en applikationsserver. I nätverk med strikt NAT/brandvägg kan en TURN-reläserver behövas för att anslutningen ska fungera.

Ljudtröskeln styrs från `Parent` och skickas över en krypterad data channel till `Child`. På child-enheten stängs mikrofonspåret av tills ljudnivån passerar tröskeln.
