const test = require('node:test');
const assert = require('node:assert/strict');
const Poker = require('./poker-engine');

const card = (value, suit) => ({ value, suit });
const hand = (values, suit = 'HEARTS') => values.map(value => card(value, suit));

test('evaluates every poker hand category from strongest to weakest', () => {
    const hands = [
        hand(['ACE', 'KING', 'QUEEN', 'JACK', '10']),
        hand(['9', '8', '7', '6', '5'], 'SPADES'),
        [card('KING', 'HEARTS'), card('KING', 'SPADES'), card('KING', 'CLUBS'), card('KING', 'DIAMONDS'), card('2', 'HEARTS')],
        [card('10', 'HEARTS'), card('10', 'SPADES'), card('10', 'CLUBS'), card('9', 'DIAMONDS'), card('9', 'HEARTS')],
        [card('ACE', 'CLUBS'), card('JACK', 'CLUBS'), card('8', 'CLUBS'), card('5', 'CLUBS'), card('2', 'CLUBS')],
        [card('9', 'HEARTS'), card('8', 'SPADES'), card('7', 'CLUBS'), card('6', 'DIAMONDS'), card('5', 'HEARTS')],
        [card('7', 'HEARTS'), card('7', 'SPADES'), card('7', 'CLUBS'), card('6', 'DIAMONDS'), card('4', 'HEARTS')],
        [card('KING', 'HEARTS'), card('KING', 'SPADES'), card('3', 'CLUBS'), card('3', 'DIAMONDS'), card('ACE', 'HEARTS')],
        [card('QUEEN', 'HEARTS'), card('QUEEN', 'SPADES'), card('KING', 'CLUBS'), card('JACK', 'DIAMONDS'), card('9', 'HEARTS')],
        [card('QUEEN', 'HEARTS'), card('JACK', 'SPADES'), card('8', 'CLUBS'), card('4', 'DIAMONDS'), card('2', 'HEARTS')]
    ];

    hands.forEach((cards, index) => {
        assert.equal(Poker.evaluateFive(cards).rank, 9 - index);
    });
});

test('handles wheel straights, kicker comparisons, and the strongest seven-card combination', () => {
    const wheel = [card('ACE', 'HEARTS'), card('2', 'SPADES'), card('3', 'CLUBS'), card('4', 'DIAMONDS'), card('5', 'HEARTS')];
    assert.deepEqual(Poker.evaluateFive(wheel).tiebreak, [5]);

    const pairOfAces = Poker.evaluateFive([card('ACE', 'HEARTS'), card('ACE', 'SPADES'), card('KING', 'CLUBS'), card('QUEEN', 'DIAMONDS'), card('JACK', 'HEARTS')]);
    const pairOfKings = Poker.evaluateFive([card('KING', 'HEARTS'), card('KING', 'SPADES'), card('ACE', 'CLUBS'), card('QUEEN', 'DIAMONDS'), card('JACK', 'HEARTS')]);
    assert.equal(Poker.compareHands(pairOfAces, pairOfKings), 1);

    const best = Poker.evaluateHand([
        card('2', 'HEARTS'), card('3', 'HEARTS'),
        card('ACE', 'CLUBS'), card('KING', 'CLUBS'), card('QUEEN', 'CLUBS'),
        card('JACK', 'CLUBS'), card('10', 'CLUBS')
    ]);
    assert.equal(best.name, 'Royal Flush');
});

test('settles main and side pots only among eligible players', () => {
    const community = [
        card('ACE', 'HEARTS'), card('ACE', 'CLUBS'), card('KING', 'SPADES'),
        card('8', 'HEARTS'), card('2', 'CLUBS')
    ];
    const players = [
        { id: 'short', contribution: 100, folded: false, holeCards: [card('KING', 'DIAMONDS'), card('KING', 'CLUBS')] },
        { id: 'winner', contribution: 300, folded: false, holeCards: [card('8', 'DIAMONDS'), card('8', 'SPADES')] },
        { id: 'other', contribution: 300, folded: false, holeCards: [card('QUEEN', 'SPADES'), card('JACK', 'DIAMONDS')] }
    ];
    const result = Poker.settleShowdown(players, community, 0);
    assert.deepEqual(result.pots.map(pot => pot.amount), [300, 400]);
    assert.equal(result.payouts.short, 300);
    assert.equal(result.payouts.winner, 400);
    assert.equal(result.payouts.other, 0);
});

test('splits ties with odd chips clockwise after the dealer', () => {
    const community = [
        card('10', 'CLUBS'), card('JACK', 'CLUBS'), card('QUEEN', 'CLUBS'),
        card('KING', 'CLUBS'), card('ACE', 'CLUBS')
    ];
    const players = [
        { id: 'dealer', contribution: 2, folded: false, holeCards: [card('2', 'HEARTS'), card('3', 'HEARTS')] },
        { id: 'next', contribution: 2, folded: false, holeCards: [card('4', 'HEARTS'), card('5', 'HEARTS')] },
        { id: 'third', contribution: 1, folded: true, holeCards: [card('6', 'HEARTS'), card('7', 'HEARTS')] }
    ];
    const result = Poker.settleShowdown(players, community, 0);
    assert.deepEqual(result.payouts, { dealer: 2, next: 3, third: 0 });
});

test('returns unmatched folded excess during an uncontested hand', () => {
    const players = [
        { id: 'winner', contribution: 100, folded: false },
        { id: 'folded', contribution: 300, folded: true }
    ];
    const result = Poker.settleUncontested(players, 'winner');
    assert.deepEqual(result.payouts, { winner: 200, folded: 200 });
});
