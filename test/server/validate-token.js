'use strict';

/**
 * Characterization tests for User#validateToken (server/users.ts).
 * A throwaway RSA key pair stands in for the login server's, so real
 * signatures go through the real verifier (in-process in tests).
 */

const assert = require('assert').strict;
const crypto = require('crypto');

const { makeUser, destroyUser } = require('../users-utils');

describe('User#validateToken', () => {
	const NOW_SECONDS = 1_700_000_000;
	const CHALLENGE = '4|deadbeefcafe';
	const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const CONFIG_KEYS = ['loginserverpublickey', 'loginserverkeyalgo', 'legalhosts', 'tokenexpiry', 'noguestsecurity'];
	let savedConfig, realNow, realWarn, realDebug;
	let user, sent;

	const sign = data => {
		const signer = crypto.createSign(Config.loginserverkeyalgo);
		signer.update(data);
		return signer.sign(privateKey, 'hex');
	};
	const assertion = ({
		challenge = CHALLENGE, userid = user.id, userType = '2', date = NOW_SECONDS, host = 'localhost', extra = [],
	} = {}) => [challenge, userid, userType, date, host, ...extra].join(',');
	const token = (data, signature = sign(data)) => `${data};${signature}`;
	const validate = (tok, name = user.name) => user.validateToken(tok, name, toID(name), user.connections[0]);

	beforeEach(() => {
		savedConfig = Object.fromEntries(CONFIG_KEYS.map(k => [k, Config[k]]));
		Config.loginserverpublickey = publicKey;
		Config.loginserverkeyalgo = 'RSA-SHA1';
		Config.legalhosts = undefined;
		Config.tokenexpiry = undefined;
		Config.noguestsecurity = false;

		realNow = Date.now;
		Date.now = () => NOW_SECONDS * 1000;
		// validateToken logs failures through Monitor; keep test output quiet
		realWarn = Monitor.warn;
		realDebug = Monitor.debug;
		Monitor.warn = Monitor.debug = () => {};

		user = makeUser('Token Tester');
		user.connections[0].challenge = CHALLENGE;
		sent = [];
		user.send = msg => sent.push(msg);
	});
	afterEach(() => {
		Object.assign(Config, savedConfig);
		Date.now = realNow;
		Monitor.warn = realWarn;
		Monitor.debug = realDebug;
		delete user.send;
		destroyUser(user);
	});

	it('givenACorrectlySignedAssertion_whenValidated_returnsTheSignedUserTypeAndSendsNothing', async () => {
		assert.equal(await validate(token(assertion())), '2');
		assert.deepEqual(sent, []);
	});

	it('givenAnAssertionWithExtraFields_whenValidated_acceptsItAndStoresFieldsFiveToSevenOnTheUser', async () => {
		assert.equal(await validate(token(assertion({ extra: ['a', 'b', 'c'] }))), '2');
		assert.deepEqual([user.s1, user.s2, user.s3], ['a', 'b', 'c']);
	});

	it('givenAnAssertionExactlyTokenexpirySecondsOld_whenValidated_stillAcceptsIt', async () => {
		const expiry = 25 * 60 * 60; // default when Config.tokenexpiry is unset
		assert.equal(await validate(token(assertion({ date: NOW_SECONDS - expiry }))), '2');
	});

	it('givenAnAssertionOneSecondPastTokenexpiry_whenValidated_rejectsItAsStale', async () => {
		const expiry = 25 * 60 * 60;
		assert.equal(await validate(token(assertion({ date: NOW_SECONDS - expiry - 1 }))), null);
		assert.match(sent[0], /^\|nametaken\|Token Tester\|Your assertion is stale/);
	});

	it('givenAnAssertionDatedInTheFuture_whenPastTokenexpiry_rejectsItAsStaleToo', async () => {
		const expiry = 25 * 60 * 60;
		assert.equal(await validate(token(assertion({ date: NOW_SECONDS + expiry + 1 }))), null);
		assert.match(sent[0], /stale/);
	});

	it('givenAnAssertionWithOnlyFourFields_whenValidated_rejectsItAsCorrupt', async () => {
		const data = [CHALLENGE, user.id, '2', NOW_SECONDS].join(',');
		assert.equal(await validate(token(data)), null);
		assert.match(sent[0], /corrupt or incorrect/);
	});

	it('givenAnAssertionSignedForAnotherUserid_whenValidated_rejectsItAsNotMatchingTheName', async () => {
		assert.equal(await validate(token(assertion({ userid: 'someoneelse' }))), null);
		assert.match(sent[0], /doesn't match your new username/);
	});

	it('givenAnAssertionSignedForAnotherConnectionsChallenge_whenValidated_rejectsIt', async () => {
		assert.equal(await validate(token(assertion({ challenge: '4|otherchallenge' }))), null);
		assert.match(sent[0], /doesn't match your authentication token/);
	});

	it('givenAnAssertionEditedAfterSigning_whenValidated_rejectsTheSignature', async () => {
		const original = assertion();
		const forged = assertion({ userType: '3' }); // try to upgrade to system operator
		assert.equal(await validate(token(forged, sign(original))), null);
		assert.match(sent[0], /verification signature was invalid/);
	});

	it('givenAnAssertionForAHostNotInLegalhosts_whenValidated_rejectsItAsTheWrongServer', async () => {
		Config.legalhosts = ['play.example.org'];
		assert.equal(await validate(token(assertion({ host: 'evil.example.org' }))), null);
		assert.match(sent[0], /assertion is for the wrong server\. This server is play\.example\.org/);
	});

	it('givenAnEmptyToken_whenValidated_rejectsItAsInvalid', async () => {
		assert.equal(await validate(''), null);
		assert.match(sent[0], /authentication token was invalid/);
	});

	it('givenATokenWithNoAssertionBeforeTheSemicolon_whenValidated_rejectsItAsInvalid', async () => {
		assert.equal(await validate(';abcdef'), null);
		assert.match(sent[0], /authentication token was invalid/);
	});

	it('givenAConnectionThatWasNeverSentAChallenge_whenValidated_returnsNullWithoutTellingTheUser', async () => {
		user.connections[0].challenge = '';
		assert.equal(await validate(token(assertion())), null);
		assert.deepEqual(sent, []);
	});

	it('givenNoguestsecurityAndNoToken_whenValidated_treatsTheUserAsUnregistered', async () => {
		Config.noguestsecurity = true;
		assert.equal(await validate(''), '1');
		assert.deepEqual(sent, []);
	});
});
