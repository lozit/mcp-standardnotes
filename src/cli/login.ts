#!/usr/bin/env node
import readline from "node:readline";
import { logger } from "../security/logger.js";
import { createClientFromLogin } from "../sn/client.js";

const CTRL_C = "";
const DEL = "";

function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSilent(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const cleanup = (): void => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          return;
        }
        if (ch === DEL || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        input += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function prompt(question: string, silent = false): Promise<string> {
  return silent ? promptSilent(question) : promptVisible(question);
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
    const causes: string[] = [];
    let cur: unknown = err;
    while (cur instanceof Error) {
      causes.push(cur.message);
      cur = (cur as Error & { cause?: unknown }).cause;
    }
    logger.error("Login failed", {
      message: causes[0] ?? String(err),
      causes: causes.slice(1),
    });
    process.exit(1);
  }
}

main();
