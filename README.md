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

## Kamerki innych graczy się nie pokazują? Dodaj serwer TURN

Wideo idzie bezpośrednio między graczami (WebRTC). Gdy gracze są w różnych sieciach (router, internet mobilny),
połączenie bezpośrednie często się nie udaje – na kafelku pojawia się wtedy „Nie udało się połączyć kamery”.
Rozwiązaniem jest serwer TURN, który przekazuje obraz. Darmowy (1000 GB miesięcznie) daje Cloudflare:

1. Załóż darmowe konto na [dash.cloudflare.com](https://dash.cloudflare.com).
2. W menu wybierz **Realtime → TURN Server → Create** (nazwa dowolna, np. `czolko`).
3. Skopiuj **Turn Token ID** oraz **API Token** (token pokazuje się tylko raz).
4. Na Render.com otwórz swoją usługę → **Environment** → **Add Environment Variable** i dodaj:
   - `CF_TURN_KEY_ID` = Turn Token ID
   - `CF_TURN_API_TOKEN` = API Token
5. Zapisz (**Save, rebuild and deploy**). Po minucie odśwież grę u wszystkich graczy.

Możesz też użyć innego dostawcy TURN – ustaw wtedy zmienne `TURN_URLS` (adresy po przecinku),
`TURN_USERNAME` i `TURN_CREDENTIAL`.

Hasła w kategoriach możesz edytować w pliku `words.js`.
