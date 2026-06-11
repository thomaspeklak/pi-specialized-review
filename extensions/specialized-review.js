import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const REVIEWERS = [
    {
        id: "sr-correctness",
        file: "sr-correctness.md",
        label: "Functional correctness",
        description: "Concrete behavior bugs, regressions, broken edge cases, and changed behavior that does not match intent. Not style, coverage, security-only, performance-only, docs, or release-process feedback.",
    },
    {
        id: "sr-tests",
        file: "sr-tests.md",
        label: "Tests and validation",
        description: "Missing, weak, flaky, misplaced, or misleading validation caused by the change. Not a broad production-code review unless a test issue exposes a concrete bug.",
    },
    {
        id: "sr-security",
        file: "sr-security.md",
        label: "Security and privacy",
        description: "Auth, permissions, secrets, untrusted input/output, crypto, privacy, dependency, filesystem, subprocess, network, and sandbox risks. Not generic hardening wishlists.",
    },
    {
        id: "sr-performance",
        file: "sr-performance.md",
        label: "Performance and scalability",
        description: "Measurable performance, resource, concurrency, scalability, startup/build/test runtime, caching, database/query, and memory risks. Not micro-optimization.",
    },
    {
        id: "sr-api-contracts",
        file: "sr-api-contracts.md",
        label: "API and compatibility contracts",
        description: "Public API, exported types, CLI, config/env, protocol/schema, migrations, serialized formats, events, plugins, and compatibility risks. Not internal refactor taste.",
    },
    {
        id: "sr-release-risk",
        file: "sr-release-risk.md",
        label: "Release and operations risk",
        description: "Deploy, CI, build, packaging, dependency, lockfile, migration/backfill, feature-flag, rollback, observability, and operational risks. Not normal app correctness.",
    },
    {
        id: "sr-docs",
        file: "sr-docs.md",
        label: "Docs and user-facing text",
        description: "Docs, comments, examples, help text, changelog, migration notes, and user-facing copy. Not code review.",
    },
    {
        id: "sr-maintainability",
        file: "sr-maintainability.md",
        label: "Maintainability and simplicity",
        description: "Unnecessary complexity, architecture drift, duplication, brittle abstractions, module boundaries, readability, and type/source-of-truth drift. Not speculative rewrites.",
    },
];
const REVIEWER_ORDER = REVIEWERS.map((reviewer) => reviewer.id);
const REVIEWER_BY_ID = new Map(REVIEWERS.map((reviewer) => [reviewer.id, reviewer]));
const ALIASES = {
    correctness: "sr-correctness",
    bug: "sr-correctness",
    bugs: "sr-correctness",
    behavior: "sr-correctness",
    test: "sr-tests",
    tests: "sr-tests",
    validation: "sr-tests",
    security: "sr-security",
    sec: "sr-security",
    privacy: "sr-security",
    perf: "sr-performance",
    performance: "sr-performance",
    scalability: "sr-performance",
    api: "sr-api-contracts",
    contract: "sr-api-contracts",
    contracts: "sr-api-contracts",
    compatibility: "sr-api-contracts",
    release: "sr-release-risk",
    deploy: "sr-release-risk",
    ops: "sr-release-risk",
    ci: "sr-release-risk",
    docs: "sr-docs",
    documentation: "sr-docs",
    comments: "sr-docs",
    maintainability: "sr-maintainability",
    cleanup: "sr-maintainability",
    complexity: "sr-maintainability",
    architecture: "sr-maintainability",
};
export default function specializedReviewExtension(pi) {
    pi.registerCommand("specialized-review", {
        description: "Run an isolated, specialist code review using pi-subagents without installing global prompts, skills, or subagent files.",
        handler: async (args, ctx) => {
            const parsed = parseArgs(args ?? "");
            if (parsed.catalog) {
                pi.sendUserMessage(buildCatalogPrompt(), { deliverAs: "followUp" });
                return;
            }
            const hasSubagentTool = hasTool(pi, "subagent");
            if (!hasSubagentTool) {
                safeNotify(ctx, "specialized-review needs pi-subagents; run: pi install npm:pi-subagents", "warning");
                pi.sendUserMessage("The specialized review extension is installed, but I cannot see the `subagent` tool. Install `pi-subagents` with `pi install npm:pi-subagents`, reload Pi, then run `/specialized-review` again.", { deliverAs: "followUp" });
                return;
            }
            const git = await inspectGit(pi, parsed);
            const selected = selectReviewers(git, parsed);
            const prompt = buildDispatchPrompt(parsed, git, selected);
            safeNotify(ctx, `specialized-review selected: ${selected.join(", ")}`, "info");
            pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        },
    });
    pi.registerCommand("specialized-reviewers", {
        description: "Show the private specialized-review reviewer catalog.",
        handler: async () => {
            pi.sendUserMessage(buildCatalogPrompt(), { deliverAs: "followUp" });
        },
    });
}
function parseArgs(raw) {
    const tokens = splitArgs(raw);
    const forced = new Set();
    const focusParts = [];
    let staged = false;
    let autofix = false;
    let all = false;
    let catalog = false;
    let context = "fresh";
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const lower = token.toLowerCase();
        if (["staged", "cached", "--staged", "--cached"].includes(lower)) {
            staged = true;
            continue;
        }
        if (["autofix", "--autofix", "fix", "--fix"].includes(lower)) {
            autofix = true;
            continue;
        }
        if (["all", "--all"].includes(lower)) {
            all = true;
            continue;
        }
        if (["catalog", "agents", "reviewers", "list", "--catalog", "--agents", "--reviewers", "--list"].includes(lower)) {
            catalog = true;
            continue;
        }
        if (["fork", "--fork"].includes(lower)) {
            context = "fork";
            continue;
        }
        if (["fresh", "--fresh"].includes(lower)) {
            context = "fresh";
            continue;
        }
        if (["focus", "--focus"].includes(lower)) {
            continue;
        }
        if (["--agent", "--reviewer"].includes(lower) && tokens[i + 1]) {
            for (const id of parseReviewerList(tokens[i + 1]))
                forced.add(id);
            i += 1;
            continue;
        }
        if (lower.startsWith("--agent=") || lower.startsWith("--reviewer=")) {
            const value = token.slice(token.indexOf("=") + 1);
            for (const id of parseReviewerList(value))
                forced.add(id);
            continue;
        }
        const alias = reviewerFromToken(lower);
        if (alias) {
            forced.add(alias);
            continue;
        }
        focusParts.push(token);
    }
    return {
        raw,
        staged,
        autofix,
        all,
        catalog,
        context,
        forced: orderReviewers([...forced]),
        focus: focusParts.join(" ").trim(),
    };
}
function splitArgs(raw) {
    const matches = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    return matches.map((token) => token.replace(/^("|')|("|')$/g, ""));
}
function parseReviewerList(value) {
    return value
        .split(",")
        .map((part) => reviewerFromToken(part.trim().toLowerCase()))
        .filter((id) => Boolean(id));
}
function reviewerFromToken(token) {
    if (REVIEWER_BY_ID.has(token))
        return token;
    return ALIASES[token];
}
async function inspectGit(pi, parsed) {
    const errors = [];
    const rootResult = await execGit(pi, ["rev-parse", "--show-toplevel"]);
    const inRepo = rootResult.ok && rootResult.text.trim().length > 0;
    if (!rootResult.ok)
        errors.push(rootResult.text || "Not inside a git repository.");
    const diffBase = parsed.staged ? ["diff", "--cached"] : ["diff"];
    const [status, stat, nameStatus, numstat, names] = await Promise.all([
        execGit(pi, ["status", "--short"]),
        execGit(pi, [...diffBase, "--stat"]),
        execGit(pi, [...diffBase, "--name-status"]),
        execGit(pi, [...diffBase, "--numstat"]),
        execGit(pi, [...diffBase, "--name-only"]),
    ]);
    for (const result of [status, stat, nameStatus, numstat, names]) {
        if (!result.ok && result.text)
            errors.push(result.text);
    }
    return {
        inRepo,
        root: rootResult.ok ? rootResult.text.trim() : "",
        mode: parsed.staged ? "staged" : "unstaged",
        status: status.text.trim(),
        stat: stat.text.trim(),
        nameStatus: nameStatus.text.trim(),
        numstat: numstat.text.trim(),
        files: names.text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        errors,
    };
}
async function execGit(pi, args) {
    try {
        const result = await pi.exec("git", args, { timeout: 5000 });
        const stdout = String(result?.stdout ?? "").trim();
        const stderr = String(result?.stderr ?? "").trim();
        const code = typeof result?.code === "number" ? result.code : 0;
        const text = stdout || stderr;
        return { ok: code === 0, text };
    }
    catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
}
function selectReviewers(git, parsed) {
    if (parsed.all)
        return REVIEWER_ORDER;
    const selected = new Set();
    const files = git.files;
    const focus = parsed.focus.toLowerCase();
    const haystack = `${git.status}\n${git.stat}\n${git.nameStatus}\n${git.numstat}\n${focus}`.toLowerCase();
    if (files.length === 0) {
        add(selected, "sr-correctness", "sr-tests", "sr-maintainability");
    }
    else {
        const onlyDocs = files.every(isDocsPath);
        const onlyTests = files.every(isTestPath);
        const onlyRelease = files.every(isReleasePath);
        const anyCode = files.some(isLikelyCodePath);
        if (onlyDocs) {
            add(selected, "sr-docs");
            if (haystackMatches(haystack, /\b(api|cli|config|env|schema|migration|breaking|compatib|public|user-facing)\b/) || files.some(isPublicContractPath)) {
                add(selected, "sr-api-contracts");
            }
        }
        else if (onlyTests) {
            add(selected, "sr-tests", "sr-correctness");
        }
        else if (onlyRelease && !anyCode) {
            add(selected, "sr-release-risk", "sr-tests");
        }
        else {
            add(selected, "sr-correctness", "sr-tests", "sr-maintainability");
        }
    }
    if (triggersSecurity(files, haystack))
        add(selected, "sr-security");
    if (triggersPerformance(files, haystack))
        add(selected, "sr-performance");
    if (triggersApiContracts(files, haystack))
        add(selected, "sr-api-contracts");
    if (triggersReleaseRisk(files, haystack))
        add(selected, "sr-release-risk");
    if (triggersDocs(files, haystack))
        add(selected, "sr-docs");
    for (const forced of parsed.forced)
        selected.add(forced);
    if (selected.size === 0)
        add(selected, "sr-correctness", "sr-tests", "sr-maintainability");
    return orderReviewers([...selected]);
}
function add(set, ...ids) {
    for (const id of ids)
        set.add(id);
}
function orderReviewers(ids) {
    const lookup = new Set(ids);
    return REVIEWER_ORDER.filter((id) => lookup.has(id));
}
function isDocsPath(path) {
    const p = path.toLowerCase();
    return (/(^|\/)(docs?|documentation|examples?|guides?|tutorials?|changelog)(\/|$)/.test(p) ||
        /(^|\/)(readme|changelog|contributing|license|security|code_of_conduct)(\.[a-z0-9]+)?$/.test(p) ||
        /\.(md|mdx|rst|adoc|txt)$/i.test(p));
}
function isTestPath(path) {
    const p = path.toLowerCase();
    return (/(^|\/)(__tests__|tests?|spec|fixtures?|mocks?)(\/|$)/.test(p) ||
        /(^|\/)(test|spec)-/.test(p) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
        /_test\.(go|py|rb)$/.test(p));
}
function isReleasePath(path) {
    const p = path.toLowerCase();
    return (/^\.github\/workflows\//.test(p) ||
        /^\.gitlab-ci\.ya?ml$/.test(p) ||
        /^\.circleci\//.test(p) ||
        /(^|\/)(dockerfile|docker-compose\.[^.]+|compose\.[^.]+)$/.test(p) ||
        /(^|\/)(package|package-lock|npm-shrinkwrap)\.json$/.test(p) ||
        /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock|go\.mod|go\.sum|poetry\.lock|pyproject\.toml|requirements.*\.txt)$/.test(p) ||
        /(^|\/)(makefile|justfile|mise\.toml|asdf\.tool-versions)$/.test(p) ||
        /(^|\/)(deploy|deployment|k8s|kubernetes|helm|terraform|infra|ops|ci|scripts)(\/|$)/.test(p) ||
        /(^|\/)migrations?(\/|$)/.test(p));
}
function isPublicContractPath(path) {
    const p = path.toLowerCase();
    return (/(^|\/)(api|routes?|endpoints?|schemas?|openapi|swagger|proto|graphql|cli|commands?|config|plugins?|events?)(\/|$)/.test(p) ||
        /(^|\/)(index|main|mod|lib)\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py)$/.test(p) ||
        /\.(proto|graphql|gql|openapi\.ya?ml|schema\.json)$/.test(p) ||
        /(^|\/)package\.json$/.test(p));
}
function isLikelyCodePath(path) {
    const p = path.toLowerCase();
    if (isDocsPath(p))
        return false;
    return /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|py|rb|java|kt|scala|cs|php|swift|c|cc|cpp|h|hpp|sql|sh|bash|zsh|fish|yml|yaml|json|toml|ini|tf)$/.test(p);
}
function triggersSecurity(files, haystack) {
    return (files.some((file) => /(^|\/)(auth|oauth|login|session|sessions|security|permissions?|acl|iam|rbac|crypto|secrets?|tokens?|passwords?|certs?|keys?|sandbox)(\/|$)/i.test(file)) ||
        files.some((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|requirements.*\.txt|pyproject\.toml|poetry\.lock|go\.mod|cargo\.lock)$/i.test(file)) ||
        haystackMatches(haystack, /\b(auth|authorization|authentication|oauth|jwt|token|session|cookie|csrf|xss|cors|csp|secret|credential|password|encrypt|decrypt|crypto|permission|sandbox|subprocess|shell|exec|spawn|path traversal|sanitize|escape|sql injection|webhook|privacy|pii)\b/));
}
function triggersPerformance(files, haystack) {
    return (files.some((file) => /(^|\/)(perf|performance|bench|benchmark|load|cache|queue|worker|scheduler|database|db|queries?|streams?)(\/|$)/i.test(file)) ||
        haystackMatches(haystack, /\b(perf|performance|benchmark|latency|throughput|cache|caching|query|queries|database|db|n\+1|loop|stream|batch|queue|worker|concurrency|parallel|async|memory|timeout|startup|build time|test runtime)\b/));
}
function triggersApiContracts(files, haystack) {
    return (files.some(isPublicContractPath) ||
        files.some((file) => /(^|\/)migrations?(\/|$)/i.test(file)) ||
        haystackMatches(haystack, /\b(api|public|exported|exports|schema|protocol|wire format|serialized|serialization|cli|flag|config|env var|environment variable|migration|backward compatible|breaking change|deprecat|versioned|plugin|event)\b/));
}
function triggersReleaseRisk(files, haystack) {
    return (files.some(isReleasePath) ||
        haystackMatches(haystack, /\b(ci|workflow|deploy|deployment|release|rollback|migration|backfill|feature flag|observability|logging|metrics|alert|package|lockfile|dependency|docker|kubernetes|helm|terraform|env|secret)\b/));
}
function triggersDocs(files, haystack) {
    return (files.some(isDocsPath) ||
        haystackMatches(haystack, /\b(readme|docs|documentation|comment|example|changelog|migration guide|help text|user-facing|copy)\b/));
}
function haystackMatches(haystack, regex) {
    return regex.test(haystack);
}
function buildDispatchPrompt(parsed, git, selected) {
    const target = parsed.staged ? "staged diff (`git diff --cached`)" : "current unstaged diff (`git diff`)";
    const focus = parsed.focus ? `\nAdditional focus from user: ${parsed.focus}` : "";
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const selectedBlocks = selected.map((id) => buildReviewerBlock(id)).join("\n\n---\n\n");
    const taskSketch = selected
        .map((id) => {
        const meta = REVIEWER_BY_ID.get(id);
        return `    { agent: "reviewer", task: "Act as ${id}. Review ${target} for ${meta.label.toLowerCase()} only, using the private specialist contract embedded below. Do not edit files. Return only XML.", output: ".pi/specialized-review/${runId}/${id}.xml", outputMode: "file-only", skill: false, acceptance: "attested" }`;
    })
        .join(",\n");
    return `Run the specialized code review requested through the \`pi-specialized-review\` extension.

This extension keeps reviewer artifacts private: it does not install Pi prompt templates, skills, or discoverable subagent files. For this run, use the existing \`subagent\` tool from \`pi-subagents\` and launch the built-in \`reviewer\` agent with the role contracts below embedded in each task. Do not create, update, or delete persistent subagent definitions.

Review target: ${target}${focus}
Invocation flags: ${parsed.raw || "(none)"}
Autofix requested: ${parsed.autofix ? "yes" : "no"}
Subagent context: ${parsed.context}
Selected specialist reviewers: ${selected.join(", ")}

## Git snapshot used for dispatch

Repository root: ${git.root || "unknown"}
Git mode: ${git.mode}
Git inspection errors: ${git.errors.length ? git.errors.join(" | ") : "none"}

### git status --short

\`\`\`
${truncate(git.status || "(empty)", 4000)}
\`\`\`

### git diff ${parsed.staged ? "--cached " : ""}--stat

\`\`\`
${truncate(git.stat || "(empty)", 4000)}
\`\`\`

### git diff ${parsed.staged ? "--cached " : ""}--name-status

\`\`\`
${truncate(git.nameStatus || "(empty)", 4000)}
\`\`\`

### git diff ${parsed.staged ? "--cached " : ""}--numstat

\`\`\`
${truncate(git.numstat || "(empty)", 4000)}
\`\`\`

## Launch instructions

Do not perform a full monolithic review first. Launch these reviewers in parallel, with fresh child context unless this prompt says \`fork\`. Each reviewer must inspect the repository and diff directly; the git snapshot above is only dispatch metadata.

Use a \`subagent\` call equivalent to this shape, adapting task strings to include the full specialist contracts below:

\`\`\`text
subagent({
  tasks: [
${taskSketch}
  ],
  context: "${parsed.context}",
  concurrency: ${Math.min(Math.max(selected.length, 1), 4)},
  artifacts: true
})
\`\`\`

For every selected reviewer task, include its full private specialist contract from the next section. Set \`skill: false\` to avoid injecting unrelated skills. Ask reviewers to avoid edits and to return only XML.

## Private specialist contracts for this run

${selectedBlocks}

## Coordinator synthesis

After the subagents return:

1. Read the XML outputs as needed.
2. Drop findings that are speculative, duplicated, outside the specialist's scope, contradicted by code, or about unchanged code not materially affected by the diff.
3. Verify serious or uncertain findings yourself with focused reads or commands before presenting them.
4. Classify final items as \`blocker\`, \`fix_now\`, \`optional\`, or \`ignore_or_defer\`.
5. Bias toward shipping: do not block on style preferences or low-confidence warnings.

${parsed.autofix ? "Autofix mode is enabled. Apply only small, safe `fix_now` edits after synthesis, then run focused validation. Do not apply optional improvements." : "Autofix mode is disabled. Do not edit files unless the user separately authorizes applying feedback."}

Final response format:

- selected reviewers and why;
- blockers;
- fixes worth doing now;
- optional improvements;
- ignored/deferred reviewer feedback with a short reason;
- validation commands run or recommended;
- whether autofix was applied.

Keep the final concise and cite file paths and line numbers for all actionable findings.`;
}
function buildReviewerBlock(id) {
    const meta = REVIEWER_BY_ID.get(id);
    const body = loadReviewerBody(meta.file);
    return `### ${id}: ${meta.label}\n\nDescription: ${meta.description}\n\n${body}`;
}
function loadReviewerBody(fileName) {
    const filePath = resolve(packageRoot(), "reviewers", fileName);
    if (!existsSync(filePath)) {
        return `Reviewer contract file missing: reviewers/${fileName}. Report this package installation problem instead of inventing a replacement contract.`;
    }
    const raw = readFileSync(filePath, "utf8");
    return stripFrontmatter(raw).trim();
}
function stripFrontmatter(markdown) {
    return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}
function buildCatalogPrompt() {
    const catalog = REVIEWERS.map((reviewer) => `- \`${reviewer.id}\` — ${reviewer.label}: ${reviewer.description}`).join("\n");
    return `Show this private specialized-review catalog to the user and explain that these reviewer specs are packaged inside the extension, not installed as global prompts, skills, or discoverable subagents.\n\n${catalog}\n\nUsage examples:\n\n- \`/specialized-review\`\n- \`/specialized-review staged\`\n- \`/specialized-review autofix\`\n- \`/specialized-review security api focus auth changes\`\n- \`/specialized-review --all\``;
}
function packageRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
function hasTool(pi, name) {
    try {
        const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
        return Array.isArray(tools) && tools.some((tool) => tool?.name === name);
    }
    catch {
        return false;
    }
}
function safeNotify(ctx, message, level) {
    try {
        ctx?.ui?.notify?.(message, level);
    }
    catch {
        // Notification failures should not block the command.
    }
}
function truncate(value, max) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, max)}\n... truncated ${value.length - max} chars ...`;
}
