import express from "express";
import fs from "fs";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = 88;
const API_URL = "https://api.rawg.io/api/games";
const API_KEY = "984255fceb114b05b5e746dc24a8520a";
const DATA_FILE = "games.json";

app.use(cors());
app.use(express.json());

// Fetch games from API and save them
app.get("/fetch-games", async (req, res) => {
    try {
        const response = await fetch(`${API_URL}?key=${API_KEY}&page_size=20`);
        if (!response.ok) throw new Error("Failed to fetch games");

        const data = await response.json();
        fs.writeFileSync(DATA_FILE, JSON.stringify(data.results, null, 2));
        res.json({ message: "Games saved successfully", games: data.results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get saved games
app.get("/games", (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
        const games = JSON.parse(fs.readFileSync(DATA_FILE));
        res.json(games);
    } else {
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
