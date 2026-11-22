'use strict';

const assert = require('assert').strict;
const { Swiss } = require('../../../dist/server/tournaments/generator-swiss');
const { PRNG } = require('../../../dist/sim/prng');

/** Stand-ins for TournamentPlayer: the generator only reads these fields. */
function makePlayers(count) {
	const disqualified = [];
	const game = {
		disqualified,
		setPlayerUser(player, user) {
			if (!user) disqualified.push(player);
		},
	};
	return Array.from({ length: count }, (_, i) => ({
		id: `p${i}`, name: `Player ${i}`, score: 0, isBusy: false, isDisqualified: false, game,
	}));
}

function start(playerCount, rounds = '', seed = '1,2,3,4') {
	const swiss = new Swiss(rounds, new PRNG(seed));
	const players = makePlayers(playerCount);
	swiss.freezeBracket(players);
	return { swiss, players };
}

/** Reports a result the way Tournament#onBattleWin does: scores first, then the generator. */
function report(swiss, [p1, p2], result) {
	if (result === 'win') {
		p1.score += 1;
	} else if (result === 'loss') {
		p2.score += 1;
	} else {
		p1.score += 0.5;
		p2.score += 0.5;
	}
	const score = result === 'win' ? [1, 0] : result === 'loss' ? [0, 1] : [0, 0];
	assert.equal(swiss.setMatchResult([p1, p2], result, score), undefined);
}

function playRound(swiss, decide = () => 'win') {
	const matches = swiss.getAvailableMatches();
	assert(matches.length, 'expected the current round to have matches');
	for (const match of matches) report(swiss, match, decide(...match));
}

function playToEnd(swiss, decide) {
	let roundsPlayed = 0;
	while (!swiss.isTournamentEnded()) {
		playRound(swiss, decide);
		roundsPlayed++;
		assert(roundsPlayed <= 100, 'tournament did not end');
	}
	return roundsPlayed;
}

const pairKey = (p1, p2) => (p1.id < p2.id ? `${p1.id}-${p2.id}` : `${p2.id}-${p1.id}`);

