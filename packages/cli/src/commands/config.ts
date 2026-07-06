import { input, password, select } from "@inquirer/prompts";
import {
  getConfigPath,
  loadConfig,
  PROVIDER_DEFAULTS,
  PROVIDER_IDS,
  resolveModel,
  saveConfig,
  type ProviderId,
  type ScissorConfig,
} from "@scissor/core";
import { theme } from "../ui/render.js";

/** Interactive configuration wizard: manage API keys and default provider. */
export async function runConfigWizard(): Promise<void> {
  const config = await loadConfig();
  process.stdout.write(theme.brand.bold("scissor config") + "\n");
  process.stdout.write(theme.dim(`Stored at ${getConfigPath()}\n\n`));

  let quit = false;
  while (!quit) {
    printStatus(config);
    const action = await select<string>({
      message: "What would you like to do?",
      choices: [
        ...PROVIDER_IDS.map((id) => ({
          name: `Configure ${PROVIDER_DEFAULTS[id].label} (${id})`,
          value: `set:${id}`,
        })),
        { name: "Set default provider", value: "default" },
        { name: "Save and exit", value: "save" },
        { name: "Exit without saving", value: "quit" },
      ],
    });

    if (action === "save") {
      await saveConfig(config);
      process.stdout.write(theme.ok(`Saved to ${getConfigPath()}\n`));
      quit = true;
    } else if (action === "quit") {
      quit = true;
    } else if (action === "default") {
      config.defaultProvider = await select<ProviderId>({
        message: "Default provider",
        choices: PROVIDER_IDS.map((id) => ({
          name: `${PROVIDER_DEFAULTS[id].label} (${id})`,
          value: id,
        })),
        default: config.defaultProvider,
      });
    } else if (action.startsWith("set:")) {
      const id = action.slice(4) as ProviderId;
      await configureProvider(config, id);
    }
  }
}

async function configureProvider(
  config: ScissorConfig,
  id: ProviderId,
): Promise<void> {
  const defaults = PROVIDER_DEFAULTS[id];
  const current = config.providers[id] ?? {};

  const key = await password({
    message: `${defaults.label} API key (leave blank to keep current)`,
    mask: "*",
  });

  const model = await input({
    message: `Model name`,
    default: resolveModel(config, id),
  });

  let baseURL = current.baseURL ?? defaults.baseURL ?? "";
  const changeBase = await select<boolean>({
    message: `Base URL (${baseURL || "SDK default"})`,
    choices: [
      { name: "Keep as-is", value: false },
      { name: "Change", value: true },
    ],
  });
  if (changeBase) {
    baseURL = await input({ message: "Base URL", default: baseURL });
  }

  config.providers[id] = {
    ...current,
    apiKey: key.trim().length > 0 ? key.trim() : current.apiKey,
    model: model.trim() || undefined,
    baseURL: baseURL.trim() || undefined,
  };
  process.stdout.write(theme.ok(`Updated ${defaults.label}.\n`));
}

function printStatus(config: ScissorConfig): void {
  process.stdout.write("\n" + theme.bold("Current configuration:") + "\n");
  for (const id of PROVIDER_IDS) {
    const pc = config.providers[id];
    const hasKey = pc?.apiKey && pc.apiKey.length > 0;
    const isDefault = config.defaultProvider === id;
    const status = hasKey ? theme.ok("key set") : theme.dim("no key");
    const marker = isDefault ? theme.brand(" (default)") : "";
    process.stdout.write(
      `  ${PROVIDER_DEFAULTS[id].label.padEnd(18)} ${status} ${theme.dim(resolveModel(config, id))}${marker}\n`,
    );
  }
  process.stdout.write("\n");
}
