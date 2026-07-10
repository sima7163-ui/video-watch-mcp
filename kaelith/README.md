# Kaelith Vaelor

Appka o drakovi, ktorý si pamätá. Jeden samostatný súbor, žiadny server, žiadny build.

## Ako spustiť

Otvor `index.html` priamo v prehliadači (dvojklik, alebo `open index.html`). Funguje aj offline.

Dáta (denník, štádium rastu, puto) sa ukladajú len lokálne cez `localStorage` — v tom istom prehliadači na tom istom zariadení. Nič sa neposiela nikam von.

## Ako to funguje

- **Denník namiesto XP baru** — každá kŕmka, rituál aj dlhšia neprítomnosť sa zapíše ako veta, nie ako číslo. Puto (`bond`) existuje len interne, v UI sa nikdy nezobrazuje ako pruh ani skóre.
- **Nálady s dôvodom** — odvodené z počtu dní od poslednej starostlivosti a z aktuálnej úrovne puta: Žiarivý / Dôverčivý / Pokojný → Zamyslený → Odmeraný → Zranený. Každá nálada má vlastné vysvetlenie v texte.
- **4 štádiá rastu** — Vajce → Mláďa → Mladý drak → Kaelith v plnej sláve. Prechody neodomykajú počty kŕmení ani čas, ale míľniky puta:
  - vyliahnutie: prvá starostlivosť o vajce,
  - Mláďa → Mladý drak: prvé udobrenie po odmieravosti,
  - Mladý drak → plná sláva: 30 rôznych dní starostlivosti + prvé tajomstvo, ktoré Kaelith prezradí.
- **Rituály** — ranné privítanie a večerné uloženie, každý raz denne, s vlastným textom v denníku.
- **Degradácia s milosťou** — dlhšia neprítomnosť spraví draka odmeraným (nikdy nezomrie, štádium sa nikdy nevráti späť), a stačí sa vrátiť a venovať mu pozornosť, aby sa puto pomaly hojilo.

## Reset

V appke je ikonka ⚙ (nastavenia), odkiaľ sa dá appka vrátiť do úplného začiatku (nové vajce).
