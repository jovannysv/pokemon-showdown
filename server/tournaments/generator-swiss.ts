import { Utils } from '../../lib';
import { PRNG } from '../../sim/prng';
import type { TournamentPlayer } from './index';

/**
 * Pairing runs on the main process, so the search for a pairing without
 * rematches gives up after this many steps and accepts rematches instead.
 */
const MAX_PAIRING_SEARCH_STEPS = 10_000;

interface SwissMatch {
	p1: TournamentPlayer;
	/** null = p1 has a bye this round */
	p2: TournamentPlayer | null;
	state: 'available' | 'finished';
	result: 'win' | 'loss' | 'draw' | '';
	score: number[] | null;
}

/**
 * Swiss-system tournament: everyone plays every round, each round pairs
 * players with similar records who haven't played each other, and the
 * final standings are ordered by score, then by Buchholz score (the sum
 * of the scores of every opponent played).
 *
 * Rounds are only known one at a time: the next round is paired as soon
 * as every match in the current round is finished.
 */
export class Swiss {
	readonly name: string;
	readonly isDrawingSupported: boolean;
	/** 0 = choose automatically when the bracket is frozen */
	readonly requestedRounds: number;
	readonly prng: PRNG;
	isBracketFrozen: boolean;
	isEnded: boolean;
	players: TournamentPlayer[];
	/** players in random order; breaks ties in the standings */
	seedOrder: TournamentPlayer[];
	totalRounds: number;
	/** rounds[0] is round 1; the last entry is the current round */
	rounds: SwissMatch[][];
	constructor(rounds: string, prng?: PRNG) {
		this.requestedRounds = 0;
		if (rounds) {
			this.requestedRounds = Number(rounds);
			if (!Number.isInteger(this.requestedRounds) || this.requestedRounds < 1) {
				throw new Chat.ErrorMessage(`The number of rounds in a Swiss tournament must be a positive integer.`);
			}
		}
		this.name = this.requestedRounds ? `${this.requestedRounds}-Round Swiss` : "Swiss";
		this.isDrawingSupported = true;
		this.prng = prng || new PRNG();
		this.isBracketFrozen = false;
		this.isEnded = false;
		this.players = [];
		this.seedOrder = [];
		this.totalRounds = 0;
		this.rounds = [];
	}

	getPendingBracketData(players: TournamentPlayer[]) {
		return {
			type: 'tree',
			rootNode: null,
		};
	}
	getBracketData() {
		const standings = this.getStandings();
		const indexOf = new Map(standings.map((player, i) => [player, i]));
		const tableContents: (AnyObject | null)[][] = standings.map(() => standings.map(() => null));
		for (const match of this.rounds.flat()) {
			if (!match.p2) continue;
			const cell: AnyObject = { state: match.state };
			if (match.state === 'finished') {
				cell.result = match.result;
				cell.score = match.score!.slice();
			}
			tableContents[indexOf.get(match.p1)!][indexOf.get(match.p2)!] = cell;
		}
		return {
			type: 'table',
			tableHeaders: {
				cols: standings.slice(),
				rows: standings.slice(),
			},
			tableContents,
			scores: standings.map(player => player.score),
		};
	}
	freezeBracket(players: TournamentPlayer[]) {
		this.players = players;
		this.isBracketFrozen = true;
		this.seedOrder = players.slice();
		this.prng.shuffle(this.seedOrder);
		// the fewest rounds after which at most one player can have won every match
		this.totalRounds = this.requestedRounds || Math.max(1, Math.ceil(Math.log2(players.length)));
		this.startNextRound();
	}

	disqualifyUser(player: TournamentPlayer) {
		if (!this.isBracketFrozen) return 'BracketNotFrozen';

		const match = this.getCurrentRound().find(m => m.state === 'available' && (m.p1 === player || m.p2 === player));
		if (match) {
			const playerIsP1 = match.p1 === player;
			const opponent = playerIsP1 ? match.p2! : match.p1;
			match.state = 'finished';
			match.result = playerIsP1 ? 'loss' : 'win';
			match.score = playerIsP1 ? [0, 1] : [1, 0];
			opponent.score += 1;
		}

		player.game.setPlayerUser(player, null);
		this.startNextRoundIfFinished();
	}

	getAvailableMatches() {
		if (!this.isBracketFrozen) return 'BracketNotFrozen';

		const matches: [TournamentPlayer, TournamentPlayer][] = [];
		for (const match of this.getCurrentRound()) {
			if (match.state !== 'available') continue;
			const p2 = match.p2!;
			if (!match.p1.isBusy && !p2.isBusy) matches.push([match.p1, p2]);
		}
		return matches;
	}
	setMatchResult([p1, p2]: [TournamentPlayer, TournamentPlayer], result: string, score: number[]) {
		if (!this.isBracketFrozen) return 'BracketNotFrozen';

		if (result !== 'win' && result !== 'loss' && result !== 'draw') return 'InvalidMatchResult';

		if (!this.players.includes(p1) || !this.players.includes(p2)) return 'UserNotAdded';

		const match = this.getCurrentRound().find(m => m.state === 'available' && m.p1 === p1 && m.p2 === p2);
		if (!match) return 'InvalidMatch';

		match.state = 'finished';
		match.result = result;
		match.score = score.slice();
		this.startNextRoundIfFinished();
	}

