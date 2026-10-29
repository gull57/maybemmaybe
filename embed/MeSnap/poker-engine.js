const CATEGORY_NAMES = [
    'High Card',
    'One Pair',
    'Two Pair',
    'Three of a Kind',
    'Straight',
    'Flush',
    'Full House',
    'Four of a Kind',
    'Straight Flush',
    'Royal Flush'
];

const RANKS = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
    '8': 8, '9': 9, '10': 10, JACK: 11, QUEEN: 12, KING: 13, ACE: 14
};

function cardRank(card) {
    const rank = RANKS[String(card && card.value || '').toUpperCase()];
    if (!rank) throw new Error('Invalid card rank.');
    return rank;
}

function compareVectors(left, right) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const difference = (left[index] || 0) - (right[index] || 0);
        if (difference) return Math.sign(difference);
    }
    return 0;
}

function evaluateFive(cards) {
    if (!Array.isArray(cards) || cards.length !== 5) throw new Error('A poker hand must contain five cards.');
    const ranks = cards.map(cardRank).sort((a, b) => b - a);
    const counts = new Map();
    const suits = new Set();
    cards.forEach((card, index) => {
        counts.set(ranks[index], (counts.get(ranks[index]) || 0) + 1);
        if (!card || !card.suit) throw new Error('Invalid card suit.');
        suits.add(card.suit);
    });

    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const uniqueRanks = [...new Set(ranks)];
    let straightHigh = 0;
    if (uniqueRanks.length === 5) {
        if (uniqueRanks[0] - uniqueRanks[4] === 4) straightHigh = uniqueRanks[0];
        else if (uniqueRanks.join(',') === '14,5,4,3,2') straightHigh = 5;
    }
    const flush = suits.size === 1;

    if (flush && straightHigh === 14) return { rank: 9, tiebreak: [14], name: CATEGORY_NAMES[9] };
    if (flush && straightHigh) return { rank: 8, tiebreak: [straightHigh], name: CATEGORY_NAMES[8] };
    if (groups[0][1] === 4) return { rank: 7, tiebreak: [groups[0][0], groups[1][0]], name: CATEGORY_NAMES[7] };
    if (groups[0][1] === 3 && groups[1][1] === 2) return { rank: 6, tiebreak: [groups[0][0], groups[1][0]], name: CATEGORY_NAMES[6] };
    if (flush) return { rank: 5, tiebreak: ranks, name: CATEGORY_NAMES[5] };
    if (straightHigh) return { rank: 4, tiebreak: [straightHigh], name: CATEGORY_NAMES[4] };
    if (groups[0][1] === 3) {
        return { rank: 3, tiebreak: [groups[0][0], ...groups.slice(1).map(group => group[0]).sort((a, b) => b - a)], name: CATEGORY_NAMES[3] };
    }
    if (groups[0][1] === 2 && groups[1][1] === 2) {
        const pairs = groups.slice(0, 2).map(group => group[0]).sort((a, b) => b - a);
        return { rank: 2, tiebreak: [...pairs, groups[2][0]], name: CATEGORY_NAMES[2] };
    }
    if (groups[0][1] === 2) {
        return { rank: 1, tiebreak: [groups[0][0], ...groups.slice(1).map(group => group[0]).sort((a, b) => b - a)], name: CATEGORY_NAMES[1] };
    }
    return { rank: 0, tiebreak: ranks, name: CATEGORY_NAMES[0] };
}

function combinations(cards, size) {
    const results = [];
    function visit(start, chosen) {
        if (chosen.length === size) {
            results.push(chosen);
            return;
        }
        for (let index = start; index <= cards.length - (size - chosen.length); index++) {
            visit(index + 1, [...chosen, cards[index]]);
        }
    }
    visit(0, []);
    return results;
}

function evaluateHand(cards) {
    if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
        throw new Error('Texas Hold’em hand evaluation requires five to seven cards.');
    }
    return combinations(cards, 5)
        .map(evaluateFive)
        .reduce((best, hand) => !best || compareVectors(
            [hand.rank, ...hand.tiebreak],
            [best.rank, ...best.tiebreak]
        ) > 0 ? hand : best, null);
}

function compareHands(left, right) {
    return compareVectors([left.rank, ...left.tiebreak], [right.rank, ...right.tiebreak]);
}

function clockwiseWinners(winners, players, dealerIndex) {
    const seats = players.length;
    return [...winners].sort((a, b) => {
        const left = (players.findIndex(player => player.id === a) - dealerIndex - 1 + seats) % seats;
        const right = (players.findIndex(player => player.id === b) - dealerIndex - 1 + seats) % seats;
        return left - right;
    });
}

function buildSidePots(players) {
    const levels = [...new Set(players.map(player => Math.max(0, Number(player.contribution || 0))).filter(Boolean))]
        .sort((a, b) => a - b);
    let previous = 0;
    return levels.map(level => {
        const contributors = players.filter(player => Number(player.contribution || 0) >= level);
        const contributionPerPlayer = level - previous;
        const amount = contributionPerPlayer * contributors.length;
        previous = level;
        return {
            amount,
            eligible: contributors.filter(player => !player.folded).map(player => player.id),
            contributors: contributors.map(player => player.id),
            contributionPerPlayer
        };
    }).filter(pot => pot.amount > 0);
}

function settleShowdown(players, community, dealerIndex) {
    const eligible = players.filter(player => !player.folded);
    const hands = Object.fromEntries(eligible.map(player => [
        player.id,
        evaluateHand([...(player.holeCards || []), ...community])
    ]));
    const payouts = Object.fromEntries(players.map(player => [player.id, 0]));
    const pots = buildSidePots(players);

    pots.forEach(pot => {
        const contenders = pot.eligible;
        if (!contenders.length) {
            pot.contributors.forEach(id => { payouts[id] += pot.contributionPerPlayer; });
            pot.winners = [];
            pot.handName = null;
            return;
        }
        let winners = [contenders[0]];
        for (const id of contenders.slice(1)) {
            const comparison = compareHands(hands[id], hands[winners[0]]);
            if (comparison > 0) winners = [id];
            else if (comparison === 0) winners.push(id);
        }
        const ordered = clockwiseWinners(winners, players, dealerIndex);
        const share = Math.floor(pot.amount / ordered.length);
        const oddChips = pot.amount % ordered.length;
        ordered.forEach((id, index) => {
            payouts[id] += share + (index < oddChips ? 1 : 0);
        });
        pot.winners = ordered;
        pot.handName = hands[ordered[0]].name;
    });

    return { payouts, pots, hands };
}

function settleUncontested(players, winnerId) {
    const payouts = Object.fromEntries(players.map(player => [player.id, 0]));
    const pots = buildSidePots(players);
    pots.forEach(pot => {
        if (pot.eligible.includes(winnerId)) {
            payouts[winnerId] += pot.amount;
            pot.winners = [winnerId];
        } else {
            pot.contributors.forEach(id => { payouts[id] += pot.contributionPerPlayer; });
            pot.winners = [];
        }
    });
    return { payouts, pots, hands: {} };
}

module.exports = {
    CATEGORY_NAMES,
    cardRank,
    compareHands,
    evaluateFive,
    evaluateHand,
    buildSidePots,
    settleShowdown,
    settleUncontested
};
