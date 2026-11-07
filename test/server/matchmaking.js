'use strict';

/**
 * Characterization tests for Ladder#matchmakingOK (server/ladders.ts).
 * These pin down what the pairing check does today, including behaviour
 * that may not be intended (see the noipchecks test).
 */

const assert = require('assert').strict;

const { Ladders } = require('../../dist/server/ladders');
const { makeUser, destroyUser } = require('../users-utils');

describe('Ladder#matchmakingOK', () => {
	const NOW = 1_700_000_000_000;
	let realNow;
	let users = [];

	const user = (name, ip) => {
		const u = makeUser(name, ip);
		users.push(u);
		return u;
	};
	const ready = (u, formatid, rating, time = NOW) => {
		const search = new Ladders.BattleReady(u.id, formatid, u.battleSettings, rating);
		search.time = time;
		return search;
	};
	const pair = (formatid, [u1, r1], [u2, r2], searchTime = NOW) => Ladders(formatid).matchmakingOK([
		[ready(u1, formatid, r1, searchTime), u1],
		[ready(u2, formatid, r2, searchTime), u2],
	]);

	before(() => {
		Dex.includeData();
	});
	beforeEach(() => {
		realNow = Date.now;
		Date.now = () => NOW;
	});
	afterEach(() => {
		Date.now = realNow;
		Config.noipchecks = false;
		for (const u of users) destroyUser(u);
		users = [];
	});

	it('givenTwoUsersOnDifferentIpsWithEqualRatings_whenPaired_matchesAndRecordsEachOtherAsLastMatch', () => {
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');

		assert.equal(pair('gen7ou', [a, 1500], [b, 1500]), true);
		assert.equal(a.lastMatch, b.id);
		assert.equal(b.lastMatch, a.id);
	});

	it('givenANonCurrentGenFormat_whenRatingGapIsExactly100_matches', () => {
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair('gen7ou', [a, 1500], [b, 1600]), true);
	});

	it('givenANonCurrentGenFormat_whenRatingGapIs101_rejectsAndLeavesLastMatchUnset', () => {
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair('gen7ou', [a, 1500], [b, 1601]), false);
		assert.equal(a.lastMatch, '');
	});

	it('givenTheCurrentGenOuFormat_whenRatingGapIs50Or51_usesTheTighterRangeOf50', () => {
		const format = `gen${Dex.gen}ou`;
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair(format, [a, 1500], [b, 1550]), true);

		const c = user('Matcher C', '10.0.0.3');
		const d = user('Matcher D', '10.0.0.4');
		assert.equal(pair(format, [c, 1500], [d, 1551]), false);
	});

	it('givenASearchWaiting30Seconds_whenRatingGapIs200Or201_widensTheRangeByOnePointPer300ms', () => {
		const started = NOW - 30_000; // 100 + 30000 / 300 = 200
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair('gen7ou', [a, 1000], [b, 1200], started), true);

		const c = user('Matcher C', '10.0.0.3');
		const d = user('Matcher D', '10.0.0.4');
		assert.equal(pair('gen7ou', [c, 1000], [d, 1201], started), false);
	});

	it('givenASearchWaitingAnHour_whenRatingGapIs600Or601_capsTheRangeAt600', () => {
		const started = NOW - 60 * 60 * 1000;
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair('gen7ou', [a, 1000], [b, 1600], started), true);

		const c = user('Matcher C', '10.0.0.3');
		const d = user('Matcher D', '10.0.0.4');
		assert.equal(pair('gen7ou', [c, 1000], [d, 1601], started), false);
	});

	it('givenTwoUsersOnTheSameIp_whenPaired_rejects', () => {
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.1');
		assert.equal(pair('gen7ou', [a, 1500], [b, 1500]), false);
		assert.equal(a.lastMatch, '');
	});

	it('givenTheSameUserTwice_whenPaired_rejects', () => {
		const a = user('Matcher A', '10.0.0.1');
		const formatid = 'gen7ou';
		const result = Ladders(formatid).matchmakingOK([
			[ready(a, formatid, 1500), a],
			[ready(a, formatid, 1500), a],
		]);
		assert.equal(result, false);
	});

	it('givenTwoUsersWhoWereJustMatched_whenPairedAgain_rejectsTheImmediateRematch', () => {
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.2');
		assert.equal(pair('gen7ou', [a, 1500], [b, 1500]), true);
		assert.equal(pair('gen7ou', [a, 1500], [b, 1500]), false);
	});

	it('givenNoipchecksEnabled_whenSameIpRematchFarApartInRating_stillMatches', () => {
		// Config.noipchecks skips the IP check, the rematch check AND the rating range
		Config.noipchecks = true;
		const a = user('Matcher A', '10.0.0.1');
		const b = user('Matcher B', '10.0.0.1');
		a.lastMatch = b.id;
		assert.equal(pair('gen7ou', [a, 1000], [b, 3000]), true);
		assert.equal(a.lastMatch, b.id);
		assert.equal(b.lastMatch, a.id);
	});
});
