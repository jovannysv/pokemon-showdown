'use strict';

const assert = require('assert').strict;
const { makeUser } = require('../../users-utils');

describe('Swiss tournaments through /tour commands', () => {
	let room, staff, players, battles, replies, originalPrep, originalCreate;
	const run = (user, command) => Chat.parse(command, room, user, user.connections[0]);
	const tour = () => room.game;
	const isJoined = user => {
		const updates = [];
		tour().updateFor(user, { sendTo: (target, message) => updates.push(message) });
		return Object.assign({}, ...updates.filter(m => m.startsWith('|tournament|update|'))
			.map(m => JSON.parse(m.slice('|tournament|update|'.length)))).isJoined;
	};

	beforeEach(() => {
		battles = [];
		replies = [];
		room = Rooms.createChatRoom('swisstournamenttest', 'Swiss tournament test', { isPrivate: true });
		staff = makeUser('Swiss Staff', '127.0.2.1');
		staff.tempGroup = '~';
		staff.joinRoom(room.roomid);
		staff.connections[0].sendTo = (target, message) => replies.push(message);
		players = [0, 1, 2, 3, 4].map(i => {
			const user = makeUser(`Swiss Player ${i}`, `127.0.2.${i + 2}`);
			user.battleSettings.team = 'Pikachu||||thunderbolt|||||||';
			user.joinRoom(room.roomid);
			return user;
		});
		originalPrep = Ladders.Ladder.prototype.prepBattle;
		Ladders.Ladder.prototype.prepBattle = async function (connection) {
			return new Ladders.BattleReady(connection.user.id, this.formatid, { ...connection.user.battleSettings });
		};
		originalCreate = Rooms.createBattle;
		Rooms.createBattle = options => {
			const battle = {
				roomid: `battle-swisstournamenttest-${battles.length + 1}`,
				p1: options.players[0].user, p2: options.players[1].user,
				game: { score: [1, 0], startTimer() {} },
				setParent() {}, addRaw() { return this; }, update() {},
			};
			battles.push(battle);
			return battle;
		};
	});

	afterEach(() => {
		Ladders.Ladder.prototype.prepBattle = originalPrep;
		Rooms.createBattle = originalCreate;
		if (room.game && !room.game.ended) room.game.forceEnd();
		room.destroy();
		for (const user of [staff, ...players]) {
			user.disconnectAll();
			user.destroy();
		}
	});

	it('runs from /tour create to the final standings, one round at a time', async () => {
		await run(staff, '/tour create gen9customgame, swiss');
		assert.equal(tour().generator.name, 'Swiss');
		for (const user of players) await run(user, '/tour join');
		await run(staff, '/tour start');
		assert.equal(tour().generator.totalRounds, 3, '5 players need 3 rounds');

		const finished = new Set();
		for (let round = 1; round <= 3; round++) {
			for (const user of players) await run(user, '/tour ready');
			const roundBattles = battles.filter(battle => !finished.has(battle));
			assert.equal(roundBattles.length, 2, `round ${round}: two battles and a bye`);

			// Ending one battle must not pair the next round while the other is still going.
			tour().onBattleWin(roundBattles[0], roundBattles[0].p1.id);
			finished.add(roundBattles[0]);
			for (const user of players) await run(user, '/tour ready');
			assert.equal(battles.length, finished.size + 1, `round ${round + 1} started early`);

			tour().onBattleWin(roundBattles[1], roundBattles[1].p1.id);
			finished.add(roundBattles[1]);
		}

		assert.equal(room.game, null, 'the tournament should be over');
		const pairs = battles.map(({ p1, p2 }) => (p1.id < p2.id ? `${p1.id}-${p2.id}` : `${p2.id}-${p1.id}`));
		assert.equal(new Set(pairs).size, pairs.length, 'nobody should play the same opponent twice');

		const endLine = room.log.log.find(line => line.startsWith('|tournament|end|'));
		const end = JSON.parse(endLine.slice('|tournament|end|'.length));
		assert.equal(end.generator, 'Swiss');
		assert.equal(end.bracketData.type, 'table');
		assert.deepEqual(new Set(end.results.flat()), new Set(players.map(user => user.name)));
		assert.equal(end.results.flat().length, players.length);
		assert.equal(end.results[0].length, 1, 'only one player can win every round');
	});

	it('accepts a number of rounds and can be chosen with /tour settype', async () => {
		await run(staff, '/tour create gen9customgame, elimination');
		await run(staff, '/tour settype swiss, 0, 4');
		assert.equal(tour().generator.name, '4-Round Swiss');
	});

	it('rejects a number of rounds that is not a positive integer', async () => {
		await run(staff, '/tour create gen9customgame, swiss, 8, zero');
		assert.equal(room.game, null);
		assert(replies.some(reply => reply.includes('positive integer')), replies.join('\n'));
	});

	it('lists Swiss among the valid tournament types', async () => {
		await run(staff, '/tour create gen9customgame, knockout');
		assert(replies.some(reply => /Valid types: .*\bswiss\b/.test(reply)), replies.join('\n'));
	});

	it('tells a disqualified player that they have left the tournament', async () => {
		await run(staff, '/tour create gen9customgame, swiss');
		for (const user of players) await run(user, '/tour join');
		await run(staff, '/tour start');
		assert.equal(isJoined(players[0]), true);
		await run(staff, `/tour dq ${players[0].name}`);
		assert.equal(isJoined(players[0]), false);
		assert.equal(isJoined(players[1]), true);
	});
});
