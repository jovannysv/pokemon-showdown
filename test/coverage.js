/**
 * Coverage entry point
 *
 * Runs the normal mocha suite (same spec/grep as .mocharc.json) inside a
 * single node:test test, so Node's built-in V8 coverage can measure it.
 * No extra dependencies are needed. Usage:
 *
 *   node --test --enable-source-maps --experimental-test-coverage \
 *     --test-coverage-include="{server,sim,lib,data,config}/**" test/coverage.js
 */
'use strict';

const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');

const root = path.resolve(__dirname, '..');
const mocharc = JSON.parse(fs.readFileSync(path.join(root, '.mocharc.json'), 'utf8'));

test('mocha suite', { timeout: 30 * 60 * 1000 }, async () => {
	const mocha = new Mocha({
		ui: mocharc.ui,
		reporter: mocharc.reporter,
		grep: new RegExp(mocharc.grep),
		timeout: 8000,
	});
	// test/main.js must load first: it builds dist/ and sets up globals
	const seen = new Set();
	for (const pattern of mocharc.spec) {
		for (const file of fs.globSync(pattern, { cwd: root }).sort()) {
			const abs = path.join(root, file);
			if (seen.has(abs)) continue;
			seen.add(abs);
			mocha.addFile(abs);
		}
	}
	await mocha.loadFilesAsync();
	const failures = await new Promise(resolve => {
		mocha.run(resolve);
	});
	// equivalent of `exit: true` in .mocharc.json: the suite leaves timers and sockets open,
	// so force the process to end once node:test has had time to report the result
	setTimeout(() => process.exit(), 2000);
	if (failures) throw new Error(`${failures} mocha test(s) failed`);
});
