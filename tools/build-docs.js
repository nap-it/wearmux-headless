#!/usr/bin/env node
// Generate the API reference without loading the wearable SDK or native addons.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'jsdoc.json'), 'utf8'));
const output = path.resolve(root, config.opts.destination);
// Detached CI checkouts use the exact commit; local builds use their branch.
const gitBranch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const sourceRef = process.env.DOCUMENTATION_REF || gitBranch.stdout.trim() || gitCommit.stdout.trim() || 'main';
const repository = `https://github.com/nap-it/wearmux-headless/blob/${encodeURIComponent(sourceRef)}/`;
const guides = {
    overview: ['README.md', 'Project overview and quick start'],
    'technical-guide': ['docs/technical-guide.md', 'Technical guide'],
    integration: ['docs/api/integration.md', 'Developer integration'],
    'message-contract': ['docs/api/message-contract.md', 'Message contracts'],
    documentation: ['docs/documentation.md', 'Documentation maintenance'],
    camera: ['camera/README.md', 'Camera'],
    microphone: ['microphone/README.md', 'Microphone'],
    sensors: ['sensors/README.md', 'Sensors'],
    display: ['display/README.md', 'Display'],
    consumers: ['examples/consumers/README.md', 'External consumers'],
    wearos: ['docs/api/wearos.md', 'Direct Wear OS developer guide'],
};
const guideByPath = new Map(Object.entries(guides).map(([name, [file]]) => [file, name]));

// Keep the Markdown guides as the single source. Links to included guides become
// tutorial links; other repository links keep their source location on GitHub.
function siteMarkdown(file) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    let inFence = false;
    return source.split('\n').map((line) => {
        if (/^\s*```/.test(line)) inFence = !inFence;
        if (inFence || /^\s*```/.test(line)) return line;
        return line.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (match, before, target, after) => {
            if (/^(?:[a-z]+:|\/\/|#)/i.test(target)) return match;
            const [pathname, anchor = ''] = target.split('#');
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), pathname));
            if (before.startsWith('!') && resolved.startsWith('docs/images/')) {
                return `${before}images/${path.posix.basename(resolved)}${after}`;
            }
            const guide = guideByPath.get(resolved);
            const url = guide ? `tutorial-${guide}.html` : `${repository}${resolved}`;
            return `${before}${url}${anchor ? `#${anchor}` : ''}${after}`;
        });
    }).join('\n');
}

function jsdoc(args) {
    const result = spawnSync(process.execPath, [require.resolve('jsdoc/jsdoc.js'), ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stderr.trim()) {
        throw new Error(result.stderr || result.stdout || `JSDoc exited with status ${result.status}`);
    }
    return result.stdout;
}

function checkApi(doclets) {
    const expectedClasses = [
        'DeviceManager', 'DeviceFleet', 'DeviceSession', 'ActionDispatcher',
        'MqttManager', 'MqttSubscriber', 'ZenohManager', 'ZenohSubscriber',
        'Config', 'CameraSession', 'MicrophoneSession', 'RtspPublisher',
        'SensorManager', 'DisplayManager', 'TextDisplay', 'PromptDisplay',
        'WearOsDevice', 'WearOsServer',
    ];
    for (const name of expectedClasses) {
        if (!doclets.some((item) => item.kind === 'class' && item.longname === name && !item.undocumented)) {
            throw new Error(`Missing documented API class: ${name}`);
        }
    }
    // Public methods of the selected classes must carry source documentation.
    const missing = doclets.filter((item) => item.kind === 'function' && item.meta?.code?.type === 'MethodDefinition' &&
        expectedClasses.includes(item.memberof) && !item.name.startsWith('_') &&
        item.access !== 'private' && item.undocumented);
    if (missing.length) throw new Error(`Undocumented public methods: ${missing.map((item) => item.longname).join(', ')}`);
    const names = new Set(doclets.map((item) => item.longname));
    for (const item of doclets) {
        for (const match of (item.comment || '').matchAll(/\{@(link|tutorial)\s+([^\s}|]+)/g)) {
            const [, kind, name] = match;
            if (kind === 'tutorial' ? !guides[name] : !names.has(name) && !/^https?:/.test(name)) {
                throw new Error(`Unresolved ${kind} ${name} in ${item.longname}`);
            }
        }
    }
}

function checkSite() {
    const files = fs.readdirSync(output).filter((file) => file.endsWith('.html'));
    const htmlByFile = new Map(files.map((file) => [file, fs.readFileSync(path.join(output, file), 'utf8')]));
    for (const file of files) {
        const html = htmlByFile.get(file);
        for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
            if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
            const [urlPath, fragment] = target.split('#');
            const pathname = decodeURIComponent(urlPath.split('?')[0]);
            if (pathname && !fs.existsSync(path.resolve(output, pathname))) {
                throw new Error(`Broken local site link in ${file}: ${target}`);
            }
            // Source line anchors are added by JSDoc's linenumber.js at runtime.
            if (fragment && !/^line\d+$/.test(fragment)) {
                const linkedHtml = htmlByFile.get(pathname || file);
                const id = decodeURIComponent(fragment);
                if (linkedHtml && !linkedHtml.includes(`id="${id}"`)) {
                    throw new Error(`Broken site anchor in ${file}: ${target}`);
                }
            }
        }
    }
    console.log(`Validated ${files.length} HTML pages, local file links, and section anchors.`);
}

function main() {
    if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: npm run docs [-- --check]');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wearmux-jsdoc-'));
    try {
        const tutorials = path.join(temporary, 'tutorials');
        fs.mkdirSync(tutorials);
        for (const [name, [file, title]] of Object.entries(guides)) {
            fs.writeFileSync(path.join(tutorials, `${name}.md`), siteMarkdown(file));
            fs.writeFileSync(path.join(tutorials, `${name}.json`), JSON.stringify({ title }));
        }
        const readme = path.join(temporary, 'index.md');
        fs.writeFileSync(readme, siteMarkdown('docs/api/index.md'));
        const args = ['-c', 'jsdoc.json', '--readme', readme, '--tutorials', tutorials];
        const doclets = JSON.parse(jsdoc([...args, '-X']));
        checkApi(doclets);
        fs.rmSync(output, { recursive: true, force: true });
        jsdoc(args);
        fs.cpSync(path.join(root, 'docs/images'), path.join(output, 'images'), { recursive: true });
        fs.writeFileSync(path.join(output, '.nojekyll'), '');
        checkSite();
        console.log(`WearMux API documentation: ${path.relative(root, output)}/index.html`);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
