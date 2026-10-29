const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3').verbose();
const createPokerService = require('./poker-server');

function firebaseToken(uid, privateKey){
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', kid: 'poker-test-key' });
    const payload = encode({
        aud: 'mesnapdata',
        iss: 'https://securetoken.google.com/mesnapdata',
        sub: uid,
        iat: now,
        exp: now + 3600,
        auth_time: now
    });
    const signed = `${header}.${payload}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
    return `${signed}.${signature}`;
}

function deckCards(){
    const suits = ['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'JACK', 'QUEEN', 'KING', 'ACE'];
    return suits.flatMap(suit => ranks.map((value, index) => ({
        code: `${index}-${suit}`,
        value,
        suit,
        image: `https://deckofcardsapi.com/static/img/${index}-${suit}.png`
    })));
}

test('authenticated poker tables persist state, enforce turns, and conceal opponent cards', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'poker-test-key' };
    const originalFetch = global.fetch;
    const accounts = new Map();
    const accountVersions = new Map();
    global.fetch = async (url, options) => {
        if (String(url).includes('securetoken@system.gserviceaccount.com')) {
            return new Response(JSON.stringify({ keys: [jwk] }), {
                status: 200,
                headers: { 'cache-control': 'max-age=3600', 'content-type': 'application/json' }
            });
        }
        if (String(url).includes('mesnapdata-default-rtdb.firebaseio.com/users/')) {
            const userId = new URL(String(url)).pathname.split('/').filter(Boolean).at(-1).replace(/\.json$/, '');
            const version = accountVersions.get(userId) || 0;
            if (!accounts.has(userId)) accounts.set(userId, { chips: 1000 });
            if (options && options.method === 'PUT') {
                if (options.headers['If-Match'] !== `"${version}"`) {
                    return new Response('null', { status: 412 });
                }
                accounts.set(userId, JSON.parse(options.body));
                accountVersions.set(userId, version + 1);
                return Response.json(accounts.get(userId));
            }
            return new Response(JSON.stringify(accounts.get(userId)), {
                status: 200,
                headers: { etag: `"${version}"` }
            });
        }
        if (String(url).endsWith('/new/shuffle/?deck_count=1')) {
            return new Response(JSON.stringify({ deck_id: 'poker-test-deck' }), { status: 200 });
        }
        if (String(url).endsWith('/poker-test-deck/draw/?count=52')) {
            return new Response(JSON.stringify({ cards: deckCards() }), { status: 200 });
        }
        return originalFetch(url, options);
    };

    const app = express();
    app.use(express.json());
    const db = new sqlite3.Database(':memory:');
    const io = {
        on() {},
        in() { return { fetchSockets: async () => [] }; }
    };
    const stopPoker = createPokerService({ app, io, db });
    const server = http.createServer(app);

    try {
        await new Promise(resolve => server.listen(0, resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const tokens = {
            host: firebaseToken('poker-host', privateKey),
            guest: firebaseToken('poker-guest', privateKey),
            observer: firebaseToken('poker-observer', privateKey),
            outsider: firebaseToken('poker-outsider', privateKey)
        };
        accounts.set('poker-observer', {
            chips: 1000,
            activeChipGame: { type: 'blackjack', gameId: 'active-blackjack' }
        });
        async function request(uid, path, method = 'GET', body){
            const response = await fetch(baseUrl + path, {
                method,
                headers: {
                    Authorization: `Bearer ${tokens[uid]}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            const text = await response.text();
            let parsed;
            try { parsed = JSON.parse(text); }
            catch { throw new Error(`Poker API returned non-JSON (${response.status}): ${text.slice(0, 300)}`); }
            return { status: response.status, body: parsed };
        }

        assert.equal((await fetch(baseUrl + '/api/poker/games/missing')).status, 401);
        const blockedByBlackjack = await request('observer', '/api/poker/games', 'POST', {
            maxPlayers: 2, maxBuyIn: 100, buyIn: 100, smallBlind: 5, bigBlind: 10
        });
        assert.equal(blockedByBlackjack.status, 400);
        assert.equal(accounts.get('poker-observer').chips, 1000);
        const insufficientBuyIn = await request('outsider', '/api/poker/games', 'POST', {
            maxPlayers: 2, maxBuyIn: 2000, buyIn: 1200, smallBlind: 5, bigBlind: 10
        });
        assert.equal(insufficientBuyIn.status, 400);
        assert.equal(accounts.get('poker-outsider').chips, 1000);
        const created = await request('host', '/api/poker/games', 'POST', {
            name: 'Test Table',
            maxPlayers: 2,
            maxBuyIn: 100,
            buyIn: 100,
            smallBlind: 5,
            bigBlind: 10,
            allowedPlayers: ['poker-guest', 'poker-observer'],
            username: 'Host'
        });
        assert.equal(created.status, 201);
        const gameId = created.body.id;
        assert.equal(created.body.players['poker-host'].stack, 100);
        assert.equal(accounts.get('poker-host').chips, 900);
        assert.deepEqual(accounts.get('poker-host').activeChipGame, { type: 'poker', gameId, buyIn: 100 });
        assert.equal((await request('host', '/api/poker/games', 'POST', {
            maxPlayers: 2, maxBuyIn: 100, buyIn: 100, smallBlind: 5, bigBlind: 10
        })).status, 400);
        assert.equal((await request('outsider', `/api/poker/games/${gameId}`)).status, 404);

        const joined = await request('guest', `/api/poker/games/${gameId}/join`, 'POST', { username: 'Guest', buyIn: 100 });
        assert.equal(joined.status, 200);
        assert.equal(accounts.get('poker-guest').chips, 900);
        assert.equal((await request('observer', `/api/poker/games/${gameId}/join`, 'POST', { username: 'Observer', buyIn: 100 })).status, 400);
        const started = await request('host', `/api/poker/games/${gameId}/start`, 'POST', {});
        assert.equal(started.status, 200);
        assert.equal(started.body.status, 'playing');
        assert.equal(started.body.currentTurn, 'poker-host');
        assert.equal(started.body.players['poker-host'].holeCards.length, 2);
        assert.deepEqual(started.body.players['poker-guest'].holeCards, []);
        assert.equal(JSON.stringify(started.body).includes('deckCards'), false);

        assert.equal((await request('guest', `/api/poker/games/${gameId}/action`, 'POST', { action: 'check' })).status, 400);
        const called = await request('host', `/api/poker/games/${gameId}/action`, 'POST', { action: 'call' });
        assert.equal(called.status, 200);
        assert.equal(called.body.currentTurn, 'poker-guest');
        const flop = await request('guest', `/api/poker/games/${gameId}/action`, 'POST', { action: 'check' });
        assert.equal(flop.status, 200, JSON.stringify(flop.body));
        assert.equal(flop.body.round, 'flop');
        assert.equal(flop.body.communityCards.length, 3);

        let state = flop.body;
        for (let round = 0; round < 6 && state.status === 'playing'; round++) {
            const uid = state.currentTurn === 'poker-host' ? 'host' : 'guest';
            const acted = await request(uid, `/api/poker/games/${gameId}/action`, 'POST', { action: 'check' });
            assert.equal(acted.status, 200);
            state = acted.body;
        }
        assert.equal(state.status, 'finished');
        assert.equal(state.communityCards.length, 5);
        const observerFirst = await request('observer', `/api/poker/games/${gameId}`);
        assert.equal(observerFirst.body.revealedPlayers.length, 1);
        const firstRevealed = observerFirst.body.revealedPlayers[0];
        const secondHidden = firstRevealed === 'poker-host' ? 'poker-guest' : 'poker-host';
        assert.equal(observerFirst.body.players[firstRevealed].holeCards.length, 2);
        assert.deepEqual(observerFirst.body.players[secondHidden].holeCards, []);

        await new Promise(resolve => setTimeout(resolve, 800));
        const observerFinal = await request('observer', `/api/poker/games/${gameId}`);
        assert.equal(observerFinal.body.revealedPlayers.length, 2);
        assert.equal(observerFinal.body.players['poker-host'].holeCards.length, 2);
        assert.equal(observerFinal.body.players['poker-guest'].holeCards.length, 2);
        if (observerFinal.body.handResult.winners.length === 1) {
            const loserId = observerFinal.body.handResult.winners[0] === 'poker-host' ? 'poker-guest' : 'poker-host';
            const loserAuth = loserId === 'poker-host' ? 'host' : 'guest';
            assert.equal((await request(loserAuth, `/api/poker/games/${gameId}/muck`, 'POST', {})).status, 200);
            const afterMuck = await request('observer', `/api/poker/games/${gameId}`);
            assert.deepEqual(afterMuck.body.players[loserId].holeCards, []);
            assert.equal((await request(loserAuth, `/api/poker/games/${gameId}`)).body.players[loserId].holeCards.length, 2);
        }
        assert.equal((await request('host', `/api/poker/games/${gameId}/leave`, 'POST', {})).status, 200);
        assert.equal((await request('guest', `/api/poker/games/${gameId}/leave`, 'POST', {})).status, 200);
        assert.equal(accounts.get('poker-host').activeChipGame, undefined);
        assert.equal(accounts.get('poker-guest').activeChipGame, undefined);
        assert.equal(accounts.get('poker-host').chips + accounts.get('poker-guest').chips, 2000);
    } finally {
        stopPoker();
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => db.close(resolve));
        global.fetch = originalFetch;
    }
});
