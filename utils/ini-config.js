const fs = require("fs");
const path = require("path");

function stripInlineComment(value) {
    const match = value.match(/\s[;#]/);
    if (!match || match.index == null) return value;
    return value.slice(0, match.index);
}

function parseIni(content) {
    const lines = content.split(/\r?\n/);
    const result = { _env: {}, _scripts: [] };
    let section = null;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#")) continue;

        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            section = sectionMatch[1].toLowerCase();
            continue;
        }

        const idx = line.indexOf("=");
        if (idx === -1) continue;

        const key = line.slice(0, idx).trim();
        const value = stripInlineComment(line.slice(idx + 1)).trim();

        if (!section || section === "env") {
            result._env[key] = value;
            continue;
        }

        if (section === "scripts") {
            const list = value.split(",").map((item) => item.trim()).filter(Boolean);
            result._scripts.push(...list.map((cmd) => ({ name: key, cmd })));
            continue;
        }

        result._env[`${section.toUpperCase()}_${key}`] = value;
    }

    return result;
}

function resolveConfigPath(explicitPath) {
    if (explicitPath) {
        return path.resolve(explicitPath);
    }

    if (process.env.BSOLE_CONFIG_PATH) {
        return path.resolve(process.env.BSOLE_CONFIG_PATH);
    }

    const dockerPath = "/config/config.ini";
    if (fs.existsSync(dockerPath)) {
        return dockerPath;
    }

    return path.resolve(process.cwd(), "config/config.ini");
}

function loadConfigFile(explicitPath, options = {}) {
    const { applyEnv = true, preserveExisting = true } = options;
    const configPath = resolveConfigPath(explicitPath);

    if (!fs.existsSync(configPath)) {
        return {
            loaded: false,
            configPath,
            parsed: { _env: {}, _scripts: [] },
        };
    }

    const parsed = parseIni(fs.readFileSync(configPath, "utf8"));

    if (applyEnv) {
        for (const [key, value] of Object.entries(parsed._env)) {
            if (preserveExisting && process.env[key] !== undefined) {
                continue;
            }
            process.env[key] = value;
        }
        process.env.BSOLE_CONFIG_PATH = configPath;
    }

    return {
        loaded: true,
        configPath,
        parsed,
    };
}

module.exports = {
    loadConfigFile,
    parseIni,
    resolveConfigPath,
    stripInlineComment,
};
