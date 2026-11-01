# Czółko online 🤔

Gra w przeglądarce z kamerkami: każdy gracz ma pod swoją kamerką hasło, które widzą wszyscy oprócz niego.
W swojej turze zadaje pytania na tak/nie, a inni odpowiadają na głos.

## Uruchomienie lokalnie

Wymagany Node.js 18+.

```bash
npm install
npm start
```

Otwórz `http://localhost:3000`. Na `localhost` kamera działa bez HTTPS.

## Granie ze znajomymi przez internet

Przeglądarki dają dostęp do kamery tylko na stronach **HTTPS**, więc serwer trzeba wystawić pod adresem https.

### Szybko: ngrok
1. Uruchom grę (`npm start`).
2. W drugim terminalu: `ngrok http 3000`
3. Wyślij znajomym adres `https://….ngrok-free.app` (albo przycisk „Kopiuj link” w pokoju).

### Na stałe: Render.com (darmowy plan)
1. Wrzuć ten folder do repozytorium na GitHubie.
2. Na render.com: **New → Web Service**, wybierz repozytorium.
3. Build command: `npm install`, Start command: `npm start`.
4. Gotowe – Render da adres https.

## Zasady

1. Host tworzy pokój i wysyła kod/link. Gra obsługuje 2–8 graczy.
2. Host wybiera tryb:
   - **Losowe z kategorii** – zaznacza kategorie, gra losuje hasła.
   - **Własne hasła** – każdy wpisuje 10 haseł; trafiają one do innych graczy, nigdy do autora.
3. Host wybiera, co się dzieje po zgadnięciu: gracz kończy (ranking wg kolejności) albo dostaje nowe hasło (ranking wg punktów), oraz opcjonalny limit czasu tury.
4. Gracz, którego kamerka jest podświetlona, zadaje pytania. Pasuje przyciskiem „Następny gracz”.
5. Gdy ktoś zgadnie, inny gracz klika **„Zgadł!”** pod jego kamerką.

Swojego hasła nie da się podejrzeć – serwer w ogóle go nie wysyła do Twojej przeglądarki.

## Problemy z obrazem

Wideo idzie bezpośrednio między graczami (WebRTC). W niektórych sieciach (np. firmowych, część sieci komórkowych)
połączenie może się nie udać – wtedy trzeba dodać serwer TURN w `public/client.js` (`ICE_SERVERS`),
np. darmowy z metered.ca.

Hasła w kategoriach możesz edytować w pliku `words.js`.
