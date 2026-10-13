import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = process.env.CODEX_DSH_BRIDGE_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { main } = await import(pathToFileURL(path.join(repo, 'cli.mjs')).href);
main().catch(error => { console.error(error.message); process.exitCode = 1; });
