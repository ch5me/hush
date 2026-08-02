#!/usr/bin/env node
process.env.HUSH_CLI_ENTRYPOINT = "1";
import("../dist/cli.js");
