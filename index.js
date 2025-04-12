import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 88;
const API_URL = "https://api.rawg.io/api/games";
const API_KEY = "984255fceb114b05b5e746dc24a8520a"; //https://rawg.io/@csszabj04/apikey

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
    const url = 'https://mmo-games.p.rapidapi.com/games';
    const options = {
        method: 'GET',
        headers: {
            'x-rapidapi-key': 'b05744bab0mshe91c13f2d427740p11f35djsnacb7b089052e',
            'x-rapidapi-host': 'mmo-games.p.rapidapi.com'
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


async function getLive(req, res) {
    const url = 'https://allsportsapi2.p.rapidapi.com/api/esport/matches/live';
    const options = {
        method: 'GET',
        headers: {
            'x-rapidapi-key': 'b05744bab0mshe91c13f2d427740p11f35djsnacb7b089052e',
            'x-rapidapi-host': 'allsportsapi2.p.rapidapi.com'
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

async function getLoot(req, res) {
    const url = 'https://gamerpower.p.rapidapi.com/api/filter?platform=epic-games-store.steam.android&type=game.loot';
    const options = {
        method: 'GET',
        headers: {
            'x-rapidapi-key': 'b05744bab0mshe91c13f2d427740p11f35djsnacb7b089052e',
            'x-rapidapi-host': 'gamerpower.p.rapidapi.com'
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

function getUserFavs(req, resp) {
    const userId = req.query.userId;
    if (favourite[userId]) {
        resp.send(favourite[userId]);
    } else {
        resp.send([]);
    }
}

let favourite={}
function saveFav(req, resp) {
    const { name, userId,gameId } = req.body;
    if (name && userId && gameId) {
        const fave = { gameId:gameId , name: name };
        if (!favourite[userId]) {
            favourite[userId] = [];
        }
        favourite[userId].push(fave);
        resp.send(fave);
    } else {
        resp.status(400).send({ error: 'Wrong parameters!' });
    }
}

function delFav(req, resp) {
    if (req.params.gameId && req.body.userId) {
        let i = indexOf(req.params.gameId,req.body.userId)    
            if(i != -1){
                favourite[req.body.userId].splice(i,1)
                resp.send("OK")
            }else resp.send({ error: 'No avaible ID!' })
    }else resp.status(400).send({error:"Missing paramters!"})
}

function indexOf(id,userId) {
   let i = 0; while (i < favourite[userId].length && favourite[userId][i].gameId != id) i++;
   if (i < favourite[userId].length) return i; else return -1
}

async function getGaminNews(req, resp) {
    try {
        const response = await fetch("https://newsapi.org/v2/everything?q=Gaming&apiKey=58cd8c33334d4de7a425f8a1c08a3a35");
        const data = await response.json();
        resp.json(data);
    } catch (error) {
        resp.status(500).json({ error: error.message });
    }
}

let reviewsData = {}; let nextReviewId = 1;

function saveReview(req, resp) {
    const { gameId, userId, email, reviewText, rating, gameName } = req.body;
    const newReview = {
        id: nextReviewId,
        gameId,
        gameName, 
        userId,
        email,
        review: reviewText,
        rating,
        createdAt: new Date(),
    };
    if (!reviewsData[gameId]) {reviewsData[gameId] = [];}
    reviewsData[gameId].push(newReview);
    nextReviewId++;
    resp.send(newReview);
}

function getAllReviews(req, resp) {
    let allReviews = [];
    for (let gameId in reviewsData) {
        allReviews = allReviews.concat(reviewsData[gameId]);
    }
    resp.json(allReviews);  
}

app.get("/", (req, res) => res.send("<h1>It's all good :)</h1>"));
app.get("/health", (req, res) => res.status(200).send("Alive"));
app.get('/get-all-reviews', getAllReviews); 
app.get("/getgamingnews", getGaminNews);
app.get("/discounted", getDiscounted);
app.get("/fetch-games", fetchGames);
app.get("/getFav", getUserFavs);
app.get("/stores", getSores);
app.get("/getlive", getLive);
app.get("/game", getGames);
app.get("/news", getNews);
app.get("/free", getFree);
app.get("/loot", getLoot);

app.post('/submit-review', saveReview);
app.delete("/delfav/:gameId", delFav);
app.post("/addfav", saveFav);

app.listen(PORT, () => {
    console.log(`Server running on port :${PORT}`);
});