	isTournamentEnded() {
		return this.isBracketFrozen && this.isEnded;
	}

	getResults() {
		if (!this.isTournamentEnded()) return 'TournamentNotEnded';

		// Scores are multiples of 0.5, so equal records produce equal keys.
		const results: TournamentPlayer[][] = [];
		let previousRecord = '';
		for (const player of this.getStandings()) {
			const record = [player.isDisqualified ? 1 : 0, player.score, this.getBuchholz(player)].join();
			if (record !== previousRecord) results.push([]);
			results[results.length - 1].push(player);
			previousRecord = record;
		}
		return results;
	}

	getCurrentRound(): SwissMatch[] {
		return this.rounds[this.rounds.length - 1] || [];
	}
	getOpponents(player: TournamentPlayer) {
		const opponents: TournamentPlayer[] = [];
		for (const match of this.rounds.flat()) {
			if (!match.p2) continue;
			if (match.p1 === player) opponents.push(match.p2);
			if (match.p2 === player) opponents.push(match.p1);
		}
		return opponents;
	}
	getBuchholz(player: TournamentPlayer) {
		let buchholz = 0;
		for (const opponent of this.getOpponents(player)) buchholz += opponent.score;
		return buchholz;
	}
	/**
	 * Disqualified players last, then by score, Buchholz score, and seed.
	 */
	getStandings() {
		const sortKeys = new Map(this.seedOrder.map((player, seed) => [player, [
			player.isDisqualified ? 1 : 0, -player.score, -this.getBuchholz(player), seed,
		]]));
		return Utils.sortBy(this.seedOrder.slice(), player => sortKeys.get(player)!);
	}

	startNextRoundIfFinished() {
		if (this.isEnded || this.getCurrentRound().some(match => match.state !== 'finished')) return;
		this.startNextRound();
	}
	startNextRound() {
		const unpaired = this.getStandings().filter(player => !player.isDisqualified);
		if (this.rounds.length >= this.totalRounds || unpaired.length < 2) {
			this.isEnded = true;
			return;
		}

		const round: SwissMatch[] = [];
		let byePlayer: TournamentPlayer | null = null;
		if (unpaired.length % 2) {
			const hadBye = new Set(this.rounds.flat().filter(match => !match.p2).map(match => match.p1));
			byePlayer = unpaired.findLast(player => !hadBye.has(player)) || unpaired[unpaired.length - 1];
			unpaired.splice(unpaired.indexOf(byePlayer), 1);
		}

		const pairings = this.pairWithoutRematches(unpaired) || this.pairPreferringNewOpponents(unpaired);
		for (const [p1, p2] of pairings) {
			round.push({ p1, p2, state: 'available', result: '', score: null });
		}
		if (byePlayer) {
			byePlayer.score += 1;
			round.push({ p1: byePlayer, p2: null, state: 'finished', result: 'win', score: null });
		}
		this.rounds.push(round);
	}
	/**
	 * Pairs each player, from the top of the standings down, with the
	 * highest-ranked player they haven't played yet, backtracking when that
	 * leaves the rest unpairable. Returns null if there is no such pairing,
	 * or if finding one takes too long.
	 */
	pairWithoutRematches(players: TournamentPlayer[]) {
		const previousOpponents = new Map(players.map(player => [player, new Set(this.getOpponents(player))]));
		let steps = 0;
		const search = (unpaired: TournamentPlayer[]): [TournamentPlayer, TournamentPlayer][] | null => {
			if (!unpaired.length) return [];
			const [player, ...candidates] = unpaired;
			for (const [i, opponent] of candidates.entries()) {
				if (++steps > MAX_PAIRING_SEARCH_STEPS) return null;
				if (previousOpponents.get(player)!.has(opponent)) continue;
				const rest = search(candidates.filter((candidate, j) => j !== i));
				if (rest) return [[player, opponent], ...rest];
			}
			return null;
		};
		return search(players);
	}
	/**
	 * Always succeeds: like pairWithoutRematches, but never backtracks, and
	 * accepts a rematch when no new opponent is left.
	 */
	pairPreferringNewOpponents(players: TournamentPlayer[]) {
		const pairings: [TournamentPlayer, TournamentPlayer][] = [];
		const unpaired = players.slice();
		while (unpaired.length >= 2) {
			const player = unpaired.shift()!;
			const previousOpponents = new Set(this.getOpponents(player));
			const index = Math.max(0, unpaired.findIndex(candidate => !previousOpponents.has(candidate)));
			pairings.push([player, unpaired.splice(index, 1)[0]]);
		}
		return pairings;
	}
}
