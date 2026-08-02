const INSTALL_HINTS: Record<string, { macos: string; linux: string; windows: string }> = {
  sops: {
    macos: "brew install sops age",
    linux: "apt-get install sops  # or: https://github.com/getsops/sops/releases",
    windows: "scoop install sops age",
  },
  age: {
    macos: "brew install age",
    linux: "apt-get install age  # or: https://github.com/FiloSottile/age/releases",
    windows: "scoop install age",
  },
  "age-keygen": {
    macos: "brew install age",
    linux: "apt-get install age  # or: https://github.com/FiloSottile/age/releases",
    windows: "scoop install age",
  },
};

export function missingBinaryError(name: "sops" | "age" | "age-keygen"): Error {
  const hints = INSTALL_HINTS[name];
  const platform = process.platform;

  let installLine: string;
  if (platform === "darwin") {
    installLine = hints.macos;
  } else if (platform === "win32") {
    installLine = hints.windows;
  } else {
    installLine = hints.linux;
  }

  const displayName = name === "sops" ? "SOPS" : name;
  const prefix = name === "sops" ? "SOPS is not installed" : `${displayName} is not installed`;

  return new Error(
    `${prefix}. Install with:\n  ${installLine}\nRun \`hush doctor\` to diagnose your setup.`,
  );
}