describe('Swiss tournament generator', () => {
	it('is named after the number of rounds when one is given', () => {
		assert.equal(new Swiss('').name, 'Swiss');
		assert.equal(new Swiss('5').name, '5-Round Swiss');
		assert.equal(new Swiss('').isDrawingSupported, true);
	});

	it('rejects a number of rounds that is not a positive integer', () => {
		for (const rounds of ['0', '-2', '2.5', 'five']) {
			assert.throws(() => new Swiss(rounds), /positive integer/, `accepted "${rounds}"`);
		}
	});

	it('plays enough rounds to separate an undefeated winner by default', () => {
		const expectedRounds = { 2: 1, 3: 2, 4: 2, 5: 3, 8: 3, 9: 4, 16: 4 };
		for (const [playerCount, rounds] of Object.entries(expectedRounds)) {
			const { swiss } = start(Number(playerCount));
			assert.equal(swiss.totalRounds, rounds, `${playerCount} players`);
			assert.equal(playToEnd(swiss), rounds, `${playerCount} players`);
		}
	});

	it('plays exactly the requested number of rounds, even if that needs rematches', () => {
		const { swiss, players } = start(2, '3');
		assert.equal(playToEnd(swiss), 3);
		assert.deepEqual(swiss.rounds.map(round => pairKey(round[0].p1, round[0].p2)), Array(3).fill('p0-p1'));
		assert.equal(players[0].score + players[1].score, 3);
	});

	it('pairs every player exactly once in the first round', () => {
		const { swiss, players } = start(8);
		const paired = swiss.getAvailableMatches().flat();
		assert.equal(paired.length, 8);
		assert.equal(new Set(paired).size, 8);
		for (const player of players) assert(paired.includes(player));
	});

	it('does not pair the next round until every match in the current round is finished', () => {
		const { swiss } = start(8);
		const [first, ...rest] = swiss.getAvailableMatches();
		for (const match of rest) report(swiss, match, 'win');
		assert.equal(swiss.rounds.length, 1);
		assert.deepEqual(swiss.getAvailableMatches(), [first]);
		report(swiss, first, 'win');
		assert.equal(swiss.rounds.length, 2);
		assert.equal(swiss.getAvailableMatches().length, 4);
	});

	it('pairs players with equal records against each other', () => {
		const { swiss } = start(8);
		playRound(swiss);
		for (const [p1, p2] of swiss.getAvailableMatches()) {
			assert.equal(p1.score, p2.score, `${p1.name} (${p1.score}) vs ${p2.name} (${p2.score})`);
		}
	});

	it('never pairs the same players twice when a fresh opponent is available', () => {
		// For these sizes and the default number of rounds, every round has a rematch-free pairing.
		for (const playerCount of [6, 7, 8, 9, 12, 16]) {
			for (let seed = 1; seed <= 25; seed++) {
				const { swiss } = start(playerCount, '', `${seed},${playerCount},3,4`);
				const results = new PRNG(`${seed},9,9,9`);
				playToEnd(swiss, () => results.sample(['win', 'loss', 'draw']));
				const pairs = swiss.rounds.flat().filter(match => match.p2).map(match => pairKey(match.p1, match.p2));
				assert.equal(new Set(pairs).size, pairs.length, `rematch with ${playerCount} players, seed ${seed}`);
			}
		}
	});

	it('gives the bye to the lowest-ranked player who has not had one, worth one point', () => {
		const { swiss, players } = start(5);
		const byes = [];
		while (!swiss.isTournamentEnded()) {
			const round = swiss.rounds[swiss.rounds.length - 1];
			const bye = round.find(match => !match.p2);
			assert(bye, 'expected a bye with an odd number of players');
			const others = players.filter(player => player !== bye.p1 && !byes.includes(player));
			const scoreBeforeBye = bye.p1.score - 1;
			for (const other of others) assert(other.score >= scoreBeforeBye, `${other.name} was ranked lower`);
			assert(!byes.includes(bye.p1), `${bye.p1.name} got a second bye`);
			byes.push(bye.p1);
			playRound(swiss);
		}
		assert.equal(byes.length, 3);
		assert.equal(players.reduce((total, player) => total + player.score, 0), 3 * 2 + 3);
	});

	it('accepts draws', () => {
		const { swiss } = start(4);
		playRound(swiss, () => 'draw');
		assert.equal(swiss.rounds[0].every(match => match.result === 'draw'), true);
		assert.equal(swiss.rounds.length, 2);
	});

	it('awards the match of a disqualified player to their opponent and does not pair them again', () => {
		const { swiss, players } = start(6);
		const [[p1, p2]] = swiss.getAvailableMatches();
		p1.isDisqualified = true;
		assert.equal(swiss.disqualifyUser(p1), undefined);
		assert.equal(p2.score, 1);
		assert.deepEqual(p1.game.disqualified, [p1]);
		assert.equal(swiss.getAvailableMatches().some(match => match.includes(p1)), false);

		playToEnd(swiss);
		const laterRounds = swiss.rounds.slice(1).flat();
		assert.equal(laterRounds.some(match => match.p1 === p1 || match.p2 === p1), false);
		const results = swiss.getResults();
		assert.deepEqual(results[results.length - 1], [p1]);
		assert.equal(results.flat().length, players.length);
	});

	it('ends early when fewer than two players are left', () => {
		const { swiss, players } = start(3, '5');
		const [[p1, p2]] = swiss.getAvailableMatches();
		p1.isDisqualified = true;
		swiss.disqualifyUser(p1);
		assert.equal(swiss.isTournamentEnded(), false);
		p2.isDisqualified = true;
		swiss.disqualifyUser(p2);
		assert.equal(swiss.isTournamentEnded(), true);
		const winner = players.find(player => !player.isDisqualified);
		assert.deepEqual(swiss.getResults()[0], [winner]);
	});

	it('ranks results by points, then by the total points of opponents, keeping exact ties together', () => {
		for (let seed = 1; seed <= 10; seed++) {
			const { swiss, players } = start(10, '', `${seed},1,1,1`);
			const results = new PRNG(`${seed},2,2,2`);
			assert.equal(swiss.getResults(), 'TournamentNotEnded');
			playToEnd(swiss, () => results.sample(['win', 'loss', 'draw']));
			const ranking = swiss.getResults();
			assert.equal(ranking.flat().length, players.length);
			const keys = ranking.map(group => group.map(player => [player.score, swiss.getBuchholz(player)]));
			for (const group of keys) {
				for (const key of group) assert.deepEqual(key, group[0], 'tied players have different records');
			}
			for (let i = 1; i < keys.length; i++) {
				const [score, buchholz] = keys[i][0];
				const [higherScore, higherBuchholz] = keys[i - 1][0];
				assert(score < higherScore || (score === higherScore && buchholz < higherBuchholz), `group ${i} is out of order`);
			}
		}
	});

	it('only offers matches whose players are not busy', () => {
		const { swiss } = start(4);
		const [[p1]] = swiss.getAvailableMatches();
		p1.isBusy = true;
		assert.equal(swiss.getAvailableMatches().length, 1);
		assert.equal(swiss.getAvailableMatches().flat().includes(p1), false);
	});

	it('reports errors the same way as the other generators', () => {
		const swiss = new Swiss('', new PRNG('1,2,3,4'));
		const players = makePlayers(4);
		assert.equal(swiss.getAvailableMatches(), 'BracketNotFrozen');
		assert.equal(swiss.setMatchResult([players[0], players[1]], 'win', [1, 0]), 'BracketNotFrozen');
		assert.equal(swiss.disqualifyUser(players[0]), 'BracketNotFrozen');

		swiss.freezeBracket(players);
		const [[p1, p2], [p3]] = swiss.getAvailableMatches();
		const stranger = makePlayers(1)[0];
		assert.equal(swiss.setMatchResult([p1, p2], 'forfeit', [1, 0]), 'InvalidMatchResult');
		assert.equal(swiss.setMatchResult([p1, stranger], 'win', [1, 0]), 'UserNotAdded');
		assert.equal(swiss.setMatchResult([p1, p3], 'win', [1, 0]), 'InvalidMatch');
		assert.equal(swiss.setMatchResult([p2, p1], 'win', [1, 0]), 'InvalidMatch');
		assert.equal(swiss.setMatchResult([p1, p2], 'win', [1, 0]), undefined);
		assert.equal(swiss.setMatchResult([p1, p2], 'win', [1, 0]), 'InvalidMatch');
	});

	it('shows a player list before the start and a crosstable in standings order after it', () => {
		const swiss = new Swiss('', new PRNG('1,2,3,4'));
		const players = makePlayers(4);
		assert.deepEqual(swiss.getPendingBracketData(players), { type: 'tree', rootNode: null });

		swiss.freezeBracket(players);
		const [finished, waiting] = swiss.getAvailableMatches();
		report(swiss, finished, 'win');
		const data = swiss.getBracketData();
		assert.equal(data.type, 'table');
		assert.deepEqual(data.tableHeaders.rows, data.tableHeaders.cols);
		assert.equal(data.tableHeaders.rows[0], finished[0], 'the only winner should be ranked first');
		assert.deepEqual(data.scores, data.tableHeaders.rows.map(player => player.score));

		const cellFor = ([p1, p2]) => {
			const rows = data.tableHeaders.rows;
			return data.tableContents[rows.indexOf(p1)][rows.indexOf(p2)];
		};
		assert.deepEqual(cellFor(finished), { state: 'finished', result: 'win', score: [1, 0] });
		assert.deepEqual(cellFor(waiting), { state: 'available' });
		assert.equal(data.tableContents.flat().filter(Boolean).length, 2, 'one cell per match');
	});

	it('pairs a large tournament with many rounds without an unbounded search', function () {
		this.timeout(10_000);
		// 64 players, 63 rounds: late rounds have few (or no) rematch-free pairings left.
		const { swiss, players } = start(64, '63');
		const startTime = Date.now();
		assert.equal(playToEnd(swiss, (p1, p2) => (p1.id < p2.id ? 'win' : 'loss')), 63);
		assert(Date.now() - startTime < 5000, `pairing took ${Date.now() - startTime}ms`);
		for (const round of swiss.rounds) {
			assert.equal(new Set(round.flatMap(match => [match.p1, match.p2])).size, players.length);
		}
	});
});
