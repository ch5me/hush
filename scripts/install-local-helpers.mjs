export function assertNode24(version) {
  if (Number(version.replace(/^v/, "").split(".", 1)[0]) !== 24) {
    throw new Error(
      `Hush requires Node 24; got ${version}. Run through the managed Mise toolchain.`,
    );
  }
}
