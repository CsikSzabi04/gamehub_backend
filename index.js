import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());


const PORT = 88;
const API_URL = "https://api.rawg.io/api/games";
const API_KEY = "984255fceb114b05b5e746dc24a8520a"; //https://rawg.io/@csszabj04/apikey
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


async function getNews(req, res) {
    const url = 'https://epic-games-store.p.rapidapi.com/getNews/locale/en/limit/30';
    const options = {
        method: 'GET',
        headers: {
            'x-rapidapi-key': 'b05744bab0mshe91c13f2d427740p11f35djsnacb7b089052e',
            'x-rapidapi-host': 'epic-games-store.p.rapidapi.com'
        }
    };
    try {
        const response = await fetch(url, options);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error(error);
    }
}

async function getDiscounted(req, res) {
    try {
        const response = await fetch("https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function getFree(req, res) {
    const url = 'https://free-to-play-games-database.p.rapidapi.com/api/games';
    const options = {
        method: 'GET',
        headers: {
            'x-rapidapi-key': 'b05744bab0mshe91c13f2d427740p11f35djsnacb7b089052e',
            'x-rapidapi-host': 'free-to-play-games-database.p.rapidapi.com'
        }
    };

    try {
        const response = await fetch(url, options);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error(error);
    }
}


app.get("/", (req, res) => res.send("<h1>It's all good :)</h1>"));
app.get("/fetch-games", fetchGames);
app.get("/stores", getSores);
app.get("/game", getGames);
app.get("/news", getNews);
app.get("/free", getFree);
app.get("/discounted", getDiscounted);


app.listen(PORT, () => {
    console.log(`Server running on port :${PORT}`);
});
