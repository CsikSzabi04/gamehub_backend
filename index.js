import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());


const PORT = 88;
const API_URL = "https://api.rawg.io/api/games";
const API_KEY = "984255fceb114b05b5e746dc24a8520a";
const DATA_FILE = "games.json";

async function fetchGames(req, res) {
    try {
        const response = await fetch(`${API_URL}?key=${API_KEY}`);
        const data = await response.json();
        res.json({ games: data.results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function getSores(req, res) {
    try {
        const response = await fetch("https://www.cheapshark.com/api/1.0/stores");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function getGames(req, res) {
    try {
        const response = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${req.query.title}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function getFreeGames(req, res) {
    try {
        const response = await fetch("https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}



app.get("/fetch-games", fetchGames);
app.get("/stores", getSores);
app.get("/game", getGames);
app.get("/freegames", getFreeGames);

app.listen(PORT, () => {
    console.log(`Server running on port :${PORT}`);
});
