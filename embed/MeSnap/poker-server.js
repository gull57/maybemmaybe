const crypto = require('crypto');
const Poker = require('./poker-engine');

const PROJECT_ID = 'mesnapdata';
const DECK_API = 'https://deckofcardsapi.com/api/deck';
const TURN_MS = 30_000;
const MAX_PLAYERS = 9;
const MIN_PLAYERS = 2;
const certCache = { expiresAt: 0, keys: null };

function decodeBase64Url(value) {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function getFirebaseSigningKeys() {
    if (certCache.keys && certCache.expiresAt > Date.now()) return certCache.keys;
    const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error('Unable to verify Firebase authentication.');
    const body = await response.json();
    const cacheControl = response.headers.get('cache-control') || '';
    const maxAge = Number((cacheControl.match(/max-age=(\d+)/) || [])[1] || 3600);
    certCache.keys = new Map((body.keys || []).map(key => [key.kid, key]));
    certCache.expiresAt = Date.now() + maxAge * 1000;
    return certCache.keys;
}

async function verifyFirebaseToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
        const payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
        const keys = await getFirebaseSigningKeys();
        const jwk = keys.get(header.kid);
        if (!jwk) return null;
        const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
        const signature = decodeBase64Url(parts[2]);
        const valid = crypto.verify('RSA-SHA256', signed, publicKey, signature);
        const now = Math.floor(Date.now() / 1000);
        if (!valid ||
            payload.aud !== PROJECT_ID ||
            payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
            typeof payload.sub !== 'string' ||
            !payload.sub ||
            payload.sub.length > 128 ||
            !Number.isFinite(payload.exp) ||
            payload.exp <= now ||
            !Number.isFinite(payload.iat) ||
            payload.iat > now ||
            !Number.isFinite(payload.auth_time) ||
            payload.auth_time > now) return null;
        return { uid: payload.sub, payload };
    } catch (error) {
        if (error.message && error.message.includes('verify Firebase')) throw error;
        return null;
    }
}

function readBearerToken(req) {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match && match[1];
}

function authMiddleware(req, res, next) {
    const token = readBearerToken(req);
    verifyFirebaseToken(token).then(user => {
        if (!user) return res.status(401).json({ error: 'Sign in to play poker.' });
        req.pokerUser = { ...user, token };
        next();
    }).catch(error => {
        console.error('Poker authentication failed:', error);
        res.status(503).json({ error: 'Poker authentication is temporarily unavailable.' });
    });
}

