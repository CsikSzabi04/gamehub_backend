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

let fav = [];
const nextId = 1;

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

let userFavorites = {}; 
let nextIdd = 1; 

function saveFav(req, resp) {
  const { name, userId } = req.body; 
  if (name && userId) {
    const fave = { id: nextIdd, name: name };
    if (!userFavorites[userId]) {
      userFavorites[userId] = [];
    }
    userFavorites[userId].push(fave);
    nextIdd++; 
    resp.send(fave); 
  } else {
    resp.status(400).send({ error: 'Wrong parameters!' }); 
  }
}

function getUserFavs(req, resp) {
  const userId = req.query.userId; 
  if (userFavorites[userId]) {
    resp.send(userFavorites[userId]); 
  } else {
    resp.send([]);
  }
}

function delFav(req, resp){
    if(req.params.id){
        let i = indexOf(req.params.id)
        if(i!=-1){
            const fave = fav.splice(i, 1);
            resp.send(fave[0]);
        } else resp.send( { error: 'No parameters!' } )
    }
}
function indexOf(id){
    let i = 0; while(i<fav.length && fav[i].id != id) i++;
    if(i<fav.length) return i; else return -1
    
}

app.get("/", (req, res) => res.send("<h1>It's all good :)</h1>"));
app.get("/fetch-games", fetchGames);
app.get("/stores", getSores);
app.get("/game", getGames);
app.get("/news", getNews);
app.get("/free", getFree);
app.get("/discounted", getDiscounted);
app.get("/health",(req,res)=>res.status(200).send("Alive"));
app.get("/getFav", getUserFavs);
app.post("/addfav", saveFav);
app.delete("delfav/:id", delFav)

app.listen(PORT, () => {
    console.log(`Server running on port :${PORT}`);
});
