import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `model-router setup <harness>` — prints (or with --write, applies) the
 * exact configuration a harness needs to route through the proxy.
 * Print is always safe; --write backs up any file it touches.
 */

const HARNESSES = ["claude-code", "codex", "opencode", "copilot", "pi"] as const;
type Harness = (typeof HARNESSES)[number];

export async function runSetup(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const port = Number(Bun.env.PORT ?? 4141);
  const base = `http://localhost:${port}`;
  const harness = args.find((a) => !a.startsWith("--")) as Harness | undefined;

  if (!harness || !HARNESSES.includes(harness)) {
    console.log(`Usage: model-router setup <harness> [--write]\n`);
    console.log(`Harnesses: ${HARNESSES.join(", ")}`);
    console.log(`\nPrints the configuration each harness needs. --write applies it`);
    console.log(`(supported for: opencode, codex) after backing up the existing file.`);
    return harness ? 1 : 0;
  }

  switch (harness) {
    case "claude-code":
      console.log(`# Claude Code — point its Anthropic base URL at the proxy.\n`);
      console.log(`# One-off:`);
      console.log(`ANTHROPIC_BASE_URL=${base} claude\n`);
      console.log(`# Permanent — add to ~/.claude/settings.json:`);
      console.log(JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }, null, 2));
      console.log(`\n# Pin a specific upstream instead: ANTHROPIC_BASE_URL=${base}/p/<upstream-name>`);
      return 0;

    case "copilot":
      console.log(`# GitHub Copilot (VS Code, bring-your-own-model):`);
      console.log(`# 1. Command palette -> "Chat: Manage Language Models"`);
      console.log(`# 2. Add an OpenAI-compatible endpoint:`);
      console.log(`#      URL:     ${base}/p/<upstream-name>/v1`);
      console.log(`#      API key: anything (forwarded per the upstream's authStyle)`);
      console.log(`# 3. Pick "auto" from the model list to delegate model choice to the router.`);
      return 0;

    case "pi":
      console.log(`# pi — point its provider base URLs at the proxy:`);
      console.log(`ANTHROPIC_BASE_URL=${base} OPENAI_BASE_URL=${base}/v1 pi`);
      console.log(`# (per-provider mounts: ${base}/p/<upstream-name>)`);
      return 0;

    case "opencode": {
      const snippet = {
        provider: {
          router: {
            npm: "@ai-sdk/openai-compatible",
            name: "model-router",
            options: { baseURL: `${base}/v1` },
            models: { auto: {}, "gpt-5.5": {}, "gpt-5.4": {} },
          },
        },
      };
      console.log(`# opencode — add a provider whose baseURL is the proxy (per-upstream: ${base}/p/<name>/v1):\n`);
      console.log(JSON.stringify(snippet, null, 2));
      if (!write) {
        console.log(`\n# Run with --write to merge this into ./opencode.json (backs up first).`);
        return 0;
      }
      const path = join(process.cwd(), "opencode.json");
      let existing: any = {};
      if (existsSync(path)) {
        copyFileSync(path, `${path}.bak`);
        try {
          existing = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          console.error(`! ${path} is not valid JSON — wrote nothing. Fix it or remove it and retry.`);
          return 1;
        }
      }
      existing.provider = { ...existing.provider, ...snippet.provider };
      writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
      console.log(`\nWrote ${path}${existsSync(`${path}.bak`) ? ` (backup: ${path}.bak)` : ""}`);
      return 0;
    }

    case "codex": {
      const block = [
        `# --- model-router (added by \`model-router setup codex --write\`) ---`,
        `model_provider = "router"`,
        ``,
        `[model_providers.router]`,
        `name = "model-router"`,
        `base_url = "${base}/p/openai/v1"`,
        `env_key = "OPENAI_API_KEY"`,
        `wire_api = "responses"   # "chat" also works`,
        `# --- end model-router ---`,
      ].join("\n");
      console.log(`# Codex CLI — ~/.codex/config.toml:\n`);
      console.log(block);
      if (!write) {
        console.log(`\n# Run with --write to append this to ~/.codex/config.toml (backs up first).`);
        return 0;
      }
      const path = join(homedir(), ".codex", "config.toml");
      if (!existsSync(join(homedir(), ".codex"))) {
        console.error(`! ~/.codex does not exist — is Codex CLI installed? Wrote nothing.`);
        return 1;
      }
      const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
      if (current.includes("[model_providers.router]")) {
        console.log(`\n~/.codex/config.toml already has a [model_providers.router] block — left unchanged.`);
        return 0;
      }
      if (existsSync(path)) copyFileSync(path, `${path}.bak`);
      writeFileSync(path, `${current.trimEnd()}\n\n${block}\n`);
      console.log(`\nWrote ${path}${existsSync(`${path}.bak`) ? ` (backup: ${path}.bak)` : ""}`);
      return 0;
    }
  }
}
