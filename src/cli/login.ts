#!/usr/bin/env node
import readline from "node:readline";
import { logger } from "../security/logger.js";
import { createClientFromLogin } from "../sn/client.js";

function prompt(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (silent) {
      const orig = (rl as unknown as { _writeToOutput: (s: string) => void })
        ._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
        (s: string) => {
          if (s.trim().length === 0) orig.call(rl, s);
          else orig.call(rl, "*");
        };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const serverUrl =
    process.env.SN_SERVER_URL ?? "https://api.standardnotes.com";
  const envEmail = process.env.SN_EMAIL;
  const email = envEmail ?? (await prompt("Email: "));
  if (!email) throw new Error("email is required");

  let password = await prompt("Password: ", true);
  if (!password) throw new Error("password is required");

  try {
    await createClientFromLogin(
      { serverUrl, email },
      password,
      async () => prompt("Two-factor code (6 digits): "),
    );
    password = "";
    logger.info("Login OK, session stored in keychain", { email, serverUrl });
    process.stdout.write("Login successful. Session saved in OS keychain.\n");
  } catch (err) {
    password = "";
    logger.error("Login failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();
