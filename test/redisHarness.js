// A real, disposable Redis plus a small Upstash-compatible HTTP adapter.
// No production credentials or application data are used by these tests.
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const exec = promisify(execFile);

const binary = process.env.CHECKIN_TEST_REDIS_BINARY || 'redis-server';
const cli = process.env.CHECKIN_TEST_REDIS_CLI || (binary.includes('/') ? path.join(path.dirname(binary), 'redis-cli') : 'redis-cli');
const available = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0 &&
    spawnSync(cli, ['--version'], { stdio: 'ignore' }).status === 0;

async function startRedisHarness() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'checkin-test-'));
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
    try {
        await new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                child.removeListener('error', finish);
                error ? reject(error) : resolve();
            };
            const timer = setTimeout(() => finish(new Error('Test Redis did not start')), 5000);
            child.once('error', finish);
            child.once('exit', code => finish(new Error('Test Redis exited with code ' + code)));
            function tryConnect() {
                if (finished) return;
                const connection = net.connect({ host: '127.0.0.1', port });
                connection.once('connect', () => { connection.end(); finish(); });
                connection.once('error', () => { connection.destroy(); if (!finished) setTimeout(tryConnect, 30); });
            }
            tryConnect();
        });
    } catch (error) {
        child.kill('SIGTERM');
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
    const harness = { commands: [], fail: false };
    const encode = value => Array.isArray(value) ? value.map(encode) : typeof value === 'string' ? Buffer.from(value).toString('base64') : value;
    async function command(args) {
        harness.commands.push(args.map(String));
        if (harness.fail) return { error: 'Injected test storage failure' };
        const { stdout } = await exec(cli, ['--json', '-h', '127.0.0.1', '-p', String(port), ...args.map(String)]);
        if (stdout.startsWith('error:')) return { error: stdout.trim() };
        let result = JSON.parse(stdout);
        // redis-cli's JSON representation uses a map for HGETALL; Upstash uses
        // alternating fields/values on its REST wire protocol.
        if (String(args[0]).toLowerCase() === 'hgetall' && result && !Array.isArray(result)) result = Object.entries(result).flat();
        return { result: encode(result) };
    }
    const server = http.createServer(async (req, res) => {
        try {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const args = JSON.parse(raw);
            const result = req.url === '/pipeline'
                ? await Promise.all(args.map(command))
                : await command(args);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    harness.url = `http://127.0.0.1:${server.address().port}`;
    harness.close = async () => {
        await new Promise(resolve => server.close(resolve));
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
        await rm(dir, { recursive: true, force: true });
    };
    return harness;
}

module.exports = { available, startRedisHarness };
