import { describe, test, expect } from "vitest";

const makeRequest = async (url, method = 'GET', body = null) => {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    return await fetch(`http://localhost:88${url}`, options);
};

describe('Basic endpoints', () => {
    test("GET / should return welcome message", async () => {
        const resp = await makeRequest("/");
        const text = await resp.text();
        expect(text).toContain("It's all good");
    });

    test("GET /health should return 'Alive'", async () => { 
        const resp = await makeRequest("/health");
        const text = await resp.text();
        expect(text).toBe("Alive");
    });
});

describe('Favorites functionality', () => {
    const testUserId = "testUser123";
    const testGame = { gameId: "123", name: "Test Game", userId: testUserId };

    test("POST /addfav should add favorite", async () => {
        const resp = await makeRequest("/addfav", 'POST', testGame);
        const json = await resp.json();
        expect(json.gameId).toBe(testGame.gameId);
    });

    test("GET /getFav should return user favorites", async () => {
        const resp = await makeRequest(`/getFav?userId=${testUserId}`);
        const json = await resp.json();
        expect(json).toContainEqual(expect.objectContaining({ gameId: testGame.gameId }));
    });

    test("DELETE /delfav/:gameId should remove favorite", async () => {
        const delResp = await makeRequest(`/delfav/${testGame.gameId}`, 'DELETE', { userId: testUserId });
        expect(delResp.status).toBe(200);

        const getResp = await makeRequest(`/getFav?userId=${testUserId}`);
        const json = await getResp.json();
        expect(json).not.toContainEqual(expect.objectContaining({ gameId: testGame.gameId }));
    });
});

describe('Reviews functionality', () => {
    const testReview = {
        gameId: "456",
        gameName: "Review Game",
        userId: "user789",
        email: "test@example.com",
        reviewText: "Great game!",
        rating: 5
    };

    test("POST /submit-review should save review", async () => {
        const resp = await makeRequest("/submit-review", 'POST', testReview);
        const json = await resp.json();
        expect(json).toHaveProperty('id');
        expect(json.gameId).toBe(testReview.gameId);
    });

    test("GET /get-all-reviews should return all reviews", async () => {
        const resp = await makeRequest("/get-all-reviews");
        const json = await resp.json();
        expect(json).toContainEqual(expect.objectContaining({
            gameId: testReview.gameId,
            review: testReview.reviewText
        }));
    });
});

describe('API proxy endpoints', () => {
    test("GET /fetch-games should return games", async () => {
        const resp = await makeRequest("/fetch-games");
        const json = await resp.json();
        expect(json).toHaveProperty('games');
    });

    test("GET /game should return game search results", async () => {
        const resp = await makeRequest("/game?title=elden");
        const json = await resp.json();
        expect(json.length).toBeGreaterThan(0);
    });

    test("GET /news should return news", async () => {
        const resp = await makeRequest("/news");
        const json = await resp.json();
        expect(json).toBeTruthy();
    });
});