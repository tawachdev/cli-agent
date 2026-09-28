#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

const platform = `${process.platform}-${process.arch}`;

function binaryCandidates() {
  const names = [`@mimon/${platform}`];
  const entries = [];
  for (const name of names) {
    try {
      entries.push(path.join(path.dirname(require.resolve(`${name}/package.json`)), "bin", "mimon"));
    } catch {
      continue;
    }
  }
  entries.push(path.join(__dirname, "..", "node_modules", "@mimon", platform, "bin", "mimon"));
  return entries;
}

const fs = require("node:fs");
const binary = binaryCandidates().find((candidate) => fs.existsSync(candidate));

if (!binary) {
  process.stderr.write(
    `mimon: no binary for ${platform} — the platform package @mimon/${platform} did not install.\n` +
      "try: npm i -g mimon --force  (or open an issue with your OS and arch)\n",
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGPIPE"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
