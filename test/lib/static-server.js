'use strict';

/**
 * Characterization tests for StaticServer (lib/static-server.ts), the file
 * server behind the game server's HTTP port. Files come from a temporary
 * directory; requests and responses are minimal stand-ins for node's http
 * objects, so no port is opened.
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { StaticServer } = require('../../dist/lib/static-server');

describe('StaticServer', () => {
	let tmp, root;

	const request = (url, headers = {}, method = 'GET') => ({ url, headers, method });
	const response = () => {
		const res = new PassThrough();
		res.statusCode = null;
		res.headers = null;
		res.chunks = [];
		res.writeHead = (status, headers) => {
			res.statusCode = status;
			res.headers = headers;
		};
		res.on('data', chunk => res.chunks.push(chunk));
		res.body = () => Buffer.concat(res.chunks).toString();
		return res;
	};
	const get = async (server, url, headers, method) => {
		const res = response();
		const result = await server.serve(request(url, headers, method), res);
		return { result, res };
	};

	before(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-static-'));
		root = path.join(tmp, 'public');
		fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
		fs.mkdirSync(path.join(root, 'empty'));
		fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world');
		fs.writeFileSync(path.join(root, 'page.html'), '<p>page</p>');
		fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<p>docs index</p>');
		fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside the root');
	});
	after(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('givenAFileInTheRoot_whenRequested_streamsItWith200ContentTypeAndCacheHeaders', async () => {
		const { result, res } = await get(new StaticServer(root), '/hello.txt');
		assert.equal(result.status, 200);
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers['Content-Type'], 'text/plain;charset=utf-8');
		assert.equal(res.headers['Content-Length'], 11);
		assert.equal(res.headers['cache-control'], 'max-age=3600');
		assert.equal(res.headers['server'], 'node-static-vendored/1.0');
		assert.equal(res.body(), 'hello world');
	});

	it('givenADirectoryWithIndexHtml_whenRequestedWithTrailingSlash_servesTheIndex', async () => {
		const { result, res } = await get(new StaticServer(root), '/docs/');
		assert.equal(result.status, 200);
		assert.equal(res.body(), '<p>docs index</p>');
	});

	it('givenADirectoryWithIndexHtml_whenRequestedWithoutTrailingSlash_redirectsWith301', async () => {
		const { result, res } = await get(new StaticServer(root), '/docs');
		assert.equal(result.status, 301);
		assert.equal(res.headers['Location'], '/docs/');
	});

	it('givenADirectoryWithoutAnIndex_whenRequested_returns404', async () => {
		const { result } = await get(new StaticServer(root), '/empty/');
		assert.equal(result.status, 404);
	});

	it('givenAValidByteRange_whenRequested_returns206WithOnlyThoseBytes', async () => {
		const { result, res } = await get(new StaticServer(root), '/hello.txt', { range: 'bytes=0-4' });
		assert.equal(result.status, 206);
		assert.equal(res.headers['Content-Range'], 'bytes 0-4/11');
		assert.equal(res.body(), 'hello');
	});

	it('givenAByteRangeEndingPastTheFile_whenRequested_ignoresTheRangeAndReturnsTheWholeFile', async () => {
		const { result, res } = await get(new StaticServer(root), '/hello.txt', { range: 'bytes=0-999' });
		assert.equal(result.status, 200);
		assert.equal(res.headers['Content-Range'], undefined);
		assert.equal(res.body(), 'hello world');
	});

	it('givenADefaultExtension_whenRequestedWithoutIt_servesTheFileWithTheExtension', async () => {
		const { result, res } = await get(new StaticServer(root, { defaultExtension: 'html' }), '/page');
		assert.equal(result.status, 200);
		assert.equal(res.body(), '<p>page</p>');
	});

	it('givenAMatchingEtag_whenRequested_returns304WithoutABodyOrEntityHeaders', async () => {
		const server = new StaticServer(root);
		const first = await get(server, '/hello.txt');
		const { result, res } = await get(server, '/hello.txt', { 'if-none-match': first.res.headers['Etag'] });
		assert.equal(result.status, 304);
		assert.equal(res.headers['Content-Type'], undefined);
		assert.equal(res.body(), '');
	});

	it('givenAHeadRequest_whenRequested_returns200HeadersWithoutABody', async () => {
		const { result, res } = await get(new StaticServer(root), '/hello.txt', {}, 'HEAD');
		assert.equal(result.status, 200);
		assert.equal(res.headers['Content-Length'], 11);
		assert.equal(res.body(), '');
	});

	it('givenAMissingFile_whenRequested_returns404WithAPlainTextBody', async () => {
		const { result, res } = await get(new StaticServer(root), '/nope.txt');
		assert.equal(result.status, 404);
		assert.equal(res.body(), '404 Not Found');
	});

	it('givenMalformedPercentEncoding_whenRequested_returns400', async () => {
		const { result } = await get(new StaticServer(root), '/%E0%A4%A');
		assert.equal(result.status, 400);
	});

	it('givenAnEncodedPathEscapingTheRoot_whenRequested_returns403AndDoesNotServeTheFile', async () => {
		const { result, res } = await get(new StaticServer(root), '/..%2Foutside.txt');
		assert.equal(result.status, 403);
		assert.equal(res.body(), '403 Forbidden');
	});

	it('givenAnErrorCallbackReturningTrue_whenTheFileIsMissing_leavesTheResponseUntouched', async () => {
		const res = response();
		const seen = [];
		const result = await new StaticServer(root).serve(request('/nope.txt'), res, r => {
			seen.push(r.status);
			return true;
		});
		assert.equal(result.status, 404);
		assert.deepEqual(seen, [404]);
		assert.equal(res.statusCode, null);
	});
});
