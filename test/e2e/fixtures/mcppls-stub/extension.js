const fs = require("node:fs");
const vscode = require("vscode");

function record(command) {
  const logPath = process.env.MCPP_E2E_MCPPLS_LOG;
  if (typeof logPath === "string") {
    fs.appendFileSync(logPath, `${command}\n`);
  }
}

function activate(context) {
  for (const command of [
    "mcppls.restartServer",
    "mcppls.selectContext",
    "mcppls.showModuleGraph",
    "mcppls.showLogs",
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        record(command);
        return undefined;
      }),
    );
  }
}

module.exports = { activate };
