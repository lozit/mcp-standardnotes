import { deleteSession } from "../sn/session.js";

async function main(): Promise<void> {
  const email = process.env.SN_EMAIL ?? process.argv[2];
  if (!email) {
    console.error(
      "Usage: SN_EMAIL=<email> npm run logout   (or: npm run logout -- <email>)",
    );
    process.exit(2);
  }
  const removed = await deleteSession(email);
  if (removed) {
    console.error(`Removed keychain entry for ${email}.`);
  } else {
    console.error(`No keychain entry found for ${email}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
