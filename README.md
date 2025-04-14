https://gamehub-backend-zekj.onrender.com/

---

## Fő funkciók

- A szerver többféle adatot gyűjt és szolgáltat, például:

- Játéklista RAWG API-ból

- Játékboltok listája (CheapShark API)

- Ingyenes játékok, akciós játékok, loot ajánlatok

- MMO játékok hírei és gaming hírek (RapidAPI és NewsAPI)

- Élő e-sport meccsek

- Kedvenc játékok mentése/fogadása törlése

- Játékhoz írt értékelések mentése és lekérdezése


## API végpontok (route-ok)

- **HTTP Módszer	Útvonal	Leírás**
- **GET	/fetch-games**	Lekéri a legnépszerűbb játékokat a RAWG API-ból

- **GET	/stores**	Visszaadja az elérhető digitális boltokat (CheapShark)

- **GET	/game?title=...**	Konkrét játék keresése cím alapján

- **GET	/news**	MMO játékok hírei (RapidAPI)

- **GET	/free	Ingyenes** játékok listája

- **GET	/loot	Ingyenes** loot ajánlatok (pl. Epic, Steam)

- **GET	/discounted**	Akciós/ingyenes játékok Epic Games-en

- **GET	/getlive**	Élő e-sport meccsek lekérdezése

- **GET	/getgamingnews**	Gaming tematikájú hírek (NewsAPI)

- **GET	/getFav?userId=...**	Felhasználó kedvencei

- **POST	/addfav**	Kedvenc játék hozzáadása { userId, name, gameId }

- **DELETE	/delfav/:gameId**	Kedvenc eltávolítása adott gameId alapján

- **POST	/submit-review**	Játékhoz tartozó értékelés mentése

- **GET	/get-all-reviews**	Minden értékelés lekérdezése

- **GET	/health**	Egyszerű elérhetőségi teszt (Alive)


---

## Adatok kezelése

- A kedvenceket és értékeléseket szerver memóriában (favourite, reviewsData) tárolja, tehát újraindítás után ezek elvesznek, hacsak nincs külső adatbázis.

- A nextReviewId egyedi ID-ket generál az értékelésekhez.

---

## API kulcsok

Több külső API-hoz használ kulcsokat (RAWG, RapidAPI, NewsAPI). Ezekkel lehet elérni a különböző szolgáltatásokat. Fontos, hogy ezek titkosan legyenek kezelve éles környezetben (ne hardcode-olva).

---

## Tesztelés

## Főbb funkciók
- Játékadatok kezelése
- Digitális játékboltok listázása
- Ingyenes játékok és akciók nyomon követése
- Játékhírek gyűjtése
- eSport meccsek adatai
- Felhasználói kedvencek kezelése
- Játékértékelések kezelése

## API Végpontok

### Játékadatok
| Végpont | Metódus | Leírás |
|---------|---------|--------|
| `/fetch-games` | GET | Legnépszerűbb játékok lekérése |
| `/game?title={cím}` | GET | Játék keresése cím alapján |

### Boltok és akciók
| `/stores` | GET | Digitális játékboltok listája |
| `/free` | GET | Ingyenes játékok listája |
| `/discounted` | GET | Akciós játékok listája |

### Felhasználói funkciók
| `/getFav?userId={azonosító}` | GET | Felhasználó kedvenceinek lekérése |
| `/addfav` | POST | Játék hozzáadása a kedvencekhez |
| `/delfav/{játékAzonosító}` | DELETE | Játék eltávolítása a kedvencekből |

### Értékelések
| `/submit-review` | POST | Játékértékelés beküldése |
| `/get-all-reviews` | GET | Összes értékelés lekérése |

## Adatkezelés
- Kedvencek és értékelések a szerver memóriájában tárolva (ideiglenes)
- Külső API-k használata játékadatokhoz és hírekhez
- API kulcsok szükségesek külső szolgáltatásokhoz

## Fejlesztési környezet
- Node.js + Express
- node-fetch API kérésekhez
- CORS middleware

---
![image](https://github.com/user-attachments/assets/b8c08b89-6683-473d-9388-f027a11755b3)
---
---

## Backend Fejlesztési Eszközök

- express – Webszerver keretrendszer

- node-fetch – Külső API-k eléréséhez

- cors – Kereszt-domain kérések engedélyezéséhez (pl. frontendről)
