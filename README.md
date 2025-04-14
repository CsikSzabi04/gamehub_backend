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

---
![image](https://github.com/user-attachments/assets/b8c08b89-6683-473d-9388-f027a11755b3)
---

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

## Backend Fejlesztési Eszközök

- express – Webszerver keretrendszer

- node-fetch – Külső API-k eléréséhez

- cors – Kereszt-domain kérések engedélyezéséhez (pl. frontendről)