function createPokerService({ app, io, db }) {
    const locks = new Map();
    const timers = new Map();
    const nextHandTimers = new Map();
    const showdownTimers = new Map();

    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });

    async function updateFirebaseAccount(uid, token, update) {
        const accountUrl = `https://${PROJECT_ID}-default-rtdb.firebaseio.com/users/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(token)}`;
        for (let attempt = 0; attempt < 6; attempt++) {
            let response;
            try {
                response = await fetch(accountUrl, { headers: { 'X-Firebase-ETag': 'true' } });
            } catch {
                const error = new Error('Could not reach your chip account. Please try again.');
                error.status = 503;
                throw error;
            }
            if (!response.ok) {
                const error = new Error('Could not access your chip account. Please sign in again.');
                error.status = response.status === 401 || response.status === 403 ? 401 : 503;
                throw error;
            }
            const etag = response.headers.get('etag');
            if (!etag) {
                const error = new Error('Could not safely update your chip account.');
                error.status = 503;
                throw error;
            }
            const stored = await response.json();
            const account = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
            const nextAccount = update({ ...account });
            if (!nextAccount) return null;
            let write;
            try {
                write = await fetch(accountUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
                    body: JSON.stringify(nextAccount)
                });
            } catch {
                const error = new Error('Could not reach your chip account. Please try again.');
                error.status = 503;
                throw error;
            }
            if (write.status === 412) continue;
            if (!write.ok) {
                const error = new Error('Could not update your chip account. Please try again.');
                error.status = write.status === 401 || write.status === 403 ? 401 : 503;
                throw error;
            }
            return await write.json();
        }
        const error = new Error('Your chip account changed repeatedly. Please try again.');
        error.status = 409;
        throw error;
    }

    async function reservePokerBuyIn(uid, token, gameId, amount) {
        let failure = '';
        const account = await updateFirebaseAccount(uid, token, current => {
            const active = current.activeChipGame;
            if (active) {
                failure = active.type === 'blackjack'
                    ? 'Finish your Blackjack game before joining Poker.'
                    : 'You are already in a chip game. Leave it before joining another.';
                return null;
            }
            const chips = current.chips == null ? 1000 : Number(current.chips);
            if (!Number.isSafeInteger(chips) || chips < 0 || amount > chips) {
                failure = 'Not enough chips for this buy-in. Ask the app owner for more chips.';
                return null;
            }
            current.chips = chips - amount;
            current.activeChipGame = { type: 'poker', gameId, buyIn: amount };
            return current;
        });
        if (!account) {
            const error = new Error(failure || 'Could not reserve your buy-in.');
            error.status = 400;
            throw error;
        }
    }

    async function cashOutPoker(uid, token, gameId, amount) {
        let failure = '';
        const account = await updateFirebaseAccount(uid, token, current => {
            const active = current.activeChipGame;
            if (!active || active.type !== 'poker' || active.gameId !== gameId) {
                failure = 'Your Poker chip reservation is no longer active.';
                return null;
            }
            const chips = current.chips == null ? 0 : Number(current.chips);
            if (!Number.isSafeInteger(chips) || chips < 0 || !Number.isSafeInteger(amount) || amount < 0) {
                failure = 'Your Poker chip balance could not be safely returned.';
                return null;
            }
            current.chips = chips + amount;
            delete current.activeChipGame;
            return current;
        });
        if (!account) {
            const error = new Error(failure || 'Could not return your Poker chips.');
            error.status = 409;
            throw error;
        }
    }

    async function preparePokerCashOut(uid, token, gameId, amount) {
        let failure = '';
        const account = await updateFirebaseAccount(uid, token, current => {
            const active = current.activeChipGame;
            if (!active || active.type !== 'poker' || active.gameId !== gameId) {
                failure = 'Your Poker chip reservation is no longer active.';
                return null;
            }
            if (active.cashOutPending != null) {
                if (active.cashOutPending !== amount) {
                    failure = 'A different Poker cash-out is already pending.';
                    return null;
                }
                return current;
            }
            const chips = current.chips == null ? 0 : Number(current.chips);
            if (!Number.isSafeInteger(chips) || chips < 0 || !Number.isSafeInteger(amount) || amount < 0) {
                failure = 'Your Poker chip balance could not be safely returned.';
                return null;
            }
            current.chips = chips + amount;
            current.activeChipGame = { ...active, cashOutPending: amount };
            return current;
        });
        if (!account) {
            const error = new Error(failure || 'Could not prepare your Poker cash-out.');
            error.status = 409;
            throw error;
        }
    }

    async function finishPokerCashOut(uid, token, gameId) {
        let failure = '';
        const account = await updateFirebaseAccount(uid, token, current => {
            const active = current.activeChipGame;
            if (!active) return current;
            if (active.type !== 'poker' || active.gameId !== gameId || !Number.isSafeInteger(active.cashOutPending)) {
                failure = 'Your Poker cash-out cannot be completed yet.';
                return null;
            }
            delete current.activeChipGame;
            return current;
        });
        if (!account) {
            const error = new Error(failure || 'Could not complete your Poker cash-out.');
            error.status = 409;
            throw error;
        }
    }

    const storageReady = run(`CREATE TABLE IF NOT EXISTS poker_tables (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`).catch(error => {
        console.error('Could not create poker table storage:', error);
        throw error;
    });

    function withLock(id, operation) {
        const previous = locks.get(id) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        locks.set(id, current);
        return current.finally(() => {
            if (locks.get(id) === current) locks.delete(id);
        });
    }

    async function loadGame(id) {
        await storageReady;
        const row = await get('SELECT state_json FROM poker_tables WHERE id = ?', [id]);
        return row ? JSON.parse(row.state_json) : null;
    }

    async function saveGame(game) {
        await storageReady;
        game.updatedAt = Date.now();
        await run(
            'INSERT INTO poker_tables (id, host_id, status, state_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, status = excluded.status, state_json = excluded.state_json, updated_at = excluded.updated_at',
            [game.id, game.hostId, game.status, JSON.stringify(game), game.updatedAt]
        );
    }

    function publicGame(game, uid) {
        const players = {};
        Object.entries(game.players).forEach(([id, player]) => {
            const visible = id === uid || (
                ['finished', 'complete'].includes(game.status) &&
                (game.revealedPlayers || []).includes(id) &&
                !((game.mucked || {})[id]) &&
                !player.folded &&
                game.handResult &&
                game.handResult.hands
            );
            players[id] = {
                id,
                username: player.username,
                avatar: player.avatar || '',
                seat: player.seat,
                stack: player.stack,
                status: player.status,
                folded: Boolean(player.folded),
                allIn: Boolean(player.allIn),
                sittingOut: Boolean(player.sittingOut),
                streetContribution: player.streetContribution || 0,
                contribution: player.contribution || 0,
                canRaise: (game.raiseRights || []).includes(id),
                mucked: Boolean((game.mucked || {})[id]),
                holeCards: visible ? player.holeCards || [] : []
            };
        });
        return {
            id: game.id,
            name: game.name,
            hostId: game.hostId,
            allowedPlayers: game.allowedPlayers,
            maxPlayers: game.maxPlayers,
            startingStack: game.startingStack,
            smallBlind: game.smallBlind,
            bigBlind: game.bigBlind,
            status: game.status,
            players,
            seats: game.seats,
            dealerIndex: game.dealerIndex,
            smallBlindId: game.smallBlindId,
            bigBlindId: game.bigBlindId,
            currentTurn: game.currentTurn,
            turnDeadline: game.turnDeadline,
            round: game.round,
            communityCards: game.communityCards,
            currentBet: game.currentBet,
            minRaise: game.minRaise,
            pot: Object.values(game.players).reduce((sum, player) => sum + Number(player.contribution || 0), 0),
            pots: (game.handResult && game.handResult.pots || Poker.buildSidePots(Object.values(game.players)))
                .map(pot => ({
                    amount: pot.amount,
                    eligible: pot.eligible,
                    contributors: pot.contributors,
                    winners: pot.winners || [],
                    handName: pot.handName || null
                })),
            actionHistory: game.actionHistory || [],
            handResult: game.handResult || null,
            handNumber: game.handNumber || 0,
            revealedPlayers: game.revealedPlayers || [],
            createdAt: game.createdAt,
            updatedAt: game.updatedAt,
            message: game.message || ''
        };
    }

    async function publish(game) {
        const sockets = await io.in(`poker:${game.id}`).fetchSockets();
        for (const socket of sockets) {
            if (socket.data.pokerUid) socket.emit('poker:state', publicGame(game, socket.data.pokerUid));
        }
    }

    function clearTimer(id) {
        if (timers.has(id)) clearTimeout(timers.get(id));
        timers.delete(id);
    }

    function clearNextHandTimer(id) {
        if (nextHandTimers.has(id)) clearTimeout(nextHandTimers.get(id));
        nextHandTimers.delete(id);
    }

    function clearShowdownTimer(id) {
        if (showdownTimers.has(id)) clearTimeout(showdownTimers.get(id));
        showdownTimers.delete(id);
    }

    function showdownOrder(game) {
        const eligible = new Set(activePlayers(game).map(player => player.id));
        const finalRoundAggressor = [...game.actionHistory].reverse().find(action =>
            action.round === game.round &&
            eligible.has(action.playerId) &&
            ['bet', 'raise', 'short all-in'].includes(action.action)
        );
        const firstId = finalRoundAggressor && finalRoundAggressor.playerId;
        const firstIndex = firstId ? game.seats.indexOf(firstId) : game.dealerIndex;
        const ordered = firstId ? [firstId] : [];
        for (let offset = 1; offset <= game.seats.length; offset++) {
            const index = (firstIndex + offset + game.seats.length) % game.seats.length;
            const id = game.seats[index];
            if (eligible.has(id) && !ordered.includes(id)) ordered.push(id);
        }
        return ordered;
    }

    function scheduleShowdownReveal(game) {
        clearShowdownTimer(game.id);
        if (!game.showdownOrder || !game.showdownOrder.length) return;
        const nextId = game.showdownOrder.find(id =>
            !(game.revealedPlayers || []).includes(id) && !((game.mucked || {})[id])
        );
        if (!nextId) return;
        showdownTimers.set(game.id, setTimeout(() => {
            withLock(game.id, async () => {
                const current = await loadGame(game.id);
                if (!current || !['finished', 'complete'].includes(current.status)) return;
                const revealId = current.showdownOrder.find(id =>
                    !(current.revealedPlayers || []).includes(id) && !((current.mucked || {})[id])
                );
                if (!revealId) return;
                current.revealedPlayers = [...(current.revealedPlayers || []), revealId];
                await saveGame(current);
                await publish(current);
                scheduleShowdownReveal(current);
            }).catch(error => console.error('Could not reveal poker showdown cards:', error));
        }, 700));
    }

    function scheduleNextHand(game) {
        clearNextHandTimer(game.id);
        if (game.status !== 'finished') return;
        nextHandTimers.set(game.id, setTimeout(() => {
            withLock(game.id, async () => {
                const current = await loadGame(game.id);
                if (!current || current.status !== 'finished') return;
                await startHand(current);
                await saveGame(current);
                await publish(current);
                scheduleTurn(current);
            }).catch(error => console.error('Could not start the next poker hand:', error));
        }, 8000));
    }

    function scheduleTurn(game) {
        clearTimer(game.id);
        if (game.status !== 'playing' || !game.currentTurn || !game.turnDeadline) return;
        const delay = Math.max(0, game.turnDeadline - Date.now());
        timers.set(game.id, setTimeout(() => {
            withLock(game.id, async () => {
                const current = await loadGame(game.id);
                if (!current || current.status !== 'playing' || current.currentTurn !== game.currentTurn || current.turnDeadline !== game.turnDeadline) return;
                const player = current.players[current.currentTurn];
                const call = Math.max(0, current.currentBet - Number(player.streetContribution || 0));
                await applyAction(current, current.currentTurn, call === 0 ? 'check' : 'fold', 0, true);
                await saveGame(current);
                await publish(current);
                scheduleTurn(current);
            }).catch(error => console.error('Poker turn timer failed:', error));
        }, delay));
    }

    async function deckForHand() {
        const shuffled = await fetch(`${DECK_API}/new/shuffle/?deck_count=1`);
        if (!shuffled.ok) throw new Error('The playing-card service is unavailable.');
        const deck = await shuffled.json();
        if (!deck.deck_id) throw new Error('The playing-card service did not create a deck.');
        const response = await fetch(`${DECK_API}/${deck.deck_id}/draw/?count=52`);
        if (!response.ok) throw new Error('The playing-card service could not deal a deck.');
        const result = await response.json();
        if (!Array.isArray(result.cards) || result.cards.length !== 52) throw new Error('The card service returned an incomplete deck.');
        const cards = result.cards.slice();
        const validRanks = new Set(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'JACK', 'QUEEN', 'KING', 'ACE']);
        const validSuits = new Set(['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES']);
        const uniqueCards = new Set(cards.map(card => `${String(card.value || '').toUpperCase()}-${String(card.suit || '').toUpperCase()}`));
        if (uniqueCards.size !== 52 || cards.some(card =>
            !validRanks.has(String(card.value || '').toUpperCase()) ||
            !validSuits.has(String(card.suit || '').toUpperCase())
        )) {
            throw new Error('The card service returned an invalid or duplicate deck.');
        }
        for (let index = cards.length - 1; index > 0; index--) {
            const swap = crypto.randomInt(index + 1);
            [cards[index], cards[swap]] = [cards[swap], cards[index]];
        }
        return cards;
    }

    function nextSeat(game, from, predicate) {
        for (let offset = 1; offset <= game.seats.length; offset++) {
            const index = (from + offset + game.seats.length) % game.seats.length;
            const player = game.players[game.seats[index]];
            if (player && predicate(player)) return index;
        }
        return -1;
    }

    function activePlayers(game) {
        return game.seats.map(id => game.players[id]).filter(player => player && !player.folded);
    }

    function potSize(game) {
        return Object.values(game.players).reduce((sum, player) => sum + Number(player.contribution || 0), 0);
    }

    function clockwisePlayer(game, fromIndex, predicate) {
        const index = nextSeat(game, fromIndex, predicate);
        return index < 0 ? null : game.seats[index];
    }

    function eligibleToAct(player) {
        return player && !player.folded && !player.allIn;
    }

    function setPendingFrom(game, predicate, excludedId) {
        game.pendingActions = game.seats.filter(id => id !== excludedId && predicate(game.players[id]));
    }

    function nextPending(game, afterId) {
        const start = game.seats.indexOf(afterId);
        return clockwisePlayer(game, start, player => eligibleToAct(player) && game.pendingActions.includes(player.id));
    }

    async function finishHand(game, uncontested = false) {
        clearTimer(game.id);
        clearNextHandTimer(game.id);
        clearShowdownTimer(game.id);
        game.status = 'finished';
        game.currentTurn = null;
        game.turnDeadline = null;
        game.pendingActions = [];
        game.revealedPlayers = [];
        game.showdownOrder = [];
        game.mucked = {};
        if (uncontested) {
            const winner = activePlayers(game)[0];
            const settlement = Poker.settleUncontested(Object.values(game.players), winner.id);
            Object.entries(settlement.payouts).forEach(([id, amount]) => { game.players[id].stack += amount; });
            game.handResult = {
                payouts: settlement.payouts,
                pots: settlement.pots,
                winners: [winner.id],
                hands: {},
                announcement: `${winner.username} wins ${settlement.payouts[winner.id]} chips uncontested.`
            };
            game.message = game.handResult.announcement;
            markTableComplete(game);
            scheduleNextHand(game);
            return;
        }
        game.showdownOrder = showdownOrder(game);
        if (game.showdownOrder.length) game.revealedPlayers = [game.showdownOrder[0]];
        const settlement = Poker.settleShowdown(Object.values(game.players), game.communityCards, game.dealerIndex);
        Object.entries(settlement.payouts).forEach(([id, amount]) => { game.players[id].stack += amount; });
        const winners = [...new Set(settlement.pots.flatMap(pot => pot.winners || []))];
        const handName = winners.length ? settlement.hands[winners[0]].name : 'High Card';
        const amount = winners.reduce((sum, id) => sum + settlement.payouts[id], 0);
        const winnerNames = winners.map(id => game.players[id].username);
        game.handResult = {
            payouts: settlement.payouts,
            pots: settlement.pots,
            winners,
            hands: settlement.hands,
            announcement: `${winnerNames.join(' and ')} ${winners.length === 1 ? 'wins' : 'split'} ${amount} chips with ${handName}.`
        };
        game.message = game.handResult.announcement;
        markTableComplete(game);
        scheduleShowdownReveal(game);
        scheduleNextHand(game);
    }

    function markTableComplete(game) {
        if (Object.values(game.players).filter(player => player.stack > 0 && !player.sittingOut).length < MIN_PLAYERS) {
            game.status = 'complete';
            game.message += ' The table is complete.';
        }
    }

    async function dealNextStreet(game) {
        const nextRound = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[game.round];
        if (nextRound === 'showdown') {
            await finishHand(game);
            return;
        }
        if (nextRound === 'flop') {
            game.burnCards.push(game.deckCards.pop());
            game.communityCards.push(...game.deckCards.splice(-3));
        } else {
            game.burnCards.push(game.deckCards.pop());
            game.communityCards.push(game.deckCards.pop());
        }
        game.round = nextRound;
        game.currentBet = 0;
        game.minRaise = game.bigBlind;
        game.seats.forEach(id => { if (game.players[id]) game.players[id].streetContribution = 0; });
        const canAct = activePlayers(game).filter(eligibleToAct);
        if (canAct.length <= 1) {
            while (game.communityCards.length < 5) {
                game.burnCards.push(game.deckCards.pop());
                game.communityCards.push(game.deckCards.pop());
            }
            await finishHand(game);
            return;
        }
        setPendingFrom(game, eligibleToAct, null);
        game.raiseRights = game.seats.filter(id => eligibleToAct(game.players[id]));
        game.currentTurn = clockwisePlayer(game, game.dealerIndex, player => eligibleToAct(player) && game.pendingActions.includes(player.id));
        setTurnDeadline(game);
    }

    function setTurnDeadline(game) {
        game.turnDeadline = game.currentTurn ? Date.now() + TURN_MS : null;
    }

    async function startHand(game) {
        clearNextHandTimer(game.id);
        clearShowdownTimer(game.id);
        const playingIds = game.seats.filter(id => game.players[id] && game.players[id].stack > 0 && !game.players[id].sittingOut);
        if (playingIds.length < MIN_PLAYERS) {
            game.status = 'complete';
            game.message = 'Not enough players have chips to continue.';
            return;
        }
        game.handNumber++;
        game.deckCards = await deckForHand();
        game.communityCards = [];
        game.burnCards = [];
        game.actionHistory = [];
        game.handResult = null;
        game.revealedPlayers = [];
        game.showdownOrder = [];
        game.mucked = {};
        game.round = 'preflop';
        game.currentBet = game.bigBlind;
        game.minRaise = game.bigBlind;
        game.players = Object.fromEntries(game.seats.map((id, seat) => {
            const previous = game.players[id];
            if (!previous) return [id, previous];
            return [id, {
                ...previous,
                seat,
                holeCards: [],
                contribution: 0,
                streetContribution: 0,
                folded: Boolean(previous.sittingOut || previous.stack <= 0),
                allIn: false,
                status: previous.sittingOut ? 'sittingOut' : (previous.stack <= 0 ? 'eliminated' : 'playing')
            }];
        }).filter(([, player]) => player));
        const liveIds = game.seats.filter(id => game.players[id] && !game.players[id].sittingOut && game.players[id].stack > 0);
        game.dealerIndex = liveIds.includes(game.seats[game.dealerIndex]) ? game.dealerIndex : game.seats.indexOf(liveIds[0]);
        if (game.handNumber > 1) game.dealerIndex = nextSeat(game, game.dealerIndex, player => !player.sittingOut && player.stack > 0);
        const dealerId = game.seats[game.dealerIndex];
        let smallBlindId;
        let bigBlindId;
        if (liveIds.length === 2) {
            smallBlindId = dealerId;
            bigBlindId = game.seats[nextSeat(game, game.dealerIndex, player => !player.sittingOut && player.stack > 0)];
        } else {
            smallBlindId = game.seats[nextSeat(game, game.dealerIndex, player => !player.sittingOut && player.stack > 0)];
            bigBlindId = game.seats[nextSeat(game, game.seats.indexOf(smallBlindId), player => !player.sittingOut && player.stack > 0)];
        }
        game.smallBlindId = smallBlindId;
        game.bigBlindId = bigBlindId;
        for (let round = 0; round < 2; round++) {
            liveIds.forEach(id => game.players[id].holeCards.push(game.deckCards.pop()));
        }
        postBlind(game.players[smallBlindId], game.smallBlind);
        postBlind(game.players[bigBlindId], game.bigBlind);
        setPendingFrom(game, eligibleToAct, null);
        const firstActorIndex = liveIds.length === 2
            ? game.dealerIndex
            : game.seats.indexOf(bigBlindId);
        game.currentTurn = liveIds.length === 2 && eligibleToAct(game.players[dealerId]) && game.pendingActions.includes(dealerId)
            ? dealerId
            : clockwisePlayer(game, firstActorIndex, player => eligibleToAct(player) && game.pendingActions.includes(player.id));
        game.raiseRights = game.seats.filter(id => eligibleToAct(game.players[id]));
        game.status = 'playing';
        game.message = `${game.players[dealerId].username} has the dealer button.`;
        setTurnDeadline(game);
        if (!game.currentTurn) await dealNextStreet(game);
    }

    function postBlind(player, blind) {
        const amount = Math.min(player.stack, blind);
        player.stack -= amount;
        player.contribution += amount;
        player.streetContribution += amount;
        player.allIn = player.stack === 0;
        if (player.allIn) player.status = 'allIn';
    }

    async function settleAfterAction(game, actorId) {
        const live = activePlayers(game);
        if (live.length === 1) {
            await finishHand(game, true);
            return;
        }
        const pending = game.pendingActions.filter(id => {
            const player = game.players[id];
            return eligibleToAct(player) && (player.streetContribution < game.currentBet || game.pendingActions.includes(id));
        });
        game.pendingActions = pending;
        const next = nextPending(game, actorId);
        if (next) {
            game.currentTurn = next;
            setTurnDeadline(game);
            return;
        }
        if (pending.length) {
            game.currentTurn = clockwisePlayer(game, game.seats.indexOf(actorId), player => eligibleToAct(player) && pending.includes(player.id));
            setTurnDeadline(game);
            return;
        }
        await dealNextStreet(game);
    }

    async function applyAction(game, uid, action, requestedAmount, timedOut = false) {
        if (game.status !== 'playing' || game.currentTurn !== uid) throw new Error('It is not your turn.');
        const player = game.players[uid];
        if (!eligibleToAct(player)) throw new Error('You cannot act in this hand.');
        const toCall = Math.max(0, game.currentBet - player.streetContribution);
        let target = player.streetContribution;
        let actionLabel = action;

        if (action === 'fold') {
            player.folded = true;
            player.status = 'folded';
            game.pendingActions = game.pendingActions.filter(id => id !== uid);
            game.raiseRights = (game.raiseRights || []).filter(id => id !== uid);
        } else if (action === 'check') {
            if (toCall > 0) throw new Error('You cannot check while facing a bet.');
            game.pendingActions = game.pendingActions.filter(id => id !== uid);
            game.raiseRights = (game.raiseRights || []).filter(id => id !== uid);
        } else if (action === 'call') {
            if (toCall === 0) throw new Error('There is no bet to call.');
            const paid = Math.min(toCall, player.stack);
            player.stack -= paid;
            player.streetContribution += paid;
            player.contribution += paid;
            player.allIn = player.stack === 0;
            player.status = player.allIn ? 'allIn' : 'playing';
            game.pendingActions = game.pendingActions.filter(id => id !== uid);
            game.raiseRights = (game.raiseRights || []).filter(id => id !== uid);
            actionLabel = player.allIn ? 'call all-in' : 'call';
        } else if (action === 'bet' || action === 'raise' || action === 'allIn') {
            const targetTotal = action === 'allIn'
                ? player.streetContribution + player.stack
                : Number(requestedAmount);
            if (!Number.isInteger(targetTotal) || targetTotal <= player.streetContribution || targetTotal > player.streetContribution + player.stack) {
                throw new Error('Choose a valid amount within your chip balance.');
            }
            if (targetTotal > game.currentBet && !(game.raiseRights || []).includes(uid)) {
                throw new Error('Betting has not reopened for you.');
            }
            if (action !== 'allIn' && targetTotal <= game.currentBet) throw new Error('Your bet must increase the current wager.');
            const increase = targetTotal - game.currentBet;
            const minIncrease = game.currentBet === 0 ? game.bigBlind : game.minRaise;
            const isAllIn = targetTotal === player.streetContribution + player.stack;
            if (targetTotal < game.currentBet && !isAllIn) throw new Error('Your wager cannot be below the current bet.');
            if (increase < minIncrease && !isAllIn) throw new Error(`The minimum raise is ${minIncrease} chips.`);
            const paid = targetTotal - player.streetContribution;
            player.stack -= paid;
            player.streetContribution = targetTotal;
            player.contribution += paid;
            player.allIn = player.stack === 0;
            player.status = player.allIn ? 'allIn' : 'playing';
            if (targetTotal > game.currentBet) {
                const previousBet = game.currentBet;
                const fullRaise = increase >= minIncrease;
                game.currentBet = targetTotal;
                if (fullRaise) {
                    game.minRaise = increase;
                    game.raiseRights = game.seats.filter(id => id !== uid && eligibleToAct(game.players[id]));
                    actionLabel = previousBet === 0 ? 'bet' : 'raise';
                } else {
                    game.raiseRights = (game.raiseRights || []).filter(id => id !== uid);
                    actionLabel = 'short all-in';
                }
                setPendingFrom(game, candidate => eligibleToAct(candidate) && candidate.id !== uid &&
                    (fullRaise || candidate.streetContribution < game.currentBet), uid);
            } else {
                game.pendingActions = game.pendingActions.filter(id => id !== uid);
                game.raiseRights = (game.raiseRights || []).filter(id => id !== uid);
                actionLabel = 'all-in call';
            }
        } else {
            throw new Error('That poker action is not supported.');
        }

        game.actionHistory.push({
            playerId: uid,
            username: player.username,
            action: timedOut ? `time expired — ${actionLabel}` : actionLabel,
            amount: Math.max(0, player.streetContribution - target),
            round: game.round,
            at: Date.now()
        });
        game.message = timedOut ? `${player.username}'s turn timed out.` : `${player.username} ${actionLabel}.`;
        await settleAfterAction(game, uid);
    }

    function validateGameAccess(game, uid) {
        if (!game || !game.allowedPlayers.includes(uid)) throw new Error('This poker table is unavailable to your account.');
    }

    async function createGame(req, res) {
        try {
            const { uid } = req.pokerUser;
            const { name, maxPlayers, maxBuyIn, buyIn, smallBlind, bigBlind, allowedPlayers, username, avatar } = req.body || {};
            const capacity = Number(maxPlayers);
            const stack = Number(maxBuyIn);
            const playerBuyIn = Number(buyIn);
            const small = Number(smallBlind);
            const big = Number(bigBlind);
            if (!Number.isInteger(capacity) || capacity < MIN_PLAYERS || capacity > MAX_PLAYERS ||
                !Number.isInteger(stack) || stack < 100 || stack > 100_000 ||
                !Number.isInteger(playerBuyIn) || playerBuyIn < big || playerBuyIn > stack ||
                !Number.isInteger(small) || !Number.isInteger(big) || small < 1 || big < small ||
                big > stack || big % small !== 0) {
                return res.status(400).json({ error: 'Choose a 2–9 seat table, a buy-in within the table limit, and valid blinds.' });
            }
            const invited = [...new Set([uid, ...(Array.isArray(allowedPlayers)
                ? allowedPlayers.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, 100)
                : [])])];
            const game = {
                id: crypto.randomUUID(),
                name: String(name || '').trim().slice(0, 40) || `${username || 'Player'}’s Poker Table`,
                hostId: uid,
                allowedPlayers: invited,
                maxPlayers: capacity,
                startingStack: stack,
                smallBlind: small,
                bigBlind: big,
                status: 'waiting',
                players: {
                    [uid]: {
                        id: uid,
                        username: String(username || 'Player').slice(0, 32),
                        avatar: typeof avatar === 'string' ? avatar.slice(0, 2048) : '',
                        seat: 0,
                        stack: playerBuyIn,
                        buyIn: playerBuyIn,
                        contribution: 0,
                        streetContribution: 0,
                        folded: false,
                        allIn: false,
                        status: 'waiting',
                        holeCards: []
                    }
                },
                seats: [uid],
                dealerIndex: -1,
                currentTurn: null,
                turnDeadline: null,
                round: null,
                communityCards: [],
                deckCards: [],
                burnCards: [],
                pendingActions: [],
                raiseRights: [],
                currentBet: 0,
                minRaise: big,
                actionHistory: [],
                handResult: null,
                handNumber: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                message: 'Waiting for players to join.'
            };
            await reservePokerBuyIn(uid, req.pokerUser.token, game.id, playerBuyIn);
            try {
                await saveGame(game);
            } catch (error) {
                await cashOutPoker(uid, req.pokerUser.token, game.id, playerBuyIn).catch(refundError => {
                    console.error('Could not roll back Poker table buy-in:', refundError);
                });
                throw error;
            }
            res.status(201).json(publicGame(game, uid));
        } catch (error) {
            const status = error.status || 500;
            if (status >= 500) console.error('Could not create poker table:', error);
            res.status(status)
                .json({ error: error.message || 'Could not create poker table.' });
        }
    }

    async function getState(req, res) {
        try {
            const game = await loadGame(req.params.id);
            validateGameAccess(game, req.pokerUser.uid);
            res.json(publicGame(game, req.pokerUser.uid));
        } catch (error) {
            res.status(404).json({ error: error.message || 'Poker table not found.' });
        }
    }

    async function performMutation(req, res, operation) {
        try {
            const result = await withLock(req.params.id, async () => {
                const game = await loadGame(req.params.id);
                validateGameAccess(game, req.pokerUser.uid);
                const hooks = await operation(game, req.pokerUser.uid, req.body || {});
                try {
                    await saveGame(game);
                } catch (error) {
                    if (typeof hooks === 'function') await hooks();
                    throw error;
                }
                if (hooks && typeof hooks.afterSave === 'function') await hooks.afterSave();
                await publish(game);
                scheduleTurn(game);
                return publicGame(game, req.pokerUser.uid);
            });
            res.json(result);
        } catch (error) {
            const status = error.status || (error.message && (error.message.startsWith('This poker table') || error.message.includes('not found')) ? 404 : 400);
            res.status(status).json({ error: error.message || 'Poker action failed.' });
        }
    }

    app.post('/api/poker/games', authMiddleware, createGame);
    app.get('/api/poker/games/:id', authMiddleware, getState);
    app.post('/api/poker/games/:id/join', authMiddleware, (req, res) => performMutation(req, res, async (game, uid, body) => {
        if (game.status !== 'waiting') throw new Error('This table has already started.');
        if (game.players[uid]) return;
        if (game.seats.length >= game.maxPlayers) throw new Error('This table is full.');
        const buyIn = Number(body.buyIn);
        if (!Number.isSafeInteger(buyIn) || buyIn < game.bigBlind || buyIn > game.startingStack) {
            throw new Error(`Choose a buy-in from ${game.bigBlind} to ${game.startingStack} chips.`);
        }
        await reservePokerBuyIn(uid, req.pokerUser.token, game.id, buyIn);
        game.players[uid] = {
            id: uid,
            username: String(body.username || 'Player').slice(0, 32),
            avatar: typeof body.avatar === 'string' ? body.avatar.slice(0, 2048) : '',
            seat: game.seats.length,
            stack: buyIn,
            buyIn,
            contribution: 0,
            streetContribution: 0,
            folded: false,
            allIn: false,
            status: 'waiting',
            holeCards: []
        };
        game.seats.push(uid);
        game.message = `${game.players[uid].username} joined the table.`;
        return () => cashOutPoker(uid, req.pokerUser.token, game.id, buyIn);
    }));
    app.post('/api/poker/games/:id/start', authMiddleware, (req, res) => performMutation(req, res, async (game, uid) => {
        if (game.hostId !== uid) throw new Error('Only the host can start the game.');
        if (game.status !== 'waiting') throw new Error('This table has already started.');
        if (game.seats.length < MIN_PLAYERS) throw new Error('At least two players must join before starting.');
        game.status = 'starting';
        await startHand(game);
    }));
    app.post('/api/poker/games/:id/action', authMiddleware, (req, res) => performMutation(req, res, async (game, uid, body) => {
        await applyAction(game, uid, body.action, body.amount);
    }));
    app.post('/api/poker/games/:id/next', authMiddleware, (req, res) => performMutation(req, res, async (game, uid) => {
        if (game.hostId !== uid) throw new Error('Only the host can deal the next hand.');
        if (game.status !== 'finished') throw new Error('This hand is not complete.');
        clearNextHandTimer(game.id);
        await startHand(game);
    }));
    app.post('/api/poker/games/:id/muck', authMiddleware, (req, res) => performMutation(req, res, async (game, uid) => {
        if (!['finished', 'complete'].includes(game.status) || !game.handResult || !game.handResult.hands[uid]) {
            throw new Error('You cannot muck this hand.');
        }
        if ((game.handResult.winners || []).includes(uid)) throw new Error('A winning hand cannot be mucked.');
        if (!(game.revealedPlayers || []).includes(uid)) throw new Error('Wait for your showdown reveal before mucking.');
        game.mucked = { ...(game.mucked || {}), [uid]: true };
        game.message = `${game.players[uid].username} mucked their hand.`;
    }));
    app.post('/api/poker/games/:id/leave', authMiddleware, (req, res) => performMutation(req, res, async (game, uid) => {
        if (!game.players[uid]) {
            await finishPokerCashOut(uid, req.pokerUser.token, game.id);
            return;
        }
        if (game.status === 'playing') {
            const player = game.players[uid];
            player.sittingOut = true;
            player.status = 'sittingOut';
            if (uid === game.currentTurn) await applyAction(game, uid, 'fold', 0);
            if (game.hostId === uid) {
                const replacement = game.seats.find(id => id !== uid && game.players[id] && !game.players[id].sittingOut);
                if (replacement) game.hostId = replacement;
            }
            return;
        }
        const playerStack = game.players[uid].stack;
        await preparePokerCashOut(uid, req.pokerUser.token, game.id, playerStack);
        const removedIndex = game.seats.indexOf(uid);
        game.seats = game.seats.filter(id => id !== uid);
        delete game.players[uid];
        if (removedIndex >= 0 && game.seats.length && game.dealerIndex >= 0) {
            if (removedIndex < game.dealerIndex) game.dealerIndex--;
            else if (removedIndex === game.dealerIndex) game.dealerIndex = (removedIndex - 1 + game.seats.length) % game.seats.length;
        }
        if (!game.seats.length) {
            game.status = 'complete';
            game.message = 'The table is empty.';
        } else if (game.hostId === uid) {
            game.hostId = game.seats[0];
        }
        return { afterSave: () => finishPokerCashOut(uid, req.pokerUser.token, game.id) };
    }));

    io.on('connection', socket => {
        socket.on('poker:authenticate', async (token, callback) => {
            const user = await verifyFirebaseToken(token).catch(() => null);
            if (!user) {
                if (typeof callback === 'function') callback({ error: 'Poker sign-in failed.' });
                return;
            }
            socket.data.pokerUid = user.uid;
            if (typeof callback === 'function') callback({ ok: true });
        });
        socket.on('poker:subscribe', async (gameId, callback) => {
            try {
                if (!socket.data.pokerUid) throw new Error('Sign in before opening a poker table.');
                const game = await loadGame(String(gameId));
                validateGameAccess(game, socket.data.pokerUid);
                await socket.join(`poker:${game.id}`);
                socket.emit('poker:state', publicGame(game, socket.data.pokerUid));
                if (typeof callback === 'function') callback({ ok: true });
            } catch (error) {
                if (typeof callback === 'function') callback({ error: error.message });
            }
        });
        socket.on('poker:unsubscribe', gameId => {
            if (typeof gameId === 'string') socket.leave(`poker:${gameId}`);
        });
        socket.on('disconnect', () => {
            for (const room of socket.rooms) {
                if (room.startsWith('poker:')) socket.leave(room);
            }
        });
    });

    storageReady.then(() => {
        db.all("SELECT state_json FROM poker_tables WHERE status IN ('playing', 'finished', 'complete')", [], (error, rows) => {
            if (error) {
                console.error('Could not restore poker turn timers:', error);
                return;
            }
            rows.forEach(row => {
                try {
                    const game = JSON.parse(row.state_json);
                    if (game.status === 'playing') scheduleTurn(game);
                    else {
                        scheduleShowdownReveal(game);
                        if (game.status === 'finished') scheduleNextHand(game);
                    }
                } catch (parseError) {
                    console.error('Could not restore poker table:', parseError);
                }
            });
        });
    }).catch(error => console.error('Could not initialize poker table recovery:', error));

    return () => {
        timers.forEach(clearTimeout);
        nextHandTimers.forEach(clearTimeout);
        showdownTimers.forEach(clearTimeout);
        timers.clear();
        nextHandTimers.clear();
        showdownTimers.clear();
    };
}

module.exports = createPokerService;
