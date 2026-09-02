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

    const configuredPath = process.env.WEARMUX_CONFIG_PATH || process.env.BSOLE_CONFIG_PATH;
    if (configuredPath) {
        return path.resolve(configuredPath);
    }

    const dockerDir = "/config";
    if (fs.existsSync(dockerDir) && fs.statSync(dockerDir).isDirectory()) {
        return dockerDir;
    }

    return path.resolve(process.cwd(), "config");
}

/**
 * Collect all *.ini file paths from a directory, sorted alphabetically.
 * config.ini is always first so its [scripts] and base settings take precedence.
 */
function collectIniFiles(dirPath) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        // Legacy: plain file path
        return fs.existsSync(dirPath) ? [dirPath] : [];
    }

    const files = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith(".ini"))
        .sort((a, b) => {
            if (a === "config.ini") return -1;
            if (b === "config.ini") return 1;
            return a.localeCompare(b);
        })
        .map((f) => path.join(dirPath, f));

    return files;
}

function loadConfigFile(explicitPath, options = {}) {
    const { applyEnv = true, preserveExisting = true } = options;
    const configPath = resolveConfigPath(explicitPath);

    const iniFiles = collectIniFiles(configPath);

    if (iniFiles.length === 0) {
        return {
            loaded: false,
            configPath,
            parsed: { _env: {}, _scripts: [] },
        };
    }

    // Merge all ini files — first file wins for duplicate keys
    const merged = { _env: {}, _scripts: [] };
    for (const file of iniFiles) {
        const parsed = parseIni(fs.readFileSync(file, "utf8"));
        Object.assign(merged._env, { ...parsed._env, ...merged._env });
        merged._scripts.push(...parsed._scripts);
    }

    if (applyEnv) {
        for (const [key, value] of Object.entries(merged._env)) {
            if (preserveExisting && process.env[key] !== undefined) {
                continue;
            }
            process.env[key] = value;
        }
        process.env.WEARMUX_CONFIG_PATH = configPath;
        // Backward-compatible alias used by earlier development snapshots.
        process.env.BSOLE_CONFIG_PATH = configPath;
    }

    return {
        loaded: true,
        configPath,
        parsed: merged,
    };
}

module.exports = {
    loadConfigFile,
    parseIni,
    resolveConfigPath,
    stripInlineComment,
};
